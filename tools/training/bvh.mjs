// Minimal BVH reader + forward kinematics, and projection of a 3D skeleton to
// the app's 17 MoveNet/COCO keypoints as seen from a chosen camera view.
import fs from 'node:fs';

export function parseBVH(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const joints = [];
  const stack = [];
  let channelsTotal = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim().split(/\s+/);
    if (t[0] === 'ROOT' || t[0] === 'JOINT') {
      const j = { name: t[1], parent: stack.length ? stack[stack.length - 1] : null, offset: [0, 0, 0], channels: [], chIndex: 0 };
      joints.push(j);
      stack.push(j);
    } else if (t[0] === 'End') {
      stack.push({ end: true });
    } else if (t[0] === 'OFFSET') {
      const top = stack[stack.length - 1];
      if (!top.end) top.offset = t.slice(1, 4).map(Number);
    } else if (t[0] === 'CHANNELS') {
      const top = stack[stack.length - 1];
      top.channels = t.slice(2);
      top.chIndex = channelsTotal;
      channelsTotal += top.channels.length;
    } else if (t[0] === '}') {
      stack.pop();
    } else if (t[0] === 'MOTION') break;
  }
  const nFrames = +lines[i + 1].split(':')[1];
  const dt = +lines[i + 2].split(':')[1];
  const motion = [];
  for (let k = i + 3; k < lines.length && motion.length < nFrames; k++) {
    if (!lines[k].trim()) continue;
    motion.push(lines[k].trim().split(/\s+/).map(Number));
  }
  return { joints, motion, dt };
}

const rad = (d) => (d * Math.PI) / 180;
function rotMat(axis, deg) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  if (axis === 'X') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'Y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
const mul = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
const apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

// World positions of every joint for one frame.
export function framePositions(bvh, frame) {
  const pos = new Map(), rot = new Map();
  for (const j of bvh.joints) {
    let local = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let trans = j.offset.slice();
    j.channels.forEach((ch, k) => {
      const v = frame[j.chIndex + k];
      if (ch.endsWith('position')) trans[{ X: 0, Y: 1, Z: 2 }[ch[0]]] = v + (j.parent ? j.offset[{ X: 0, Y: 1, Z: 2 }[ch[0]]] : 0);
      else local = mul(local, rotMat(ch[0], v));
    });
    if (!j.parent) { pos.set(j.name, trans); rot.set(j.name, local); continue; }
    const pr = rot.get(j.parent.name), pp = pos.get(j.parent.name);
    const off = apply(pr, j.offset);
    pos.set(j.name, [pp[0] + off[0], pp[1] + off[1], pp[2] + off[2]]);
    rot.set(j.name, mul(pr, local));
  }
  return pos;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => scale(a, 1 / (Math.hypot(...a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// 3D joints (BVH names) -> 17 COCO points in 3D. The face points are placed
// from the head joint and the body's facing direction.
export function toCoco3D(p, fwd, up) {
  const head = p.get('Head'), neck = p.get('Neck');
  const right = norm(sub(p.get('RightShoulder'), p.get('LeftShoulder')));
  const hlen = Math.hypot(...sub(head, neck)) || 10;
  const face = add(add(head, scale(up, hlen * 0.35)), scale(fwd, hlen * 0.6));
  return [
    face, // nose
    add(add(face, scale(right, -hlen * 0.2)), scale(up, hlen * 0.15)), // left eye
    add(add(face, scale(right, hlen * 0.2)), scale(up, hlen * 0.15)), // right eye
    add(add(head, scale(right, -hlen * 0.45)), scale(up, hlen * 0.3)), // left ear
    add(add(head, scale(right, hlen * 0.45)), scale(up, hlen * 0.3)), // right ear
    p.get('LeftShoulder'), p.get('RightShoulder'),
    p.get('LeftElbow'), p.get('RightElbow'),
    p.get('LeftWrist'), p.get('RightWrist'),
    p.get('LeftHip'), p.get('RightHip'),
    p.get('LeftKnee'), p.get('RightKnee'),
    p.get('LeftAnkle'), p.get('RightAnkle'),
  ];
}

// Load a BVH file and return 17-point 3D frames resampled to `fps`, plus the
// player's overall facing direction and the up axis.
export function loadMocap(file, fps = 30) {
  const bvh = parseBVH(fs.readFileSync(file, 'utf8'));
  const step = Math.max(1, Math.round(1 / fps / bvh.dt));
  const up = [0, 1, 0];
  const raw = [];
  for (let f = 0; f < bvh.motion.length; f += step) raw.push(framePositions(bvh, bvh.motion[f]));
  // Facing: perpendicular to the hip line, averaged over the clip.
  let acc = [0, 0, 0];
  for (const p of raw) {
    const hr = sub(p.get('RightHip'), p.get('LeftHip'));
    acc = add(acc, norm(cross(up, hr)));
  }
  let fwd = norm([acc[0], 0, acc[2]]);
  const frames = raw.map((p) => toCoco3D(p, fwd, up));
  return { frames, fwd, up, fps: 1 / (step * bvh.dt) };
}

// Orthographic camera views. 'side' = camera on the player's right, looking at
// their right side, so the swing toward the net runs across the image; 'behind'
// = camera behind the player looking toward the net; 'front' = facing them.
export function project(frames3d, fwd, up, view, { width = 640, height = 480 } = {}) {
  const right = norm(cross(fwd, up)); // player's right
  const axisX = view === 'side' ? fwd : view === 'behind' ? right : scale(right, -1);
  const pts = frames3d.map((f) => f.map((q) => [dot(q, axisX), dot(q, up)]));
  // Fit to the frame with margins, y down.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const f of pts) for (const [x, y] of f) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const s = 0.8 * Math.min(width / (x1 - x0), height / (y1 - y0));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return pts.map((f) => f.map(([x, y]) => [width / 2 + (x - cx) * s, height / 2 - (y - cy) * s, 0.9]));
}
