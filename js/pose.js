// MoveNet single-pose inference with TensorFlow.js (loaded as the global `tf`).
// Follows the player with a crop region so small, distant players still get
// enough pixels.

const MODELS = {
  thunder: { url: 'models/movenet-thunder/model.json', size: 256 },
  lightning: { url: 'models/movenet-lightning/model.json', size: 192 },
};

let backendReady = null;
async function ensureBackend() {
  if (!backendReady) {
    backendReady = (async () => {
      const tf = globalThis.tf;
      if (!tf) throw new Error('TensorFlow.js failed to load.');
      try { await tf.setBackend('webgl'); } catch { await tf.setBackend('cpu'); }
      await tf.ready();
      return tf.getBackend();
    })();
  }
  return backendReady;
}

const loaded = {};
async function loadModel(kind) {
  if (!loaded[kind]) {
    loaded[kind] = (async () => {
      await ensureBackend();
      const tf = globalThis.tf;
      const model = await tf.loadGraphModel(MODELS[kind].url);
      const s = MODELS[kind].size;
      tf.tidy(() => model.execute(tf.zeros([1, s, s, 3], 'int32')));
      return model;
    })().catch((e) => { delete loaded[kind]; throw e; });
  }
  return loaded[kind];
}

export class PoseEstimator {
  constructor(kind = 'thunder') {
    this.kind = kind;
    this.size = MODELS[kind].size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.crop = null;
    this.lastMs = 0;
  }

  async load() {
    this.model = await loadModel(this.kind);
    return this;
  }

  backend() { return globalThis.tf ? globalThis.tf.getBackend() : null; }

  reset() { this.crop = null; }

  fullCrop(w, h) {
    const size = Math.max(w, h);
    return { x: (w - size) / 2, y: (h - size) / 2, size };
  }

  async run(source, w, h, crop) {
    const S = this.size, ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    // Draw only the part of the crop that lies inside the frame.
    const sx = Math.max(0, crop.x), sy = Math.max(0, crop.y);
    const ex = Math.min(w, crop.x + crop.size), ey = Math.min(h, crop.y + crop.size);
    if (ex > sx && ey > sy) {
      const k = S / crop.size;
      ctx.drawImage(source, sx, sy, ex - sx, ey - sy, (sx - crop.x) * k, (sy - crop.y) * k, (ex - sx) * k, (ey - sy) * k);
    }
    const tf = globalThis.tf;
    const out = tf.tidy(() => {
      const input = tf.browser.fromPixels(this.canvas).expandDims(0).toInt();
      return this.model.execute(input);
    });
    const data = await out.data();
    out.dispose();
    const kps = [];
    for (let i = 0; i < 17; i++) {
      const y = data[i * 3], x = data[i * 3 + 1], s = data[i * 3 + 2];
      kps.push([crop.x + x * crop.size, crop.y + y * crop.size, s]);
    }
    return kps;
  }

  nextCrop(kps, w, h) {
    const ok = (i) => kps[i][2] > 0.25;
    const torso = [5, 6, 11, 12].filter(ok);
    if (torso.length < 2) return null;
    const hips = [11, 12].filter(ok);
    const base = hips.length ? hips : [5, 6].filter(ok);
    const cx = base.reduce((s, i) => s + kps[i][0], 0) / base.length;
    const cy = base.reduce((s, i) => s + kps[i][1], 0) / base.length;
    let tx = 0, ty = 0, bx = 0, by = 0;
    for (const i of torso) { tx = Math.max(tx, Math.abs(cx - kps[i][0])); ty = Math.max(ty, Math.abs(cy - kps[i][1])); }
    for (let i = 0; i < 17; i++) if (ok(i)) { bx = Math.max(bx, Math.abs(cx - kps[i][0])); by = Math.max(by, Math.abs(cy - kps[i][1])); }
    let half = Math.max(tx * 1.9, ty * 1.9, bx * 1.3, by * 1.3);
    // Leave room for the racquet arm reaching out or up.
    half = Math.max(half, ty * 3.2);
    const maxHalf = Math.max(w, h) / 2;
    if (half >= maxHalf) return null;
    return { x: cx - half, y: cy - half, size: half * 2 };
  }

  // Estimate the pose in a video frame / image. Returns 17 [x, y, score] in
  // source pixels.
  async estimate(source, w, h) {
    const t0 = performance.now();
    let kps;
    if (this.crop) {
      kps = await this.run(source, w, h, this.crop);
      const conf = [5, 6, 11, 12].reduce((s, i) => s + kps[i][2], 0) / 4;
      if (conf < 0.25) this.crop = null;
    }
    if (!this.crop) {
      kps = await this.run(source, w, h, this.fullCrop(w, h));
      const c = this.nextCrop(kps, w, h);
      if (c) kps = await this.run(source, w, h, c);
    }
    this.crop = this.nextCrop(kps, w, h);
    this.lastMs = performance.now() - t0;
    return kps;
  }
}

export async function createEstimator(kind) {
  const e = new PoseEstimator(kind);
  await e.load();
  return e;
}
