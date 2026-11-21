// Final per-view models + confidence calibration on held-out players.
import fs from 'node:fs';
import { fitMLP, predictMLP } from './mlp.mjs';
import * as A from '../../js/analysis.js';
import { loadClips } from './features.mjs';
const { CLASSES, rows } = JSON.parse(fs.readFileSync('rows.json', 'utf8'));
const views = ['side', 'behind', 'front'];
const models = {}, report = {};
for (const view of views) {
  const data = rows.filter((r) => r.view === view);
  const players = [...new Set(data.map((r) => r.player))].sort();
  const preds = [];
  for (let f = 0; f < 6; f++) {
    const test = new Set(players.filter((_, i) => i % 6 === f));
    const m = fitMLP(data.filter((r) => !test.has(r.player)), CLASSES, { H: 32, epochs: 200 });
    for (const r of data.filter((x) => test.has(x.player))) { const p = predictMLP(m, r.x); preds.push({ ok: p.k === r.y, conf: p.p, y: r.y }); }
  }
  const acc = preds.filter((p) => p.ok).length / preds.length;
  const cal = [0.5, 0.6, 0.65, 0.7, 0.8].map((t) => {
    const hi = preds.filter((p) => p.conf >= t), lo = preds.filter((p) => p.conf < t);
    return `>=${t}: ${(100 * hi.length / preds.length).toFixed(0)}% of strokes, ${(100 * hi.filter((p) => p.ok).length / hi.length).toFixed(1)}% right | below: ${(100 * lo.filter((p) => p.ok).length / (lo.length || 1)).toFixed(1)}% right`;
  });
  const perClass = Object.fromEntries(CLASSES.map((c, k) => { const d = preds.filter((p) => p.y === k); return [c, d.length ? +(d.filter((p) => p.ok).length / d.length).toFixed(2) : null]; }));
  report[view] = { strokes: data.length, players: players.length, heldOutAccuracy: +acc.toFixed(3), perClass };
  console.log(`\n${view}: held-out accuracy ${(100 * acc).toFixed(1)}%`);
  cal.forEach((l) => console.log('  ' + l));
  const final = fitMLP(data, CLASSES, { H: 32, epochs: 200 });
  if (view === 'front') {
    // End to end on THETIS beginners p10-p20, never used for training: detect
    // the stroke as the app does for clips, then recognise it.
    const held = loadClips(fs.readdirSync('.').filter((f) => /^beg_\d\.jsonl$/.test(f)));
    let found = 0, right = 0, sure = 0, sureRight = 0;
    for (const c of held) {
      const seq = A.buildSequence(c.samples, { fps: 30, width: c.w, height: c.h });
      let k = A.detectStrokes(seq, { hand: 'R', shot: 'auto', view: 'front' });
      if (!k.length) k = A.detectStrokes(seq, { hand: 'R', shot: 'auto', view: 'front', sensitivity: 2.5, relative: 0.3 });
      if (!k.length) continue;
      found++;
      const v = A.speedSeries(seq.frames, 10, 30, A.torsoLength(seq.frames));
      const contact = k.reduce((b, i) => (v[i] > v[b] ? i : b));
      const p = predictMLP(final, A.strokeFeatures(A.cutStroke(seq, contact, 'auto'), 'R'));
      const ok = CLASSES[p.k] === c.label;
      if (ok) right++;
      if (p.p >= 0.7) { sure++; if (ok) sureRight++; }
    }
    report[view].heldOutBeginners = { clips: held.length, strokeFound: +(found / held.length).toFixed(2), shotRight: +(right / found).toFixed(2), confidentShare: +(sure / found).toFixed(2), rightWhenConfident: +(sureRight / (sure || 1)).toFixed(2) };
    console.log('  held-out beginners (p10-p20):', JSON.stringify(report[view].heldOutBeginners));
  }
  const r5 = (a) => a.map((v) => +v.toFixed(5));
  models[view] = { type: 'mlp', classes: CLASSES, mu: r5(final.mu), sd: r5(final.sd), W1: final.W1.map(r5), W2: final.W2.map(r5) };
}
const hdr = `// Shot recognisers, one per camera angle, trained on real tennis strokes.
// Inputs: analysis.strokeFeatures(); small network (one hidden layer of 32).
// Training data: Tennis-MoCap (Pulgarin-Giraldo et al. 2017, CC BY-SA 3.0)
// rendered side-on, from behind and from the front; MvST (Asror et al., MIT)
// side and behind; THETIS players (Gourgari et al. 2013) front: experienced
// p32-p55 and beginners p1-p9, p21-p31 (p10-p20 kept aside for testing). Accuracy below is on players left out of training (6-fold).
// Because it is derived from Tennis-MoCap, this file is licensed CC BY-SA 3.0.
export const SHOT_MODEL_REPORT = ${JSON.stringify(report)};
export const SHOT_MODELS = ${JSON.stringify(models)};
`;
fs.writeFileSync(process.argv[2] || 'shotmodels.js', hdr);
console.log('\n' + JSON.stringify(report));
