// Per-camera-angle recognisers, evaluated on players held out of training.
import fs from 'node:fs';
import { fitMLP, predictMLP } from './mlp.mjs';
const { CLASSES, rows } = JSON.parse(fs.readFileSync('rows.json', 'utf8'));
const H = +(process.argv[2] || 32);
const sets = {
  side: rows.filter((r) => r.view === 'side'),
  behind: rows.filter((r) => r.view === 'behind'),
  front: rows.filter((r) => r.view === 'front'),
  'front (THETIS only)': rows.filter((r) => r.source === 'thetis'),
};
for (const [name, data] of Object.entries(sets)) {
  const players = [...new Set(data.map((r) => r.player))].sort();
  const folds = Math.min(6, players.length);
  const conf = CLASSES.map(() => CLASSES.map(() => 0));
  for (let f = 0; f < folds; f++) {
    const test = new Set(players.filter((_, i) => i % folds === f));
    const model = fitMLP(data.filter((r) => !test.has(r.player)), CLASSES, { H, epochs: 200 });
    for (const r of data.filter((x) => test.has(x.player))) { const k = predictMLP(model, r.x).k; conf[r.y][k]++; r.cv = k; }
  }
  const acc = data.filter((r) => r.cv === r.y).length / data.length;
  const rule = data.filter((r) => r.rule === r.y).length / data.length;
  const bySource = [...new Set(data.map((r) => r.source))].map((s) => { const d = data.filter((r) => r.source === s); return `${s} ${(100 * d.filter((r) => r.cv === r.y).length / d.length).toFixed(1)}%`; }).join(', ');
  const perClass = CLASSES.map((c, k) => { const n = conf[k].reduce((a, b) => a + b, 0); return n ? `${c} ${Math.round((100 * conf[k][k]) / n)}% (n=${n})` : null; }).filter(Boolean).join(', ');
  console.log(`\n${name}: ${data.length} strokes, ${players.length} players. learned ${(100 * acc).toFixed(1)}% (rules ${(100 * rule).toFixed(1)}%) | ${bySource}\n  ${perClass}`);
}
