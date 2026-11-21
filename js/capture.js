// Getting poses out of video: uploaded/recorded clips and the live camera.

import { buildSequence, speedSeries, torsoLength, bodyVisible, cutStroke, strokeQuality, pickStrokes, MIN_STROKE_GAP, VIEW_SPEED } from './analysis.js';
import { shotConfig } from './shots.js';

const FRAME_MAX_DIM = 480;

function waitFor(el, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('This video could not be read. Try an MP4 (H.264) or MOV file.')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(event, ok); el.removeEventListener('error', bad); };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

export async function openVideo(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = URL.createObjectURL(file);
  await waitFor(video, 'loadedmetadata', 15000);
  if (video.readyState < 2) await waitFor(video, 'loadeddata', 15000).catch(() => {});
  // iOS Safari only decodes frames after a play() call.
  try { await video.play(); video.pause(); } catch { /* autoplay refused; seeking still works elsewhere */ }
  return video;
}

async function seek(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return;
  const p = waitFor(video, 'seeked', 5000);
  video.currentTime = t;
  await p;
}

// Run pose estimation over a whole clip.
// timeScale: 1 for real-time video, 4 for 4x slow motion, etc.
export async function processClip(video, estimator, { fps = 30, timeScale = 1, onProgress, signal } = {}) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) throw new Error('This video has no picture the browser can decode.');
  const duration = video.duration;
  const step = timeScale / fps; // video seconds between samples
  const total = Math.max(1, Math.floor(duration / step));
  estimator.reset();
  const samples = [];
  for (let k = 0; k < total; k++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const vt = Math.min(duration - 0.001, k * step);
    await seek(video, vt);
    const kps = await estimator.estimate(video, w, h);
    samples.push({ t: vt / timeScale, kps });
    onProgress?.(k + 1, total);
  }
  return {
    seq: buildSequence(samples, { fps, width: w, height: h }),
    width: w,
    height: h,
    videoTime: (frameIndexInSeq) => (samples[0]?.t ?? 0) * timeScale + frameIndexInSeq * step,
  };
}

function frameCanvas(w, h, maxDim = FRAME_MAX_DIM) {
  const k = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  return c;
}

// Grab display frames for one stroke window.
export async function extractFrames(video, times) {
  const c = frameCanvas(video.videoWidth, video.videoHeight);
  const ctx = c.getContext('2d');
  const out = [];
  for (const t of times) {
    await seek(video, Math.max(0, Math.min(video.duration - 0.001, t)));
    ctx.drawImage(video, 0, 0, c.width, c.height);
    out.push(await createImageBitmap(c));
  }
  return out;
}

export async function bitmapsToBlobs(bitmaps, quality = 0.72) {
  if (!bitmaps?.length) return [];
  const c = document.createElement('canvas');
  c.width = bitmaps[0].width; c.height = bitmaps[0].height;
  const ctx = c.getContext('2d');
  const out = [];
  for (const b of bitmaps) {
    ctx.drawImage(b, 0, 0);
    out.push(await new Promise((r) => c.toBlob(r, 'image/jpeg', quality)));
  }
  return out;
}

export async function blobsToBitmaps(blobs) {
  return Promise.all((blobs || []).map((b) => createImageBitmap(b)));
}

// ---------- live camera ----------

export class LiveSession extends EventTarget {
  constructor(video, overlay) {
    super();
    this.video = video;
    this.overlay = overlay;
    this.buffer = []; // {t, kps, bmp}
    this.keepSeconds = 5.5; // lead-in + confirmation window + margin
    this.running = false;
    this.detecting = true;
    this.lastContactT = -Infinity;
    this.facing = 'environment';
    this.fpsEstimate = 0;
    this.config = { hand: 'R', shot: 'forehand', sensitivity: 1, view: 'side' };
    this.retained = new Map(); // bitmap -> number of captured strokes using it
    this.recentPeaks = []; // hand-speed peaks of the last few strokes
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start(estimator, facing = this.facing) {
    this.estimator = estimator;
    this.facing = facing;
    await this.openStream();
    this.running = true;
    this.estimator.reset();
    this.loop();
  }

  async openStream() {
    this.stopStream();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    if (!this.video.videoWidth) await waitFor(this.video, 'loadeddata', 8000).catch(() => {});
  }

  async flip() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.clearBuffer();
    await this.openStream();
    this.estimator.reset();
  }

  stopStream() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  stop() {
    this.running = false;
    this.stopStream();
    this.clearBuffer();
  }

  clearBuffer() {
    for (const s of this.buffer) if (!this.retained.has(s.bmp)) s.bmp?.close?.();
    this.buffer = [];
  }

  release(bitmaps) {
    for (const b of new Set(bitmaps || [])) {
      const n = (this.retained.get(b) || 0) - 1;
      if (n > 0) { this.retained.set(b, n); continue; }
      this.retained.delete(b);
      if (!this.buffer.some((s) => s.bmp === b)) b.close?.();
    }
  }

  loop() {
    const v = this.video;
    const next = () => {
      if (!this.running) return;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.tick().finally(next));
      else requestAnimationFrame(() => this.tick().finally(next));
    };
    next();
  }

  async tick() {
    const v = this.video;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h || v.readyState < 2) return;
    if (!this.fc || this.fc.srcW !== w || this.fc.srcH !== h) {
      this.fc = frameCanvas(w, h, 360); // ~5 s of live frames stays near 50 MB
      this.fc.srcW = w; this.fc.srcH = h;
      this.fctx = this.fc.getContext('2d');
    }
    const t = performance.now() / 1000;
    let kps;
    try {
      kps = await this.estimator.estimate(v, w, h);
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', { detail: e }));
      return;
    }
    this.fctx.drawImage(v, 0, 0, this.fc.width, this.fc.height);
    const bmp = await createImageBitmap(this.fc);
    this.buffer.push({ t, kps, bmp });
    while (this.buffer.length && this.buffer[0].t < t - this.keepSeconds) {
      const old = this.buffer.shift();
      if (!this.retained.has(old.bmp)) old.bmp.close?.();
    }
    if (this.buffer.length > 5) {
      const span = this.buffer[this.buffer.length - 1].t - this.buffer[this.buffer.length - 6].t;
      if (span > 0) this.fpsEstimate = 5 / span;
    }
    this.dispatchEvent(new CustomEvent('frame', { detail: { kps, w, h, visible: bodyVisible(kps) } }));
    if (this.detecting) this.detect(t);
  }

  detect(now) {
    const cfg = shotConfig(this.config.shot);
    const fps = 30;
    // A swing is confirmed only once nothing later can replace it: a hit that
    // follows the preparation within MIN_STROKE_GAP takes its place.
    const look = Math.max(cfg.post, MIN_STROKE_GAP);
    const win = this.buffer.filter((s) => s.t >= now - (cfg.pre + look + 1.0));
    if (win.length < 8 || win[win.length - 1].t - win[0].t < look + 0.5) return;
    const seq = buildSequence(win, { fps, width: this.video.videoWidth, height: this.video.videoHeight });
    const torso = torsoLength(seq.frames);
    const wri = this.config.hand === 'L' ? 9 : 10;
    const v = speedSeries(seq.frames, wri, fps, torso);
    const tOf = (i) => seq.t0 + i / fps;
    const half = Math.round(0.35 * fps);
    // After a few swings, a stroke must also be at least 40% as fast as this
    // player's typical swing, which filters out slower in-between movements.
    let minSpeed = (cfg.minSpeed * (VIEW_SPEED[this.config.view] || 1)) / this.config.sensitivity;
    if (this.recentPeaks.length >= 3) {
      const sorted = [...this.recentPeaks].sort((x, y) => x - y);
      minSpeed = Math.max(minSpeed, (0.4 / this.config.sensitivity) * sorted[sorted.length >> 1]);
    }
    const cands = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] < minSpeed || !bodyVisible(seq.frames[i])) continue;
      let isMax = true;
      for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) if (v[k] > v[i]) { isMax = false; break; }
      if (isMax && strokeQuality(seq, i, { hand: this.config.hand, torso, v }).ok) cands.push(i);
    }
    const picked = pickStrokes(cands, v, Math.round(MIN_STROKE_GAP * fps), fps);
    const best = picked.find((i) => tOf(i) <= now - look && tOf(i) > this.lastContactT + MIN_STROKE_GAP - 0.05);
    if (best == null) return;
    const tc = tOf(best);
    if (tc - cfg.pre < this.buffer[0].t - 0.05) return; // not enough lead-in recorded yet
    this.lastContactT = tc;
    this.recentPeaks.push(v[best]);
    if (this.recentPeaks.length > 7) this.recentPeaks.shift();

    // Build the stroke from the samples around contact.
    const raw = this.buffer.filter((s) => s.t >= tc - cfg.pre - 0.1 && s.t <= tc + cfg.post + 0.1);
    const full = buildSequence(raw, { fps, width: this.video.videoWidth, height: this.video.videoHeight });
    const contact = Math.round((tc - full.t0) * fps);
    const stroke = cutStroke(full, contact, this.config.shot);
    const bitmaps = stroke.frames.map((_, i) => {
      const t = stroke.t0 + i / fps;
      let bestS = raw[0];
      for (const s of raw) if (Math.abs(s.t - t) < Math.abs(bestS.t - t)) bestS = s;
      return bestS.bmp;
    });
    for (const b of new Set(bitmaps)) this.retained.set(b, (this.retained.get(b) || 0) + 1);
    this.dispatchEvent(new CustomEvent('stroke', { detail: { stroke, bitmaps, width: full.width, height: full.height } }));
  }
}

export { cutStroke };
