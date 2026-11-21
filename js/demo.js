// Synthetic stick-figure forehands used for the example comparison shown
// before the coach records anything. These are generated, not real players.

const UPPER_ARM = 55, FOREARM = 50, THIGH = 50, SHIN = 50, TORSO = 100, GROUND = 420;

const rad = (d) => (d * Math.PI) / 180;
// Angles are y-up degrees (0 = toward the net / +x, 90 = up); output is image coords (y down).
const step = (p, len, a) => [p[0] + len * Math.cos(rad(a)), p[1] - len * Math.sin(rad(a))];

const PRO = [
  { t: 0.0, hipX: 320, lean: 8, rx: 3, hx: 2, legR: [-100, -95], legL: [-80, -85], armR: [-60, 10], armL: [-70, 15] },
  { t: 0.55, hipX: 315, lean: 10, rx: -22, hx: -12, legR: [-95, -140], legL: [-45, -90], armR: [-150, -190], armL: [-10, 0] },
  { t: 0.95, hipX: 322, lean: 12, rx: 5, hx: 4, legR: [-110, -130], legL: [-50, -70], armR: [-35, -15], armL: [-100, -60] },
  { t: 1.35, hipX: 326, lean: 6, rx: 20, hx: 12, legR: [-100, -110], legL: [-70, -80], armR: [140, 190], armL: [-120, -80] },
  { t: 1.6, hipX: 326, lean: 5, rx: 20, hx: 12, legR: [-100, -108], legL: [-72, -82], armR: [135, 200], armL: [-115, -85] },
];

const STUDENT = [
  { t: 0.0, hipX: 320, lean: 6, rx: 3, hx: 2, legR: [-95, -92], legL: [-85, -88], armR: [-60, 10], armL: [-70, 15] },
  { t: 0.6, hipX: 317, lean: 6, rx: -12, hx: -6, legR: [-92, -100], legL: [-75, -85], armR: [-140, -175], armL: [-40, -20] },
  { t: 0.95, hipX: 320, lean: 2, rx: 2, hx: 2, legR: [-98, -100], legL: [-78, -80], armR: [-75, -30], armL: [-95, -70] },
  { t: 1.3, hipX: 321, lean: 3, rx: 8, hx: 5, legR: [-95, -95], legL: [-80, -85], armR: [-30, 45], armL: [-110, -80] },
  { t: 1.6, hipX: 321, lean: 3, rx: 8, hx: 5, legR: [-95, -95], legL: [-80, -85], armR: [-35, 40], armL: [-110, -85] },
];

const smoothstep = (x) => x * x * (3 - 2 * x);
const easeIn = (x) => x * x;
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const EASES = [smoothstep, easeIn, easeOut, smoothstep];

function lerpKey(a, b, f) {
  const out = {};
  for (const k of Object.keys(a)) {
    if (Array.isArray(a[k])) out[k] = a[k].map((v, i) => v + (b[k][i] - v) * f);
    else out[k] = a[k] + (b[k] - a[k]) * f;
  }
  return out;
}

function poseAt(keys, t) {
  let k = 0;
  while (k < keys.length - 2 && t > keys[k + 1].t) k++;
  const a = keys[k], b = keys[k + 1];
  const x = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return lerpKey(a, b, EASES[k](x));
}

function skeleton(p) {
  const legDrop = (leg) => -(THIGH * Math.sin(rad(leg[0])) + SHIN * Math.sin(rad(leg[1])));
  const hipY = GROUND - (legDrop(p.legR) + legDrop(p.legL)) / 2;
  const hipC = [p.hipX, hipY];
  const shoC = step(hipC, TORSO, 90 - p.lean);
  const shoR = [shoC[0] + p.rx, shoC[1] - p.rx * 0.08];
  const shoL = [shoC[0] - p.rx, shoC[1] + p.rx * 0.08];
  const hipR = [hipC[0] + p.hx, hipC[1]];
  const hipL = [hipC[0] - p.hx, hipC[1]];
  const kneeR = step(hipR, THIGH, p.legR[0]), ankR = step(kneeR, SHIN, p.legR[1]);
  const kneeL = step(hipL, THIGH, p.legL[0]), ankL = step(kneeL, SHIN, p.legL[1]);
  const elbR = step(shoR, UPPER_ARM, p.armR[0]), wriR = step(elbR, FOREARM, p.armR[1]);
  const elbL = step(shoL, UPPER_ARM, p.armL[0]), wriL = step(elbL, FOREARM, p.armL[1]);
  const head = step(shoC, 32, 90 - p.lean * 1.5);
  const nose = [head[0] + 7, head[1]];
  const pts = [nose, [head[0] + 4, head[1] - 4], [head[0] + 4, head[1] - 4], [head[0] - 4, head[1] - 2], [head[0] - 4, head[1] - 2],
    shoL, shoR, elbL, elbR, wriL, wriR, hipL, hipR, kneeL, kneeR, ankL, ankR];
  return pts.map((q) => [q[0], q[1], 0.9]);
}

export function makeDemoSamples(kind = 'pro', fps = 30) {
  const keys = kind === 'pro' ? PRO : STUDENT;
  const end = keys[keys.length - 1].t;
  const out = [];
  for (let i = 0; i <= Math.round(end * fps); i++) {
    const t = i / fps;
    out.push({ t, kps: skeleton(poseAt(keys, t)) });
  }
  return out;
}

export const DEMO_SIZE = { width: 640, height: 480 };
