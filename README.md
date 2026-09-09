# Control Map Studio

Upload a 3D model or an image — one at a time — and generate depth, Canny edge, or pose-skeleton control maps. Runs entirely in the browser: no backend, no build step, no server-side storage. Everything (model/image loading, edge detection, depth estimation, pose detection) happens client-side, so it works as a plain static site — including on GitHub Pages.

## Tech stack

**Core** — plain HTML5, CSS3, and vanilla JavaScript (ES modules). No framework, no bundler, no build step, no npm dependencies of any kind — every library is loaded from a CDN at runtime.

**3D rendering** — [three.js](https://threejs.org/) `0.160.0` (via jsdelivr CDN), specifically:
- `WebGLRenderer`, `PerspectiveCamera`, `WebGLRenderTarget` — the core render/capture pipeline
- `OrbitControls` — rotate/pan/zoom
- `GLTFLoader`, `OBJLoader` + `MTLLoader`, `FBXLoader`, `STLLoader` — model format support
- `LoadingManager` with a custom `setURLModifier` — resolves multi-file models (textures, `.bin` buffers) against in-memory blob URLs instead of a server
- `MeshDepthMaterial` (`BasicDepthPacking`) — the geometric depth-map render
- `RoomEnvironment` + `PMREMGenerator` — a neutral studio environment map so PBR/metallic materials get reflections instead of rendering solid black
- `Raycaster` — used to find the nearest actually-visible surface for correct depth-map near-plane placement, especially when the camera is zoomed in close or inside the model

**Machine learning models** (all client-side inference, loaded lazily from a CDN on first use and cached by the browser after that — nothing runs server-side, there is no server):
- **[Depth Anything](https://huggingface.co/Xenova/depth-anything-small-hf)** (`Xenova/depth-anything-small-hf`) via [🤗 Transformers.js](https://github.com/xenova/transformers.js) `2.17.2` — monocular depth estimation for uploaded images
- **[MoveNet](https://www.tensorflow.org/hub/tutorials/movenet)** (SINGLEPOSE_LIGHTNING) via [TensorFlow.js](https://www.tensorflow.org/js) `4.20.0` + `@tensorflow-models/pose-detection` `2.1.3` — 2D human pose keypoint detection for uploaded images

**Hand-implemented algorithms** (no library — original code in this repo):
- **Canny edge detector** (`canny.js`) — grayscale conversion → Gaussian blur → Sobel gradients → non-maximum suppression → hysteresis thresholding → dilation for line thickness. Used for both 3D-model and image edge maps.
- **Rig/skeleton mapper** (`pose.js`) — maps arbitrary bone names (Mixamo, VRM / Ready Player Me / Unity Humanoid conventions) to canonical joints for 3D models, and renders both the 3D and image pose results in the standard OpenPose COCO-18 topology (a synthesized neck hub, matching what SD1.5/SDXL OpenPose ControlNet models expect).

**Browser APIs relied on** — `File`/`Blob`/`URL.createObjectURL`, the HTML5 Drag-and-Drop API (`DataTransferItem`/`FileSystemEntry`, for whole-folder model uploads), `Canvas2D`, `ResizeObserver`, and `localStorage` (theme preference only — no other state persists).

**Hosting** — static files only; no server, no database, no environment variables, no secrets. Works from GitHub Pages, any static host, or a local static file server.

## Deploying to GitHub Pages

This repo's root **is** the site — no `/docs` folder, no build step.

1. Push these files to your repo (`main` branch is fine).
2. On GitHub: **Settings → Pages → Source** → "Deploy from a branch" → **Branch: `main`**, folder **`/ (root)`** → Save.
3. GitHub gives you a URL like `https://<username>.github.io/<repo-name>/` — it can take a minute or two after the first push to go live.

That's the whole setup. No secrets, no Actions workflow, no environment variables needed.

## Files to upload

Everything at the repo root — this is the entire site:

```
index.html
style.css
app.js
canny.js
pose.js
.nojekyll
.gitignore
README.md
```

`.nojekyll` is an empty file that tells GitHub Pages not to run its default Jekyll processing (unnecessary for a plain static site, and Jekyll's handling of files could otherwise interfere). `.gitignore` and `README.md` aren't required for the site to work, but are normal to keep in the repo.

Nothing else in the working folder should be uploaded — see below.

## How it works

- Two input modes, switched via the tabs at the top of the upload panel: **3D Model** and **Image**. Only one is kept "current" at a time; loading a new one replaces whatever was there. Uploaded files are read directly in the browser (`URL.createObjectURL`) and never leave your machine — there's nowhere for them to go, since there's no server.
- A dropped/selected model folder (e.g. a glTF with a separate `scene.bin` and a `textures/` folder) is handled via a `THREE.LoadingManager` with a custom `setURLModifier`: every file becomes a blob URL, and the loader's own relative-path resolution (e.g. `textures/base.png`) transparently maps to the right blob — the same mechanism a real static file server would provide, just done in memory.
- The frontend (plain HTML/CSS/JS + [three.js](https://threejs.org/) via CDN) renders an uploaded model with `OrbitControls` so you can freely rotate/zoom/pan it. Lighting is fixed (a hemisphere fill + one directional light, plus a neutral studio environment map for PBR reflections) — no manual light rig, just enough to see the geometry clearly.

Both input modes offer the same three output types, though how each is produced differs since a 3D model has known geometry and an image doesn't:

- **Depth map** — for a model, re-renders the current camera view with `THREE.MeshDepthMaterial` and reads back the real depth buffer (white = near, black = far; no AI/ML model needed, since the exact geometry is known). The near clip plane is picked by raycasting the nearest actually-visible surface (not just "distance to the model's overall center") and the result is auto-contrast-stretched, so a tightly zoomed-in shot — or the camera ending up inside the model — still renders a properly visible result instead of a razor-thin depth range that collapses to solid black. For an image, runs a small pretrained monocular depth-estimation model (Depth Anything, via `transformers.js`, loaded lazily from a CDN and cached by the browser after first use) to *estimate* depth from a single 2D photo.
- **Canny edges** — a real Canny edge detector (Gaussian blur → Sobel gradients → non-max suppression → hysteresis thresholding) client-side in `canny.js`, run either on the model's current lit view or directly on an uploaded image. Non-max suppression naturally thins detected edges to 1px, so a dilation pass thickens them back up to 3px by default.
- **Pose skeleton** — for a model, walks its rig (if it has one) in `pose.js`, maps bone names from common conventions (Mixamo, VRM / Ready Player Me / Unity Humanoid) to canonical joints, and draws an OpenPose-style stick figure by projecting joints into the current camera view; falls back to the raw bone hierarchy if names aren't recognized, or a clear message if there's no rig at all. For an image, runs a pretrained 2D pose-detection model (MoveNet, via TensorFlow.js, loaded lazily) to detect a person's keypoints in the photo, then draws them in the standard OpenPose COCO-18 layout (SD1.5/SDXL OpenPose ControlNet's expected format) — a synthesized "neck" hub joining the head, both arms, and both legs, rather than a shoulder-to-shoulder/hip-to-hip ladder. Needs enough of the body visible to draw a real stick figure — a headshot only yields a couple of tiny, meaningless face-to-face links, so those are only drawn as a bonus on top of at least one real body link; with no body visible, it reports that clearly instead of drawing a near-invisible result. Also reports if no person is found at all.

Output resolution is selectable for both input modes (1024 / 2048 / 4096), and every generated output is always exactly square at that resolution. For an image that isn't already square, it's letterboxed (contain-fit, centered, black-padded) into the square before depth/Canny/pose runs — so the full image is preserved, nothing gets cropped out.

Light/dark theme (icon-only toggle, top right), respecting system preference by default and persisted to `localStorage`.

Supported model formats: `.glb`, `.gltf`, `.obj` (+ `.mtl` + textures, upload them together), `.fbx`, `.stl`. Pose skeletons require a skinned/rigged model (glTF or FBX with bones) — static meshes (like a plain OBJ or STL) will report that no rig was found. Supported image formats: anything a browser `<img>` can decode (PNG, JPEG, WebP, …).

If a `.gltf`/`.obj` references sibling resources in subfolders (e.g. Sketchfab-style exports with `scene.bin` and a `textures/` folder), either drag-and-drop the whole model folder or use "select the folder instead" — this preserves the relative paths so the referenced resources resolve correctly.

**Nothing is saved anywhere** — reloading the page clears whatever's loaded. Use the **Download PNG** button to keep a generated result; there's no server to persist it to.

## Running locally

Any static file server works — ES modules need to be served over `http://`, not opened directly as a `file://` URL. For example:

```bash
npx serve .
```

or, with Python:

```bash
python -m http.server 8000
```

Then open the printed local URL. No `npm install` is required — this project has no dependencies at all.

## What's *not* uploaded

A local working copy of this project may also contain a `server/` folder and `node_modules/` from an earlier version that used a Node/Express backend for file uploads. That backend is gone — everything now runs client-side, which is what makes GitHub Pages hosting possible in the first place. Neither is needed, referenced, or should be pushed to GitHub (both are excluded in `.gitignore`).
