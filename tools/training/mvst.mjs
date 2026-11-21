// MvST (MIT): MediaPipe 33-landmark CSVs -> 17 COCO points, side and back views.
import fs from 'node:fs';
import path from 'node:path';
const DIR = process.env.MVST_DIR || 'data/DatasetMvST/Dataset_AQA_CSV';
const MP = ['NOSE', 'LEFT_EYE', 'RIGHT_EYE', 'LEFT_EAR', 'RIGHT_EAR', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'LEFT_ELBOW', 'RIGHT_ELBOW',
  'LEFT_WRIST', 'RIGHT_WRIST', 'LEFT_HIP', 'RIGHT_HIP', 'LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE'];
const LIMBS = [[5, 7], [7, 9], [6, 8], [8, 10], [11, 13], [13, 15], [12, 14], [14, 16]];
const out = fs.createWriteStream('mvst.jsonl');
let count = 0;
for (const folder of ['forehand', 'backhand', 'forehandNewbie', 'backhandNewbie']) {
  for (const f of fs.readdirSync(path.join(DIR, folder)).filter((x) => x.endsWith('.csv'))) {
    const rows = fs.readFileSync(path.join(DIR, folder, f), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
    const byFrame = new Map();
    for (const r of rows) {
      const fr = +r[0];
      if (!byFrame.has(fr)) byFrame.set(fr, {});
      byFrame.get(fr)[r[1]] = [+r[2], +r[3]];
    }
    const frames = [...byFrame.keys()].sort((a, b) => a - b).map((k) => MP.map((name) => byFrame.get(k)[name] || null));
    if (frames.some((fr) => fr.some((p) => !p))) { console.error('incomplete', f); continue; }
    // Aspect ratio (width/height) that keeps limb lengths most constant.
    let best = null;
    for (let a = 0.4; a <= 2.6; a += 0.01) {
      let cv = 0;
      for (const [i, j] of LIMBS) {
        const L = frames.map((fr) => Math.hypot((fr[i][0] - fr[j][0]) * a, fr[i][1] - fr[j][1]));
        const m = L.reduce((s, x) => s + x, 0) / L.length;
        cv += Math.sqrt(L.reduce((s, x) => s + (x - m) ** 2, 0) / L.length) / m;
      }
      if (!best || cv < best.cv) best = { a, cv };
    }
    // Per-file fits cluster around widescreen but are noisy; use 16:9 for all.
    const W = 1138, H = 640;
    const m = f.match(/^(Forehand|Backhand)_([A-Z])(\d+)_(Side|Back)\.csv$/i);
    const stroke = m[1].toLowerCase();
    out.write(JSON.stringify({
      source: 'mvst', file: `${folder}/${f}`, name: f.replace('.csv', ''), player: `mvst_${m[2]}`, hp: !folder.includes('Newbie'),
      view: m[4] === 'Side' ? 'side' : 'behind', hand: 'R', label: stroke === 'forehand' ? 'forehand' : 'backhand', aspect: +best.a.toFixed(2), aspectFit: +best.cv.toFixed(3),
      w: W, h: H, fps: 30, samples: frames.map((fr, k) => ({ t: k / 30, kps: fr.map((p) => [+(p[0] * W).toFixed(1), +(p[1] * H).toFixed(1), 0.9]) })),
    }) + '\n');
    count++;
  }
}
out.end(() => console.error('mvst strokes', count));
