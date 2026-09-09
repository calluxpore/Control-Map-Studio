import * as THREE from 'three';

// Best-effort bone-name -> canonical joint mapping, covering common rig
// conventions (Mixamo, VRM / Ready Player Me / Unity Humanoid).
// A bone's own world position is the joint at its *proximal* end, which
// lines up with how these joints are meant to be read (e.g. the "LeftArm"
// bone's origin is the shoulder joint; "LeftForeArm" origin is the elbow).
const JOINT_RULES = [
  { key: 'elbow', pattern: /forearm|lowerarm/i },
  { key: 'shoulder', pattern: /arm/i },
  { key: 'wrist', pattern: /hand(?!.*(thumb|index|middle|ring|pinky|finger))/i },
  { key: 'hip', pattern: /upleg|upperleg/i },
  { key: 'knee', pattern: /leg/i },
  { key: 'ankle', pattern: /foot(?!.*toe)/i },
  { key: 'head', pattern: /head(?!.*(top|eye|jaw))/i },
  { key: 'neck', pattern: /neck/i },
  { key: 'hips', pattern: /^hips$|pelvis/i },
  { key: 'chest', pattern: /spine2|chest|upperchest/i },
];

function stripPrefix(name) {
  return name.replace(/^mixamorig[:_]?/i, '').replace(/^j_bip_[clr]_/i, '');
}

function sideOf(name) {
  const n = stripPrefix(name);
  if (/left|_l$|\.l$|^l[_.]/i.test(n)) return 'left';
  if (/right|_r$|\.r$|^r[_.]/i.test(n)) return 'right';
  return null;
}

function classify(boneName) {
  const n = stripPrefix(boneName);
  for (const rule of JOINT_RULES) {
    if (rule.pattern.test(n)) return rule.key;
  }
  return null;
}

/**
 * Walk the object graph, find any skinned meshes, and build a canonical
 * joint map (worldPosition per named joint) plus the raw bone list for a
 * generic fallback skeleton drawing.
 */
export function extractSkeleton(root) {
  const bones = new Map(); // name -> THREE.Bone
  root.traverse((obj) => {
    if (obj.isSkinnedMesh && obj.skeleton) {
      obj.skeleton.bones.forEach((b) => bones.set(b.uuid, b));
    } else if (obj.isBone && !bones.has(obj.uuid)) {
      // Some rigs attach bones outside a SkinnedMesh's own skeleton list.
    }
  });

  if (bones.size === 0) {
    return { found: false, joints: {}, boneLines: [] };
  }

  const boneList = [...bones.values()];
  const joints = {}; // canonicalKey -> Vector3
  let matched = 0;

  for (const bone of boneList) {
    const side = sideOf(bone.name);
    const key = classify(bone.name);
    if (!key) continue;
    const canonicalKey = side ? `${side}${key[0].toUpperCase()}${key.slice(1)}` : key;
    if (joints[canonicalKey]) continue; // keep first match
    joints[canonicalKey] = bone.getWorldPosition(new THREE.Vector3());
    matched++;
  }

  // Neck fallback: midpoint of shoulders if no explicit Neck bone.
  if (!joints.neck && joints.leftShoulder && joints.rightShoulder) {
    joints.neck = joints.leftShoulder.clone().add(joints.rightShoulder).multiplyScalar(0.5);
  }

  const boneLines = boneList
    .filter((b) => b.parent && b.parent.isBone)
    .map((b) => [b.parent.getWorldPosition(new THREE.Vector3()), b.getWorldPosition(new THREE.Vector3())]);

  return { found: true, matched, joints, boneLines };
}

// [fromKey, toKey, hue] — hue drives an HSL rainbow palette like OpenPose's.
const SKELETON_LINKS = [
  ['hips', 'neck', 0],
  ['neck', 'head', 20],
  ['neck', 'leftShoulder', 40],
  ['leftShoulder', 'leftElbow', 60],
  ['leftElbow', 'leftWrist', 80],
  ['neck', 'rightShoulder', 100],
  ['rightShoulder', 'rightElbow', 120],
  ['rightElbow', 'rightWrist', 140],
  ['hips', 'leftHip', 160],
  ['leftHip', 'leftKnee', 180],
  ['leftKnee', 'leftAnkle', 200],
  ['hips', 'rightHip', 220],
  ['rightHip', 'rightKnee', 240],
  ['rightKnee', 'rightAnkle', 260],
];

function project(vec3, camera, width, height) {
  const p = vec3.clone().project(camera);
  return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height };
}

/**
 * Draw an OpenPose-style stick figure onto a 2D canvas context.
 * Returns the number of limb links actually drawn.
 */
export function drawPoseSkeleton(ctx, joints, camera, width, height) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const lineWidth = Math.max(2, width * 0.006);
  const jointRadius = Math.max(3, width * 0.008);
  let drawn = 0;

  ctx.lineCap = 'round';
  for (const [fromKey, toKey, hue] of SKELETON_LINKS) {
    const a = joints[fromKey];
    const b = joints[toKey];
    if (!a || !b) continue;
    const pa = project(a, camera, width, height);
    const pb = project(b, camera, width, height);
    ctx.strokeStyle = `hsl(${hue}, 100%, 55%)`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    drawn++;
  }

  for (const key of Object.keys(joints)) {
    const p = project(joints[key], camera, width, height);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  return drawn;
}

/** Fallback: draw the raw bone hierarchy when names don't match a known rig. */
export function drawGenericSkeleton(ctx, boneLines, camera, width, height) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  const lineWidth = Math.max(2, width * 0.005);
  ctx.strokeStyle = '#5b8cff';
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';

  for (const [from, to] of boneLines) {
    const pa = project(from, camera, width, height);
    const pb = project(to, camera, width, height);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  const jointRadius = Math.max(3, width * 0.007);
  ctx.fillStyle = '#fff';
  for (const [, to] of boneLines) {
    const p = project(to, camera, width, height);
    ctx.beginPath();
    ctx.arc(p.x, p.y, jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}
