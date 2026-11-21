// Stroke analysis: cleaning pose tracks, finding strokes, key events,
// checkpoint metrics and comparison against a reference stroke.
// Pure functions only (no DOM), so they run in the browser and in Node tests.

import { SHOT_BY_ID, METRICS, metricCopy, formatMetric, shotConfig } from './shots.js';
import { SHOT_MODELS } from './shotmodel.js';

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
      let keep = 0, swap = 0, n = 0, rootSwapped = false;
      for (const [k, [a, b]] of group.entries()) {
        if (cur[a][2] < MIN_SCORE || cur[b][2] < MIN_SCORE || prev[a][2] < MIN_SCORE || prev[b][2] < MIN_SCORE) continue;
        const pa = pred(a), pb = pred(b);
        const kk = dist(cur[a], pa) + dist(cur[b], pb), ss = dist(cur[a], pb) + dist(cur[b], pa);
        // The model flips a whole side at once, so the shoulders (or hips)
        // must agree; hands passing close to each other are not a flip.
        if (k === 0) rootSwapped = ss < kk * 0.7;
        keep += kk; swap += ss;
        n++;
      }
      if (rootSwapped && n >= 2 && swap < keep * 0.5 && keep > 0.25 * scale * n) {
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
export const MIN_STROKE_GAP = 1.6; // seconds between two strokes
// Seen from the front much of the swing moves toward the camera, so the hand
// looks slower on screen than it is.
export const VIEW_SPEED = { side: 1, behind: 0.9, front: 0.7 };

// Does a hand-speed peak look like a real swing? Rejects tracking glitches
// (a point jumping for a frame or two), small movements (adjusting the grip,
// bouncing the ball) and out-and-back jitter.
export function strokeQuality(seq, contact, { hand = 'R', torso = null, v = null } = {}) {
  const { frames, fps } = seq;
  const n = frames.length;
  torso = torso || torsoLength(frames);
  const { wri } = handIdx(hand);
  v = v || speedSeries(frames, wri, fps, torso);
  const peak = v[contact];
  // 1. The hand stays fast for a moment, not a single-frame spike.
  let a = contact, b = contact;
  while (a > 0 && v[a - 1] >= 0.5 * peak) a--;
  while (b < n - 1 && v[b + 1] >= 0.5 * peak) b++;
  const fastFrames = b - a + 1;
  // 2. It travels far enough around contact (relative to the hips).
  const rel = (i) => [frames[i][wri][0] - (frames[i][11][0] + frames[i][12][0]) / 2, frames[i][wri][1] - (frames[i][11][1] + frames[i][12][1]) / 2];
  const from = Math.max(1, contact - Math.round(0.4 * fps)), to = Math.min(n - 1, contact + Math.round(0.3 * fps));
  let travel = 0;
  for (let i = from; i <= to; i++) travel += dist(rel(i), rel(i - 1)) / torso;
  // 3. Through contact it keeps going one way instead of jumping out and back.
  const c0 = Math.max(0, contact - Math.round(0.12 * fps)), c1 = Math.min(n - 1, contact + Math.round(0.12 * fps));
  let path = 0;
  for (let i = c0 + 1; i <= c1; i++) path += dist(rel(i), rel(i - 1));
  const straightness = path > 0 ? dist(rel(c1), rel(c0)) / path : 0;
  // 4. The hand was actually seen, not guessed.
  const seenFrom = Math.max(0, contact - Math.round(0.2 * fps)), seenTo = Math.min(n - 1, contact + Math.round(0.2 * fps));
  let conf = 0;
  for (let i = seenFrom; i <= seenTo; i++) conf += frames[i][wri][2];
  conf /= seenTo - seenFrom + 1;

  const reasons = [];
  if (fastFrames < Math.max(3, Math.round(0.08 * fps))) reasons.push('spike');
  if (travel < 0.7) reasons.push('small'); // a volley punch is short
  if (straightness < 0.6) reasons.push('jitter');
  if (conf < 0.25) reasons.push('unseen');
  return { ok: reasons.length === 0, reasons, peak, fastFrames, travel, straightness, conf };
}

// Returns contact frame indices (peaks of hitting-hand speed).
export function detectStrokes(seq, { hand = 'R', shot = 'forehand', sensitivity = 1, relative = 0.4, view = 'side' } = {}) {
  const cfg = shotConfig(shot);
  const { frames, fps } = seq;
  if (frames.length < 5) return [];
  const torso = torsoLength(frames);
  const { wri } = handIdx(hand);
  const v = speedSeries(frames, wri, fps, torso);
  const peak = Math.max(...v);
  const thresh = Math.max((cfg.minSpeed * (VIEW_SPEED[view] || 1)) / sensitivity, peak * relative);
  const half = Math.max(2, Math.round(0.35 * fps));
  const gap = Math.round(MIN_STROKE_GAP * fps);
  const candidates = [];
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] < thresh) continue;
    let isMax = true;
    for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
      if (v[k] > v[i] || (v[k] === v[i] && k < i)) { isMax = false; break; }
    }
    if (isMax && bodyVisible(frames[i]) && strokeQuality(seq, i, { hand, torso, v }).ok) candidates.push(i);
  }
  return pickStrokes(candidates, v, gap, fps);
}

// Of hand-speed peaks closer together than the minimum gap, keep one. The
// preparation (take-back, or toss and racquet drop on a serve) comes 0.6 s or
// more before the hit and can be nearly as fast, so such a later peak wins if
// it reaches 75% of the earlier one. Peaks right after each other (contact and
// follow-through) keep the faster one.
export function pickStrokes(candidates, v, gap, fps = 30) {
  const out = [];
  const prepGap = Math.round(0.6 * fps);
  for (const i of [...candidates].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last == null || i - last >= gap) out.push(i);
    else if (i - last >= prepGap ? v[i] >= 0.75 * v[last] : v[i] > v[last]) out[out.length - 1] = i;
  }
  return out;
}

// Cut a stroke window around a contact frame.
export function cutStroke(seq, contact, shot) {
  const cfg = shotConfig(shot);
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

// Detection confidence of each canonical joint, per frame.
export function canonScores(frames, hand) {
  const ix = canonIndices(hand);
  return frames.map((f) => {
    const out = new Array(CANON.length);
    out[C.head] = f[0][2];
    for (const name of CANON.slice(1)) out[C[name]] = f[ix[name]][2];
    return out;
  });
}

// A joint must be seen this confidently before a checkpoint is measured from
// it. Points below it were guessed by the model or filled in, so measuring
// them gives nonsense such as a 12° knee.
const SEEN = 0.3;
const SEEN_FAST = 0.2; // the hand is blurred near contact, so allow a little less

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
  const conf = canonScores(frames, h);
  const seen = (i, names, thr = SEEN) => names.every((nm) => conf[i][C[nm]] >= thr);
  const legAngle = (i, side) => {
    const [hp, kn, an] = [`${side}Hip`, `${side}Knee`, `${side}Ank`];
    if (!seen(i, [hp, kn, an])) return NaN;
    const a = angleAt(canon[i][C[hp]], canon[i][C[kn]], canon[i][C[an]]);
    return a >= 50 ? a : NaN; // tighter than this isn't a tennis knee bend
  };
  const kneeAngles = canon.map((_, i) => {
    const a = [legAngle(i, 'hit'), legAngle(i, 'off')].filter(Number.isFinite);
    return a.length ? Math.min(...a) : NaN;
  });
  const legFrames = canon.filter((_, i) => seen(i, ['hitKnee', 'offKnee', 'hitAnk', 'offAnk'])).length;
  const legsHidden = legFrames < 0.5 * n;
  const armFrames = canon.filter((_, i) => seen(i, ['hitElb', 'hitWri'], SEEN_FAST)).length;
  const armHidden = armFrames < 0.5 * n;

  // End of preparation.
  let prep = 0;
  if (cfg.prep === 'trophy') {
    let best = Infinity;
    for (let i = 0; i <= contact - 2; i++) if (kneeAngles[i] < best) { best = kneeAngles[i]; prep = i; }
    if (best === Infinity) {
      // Legs not visible: use the pause of the hand before the drive instead.
      let slow = Infinity;
      for (let i = Math.max(0, contact - Math.round(0.9 * fps)); i <= contact - 3; i++) if (v[i] < slow) { slow = v[i]; prep = i; }
    }
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
  const minFinish = contact + Math.max(2, Math.round(0.12 * fps));
  for (let i = minFinish; i < n; i++) if (v[i] < 0.25 * vPeak) { finish = i; break; }
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

  const armAtContact = seen(contact, ['hitSho', 'hitElb', 'hitWri'], SEEN_FAST);
  const wristAtContact = seen(contact, ['hitWri'], SEEN_FAST);
  const backFrames = range(0, contact, (i) => (seen(i, ['hitWri'], SEEN_FAST) ? canon[i][C.hitWri][0] : NaN)).filter(Number.isFinite);
  const kneeLoad = range(loadFrom, contact, (i) => kneeAngles[i]).filter(Number.isFinite);
  // Values outside these bounds can only come from bad tracking.
  const within = (x, lo, hi) => (x >= lo && x <= hi ? x : NaN);

  const metrics = {
    loadKnee: kneeLoad.length ? Math.min(...kneeLoad) : NaN,
    contactElbow: armAtContact ? angleAt(pc[C.hitSho], pc[C.hitElb], pc[C.hitWri]) : NaN,
    contactHeight: wristAtContact ? within(pc[C.hitWri][1], -2, 3.6) : NaN,
    contactFront: wristAtContact ? within(pc[C.hitWri][0], -2, 3) : NaN,
    finishHeight: seen(finish, ['hitWri'], SEEN_FAST) ? within(canon[finish][C.hitWri][1], -2, 3.6) : NaN,
    takeback: backFrames.length >= 0.5 * (contact + 1) ? within(Math.max(0, -Math.min(...backFrames)), 0, 3) : NaN,
    shoulderTurn: maxW > 0 ? (100 * (maxW - minW)) / maxW : NaN,
    trunkTilt: trunk(pc),
    stance: seen(contact, ['hitAnk', 'offAnk']) ? within(dist(pc[C.hitAnk], pc[C.offAnk]), 0, 4) : NaN,
    swingTime: armHidden ? NaN : (contact - prep) / fps / timeScale,
    wristSpeed: armHidden ? NaN : vPeak * timeScale,
    tossArm: seen(prep, ['offWri']) ? within(canon[prep][C.offWri][1], -2, 3.6) : NaN,
  };
  for (const k of Object.keys(metrics)) if (!Number.isFinite(metrics[k])) metrics[k] = null;

  return { shot, hand: h, handSwapped: h !== hand, dir, torso, fps, timeScale, events, canon, conf, metrics, n, legsHidden, armHidden };
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
// Average distance between matching joints, in torso lengths. Joints that
// weren't clearly seen in either stroke (ca / cb confidences) are left out.
export function poseDistance(pa, pb, ca = null, cb = null) {
  let s = 0, ws = 0;
  for (const [name, w] of Object.entries(JOINT_W)) {
    const j = C[name];
    if ((ca && ca[j] < SEEN) || (cb && cb[j] < SEEN)) continue;
    s += w * dist(pa[j], pb[j]);
    ws += w;
  }
  return ws ? s / ws : NaN;
}

const confAt = (analysis, idx) => (analysis.conf ? analysis.conf[clamp(Math.round(idx), 0, analysis.conf.length - 1)] : null);

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
    const iS = indexFromU(aS, u), iR = indexFromU(aR, u);
    const d = poseDistance(poseAt(student, iS), poseAt(ref, iR), confAt(student, iS), confAt(ref, iR));
    if (Number.isFinite(d)) dists.push({ u, d });
  }
  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.d, 0) / arr.length : NaN);
  const meanD = mean(dists);
  const phases = {};
  for (const ph of PHASES) {
    const v = mean(dists.filter((x) => x.u >= ph.from && x.u <= ph.to));
    phases[ph.key] = Number.isFinite(v) ? scoreFromDistance(v) : null;
  }
  return { score: Number.isFinite(meanD) ? scoreFromDistance(meanD) : null, meanDistance: meanD, phases, curve: dists };
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

// ---------- automatic shot recognition ----------
// Rule-based: uses only body-relative cues, so it works from any camera angle
// as long as the whole body is visible. Returns the most likely shot and a
// 0..1 confidence.
export function classifyStroke(stroke, { hand = 'R' } = {}) {
  const { frames, fps } = stroke;
  const n = frames.length;
  const torso = torsoLength(frames);
  const { wri } = handIdx(hand);
  const v = speedSeries(frames, wri, fps, torso);
  const contact = clamp(stroke.contact != null ? stroke.contact : v.indexOf(Math.max(...v)), 1, Math.max(1, n - 2));
  const dir = swingDirection(frames, wri, contact);
  const canon = canonicalize(frames, hand, dir, torso);
  const conf = canonScores(frames, hand);
  const ok = (i, nm, t = SEEN_FAST) => conf[i][C[nm]] >= t;
  const at = (i, nm) => canon[clamp(i, 0, n - 1)][C[nm]];
  const sec = (s) => Math.round(s * fps);
  const wristGap = (i) => dist(at(i, 'hitWri'), at(i, 'offWri'));
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const frameRange = (a, b) => { const out = []; for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) out.push(i); return out; };

  // 1. Overhead strokes: hand above the head around contact. (The hand's
  // speed peaks a moment before the highest point, so look either side.)
  const around = frameRange(contact - sec(0.12), contact + 1);
  const hTop = Math.max(...around.map((i) => at(i, 'hitWri')[1] - Math.max(1.5, at(i, 'head')[1] - 0.15)));
  if (hTop > 0) {
    // A serve starts with both hands low together (ball on the strings), then
    // the tossing hand goes up while the racquet drops behind.
    const early = frameRange(0, contact - sec(0.5));
    const startLowTogether = early.some((i) => wristGap(i) < 0.6 && at(i, 'hitWri')[1] < 1.1 && at(i, 'offWri')[1] < 1.1);
    const tossUp = frameRange(contact - sec(1.0), contact - 2).some((i) => ok(i, 'offWri') && at(i, 'offWri')[1] > Math.max(1.8, at(i, 'head')[1]));
    // Only a serve starts from the ready position with ball and racquet together.
    const shot = startLowTogether ? 'serve' : 'overhead';
    return { shot, confidence: startLowTogether && tossUp ? 0.9 : 0.7, features: { hTop, startLowTogether, tossUp } };
  }

  // 2. Swing size: take-back depth and follow-through length.
  const prepRange = frameRange(contact - sec(0.9), contact - 1).filter((i) => ok(i, 'hitWri'));
  let prep = prepRange[0] ?? Math.max(0, contact - 1);
  for (const i of prepRange) if (at(i, 'hitWri')[0] < at(prep, 'hitWri')[0]) prep = i;
  const takeback = Math.max(0, -at(prep, 'hitWri')[0]);
  let follow = 0;
  for (const i of frameRange(contact + 1, contact + sec(0.45))) follow += dist(at(i, 'hitWri'), at(i - 1, 'hitWri'));
  const volley = takeback < 0.4 || (takeback < 0.65 && follow < 1.7);

  // 3. Forehand or backhand side.
  const nearContact = frameRange(contact - 2, contact + 2).filter((i) => ok(i, 'offWri') && ok(i, 'hitWri'));
  const gapContact = avg(nearContact.map(wristGap));
  const gapPrep = ok(prep, 'offWri') ? wristGap(prep) : NaN;
  const twoHanded = gapContact < 0.45;
  // Where the hand sits along the shoulder line at the end of the take-back:
  // +1 = at the hitting shoulder, -1 = at the other shoulder.
  const sh = at(prep, 'hitSho'), so = at(prep, 'offSho');
  const axis = [sh[0] - so[0], sh[1] - so[1]];
  const axisLen2 = axis[0] ** 2 + axis[1] ** 2;
  const smid = mid(sh, so), w = at(prep, 'hitWri');
  const side = axisLen2 > 0.3 ** 2 ? (2 * ((w[0] - smid[0]) * axis[0] + (w[1] - smid[1]) * axis[1])) / axisLen2 : NaN;

  let back = 0;
  if (twoHanded) back += 2.5;
  if (gapPrep < 0.6) back += 1.2; else if (gapPrep > 0.9) back -= 1.2;
  if (side < -0.3) back += 1; else if (side > 0.5) back -= 1;
  const isBack = back > 0;
  const sideConf = clamp(0.5 + Math.abs(back) * 0.15, 0.5, 0.95);

  if (volley) {
    return { shot: isBack ? 'bhVolley' : 'fhVolley', confidence: sideConf * 0.9, features: { takeback, follow, gapPrep, gapContact, side } };
  }
  if (!isBack) return { shot: 'forehand', confidence: sideConf, features: { takeback, follow, gapPrep, gapContact, side } };
  if (twoHanded) return { shot: 'backhand2', confidence: sideConf, features: { takeback, follow, gapPrep, gapContact, side } };
  // One hand on a backhand: slice swings high to low, topspin low to high.
  const prepH = at(prep, 'hitWri')[1];
  const lowH = at(contact + sec(0.1), 'hitWri')[1];
  const finH = at(contact + sec(0.35), 'hitWri')[1];
  const slice = prepH - lowH > 0.25 && finH - lowH < 0.6;
  return { shot: slice ? 'slice' : 'backhand1', confidence: sideConf * 0.9, features: { takeback, follow, gapPrep, gapContact, side, prepH, finH } };
}

// Re-cut a captured window to the given shot's pre/post-contact window.
export function recut(full, shot) {
  const cfg = shotConfig(shot);
  const a = Math.max(0, full.contact - Math.round(cfg.pre * full.fps));
  const b = Math.min(full.frames.length - 1, full.contact + Math.round(cfg.post * full.fps));
  return { range: [a, b], stroke: { ...full, frames: full.frames.slice(a, b + 1), contact: full.contact - a, offset: (full.offset || 0) + a, t0: (full.t0 || 0) + a / full.fps } };
}

// ---------- features for the learned shot recogniser ----------
// Hand heights, sideways positions along the shoulder line, hand gap and
// forward position at fixed times around contact, plus a few whole-stroke
// measures. Used by js/shotmodel.js (trained on THETIS expert strokes).
export const FEATURE_TIMES = [-1.2, -0.9, -0.6, -0.4, -0.2, 0, 0.2, 0.4];
export function strokeFeatures(stroke, hand = 'R') {
  const { frames, fps } = stroke;
  const n = frames.length;
  const torso = torsoLength(frames);
  const { wri, owri } = handIdx(hand);
  const v = speedSeries(frames, wri, fps, torso);
  const contact = clamp(stroke.contact != null ? stroke.contact : v.indexOf(Math.max(...v)), 1, Math.max(1, n - 2));
  const dir = swingDirection(frames, wri, contact);
  const ix = canonIndices(hand);
  const f = [];
  for (const dt of FEATURE_TIMES) {
    const i = clamp(contact + Math.round(dt * fps), 0, n - 1);
    const p = frames[i];
    const hip = mid(p[11], p[12]);
    const sm = mid(p[ix.hitSho], p[ix.offSho]);
    const axis = [p[ix.hitSho][0] - p[ix.offSho][0], p[ix.hitSho][1] - p[ix.offSho][1]];
    const lat = (q) => ((q[0] - sm[0]) * axis[0] + (q[1] - sm[1]) * axis[1]) / (torso * torso);
    f.push(
      (hip[1] - p[wri][1]) / torso, // hitting hand height
      (hip[1] - p[owri][1]) / torso, // other hand height
      lat(p[wri]), // hitting hand along the shoulder line (+ = hitting side)
      lat(p[owri]),
      dist(p[wri], p[owri]) / torso, // gap between the hands
      ((p[wri][0] - hip[0]) * dir) / torso, // hitting hand ahead of the hips
    );
  }
  const shoW = frames.map((p) => dist(p[5], p[6]) / torso);
  const pc = frames[contact];
  // Serve vs overhead: a serve starts still with both hands low together and
  // the tossing hand then goes up; an overhead usually involves moving.
  const before = [];
  for (let i = Math.max(0, contact - Math.round(1.6 * fps)); i <= Math.max(0, contact - Math.round(0.4 * fps)); i++) before.push(frames[i]);
  const hipAt = (i) => mid(frames[clamp(i, 0, n - 1)][11], frames[clamp(i, 0, n - 1)][12]);
  const moved = dist(hipAt(contact - Math.round(1.0 * fps)), hipAt(contact)) / torso;
  const minGap = before.length ? Math.min(...before.map((p) => dist(p[wri], p[owri]) / torso)) : 0;
  const maxOff = before.length ? Math.max(...before.map((p) => (hip0(p)[1] - p[owri][1]) / torso)) : 0;
  f.push(moved, minGap, maxOff);
  // Motion: hitting-hand velocity (forward, up) and hitting-elbow and knee
  // angles through the swing.
  for (const dt of [-0.5, -0.3, -0.15, 0, 0.15, 0.3]) {
    const i = clamp(contact + Math.round(dt * fps), 1, n - 2);
    const a = frames[i - 1], c2 = frames[i + 1];
    const rel = (p) => [p[wri][0] - hip0(p)[0], p[wri][1] - hip0(p)[1]];
    const ra = rel(a), rc = rel(c2);
    f.push(((rc[0] - ra[0]) * dir * fps) / (2 * torso) / 10, ((ra[1] - rc[1]) * fps) / (2 * torso) / 10);
    const p = frames[i];
    f.push((angleAt(p[ix.hitSho], p[ix.hitElb], p[ix.hitWri]) || 0) / 180, (Math.min(angleAt(p[ix.hitHip], p[ix.hitKnee], p[ix.hitAnk]), angleAt(p[ix.offHip], p[ix.offKnee], p[ix.offAnk])) || 0) / 180);
  }
  f.push(
    Math.min(...shoW) / (Math.max(...shoW) || 1),
    angleAt(pc[ix.hitSho], pc[ix.hitElb], pc[ix.hitWri]) / 180 || 0,
    Math.log(1 + v[contact]),
    (hip0(pc)[1] - pc[0][1]) / torso, // head height
  );
  return f.map((x) => (Number.isFinite(x) ? x : 0));
}
const hip0 = (p) => mid(p[11], p[12]);

// Apply a softmax shot model ({classes, mu, sd, W}) to a feature vector.
// Returns the most likely shot, its probability and all probabilities.
export function predictShot(model, x) {
  const D = model.mu.length;
  const xs = x.map((v, j) => (v - model.mu[j]) / model.sd[j]);
  const layer = (W, input) => W.map((w) => {
    let s = w[input.length];
    for (let j = 0; j < input.length; j++) s += input[j] * w[j];
    return s;
  });
  // 'mlp': one tanh hidden layer (W1, W2); otherwise plain softmax regression (W).
  const z = model.type === 'mlp' ? layer(model.W2, layer(model.W1, xs).map(Math.tanh)) : layer(model.W, xs.slice(0, D));
  const mx = Math.max(...z);
  const ex = z.map((v) => Math.exp(v - mx));
  const se = ex.reduce((a, b) => a + b, 0);
  const p = ex.map((v) => v / se);
  const k = p.indexOf(Math.max(...p));
  return { shot: model.classes[k], confidence: p[k], probs: Object.fromEntries(model.classes.map((c, i) => [c, p[i]])) };
}

// Recognise the shot type of a captured stroke window with the model for the
// camera angle (js/shotmodel.js, trained on real strokes). Below this
// confidence the app asks instead of stating a shot: on players left out of
// training, strokes above it were right 81-89% of the time, those below 40-54%.
export const SURE = 0.7;
export function detectShot(stroke, { hand = 'R', view = 'side' } = {}) {
  const model = SHOT_MODELS && (SHOT_MODELS[view] || SHOT_MODELS.side);
  if (model) {
    const r = predictShot(model, strokeFeatures(stroke, hand));
    const alternatives = Object.entries(r.probs).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([shot, p]) => ({ shot, p }));
    return { shot: r.shot, confidence: r.confidence, sure: r.confidence >= SURE, alternatives, method: 'model' };
  }
  const rule = classifyStroke(stroke, { hand });
  return { ...rule, sure: false, alternatives: [{ shot: rule.shot, p: rule.confidence }], method: 'rules' };
}
