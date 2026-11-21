// Stroke analysis: cleaning pose tracks, finding strokes, key events,
// checkpoint metrics and comparison against a reference stroke.
// Pure functions only (no DOM), so they run in the browser and in Node tests.

import { SHOT_BY_ID, METRICS, metricCopy, formatMetric } from './shots.js';

// MoveNet keypoint order (anatomical left/right of the player).
export const KP = {
  nose: 0, lEye: 1, rEye: 2, lEar: 3, rEar: 4, lSho: 5, rSho: 6, lElb: 7, rElb: 8,
  lWri: 9, rWri: 10, lHip: 11, rHip: 12, lKnee: 13, rKnee: 14, lAnk: 15, rAnk: 16,
};
export const EDGES = [
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
];

// Canonical skeleton: hitting side / other side instead of left / right.
export const CANON = ['head', 'hitSho', 'hitElb', 'hitWri', 'offSho', 'offElb', 'offWri',
  'hitHip', 'hitKnee', 'hitAnk', 'offHip', 'offKnee', 'offAnk'];
export const C = Object.fromEntries(CANON.map((n, i) => [n, i]));
export const CANON_EDGES = [
  [C.hitSho, C.offSho], [C.hitSho, C.hitElb], [C.hitElb, C.hitWri], [C.offSho, C.offElb],
  [C.offElb, C.offWri], [C.hitSho, C.hitHip], [C.offSho, C.offHip], [C.hitHip, C.offHip],
  [C.hitHip, C.hitKnee], [C.hitKnee, C.hitAnk], [C.offHip, C.offKnee], [C.offKnee, C.offAnk],
];

const MIN_SCORE = 0.2;

// ---------- small geometry helpers ----------
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export function angleAt(a, b, c) {
  const v1x = a[0] - b[0], v1y = a[1] - b[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!n) return NaN;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n));
  return (Math.acos(cos) * 180) / Math.PI;
}
const median = (arr) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- track cleaning ----------

// MoveNet sometimes swaps left/right limbs between frames, especially from a
// side view. Keep each limb group consistent with the previous frame.
const SWAP_GROUPS = [
  [[5, 6], [7, 8], [9, 10]],
  [[11, 12], [13, 14], [15, 16]],
];
export function fixSwaps(samples) {
  if (!samples.length) return samples;
  const scale = torsoLength(samples.map((s) => s.kps));
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].kps, cur = samples[i].kps;
    const pp = i >= 2 ? samples[i - 2].kps : prev;
    // Constant-velocity prediction, so a fast-moving hand isn't mistaken
    // for the other hand that happens to be near its old position.
    const pred = (j) => [2 * prev[j][0] - pp[j][0], 2 * prev[j][1] - pp[j][1]];
    for (const group of SWAP_GROUPS) {
      let keep = 0, swap = 0, n = 0;
      for (const [a, b] of group) {
        if (cur[a][2] < MIN_SCORE || cur[b][2] < MIN_SCORE || prev[a][2] < MIN_SCORE || prev[b][2] < MIN_SCORE) continue;
        const pa = pred(a), pb = pred(b);
        keep += dist(cur[a], pa) + dist(cur[b], pb);
        swap += dist(cur[a], pb) + dist(cur[b], pa);
        n++;
      }
      if (n >= 2 && swap < keep * 0.5 && keep > 0.25 * scale * n) {
        for (const [a, b] of group) { const t = cur[a]; cur[a] = cur[b]; cur[b] = t; }
      }
    }
  }
  return samples;
}

// Resample irregular samples ({t, kps}) onto a uniform time grid.
export function resample(samples, fps) {
  if (!samples.length) return { fps, t0: 0, frames: [] };
  const t0 = samples[0].t, tEnd = samples[samples.length - 1].t;
  const n = Math.max(1, Math.floor((tEnd - t0) * fps + 1e-6) + 1);
  const frames = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k / fps;
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j], b = samples[Math.min(j + 1, samples.length - 1)];
    const span = b.t - a.t;
    const f = span > 0 ? clamp((t - a.t) / span, 0, 1) : 0;
    frames.push(a.kps.map((p, i) => {
      const q = b.kps[i];
      return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f];
    }));
  }
  return { fps, t0, frames };
}

// Fill low-confidence keypoints by interpolating between confident frames.
export function fillGaps(frames) {
  const n = frames.length;
  for (let j = 0; j < 17; j++) {
    const good = [];
    for (let i = 0; i < n; i++) if (frames[i][j][2] >= MIN_SCORE) good.push(i);
    if (!good.length) continue;
    let g = 0;
    for (let i = 0; i < n; i++) {
      if (frames[i][j][2] >= MIN_SCORE) continue;
      while (g < good.length - 1 && good[g + 1] < i) g++;
      const a = good[g] < i ? good[g] : null;
      const b = good.find((x) => x > i) ?? null;
      let p;
      if (a != null && b != null) {
        const f = (i - a) / (b - a);
        p = [frames[a][j][0] + (frames[b][j][0] - frames[a][j][0]) * f, frames[a][j][1] + (frames[b][j][1] - frames[a][j][1]) * f];
      } else {
        const s = a != null ? a : b;
        p = [frames[s][j][0], frames[s][j][1]];
      }
      frames[i][j] = [p[0], p[1], frames[i][j][2]];
    }
  }
  return frames;
}

// Light centred smoothing (5-tap binomial) of x/y.
export function smooth(frames) {
  const w = [1, 4, 6, 4, 1];
  const n = frames.length;
  return frames.map((_, i) => frames[i].map((p, j) => {
    let x = 0, y = 0, ws = 0;
    for (let k = -2; k <= 2; k++) {
      const q = frames[clamp(i + k, 0, n - 1)][j];
      x += q[0] * w[k + 2]; y += q[1] * w[k + 2]; ws += w[k + 2];
    }
    return [x / ws, y / ws, p[2]];
  }));
}

// Raw samples -> clean uniform sequence.
export function buildSequence(samples, { fps = 30, width, height } = {}) {
  const copy = samples.map((s) => ({ t: s.t, kps: s.kps.map((p) => p.slice()) }));
  fixSwaps(copy);
  const r = resample(copy, fps);
  fillGaps(r.frames);
  return { fps, t0: r.t0, frames: smooth(r.frames), width, height };
}

// ---------- body measures ----------
export function torsoLength(frames) {
  const vals = frames.map((f) => {
    if (Math.min(f[5][2], f[6][2], f[11][2], f[12][2]) < MIN_SCORE) return NaN;
    return dist(mid(f[5], f[6]), mid(f[11], f[12]));
  });
  let t = median(vals);
  if (!Number.isFinite(t)) t = median(frames.map((f) => dist(mid(f[5], f[6]), mid(f[11], f[12]))));
  return t > 1e-6 ? t : 1;
}

export function bodyVisible(frame) {
  return Math.min(frame[5][2], frame[6][2], frame[11][2], frame[12][2]) >= 0.3;
}

const handIdx = (hand) => (hand === 'L'
  ? { wri: 9, elb: 7, sho: 5, owri: 10 }
  : { wri: 10, elb: 8, sho: 6, owri: 9 });

// Speed of one keypoint relative to the hips (so running to the ball doesn't
// look like a swing), in torso lengths per second.
export function speedSeries(frames, kp, fps, torso) {
  const n = frames.length;
  const v = new Array(n).fill(0);
  const rel = (f) => [f[kp][0] - (f[11][0] + f[12][0]) / 2, f[kp][1] - (f[11][1] + f[12][1]) / 2];
  for (let i = 0; i < n; i++) {
    const a = rel(frames[Math.max(0, i - 1)]), b = rel(frames[Math.min(n - 1, i + 1)]);
    const span = Math.min(n - 1, i + 1) - Math.max(0, i - 1);
    v[i] = span ? (dist(a, b) * fps) / span / torso : 0;
  }
  return v;
}

// ---------- stroke detection ----------
// Returns contact frame indices (peaks of hitting-hand speed).
export function detectStrokes(seq, { hand = 'R', shot = 'forehand', sensitivity = 1, relative = 0.4 } = {}) {
  const cfg = SHOT_BY_ID[shot];
  const { frames, fps } = seq;
  if (frames.length < 5) return [];
  const torso = torsoLength(frames);
  const { wri } = handIdx(hand);
  const v = speedSeries(frames, wri, fps, torso);
  const peak = Math.max(...v);
  const thresh = Math.max(cfg.minSpeed / sensitivity, peak * relative);
  const half = Math.max(2, Math.round(0.35 * fps));
  const gap = Math.round(0.9 * fps);
  const candidates = [];
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] < thresh) continue;
    let isMax = true;
    for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
      if (v[k] > v[i] || (v[k] === v[i] && k < i)) { isMax = false; break; }
    }
    if (isMax && bodyVisible(frames[i])) candidates.push(i);
  }
  // Strongest peaks win; a weaker peak close to a stronger one (for example
  // the take-back just before the forward swing) is dropped.
  candidates.sort((a, b) => v[b] - v[a]);
  const out = [];
  for (const i of candidates) if (out.every((j) => Math.abs(i - j) >= gap)) out.push(i);
  return out.sort((a, b) => a - b);
}

// Cut a stroke window around a contact frame.
export function cutStroke(seq, contact, shot) {
  const cfg = SHOT_BY_ID[shot];
  const a = Math.max(0, contact - Math.round(cfg.pre * seq.fps));
  const b = Math.min(seq.frames.length - 1, contact + Math.round(cfg.post * seq.fps));
  return {
    fps: seq.fps,
    width: seq.width,
    height: seq.height,
    frames: seq.frames.slice(a, b + 1),
    contact: contact - a,
    offset: a,
    t0: seq.t0 + a / seq.fps,
  };
}

// ---------- canonical pose ----------
function canonIndices(hand) {
  return hand === 'L'
    ? { hitSho: 5, hitElb: 7, hitWri: 9, offSho: 6, offElb: 8, offWri: 10, hitHip: 11, hitKnee: 13, hitAnk: 15, offHip: 12, offKnee: 14, offAnk: 16 }
    : { hitSho: 6, hitElb: 8, hitWri: 10, offSho: 5, offElb: 7, offWri: 9, hitHip: 12, hitKnee: 14, hitAnk: 16, offHip: 11, offKnee: 13, offAnk: 15 };
}

// Hip-centred, torso-scaled, y-up, mirrored so the swing at contact moves +x.
export function canonicalize(frames, hand, dir, torso) {
  const ix = canonIndices(hand);
  return frames.map((f) => {
    const hip = mid(f[11], f[12]);
    const tr = (p) => [((p[0] - hip[0]) * dir) / torso, (hip[1] - p[1]) / torso];
    const out = new Array(CANON.length);
    out[C.head] = tr(f[0]);
    for (const name of CANON.slice(1)) out[C[name]] = tr(f[ix[name]]);
    return out;
  });
}

// ---------- events & metrics ----------
function swingDirection(frames, wri, contact) {
  const n = frames.length;
  const a = frames[Math.max(0, contact - 2)][wri], b = frames[Math.min(n - 1, contact + 2)][wri];
  const dx = b[0] - a[0];
  return dx < 0 ? -1 : 1;
}

export function analyzeStroke(stroke, { shot, hand = 'R', timeScale = 1 }) {
  const cfg = SHOT_BY_ID[shot];
  const { frames, fps } = stroke;
  const n = frames.length;
  const torso = torsoLength(frames);
  let h = hand;
  let { wri } = handIdx(h);
  let v = speedSeries(frames, wri, fps, torso);

  // Guard against the whole clip having left/right arms labelled the wrong
  // way round: the hitting hand should be the fast one (two-handers excepted).
  if (shot !== 'backhand2') {
    const other = speedSeries(frames, handIdx(h).owri, fps, torso);
    if (Math.max(...other) > 1.35 * Math.max(...v)) {
      h = h === 'L' ? 'R' : 'L';
      wri = handIdx(h).wri;
      v = other;
    }
  }

  let contact = stroke.contact != null ? stroke.contact : v.indexOf(Math.max(...v));
  contact = clamp(contact, 1, Math.max(1, n - 2));
  const dir = swingDirection(frames, wri, contact);
  const canon = canonicalize(frames, h, dir, torso);
  const kneeAngles = canon.map((p) => Math.min(
    angleAt(p[C.hitHip], p[C.hitKnee], p[C.hitAnk]),
    angleAt(p[C.offHip], p[C.offKnee], p[C.offAnk]),
  ));

  // End of preparation.
  let prep = 0;
  if (cfg.prep === 'trophy') {
    let best = Infinity;
    for (let i = 0; i <= contact - 2; i++) if (kneeAngles[i] < best) { best = kneeAngles[i]; prep = i; }
  } else {
    let best = Infinity;
    for (let i = 0; i <= contact - 1; i++) {
      const x = canon[i][C.hitWri][0];
      if (x < best) { best = x; prep = i; }
    }
  }
  prep = clamp(prep, 0, contact - 1);

  // Finish: hand slows to a quarter of its peak after contact.
  const vPeak = v[contact];
  let finish = n - 1;
  for (let i = contact + 2; i < n; i++) if (v[i] < 0.25 * vPeak) { finish = i; break; }
  finish = clamp(finish, contact + 1, n - 1);

  const events = { start: 0, prep, contact, finish, end: n - 1 };

  const pc = canon[contact];
  const range = (a, b, fn) => { const out = []; for (let i = a; i <= b; i++) out.push(fn(i)); return out; };
  const loadFrom = Math.max(0, prep - Math.round(0.4 * fps));
  const shoW = canon.map((p) => dist(p[C.hitSho], p[C.offSho]));
  const shoWin = shoW.slice(0, finish + 1);
  const maxW = Math.max(...shoWin), minW = Math.min(...shoWin);
  const trunk = (p) => {
    const s = mid(p[C.hitSho], p[C.offSho]);
    return (Math.atan2(s[0], s[1]) * 180) / Math.PI;
  };

  const metrics = {
    loadKnee: Math.min(...range(loadFrom, contact, (i) => kneeAngles[i]).filter(Number.isFinite)),
    contactElbow: angleAt(pc[C.hitSho], pc[C.hitElb], pc[C.hitWri]),
    contactHeight: pc[C.hitWri][1],
    contactFront: pc[C.hitWri][0],
    finishHeight: canon[finish][C.hitWri][1],
    takeback: Math.max(0, -Math.min(...range(0, contact, (i) => canon[i][C.hitWri][0]))),
    shoulderTurn: maxW > 0 ? (100 * (maxW - minW)) / maxW : NaN,
    trunkTilt: trunk(pc),
    stance: dist(pc[C.hitAnk], pc[C.offAnk]),
    swingTime: (contact - prep) / fps / timeScale,
    wristSpeed: vPeak * timeScale,
    tossArm: canon[prep][C.offWri][1],
  };
  for (const k of Object.keys(metrics)) if (!Number.isFinite(metrics[k])) metrics[k] = null;

  return { shot, hand: h, handSwapped: h !== hand, dir, torso, fps, timeScale, events, canon, metrics, n };
}

// ---------- alignment & comparison ----------
// Phase anchors are placed at fixed points of a 0..1 "stroke clock" so two
// strokes of different speeds line up preparation-to-preparation,
// contact-to-contact and finish-to-finish.
export const PHASE_U = [0, 0.4, 0.7, 0.88, 1];

export function anchors(ev) {
  const a = [ev.start, ev.prep, ev.contact, ev.finish, ev.end];
  for (let i = 1; i < a.length; i++) if (a[i] <= a[i - 1]) a[i] = a[i - 1] + 1e-3;
  return a;
}

export function indexFromU(an, u) {
  u = clamp(u, 0, 1);
  for (let k = 0; k < PHASE_U.length - 1; k++) {
    if (u <= PHASE_U[k + 1] || k === PHASE_U.length - 2) {
      const f = (u - PHASE_U[k]) / (PHASE_U[k + 1] - PHASE_U[k]);
      return an[k] + f * (an[k + 1] - an[k]);
    }
  }
  return an[an.length - 1];
}

export function uFromIndex(an, i) {
  i = clamp(i, an[0], an[an.length - 1]);
  for (let k = 0; k < an.length - 1; k++) {
    if (i <= an[k + 1] || k === an.length - 2) {
      const f = (i - an[k]) / (an[k + 1] - an[k]);
      return PHASE_U[k] + f * (PHASE_U[k + 1] - PHASE_U[k]);
    }
  }
  return 1;
}

export function poseAt(analysis, idx) {
  const c = analysis.canon;
  const i0 = clamp(Math.floor(idx), 0, c.length - 1), i1 = Math.min(c.length - 1, i0 + 1);
  const f = clamp(idx - i0, 0, 1);
  return c[i0].map((p, j) => [p[0] + (c[i1][j][0] - p[0]) * f, p[1] + (c[i1][j][1] - p[1]) * f]);
}

const JOINT_W = {
  hitSho: 1, hitElb: 1.5, hitWri: 2, offSho: 0.8, offElb: 0.7, offWri: 0.7,
  hitHip: 0.5, offHip: 0.5, hitKnee: 1, offKnee: 1, hitAnk: 0.7, offAnk: 0.7,
};
export function poseDistance(pa, pb) {
  let s = 0, ws = 0;
  for (const [name, w] of Object.entries(JOINT_W)) {
    s += w * dist(pa[C[name]], pb[C[name]]);
    ws += w;
  }
  return s / ws;
}

export const scoreFromDistance = (d) => Math.round(clamp(100 - d * 120, 0, 100));

export const PHASES = [
  { key: 'prep', from: 0, to: 0.45 },
  { key: 'contact', from: 0.55, to: 0.8 },
  { key: 'finish', from: 0.8, to: 1 },
];

export function compareStrokes(student, ref, samples = 60) {
  const aS = anchors(student.events), aR = anchors(ref.events);
  const dists = [];
  for (let k = 0; k < samples; k++) {
    const u = k / (samples - 1);
    dists.push({ u, d: poseDistance(poseAt(student, indexFromU(aS, u)), poseAt(ref, indexFromU(aR, u))) });
  }
  const meanD = dists.reduce((s, x) => s + x.d, 0) / dists.length;
  const phases = {};
  for (const ph of PHASES) {
    const sel = dists.filter((x) => x.u >= ph.from && x.u <= ph.to);
    phases[ph.key] = scoreFromDistance(sel.reduce((s, x) => s + x.d, 0) / sel.length);
  }
  return { score: scoreFromDistance(meanD), meanDistance: meanD, phases, curve: dists };
}

// ---------- checkpoint evaluation & coaching tips ----------
export function evaluate(studentMetrics, refMetrics, shotId, refName = 'the pro') {
  const cfg = SHOT_BY_ID[shotId];
  const rows = [];
  for (const [key, guide] of Object.entries(cfg.metrics)) {
    const m = METRICS[key];
    const s = studentMetrics[key];
    let target = null, targetText = '–', source = null;
    if (refMetrics && refMetrics[key] != null) {
      target = refMetrics[key]; targetText = formatMetric(key, target); source = 'ref';
    } else if (guide) {
      target = (guide[0] + guide[1]) / 2;
      targetText = `${formatMetric(key, guide[0])} – ${formatMetric(key, guide[1])}`;
      source = 'guide';
    }
    let status = 'none', severity = 0, direction = null;
    if (s != null && target != null) {
      const tol = m.tolRel ? Math.abs(target) * m.tolRel : m.tol;
      let off;
      if (source === 'guide') off = s < guide[0] ? s - guide[0] : s > guide[1] ? s - guide[1] : 0;
      else off = s - target;
      severity = Math.abs(off) / tol;
      direction = off > 0 ? 'hi' : off < 0 ? 'lo' : null;
      status = severity <= 1 ? 'good' : severity <= 2 ? 'close' : 'work';
      if (source === 'guide' && off === 0) severity = 0;
    }
    rows.push({ key, label: m.label, short: m.short, help: m.help, student: s, studentText: formatMetric(key, s), target, targetText, source, status, severity, direction });
  }

  const tips = rows
    .filter((r) => r.status !== 'good' && r.status !== 'none' && r.direction)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 3)
    .map((r) => {
      const ref = r.source === 'ref' ? refName : 'the guide range';
      const t = r.source === 'ref' ? r.targetText : r.targetText;
      const text = metricCopy(r.key, shotId, r.direction)
        .replaceAll('{s}', r.studentText).replaceAll('{t}', t).replaceAll('{ref}', ref);
      return { key: r.key, status: r.status, text };
    });
  return { rows, tips, onTarget: rows.filter((r) => r.status === 'good').length, rated: rows.filter((r) => r.status !== 'none').length };
}
