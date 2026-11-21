// Tennis-MoCap (CC BY-SA 3.0) -> single strokes as 2D keypoints from the
// side, from behind and from the front. Writes mocap.jsonl (one stroke/view
// per line) in the same shape as the THETIS extraction.
import fs from 'node:fs';
import path from 'node:path';
import * as A from '../../js/analysis.js';
import { loadMocap, project } from './bvh.mjs';

const DIR = process.env.MOCAP_DIR || 'data/Tennis-MoCap';
const LABELS = { 0: 'serve', 1: 'overhead', 2: 'forehand', 3: 'fhVolley', 4: 'backhand', 5: 'bhVolley' };
const rows = fs.readFileSync(path.join(DIR, 'labels.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.trim().split(';').map((x) => x.trim()));
const actual = new Map(fs.readdirSync(path.join(DIR, 'data')).map((f) => [f.toLowerCase(), f]));
// Handedness per player: the wrist that is faster across all their files.
const handVotes = {};
const out = fs.createWriteStream('mocap.jsonl');
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(...a);
let total = 0;

const loaded = [];
for (const [file0, hp, , , lab] of rows) {
  const file = actual.get(file0.toLowerCase());
  if (!file) { console.error('missing', file0); continue; }
  const m = loadMocap(path.join(DIR, 'data', file), 30);
  loaded.push({ file, hp, lab, m });
}
const hipMidG = (f) => [(f[11][0] + f[12][0]) / 2, (f[11][1] + f[12][1]) / 2, (f[11][2] + f[12][2]) / 2];
for (const { file, m } of loaded) {
  const player = file.split('_')[0];
  const peak = (w) => Math.max(...m.frames.map((f, i) => (i === 0 ? 0 : len(sub(sub(f[w], hipMidG(f)), sub(m.frames[i - 1][w], hipMidG(m.frames[i - 1])))))));
  handVotes[player] = (handVotes[player] || 0) + (peak(10) >= peak(9) ? 1 : -1);
}
for (const { file, hp, lab, m } of loaded) {
  const label0 = LABELS[lab];
  const player = file.split('_')[0];
  const F = m.frames, n = F.length, dt = 1 / m.fps;
  // Hitting hand = the faster wrist (relative to the hips).
  const hipMid = (f) => [(f[11][0] + f[12][0]) / 2, (f[11][1] + f[12][1]) / 2, (f[11][2] + f[12][2]) / 2];
  const speed = (w) => F.map((f, i) => (i === 0 ? 0 : len(sub(sub(f[w], hipMid(f)), sub(F[i - 1][w], hipMid(F[i - 1])))) / dt));
  const vR = speed(10), vL = speed(9);
  const hand = handVotes[player] >= 0 ? 'R' : 'L';
  const v = hand === 'R' ? vR : vL;
  const wi = hand === 'R' ? 10 : 9;
  // Strokes = speed peaks at least 1.2 s apart and above 40% of the file's max.
  const peaks = [];
  const thr = 0.4 * Math.max(...v);
  for (let i = 1; i < n - 1; i++) if (v[i] >= thr && v[i] >= v[i - 1] && v[i] >= v[i + 1]) peaks.push(i);
  peaks.sort((a, b) => v[b] - v[a]);
  const chosen = [];
  for (const p of peaks) if (chosen.every((q) => Math.abs(p - q) > 1.2 * m.fps)) chosen.push(p);
  chosen.sort((a, b) => a - b);
  // Net direction: the way the chest faces at contact (players turn square
  // to the net through the hit), averaged over the strokes in the file.
  let dir = [0, 0];
  for (const p of chosen) {
    const r = sub(F[p][6], F[p][5]); // left -> right shoulder
    const c = [-r[2], r[0]]; // horizontal normal: cross(up, r) in (x, z)
    const l = Math.hypot(...c) || 1;
    dir = [dir[0] + c[0] / l, dir[1] + c[1] / l];
  }
  const dl = Math.hypot(...dir) || 1;
  const fwd = [dir[0] / dl, 0, dir[1] / dl];
  for (const view of ['side', 'behind', 'front']) {
    const P = project(F, fwd, m.up, view);
    const samples = P.map((kps, i) => ({ t: i * dt, kps }));
    chosen.forEach((p, k) => {
      const a = Math.max(0, p - Math.round(2.0 * m.fps)), b = Math.min(n - 1, p + Math.round(1.0 * m.fps));
      if (p - a < 1.0 * m.fps || b - p < 0.6 * m.fps) return; // need room around contact
      let label = label0;
      if (label0 === 'backhand') {
        // Two hands on the racquet at contact => two-handed backhand.
        const gap = len(sub(F[p][9], F[p][10]));
        const torso = len(sub(hipMid(F[p]), [(F[p][5][0] + F[p][6][0]) / 2, (F[p][5][1] + F[p][6][1]) / 2, (F[p][5][2] + F[p][6][2]) / 2]));
        label = gap < 0.45 * torso ? 'backhand2' : 'backhand1';
      }
      out.write(JSON.stringify({
        source: 'mocap', file: `${file}#${k + 1}`, name: `${player}_${label}_${k + 1}`, player, hp: hp === '1', view, hand, label,
        w: 640, h: 480, fps: m.fps, samples: samples.slice(a, b + 1).map((s) => ({ t: s.t - samples[a].t, kps: s.kps.map((q) => q.map((x) => +x.toFixed(1))) })),
      }) + '\n');
      total++;
    });
  }
  console.error(`${file}: ${label0}, hand ${hand}, ${chosen.length} strokes`);
}
out.end(() => console.error(`total ${total} stroke-views`));
