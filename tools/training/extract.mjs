// Run MoveNet Thunder over video files in Node (tfjs WASM backend), with the
// same tracking-crop logic as the app, and write raw pose samples as JSON.
// Usage: node extract.mjs out.jsonl file1.mp4 file2.mp4 ...
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-converter';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';

const here = path.dirname(new URL(import.meta.url).pathname);
setWasmPaths(path.join(here, 'node_modules/@tensorflow/tfjs-backend-wasm/dist/'));
await tf.setBackend('wasm');
await tf.ready();

const MODEL_DIR = path.join(here, '../../models/movenet-thunder');
const SIZE = 256;
const modelJson = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'model.json'), 'utf8'));
const weights = fs.readFileSync(path.join(MODEL_DIR, 'movenet-thunder.bin'));
const model = await loadGraphModel({
  load: async () => ({
    modelTopology: modelJson.modelTopology,
    weightSpecs: modelJson.weightsManifest[0].weights,
    weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
    signature: modelJson.signature,
  }),
});

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return { w, h };
}

function frames(file, fps) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', file, '-vf', `fps=${fps}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  return r.stdout;
}

const fullCrop = (w, h) => { const s = Math.max(w, h); return { x: (w - s) / 2, y: (h - s) / 2, size: s }; };

function nextCrop(kps, w, h) {
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
  let half = Math.max(tx * 1.9, ty * 1.9, bx * 1.3, by * 1.3, ty * 3.2);
  if (half >= Math.max(w, h) / 2) return null;
  return { x: cx - half, y: cy - half, size: half * 2 };
}

async function run(img, w, h, crop) {
  const out = tf.tidy(() => {
    const box = [[crop.y / (h - 1), crop.x / (w - 1), (crop.y + crop.size) / (h - 1), (crop.x + crop.size) / (w - 1)]];
    const resized = tf.image.cropAndResize(img, box, [0], [SIZE, SIZE], 'bilinear', 0);
    return model.execute(tf.cast(resized, 'int32'));
  });
  const d = await out.data();
  out.dispose();
  const kps = [];
  for (let i = 0; i < 17; i++) kps.push([crop.x + d[i * 3 + 1] * crop.size, crop.y + d[i * 3] * crop.size, d[i * 3 + 2]]);
  return kps;
}

let [outFile, ...files] = process.argv.slice(2);
// "@list.txt" = THETIS repo paths, fetched one at a time with git show.
const REPO = process.env.THETIS_REPO;
if (files.length === 1 && files[0].startsWith('@')) files = fs.readFileSync(files[0].slice(1), 'utf8').split('\n').filter(Boolean);
const FPS = +(process.env.FPS || 30);
const done = new Set(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);
const out = fs.createWriteStream(outFile, { flags: 'a' });
for (const file of files) {
  if (done.has(file)) continue;
  const t0 = Date.now();
  let src = file;
  if (REPO) {
    src = path.join(here, `tmp-${process.pid}.avi`);
    fs.writeFileSync(src, spawnSync('git', ['-C', REPO, 'show', `HEAD:${file}`], { maxBuffer: 1 << 29 }).stdout);
  }
  const { w, h } = probe(src);
  if (!w) { console.error('unreadable', file); continue; }
  const buf = frames(src, FPS);
  const n = Math.floor(buf.length / (w * h * 3));
  let crop = null;
  const samples = [];
  for (let k = 0; k < n; k++) {
    const img = tf.tensor4d(new Uint8Array(buf.buffer, buf.byteOffset + k * w * h * 3, w * h * 3), [1, h, w, 3], 'int32');
    let kps;
    if (crop) {
      kps = await run(img, w, h, crop);
      if ([5, 6, 11, 12].reduce((s, i) => s + kps[i][2], 0) / 4 < 0.25) crop = null;
    }
    if (!crop) {
      kps = await run(img, w, h, fullCrop(w, h));
      const c = nextCrop(kps, w, h);
      if (c) kps = await run(img, w, h, c);
    }
    crop = nextCrop(kps, w, h);
    img.dispose();
    samples.push({ t: k / FPS, kps: kps.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(3)]) });
  }
  out.write(JSON.stringify({ file, w, h, fps: FPS, samples }) + '\n');
  console.error(`${path.basename(file)}: ${n} frames, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
out.end();
