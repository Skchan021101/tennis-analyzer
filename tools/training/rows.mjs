// Detect each stroke once and cache features + labels (rows.json).
import fs from 'node:fs';
import * as A from '../../js/analysis.js';
import { loadClips, strokeOf, loadStrokeFile, backhandLabel } from './features.mjs';
const CLASSES = ['forehand', 'backhand2', 'backhand1', 'slice', 'serve', 'fhVolley', 'bhVolley', 'overhead'];
// THETIS: experienced players (out_*) and beginners (begtrain_*, players p1-p9
// and p21-p31; p10-p20 are kept aside for testing).
const clips = loadClips(fs.readdirSync('.').filter((f) => /^(out|begtrain)_\d\.jsonl$/.test(f))).map((c) => ({ ...c, source: 'thetis', view: 'front', hand: 'R' }));
for (const f of ['mocap.jsonl', 'mvst.jsonl']) clips.push(...loadStrokeFile(f));
const rows = [];
for (const c of clips) {
  const label = backhandLabel(c);
  if (!label) continue; // ambiguous one/two-handed backhand
  const s = strokeOf(c, c.hand);
  if (!s) continue;
  rows.push({ source: c.source, view: c.view, player: `${c.source}/${c.player}`, hp: c.source === 'thetis' ? c.player >= 32 : !!c.hp, name: c.name || c.file, x: A.strokeFeatures(s.full, c.hand), y: CLASSES.indexOf(label), rule: CLASSES.indexOf(A.classifyStroke(s.full, { hand: c.hand }).shot) });
}
fs.writeFileSync('rows.json', JSON.stringify({ CLASSES, rows }));
console.log('rows', rows.length);
