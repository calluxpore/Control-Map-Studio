import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { cannyEdgeDetection } from './canny.js';
import { extractSkeleton, drawPoseSkeleton, drawGenericSkeleton } from './pose.js';

// ---------- DOM ----------
const tabModelBtn = document.getElementById('tabModelBtn');
const tabImageBtn = document.getElementById('tabImageBtn');
const modelDropzone = document.getElementById('modelDropzone');
const imageDropzone = document.getElementById('imageDropzone');
const fileInput = document.getElementById('fileInput');
const folderInput = document.getElementById('folderInput');
const browseFolderBtn = document.getElementById('browseFolderBtn');
const imageInput = document.getElementById('imageInput');
const uploadStatus = document.getElementById('uploadStatus');
const modelModeFieldset = document.getElementById('modelModeFieldset');
const imageModeFieldset = document.getElementById('imageModeFieldset');
const resolutionField = document.getElementById('resolutionField');
const viewerContainer = document.getElementById('viewerContainer');
const canvas = document.getElementById('viewerCanvas');
const imagePreview = document.getElementById('imagePreview');
const viewerPlaceholder = document.getElementById('viewerPlaceholder');
const resetViewBtn = document.getElementById('resetViewBtn');
const generateBtn = document.getElementById('generateBtn');
const resultImage = document.getElementById('resultImage');
const resultPlaceholder = document.getElementById('resultPlaceholder');
const resultNote = document.getElementById('resultNote');
const downloadBtn = document.getElementById('downloadBtn');
const resolutionSelect = document.getElementById('resolutionSelect');
const themeToggle = document.getElementById('themeToggle');
const themeToggleIcon = document.getElementById('themeToggleIcon');

// ---------- Theme ----------
function applyViewerBackground() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--viewer-bg').trim();
  scene.background = new THREE.Color(bg);
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  const isLight = theme === 'light';
  themeToggle.setAttribute('aria-pressed', String(isLight));
  themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
  themeToggleIcon.textContent = isLight ? '☀' : '☽'; // sun / crescent moon
  if (typeof scene !== 'undefined') applyViewerBackground();
}

function initTheme() {
  const saved = localStorage.getItem('theme');
  const preferred = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  setTheme(preferred);
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  setTheme(current === 'light' ? 'dark' : 'light');
});

// ---------- Three.js setup ----------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2, 2, 3);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// PBR metal/rough materials need something to reflect or they render pure
// black without an environment map. A neutral studio-room IBL fixes that
// for any uploaded model without altering its actual material data.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();

// Simple fixed lighting — just enough to see the model's geometry clearly.
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2b2a28, 0.7));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);

const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });

let currentModel = null;
let currentMeta = null; // { name, mainFile, files } for whatever is currently loaded, for display/downloads
let activeInput = 'model'; // 'model' | 'image'
let imageLoaded = false;
let baseNear = 0.01;
let baseFar = 1000;

const MODEL_EXT_PRIORITY = ['glb', 'gltf', 'obj', 'fbx', 'stl'];

// Everything runs client-side (no backend — this needs to work as a static
// GitHub Pages site), so uploaded files are held as blob: URLs for the life
// of the tab rather than persisted anywhere. Old URLs are revoked whenever
// they're replaced, since only one model or image is ever "current".
let modelBlobUrls = [];
let imageBlobUrl = null;
function revokeModelBlobUrls() {
  modelBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  modelBlobUrls = [];
}
function revokeImageBlobUrl() {
  if (imageBlobUrl) {
    URL.revokeObjectURL(imageBlobUrl);
    imageBlobUrl = null;
  }
}

function resizeRenderer() {
  const w = viewerContainer.clientWidth;
  const h = viewerContainer.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeRenderer).observe(viewerContainer);
resizeRenderer();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ---------- Model loading ----------
function clearCurrentModel() {
  if (!currentModel) return;
  scene.remove(currentModel);
  currentModel.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => {
        Object.values(m).forEach((v) => {
          if (v && v.isTexture) v.dispose();
        });
        m.dispose();
      });
    }
  });
  currentModel = null;
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.001);

  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(radius * 2.8));

  baseNear = radius * 0.01;
  baseFar = radius * 100;
  camera.near = baseNear;
  camera.far = baseFar;
  camera.updateProjectionMatrix();

  controls.update();
}

function setStatus(msg, isError = false) {
  uploadStatus.textContent = msg;
  uploadStatus.classList.toggle('error', isError);
}

function setResultNote(msg, isError = false) {
  resultNote.textContent = msg;
  resultNote.classList.toggle('error', isError);
}

function ext(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

// Split "textures/model/foo.png" into { dir: "textures/model/", base: "foo.png" }.
function splitDirBase(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? { dir: '', base: relPath } : { dir: relPath.slice(0, i + 1), base: relPath.slice(i + 1) };
}

// Letterboxes an image into a square canvas at the given size (contain-fit,
// centered, black-padded) so every image-mode output is square like the 3D
// model outputs, without cropping any of the source image away.
function buildSquareCanvas(source, size, bgColor = '#000') {
  const canvasEl = document.createElement('canvas');
  canvasEl.width = size;
  canvasEl.height = size;
  const ctx = canvasEl.getContext('2d');
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const scale = Math.min(size / sw, size / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;
  ctx.drawImage(source, dx, dy, dw, dh);

  return { canvas: canvasEl, ctx };
}

// Each item is { file: File, relativePath: string }. relativePath preserves
// any subfolder structure (e.g. "textures/base.png") so glTF/OBJ resources
// referenced relative to the model file keep resolving. Since there's no
// server, each file becomes a blob: URL, and a LoadingManager.setURLModifier
// intercepts every fetch the three.js loaders make (including glTF/OBJ's own
// resolution of sibling resources like "scene.bin" or "textures/x.png") and
// redirects it to the matching blob URL — the loaders are given plain
// relative-path strings, never the blob URLs themselves, precisely so this
// interception is the only thing that ever turns one into the other.
function loadModelFromItems(items) {
  if (items.length === 0) return;

  const supported = items.some((it) => MODEL_EXT_PRIORITY.includes(ext(it.relativePath)));
  if (!supported) {
    setStatus('No recognized 3D model file (.glb/.gltf/.obj/.fbx/.stl) in the selection.', true);
    return;
  }

  const mainItem = MODEL_EXT_PRIORITY.map((e) => items.find((it) => ext(it.relativePath) === e)).find(Boolean) || items[0];
  const mainFile = mainItem.relativePath;
  const extension = ext(mainFile);

  setStatus(`Loading ${mainFile}...`);
  generateBtn.disabled = true;
  resetViewBtn.disabled = true;

  revokeImageBlobUrl();
  revokeModelBlobUrls();
  const urlMap = new Map();
  items.forEach(({ file, relativePath }) => {
    const url = URL.createObjectURL(file);
    urlMap.set(relativePath, url);
    modelBlobUrls.push(url);
  });

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (urlMap.has(url)) return urlMap.get(url);
    try {
      const decoded = decodeURIComponent(url);
      if (urlMap.has(decoded)) return urlMap.get(decoded);
    } catch {
      /* not URI-encoded, ignore */
    }
    return url;
  });

  const onLoaded = (object) => {
    clearCurrentModel();
    currentModel = object;
    scene.add(object);
    frameObject(object);
    viewerPlaceholder.hidden = true;
    generateBtn.disabled = false;
    resetViewBtn.disabled = false;
    currentMeta = { name: splitDirBase(mainFile).base, mainFile, files: items.map((it) => it.relativePath) };
    imageLoaded = false;
    setStatus(`Loaded ${mainFile}`);
    updateModeUI();
  };

  const onError = (err) => {
    console.error(err);
    setStatus(`Failed to load ${mainFile}: ${err.message || err}`, true);
  };

  try {
    if (extension === 'glb' || extension === 'gltf') {
      new GLTFLoader(manager).load(mainFile, (gltf) => onLoaded(gltf.scene), undefined, onError);
    } else if (extension === 'obj') {
      // Assumes the .mtl lives alongside the .obj, which is the near-universal convention.
      const mtlItem = items.find((it) => ext(it.relativePath) === 'mtl');
      if (mtlItem) {
        new MTLLoader(manager).load(
          mtlItem.relativePath,
          (materials) => {
            materials.preload();
            const objLoader = new OBJLoader(manager);
            objLoader.setMaterials(materials);
            objLoader.load(mainFile, onLoaded, undefined, onError);
          },
          undefined,
          onError
        );
      } else {
        new OBJLoader(manager).load(mainFile, onLoaded, undefined, onError);
      }
    } else if (extension === 'fbx') {
      new FBXLoader(manager).load(mainFile, onLoaded, undefined, onError);
    } else if (extension === 'stl') {
      new STLLoader(manager).load(mainFile, (geometry) => {
        const material = new THREE.MeshStandardMaterial({ color: 0x9aa5c9, metalness: 0.1, roughness: 0.7 });
        onLoaded(new THREE.Mesh(geometry, material));
      }, undefined, onError);
    } else {
      onError(new Error(`Unsupported file type: .${extension}`));
    }
  } catch (err) {
    onError(err);
  }
}

// ---------- Image loading ----------
function loadImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please choose an image file (.png, .jpg, .webp, …).', true);
    return;
  }

  clearCurrentModel();
  revokeModelBlobUrls();
  revokeImageBlobUrl();
  imageBlobUrl = URL.createObjectURL(file);
  currentMeta = { name: file.name, mainFile: file.name, files: [file.name] };

  imagePreview.onload = () => {
    viewerPlaceholder.hidden = true;
    imagePreview.hidden = false;
    generateBtn.disabled = false;
    imageLoaded = true;
    updateModeUI();
  };
  imagePreview.onerror = () => {
    setStatus(`Failed to load ${file.name}`, true);
  };
  imagePreview.src = imageBlobUrl;
  setStatus(`Loaded ${file.name}`);
}

// ---------- Tabs ----------
function switchInputTab(tab) {
  activeInput = tab;
  tabModelBtn.classList.toggle('active', tab === 'model');
  tabModelBtn.setAttribute('aria-selected', String(tab === 'model'));
  tabImageBtn.classList.toggle('active', tab === 'image');
  tabImageBtn.setAttribute('aria-selected', String(tab === 'image'));

  modelDropzone.hidden = tab !== 'model';
  imageDropzone.hidden = tab !== 'image';
  modelModeFieldset.hidden = tab !== 'model';
  imageModeFieldset.hidden = tab !== 'image';
  resetViewBtn.hidden = tab !== 'model';

  const loaded = tab === 'model' ? !!currentModel : imageLoaded;

  canvas.hidden = tab !== 'model';
  imagePreview.hidden = !(tab === 'image' && imageLoaded);

  viewerPlaceholder.hidden = loaded;
  viewerPlaceholder.textContent = tab === 'model' ? 'No model loaded yet' : 'No image uploaded yet';
  generateBtn.disabled = !loaded;

  hideResult();
  setResultNote('');
  setStatus('');
  updateModeUI();
}

tabModelBtn.addEventListener('click', () => switchInputTab('model'));
tabImageBtn.addEventListener('click', () => switchInputTab('image'));

// ---------- Output generation ----------
const MODEL_MODE_LABELS = {
  depth: { button: 'Generate depth map' },
  canny: { button: 'Generate Canny edges' },
  pose: { button: 'Generate pose skeleton' },
};
const IMAGE_MODE_LABELS = {
  depth: { button: 'Generate depth map' },
  canny: { button: 'Generate Canny edges' },
  pose: { button: 'Generate pose skeleton' },
};
const OUTPUT_ALT = {
  depth: 'Generated depth map',
  canny: 'Generated Canny edge map',
  pose: 'Generated pose skeleton map',
};

function currentModelMode() {
  return document.querySelector('input[name="modelMode"]:checked').value;
}
function currentImageMode() {
  return document.querySelector('input[name="imageMode"]:checked').value;
}
function currentResolution() {
  return Number(resolutionSelect.value);
}

function updateModeUI() {
  if (activeInput === 'model') {
    generateBtn.textContent = MODEL_MODE_LABELS[currentModelMode()].button;
  } else {
    generateBtn.textContent = IMAGE_MODE_LABELS[currentImageMode()].button;
  }
}
document.querySelectorAll('input[name="modelMode"]').forEach((r) => r.addEventListener('change', updateModeUI));
document.querySelectorAll('input[name="imageMode"]').forEach((r) => r.addEventListener('change', updateModeUI));

// Renders the scene (optionally with an override material) into an
// offscreen target at the requested resolution and returns it as a 2D
// canvas, flipped right-side-up. Shared by the depth and Canny passes.
function captureSceneRender({ material = null, clearColor = 0x000000, size }) {
  const renderTarget = new THREE.WebGLRenderTarget(size, size);
  // scene.background (used for the on-screen theme) takes precedence over
  // the renderer's own clear color, so swap it out for the capture too.
  const prevBackground = scene.background;

  scene.overrideMaterial = material;
  scene.background = new THREE.Color(clearColor);
  renderer.setRenderTarget(renderTarget);
  renderer.render(scene, camera);

  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(renderTarget, 0, 0, size, size, pixels);

  renderer.setRenderTarget(null);
  scene.overrideMaterial = null;
  scene.background = prevBackground;
  renderTarget.dispose();

  const outCanvas = document.createElement('canvas');
  outCanvas.width = size;
  outCanvas.height = size;
  const ctx = outCanvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  // WebGL reads bottom-to-top; flip rows so the image reads top-to-bottom.
  for (let y = 0; y < size; y++) {
    const srcRow = size - y - 1;
    imageData.data.set(pixels.subarray(srcRow * size * 4, (srcRow + 1) * size * 4), y * size * 4);
  }
  ctx.putImageData(imageData, 0, 0);
  return { canvas: outCanvas, ctx, imageData };
}

// A near plane based purely on "distance to the model's bounding-sphere
// center" collapses to a razor-thin absolute floor once the camera is
// zoomed in closer than ~1.5x the model's radius (or ends up inside the
// model entirely) — far stays large, so the near:far ratio explodes and
// WebGL's non-linear depth buffer loses virtually all precision for
// geometry that's actually much farther away than that tiny floor. The
// whole capture then renders solid black. Raycasting across the view
// frustum for the nearest actually-visible surface gives a near plane that
// tracks the real geometry instead, regardless of zoom level.
function estimateNearestVisibleDistance(camera, object) {
  const originalSides = [];
  object.traverse((o) => {
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        originalSides.push([m, m.side]);
        m.side = THREE.DoubleSide; // so a hit registers even from inside the mesh
      });
    }
  });

  const raycaster = new THREE.Raycaster();
  const samples = [
    [0, 0],
    [0.8, 0.8], [-0.8, 0.8], [0.8, -0.8], [-0.8, -0.8],
    [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8],
  ];
  let minHit = Infinity;
  samples.forEach(([nx, ny]) => {
    raycaster.setFromCamera({ x: nx, y: ny }, camera);
    const hits = raycaster.intersectObject(object, true);
    if (hits.length > 0) minHit = Math.min(minHit, hits[0].distance);
  });

  originalSides.forEach(([m, side]) => {
    m.side = side;
  });

  return Number.isFinite(minHit) ? minHit : null;
}

// Safety net on top of the near-plane fix above: stretch the rendered
// depth values to fill the full 0-255 range, so even a tighter-than-ideal
// near/far estimate still yields a clearly visible result.
function autoContrastStretch(imageData) {
  const data = imageData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max <= min) return;
  const range = max - min;
  for (let i = 0; i < data.length; i += 4) {
    const stretched = Math.round(((data[i] - min) / range) * 255);
    data[i] = data[i + 1] = data[i + 2] = stretched;
  }
}

function generateDepthMap() {
  const box = new THREE.Box3().setFromObject(currentModel);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const camDist = camera.position.distanceTo(sphere.center);
  const radius = Math.max(sphere.radius, 0.001);

  const nearestHit = estimateNearestVisibleDistance(camera, currentModel);
  const radiusFloor = Math.max(radius * 0.001, 1e-4);
  const estimatedNear = nearestHit !== null ? nearestHit * 0.5 : camDist - radius * 1.5;

  camera.near = Math.max(radiusFloor, estimatedNear);
  camera.far = Math.max(camera.near * 2, camDist + radius * 1.5);
  camera.updateProjectionMatrix();

  const size = currentResolution();
  const { canvas: outCanvas, ctx, imageData } = captureSceneRender({ material: depthMaterial, clearColor: 0x000000, size });
  autoContrastStretch(imageData);
  ctx.putImageData(imageData, 0, 0);

  camera.near = baseNear;
  camera.far = baseFar;
  camera.updateProjectionMatrix();

  setResultNote(`Depth map rendered at ${size}×${size}.`);
  showResult(outCanvas.toDataURL('image/png'), 'depth');
}

function generateModelCannyMap() {
  const size = currentResolution();
  setResultNote('Processing Canny edges…');
  // Defer one frame so the status text paints before the blocking pass runs.
  requestAnimationFrame(() => {
    const { canvas: outCanvas, ctx, imageData } = captureSceneRender({ material: null, clearColor: 0xffffff, size });
    const edges = cannyEdgeDetection(imageData, { lowThreshold: 30, highThreshold: 90 });
    ctx.putImageData(edges, 0, 0);
    setResultNote(`Canny edge map rendered at ${size}×${size}.`);
    showResult(outCanvas.toDataURL('image/png'), 'canny');
  });
}

function generatePoseMap() {
  const size = currentResolution();
  const skeleton = extractSkeleton(currentModel);

  if (!skeleton.found) {
    setResultNote("This model has no rig/skeleton, so a pose map isn't available. Try an .fbx or a rigged .glb character.", true);
    hideResult();
    return;
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = size;
  outCanvas.height = size;
  const ctx = outCanvas.getContext('2d');

  const drawn = drawPoseSkeleton(ctx, skeleton.joints, camera, size, size);

  if (drawn === 0) {
    if (skeleton.boneLines.length === 0) {
      setResultNote('No recognizable joints or bones were found in this rig.', true);
      hideResult();
      return;
    }
    drawGenericSkeleton(ctx, skeleton.boneLines, camera, size, size);
    setResultNote("This rig's bone names weren't recognized, so the raw bone hierarchy is shown instead of a standard pose skeleton.");
  } else {
    setResultNote(`Pose skeleton generated from ${drawn} detected limb link(s) at ${size}×${size}.`);
  }

  showResult(outCanvas.toDataURL('image/png'), 'pose');
}

function generateImageCanny() {
  const size = currentResolution();
  const { canvas: canvasEl, ctx } = buildSquareCanvas(imagePreview, size, '#000');
  const imageData = ctx.getImageData(0, 0, size, size);
  const edges = cannyEdgeDetection(imageData, { lowThreshold: 30, highThreshold: 90 });
  ctx.putImageData(edges, 0, 0);
  setResultNote(`Canny edge map rendered at ${size}×${size}.`);
  showResult(canvasEl.toDataURL('image/png'), 'canny');
}

// Monocular depth estimation is loaded lazily via transformers.js, running
// a small pretrained Depth Anything model fully client-side (downloaded
// once and cached by the browser). Unlike the 3D model's depth map — which
// reads the real geometric depth buffer — this is a learned estimate from
// a single 2D photo.
let depthEstimatorPromise = null;
function ensureDepthEstimator() {
  if (!depthEstimatorPromise) {
    depthEstimatorPromise = (async () => {
      const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      return pipeline('depth-estimation', 'Xenova/depth-anything-small-hf');
    })();
  }
  return depthEstimatorPromise;
}

async function generateImageDepth() {
  setResultNote('Loading depth model (first run only, downloads ~25MB)…');
  generateBtn.disabled = true;
  try {
    const estimator = await ensureDepthEstimator();
    setResultNote('Estimating depth…');

    // Feed the estimator the already-letterboxed square image, so its
    // output comes back at (or very near) the target size directly.
    const size = currentResolution();
    const { canvas: squareSource } = buildSquareCanvas(imagePreview, size, '#000');
    const output = await estimator(squareSource.toDataURL('image/png'));
    const depthImg = output.depth;
    const dw = depthImg.width;
    const dh = depthImg.height;
    const channels = depthImg.channels || 1;
    const src = depthImg.data;

    const rawCanvas = document.createElement('canvas');
    rawCanvas.width = dw;
    rawCanvas.height = dh;
    const rawCtx = rawCanvas.getContext('2d');
    const imageData = rawCtx.createImageData(dw, dh);
    for (let p = 0, i = 0; p < dw * dh; p++, i += channels) {
      const v = src[i];
      imageData.data[p * 4] = v;
      imageData.data[p * 4 + 1] = v;
      imageData.data[p * 4 + 2] = v;
      imageData.data[p * 4 + 3] = 255;
    }
    rawCtx.putImageData(imageData, 0, 0);

    // Guard against the model returning slightly different dimensions than
    // requested — the final output is always exactly size×size.
    const canvasEl = document.createElement('canvas');
    canvasEl.width = size;
    canvasEl.height = size;
    canvasEl.getContext('2d').drawImage(rawCanvas, 0, 0, size, size);

    setResultNote(`Depth map estimated at ${size}×${size}.`);
    showResult(canvasEl.toDataURL('image/png'), 'depth');
  } catch (err) {
    console.error(err);
    setResultNote(`Depth estimation failed: ${err.message || err}`, true);
  } finally {
    generateBtn.disabled = false;
  }
}

// 2D pose detection is loaded lazily via a pretrained MoveNet model
// (downloaded once and cached by the browser). The skeleton is drawn in the
// standard OpenPose COCO-18 layout — a "neck" hub (synthesized as the
// shoulder midpoint, since MoveNet's 17 COCO keypoints don't include one)
// that both arms, both legs, and the head all branch from — rather than a
// shoulder-to-shoulder / hip-to-hip ladder, so it reads the same way as
// OpenPose ControlNet conditioning images (SD1.5 openpose models expect
// this exact topology).
//
// Body links (torso/arms/legs) are what actually reads as a "stick figure".
// Face links (neck-nose-eyes-ears) are drawn too when present, but on their
// own they're just a couple of dots close together — for a headshot crop
// with no torso visible, that reads as "nothing happened" even though a
// low-value face link technically got drawn. So face links only count as a
// bonus on top of at least one real body link.
const BODY_POSE_CONNECTIONS = [
  ['neck', 'right_shoulder'],
  ['neck', 'left_shoulder'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['neck', 'right_hip'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  ['neck', 'left_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
];
const FACE_POSE_CONNECTIONS = [
  ['neck', 'nose'],
  ['nose', 'left_eye'],
  ['nose', 'right_eye'],
  ['left_eye', 'left_ear'],
  ['right_eye', 'right_ear'],
];
const KEYPOINT_SCORE_THRESHOLD = 0.3;

// MoveNet has no "neck" keypoint — OpenPose's is the shoulder midpoint, so
// it's synthesized here. Falls back to whichever single shoulder is visible
// if only one is, so a partially-turned body still gets a partial skeleton
// instead of the whole hub (and everything hanging off it) disappearing.
function withSyntheticNeck(keypoints) {
  const byName = {};
  keypoints.forEach((kp) => {
    byName[kp.name] = kp;
  });
  const ls = byName.left_shoulder;
  const rs = byName.right_shoulder;
  const lsOk = ls && ls.score >= KEYPOINT_SCORE_THRESHOLD;
  const rsOk = rs && rs.score >= KEYPOINT_SCORE_THRESHOLD;
  if (lsOk && rsOk) {
    byName.neck = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2, score: Math.min(ls.score, rs.score) };
  } else if (lsOk) {
    byName.neck = { x: ls.x, y: ls.y, score: ls.score };
  } else if (rsOk) {
    byName.neck = { x: rs.x, y: rs.y, score: rs.score };
  } else {
    byName.neck = null;
  }
  return byName;
}

let poseDetectorPromise = null;
function ensurePoseDetector() {
  if (!poseDetectorPromise) {
    poseDetectorPromise = (async () => {
      await loadScriptOnce('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js');
      await loadScriptOnce('https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js');
      return window.poseDetection.createDetector(window.poseDetection.SupportedModels.MoveNet, {
        modelType: window.poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      });
    })();
  }
  return poseDetectorPromise;
}

// Pure drawing helper (no model/network dependency) so it can be unit-tested
// with fabricated keypoints. Returns counts describing what was actually drawn.
function drawImagePoseKeypoints(ctx, poses, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  const lineWidth = Math.max(2, w * 0.006);
  const jointRadius = Math.max(3, w * 0.008);
  ctx.lineCap = 'round';

  let bodyLinks = 0;
  let faceLinks = 0;
  let personsWithBody = 0;

  poses.forEach((pose) => {
    const byName = withSyntheticNeck(pose.keypoints);

    const drawLinks = (connections, hueOffset) => {
      let drawn = 0;
      connections.forEach(([a, b], i) => {
        const ka = byName[a];
        const kb = byName[b];
        if (!ka || !kb || ka.score < KEYPOINT_SCORE_THRESHOLD || kb.score < KEYPOINT_SCORE_THRESHOLD) return;
        ctx.strokeStyle = `hsl(${(hueOffset + i * 24) % 360}, 100%, 55%)`;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(ka.x, ka.y);
        ctx.lineTo(kb.x, kb.y);
        ctx.stroke();
        drawn++;
      });
      return drawn;
    };

    const bodyDrawn = drawLinks(BODY_POSE_CONNECTIONS, 0);
    bodyLinks += bodyDrawn;
    // Face links only get drawn (and counted) when there's at least one real
    // body link too — on their own they're just two dots a few pixels apart.
    if (bodyDrawn > 0) {
      personsWithBody++;
      faceLinks += drawLinks(FACE_POSE_CONNECTIONS, 200);
      Object.values(byName).forEach((kp) => {
        if (!kp || kp.score < KEYPOINT_SCORE_THRESHOLD) return;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, jointRadius, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  });

  return { bodyLinks, faceLinks, personsWithBody, personCount: poses.length };
}

async function generateImagePoseDetection() {
  setResultNote('Loading pose model (first run only)…');
  generateBtn.disabled = true;
  try {
    const detector = await ensurePoseDetector();
    setResultNote('Detecting pose…');

    // estimatePoses() reads an <img> element's DOM .width/.height (its
    // CSS-rendered display size) rather than .naturalWidth/.naturalHeight,
    // so keypoints come back in the wrong coordinate space for an element
    // styled with width:100%/height:100% like imagePreview. Feeding it a
    // plain canvas sidesteps that ambiguity entirely — a canvas's pixel
    // dimensions are never in question. Using the letterboxed square
    // version also means the returned keypoints already land in the same
    // size×size coordinate space the skeleton gets drawn into.
    const size = currentResolution();
    const { canvas: sourceCanvas } = buildSquareCanvas(imagePreview, size, '#000');

    const poses = await detector.estimatePoses(sourceCanvas);

    if (poses.length === 0) {
      setResultNote('No person detected in this image.', true);
      hideResult();
      return;
    }

    const canvasEl = document.createElement('canvas');
    canvasEl.width = size;
    canvasEl.height = size;
    const ctx = canvasEl.getContext('2d');

    const { bodyLinks, faceLinks, personsWithBody, personCount } = drawImagePoseKeypoints(ctx, poses, size, size);

    if (personsWithBody === 0) {
      setResultNote(
        "Only facial features were detected — no shoulders, arms, or legs are visible in this photo, so there's no body pose to draw. Try a photo that shows more of the person.",
        true
      );
      hideResult();
      return;
    }

    const parts = [`${bodyLinks} body limb link(s)`];
    if (faceLinks > 0) parts.push(`${faceLinks} face link(s)`);
    setResultNote(`Pose skeleton detected for ${personsWithBody} of ${personCount} person(s) — ${parts.join(', ')} at ${size}×${size}.`);
    showResult(canvasEl.toDataURL('image/png'), 'pose');
  } catch (err) {
    console.error(err);
    setResultNote(`Pose detection failed: ${err.message || err}`, true);
  } finally {
    generateBtn.disabled = false;
  }
}

// Scripts for the lazily-loaded ML models below are fetched once and cached.
const loadedScripts = new Map();
function loadScriptOnce(src) {
  if (!loadedScripts.has(src)) {
    loadedScripts.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
      })
    );
  }
  return loadedScripts.get(src);
}

function generateOutput() {
  if (activeInput === 'model') {
    if (!currentModel) return;
    const mode = currentModelMode();
    if (mode === 'depth') generateDepthMap();
    else if (mode === 'canny') generateModelCannyMap();
    else generatePoseMap();
  } else {
    if (!imageLoaded) return;
    const mode = currentImageMode();
    if (mode === 'depth') generateImageDepth();
    else if (mode === 'canny') generateImageCanny();
    else generateImagePoseDetection();
  }
}

function showResult(dataUrl, kind) {
  resultImage.src = dataUrl;
  resultImage.alt = OUTPUT_ALT[kind] || 'Generated output';
  resultImage.hidden = false;
  resultPlaceholder.hidden = true;
  downloadBtn.href = dataUrl;
  const mainBasename = currentMeta ? splitDirBase(currentMeta.mainFile).base : 'output';
  const baseName = mainBasename.replace(/\.[^.]+$/, '');
  downloadBtn.download = `${baseName}-${kind}.png`;
  downloadBtn.hidden = false;
}

function hideResult() {
  resultImage.hidden = true;
  resultPlaceholder.hidden = false;
  downloadBtn.hidden = true;
}

// ---------- Model file collection ----------
// Each item is { file: File, relativePath: string }. relativePath preserves
// any subfolder structure (e.g. "textures/base.png") so glTF/OBJ resources
// referenced relative to the model file keep resolving — see loadModelFromItems.
function filesToItems(fileList) {
  return Array.from(fileList).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

// Recursively walk a dropped folder (DataTransferItem -> FileSystemEntry),
// preserving relative paths the same way <input webkitdirectory> does.
function readEntryAsFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
function readDirEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await readEntryAsFile(entry);
    out.push({ file, relativePath: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await readDirEntries(reader);
      for (const child of batch) {
        await walkEntry(child, `${prefix}${entry.name}/`, out);
      }
    } while (batch.length > 0);
  }
}
async function collectDroppedItems(dataTransfer) {
  const items = dataTransfer.items;
  const hasEntrySupport = items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function';
  if (!hasEntrySupport) {
    return filesToItems(dataTransfer.files);
  }
  const entries = [...items].map((item) => item.webkitGetAsEntry()).filter(Boolean);
  if (entries.length === 0) return filesToItems(dataTransfer.files);
  const out = [];
  for (const entry of entries) {
    await walkEntry(entry, '', out);
  }
  return out;
}

// ---------- Event wiring ----------
modelDropzone.addEventListener('click', () => fileInput.click());
modelDropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => loadModelFromItems(filesToItems(fileInput.files)));

browseFolderBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  folderInput.click();
});
folderInput.addEventListener('change', () => loadModelFromItems(filesToItems(folderInput.files)));

['dragenter', 'dragover'].forEach((evt) =>
  modelDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    modelDropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  modelDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    modelDropzone.classList.remove('dragover');
  })
);
modelDropzone.addEventListener('drop', async (e) => {
  const items = await collectDroppedItems(e.dataTransfer);
  if (items.length) loadModelFromItems(items);
});

imageDropzone.addEventListener('click', () => imageInput.click());
imageDropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    imageInput.click();
  }
});
imageInput.addEventListener('change', () => {
  if (imageInput.files[0]) loadImageFromFile(imageInput.files[0]);
});
['dragenter', 'dragover'].forEach((evt) =>
  imageDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    imageDropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  imageDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    imageDropzone.classList.remove('dragover');
  })
);
imageDropzone.addEventListener('drop', (e) => {
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (file) loadImageFromFile(file);
});

resetViewBtn.addEventListener('click', () => {
  if (currentModel) frameObject(currentModel);
});

generateBtn.addEventListener('click', generateOutput);

// ---------- Startup ----------
// Everything lives in memory as blob: URLs for the life of the tab — there's
// no backend to persist a session across reloads, so each load starts fresh.
initTheme();
switchInputTab('model');
