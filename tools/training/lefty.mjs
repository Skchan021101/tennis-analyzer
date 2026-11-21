// A left-hander is a mirrored right-hander with left/right labels swapped.
// The recogniser should give the same answer for both.
import * as A from '../../js/analysis.js';
import { loadStrokeFile, strokeOf, backhandLabel } from './features.mjs';
const SWAP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];
let same = 0, total = 0, rightR = 0, rightL = 0;
for (const c of loadStrokeFile('mocap.jsonl').filter((_, i) => i % 3 === 0)) {
  const label = backhandLabel(c);
  if (!label) continue;
  const lefty = { ...c, samples: c.samples.map((s) => ({ t: s.t, kps: SWAP.map((j) => [c.w - s.kps[j][0], s.kps[j][1], s.kps[j][2]]) })) };
  const a = strokeOf(c, 'R'), b = strokeOf(lefty, 'L');
  if (!a || !b) continue;
  const pa = A.detectShot(a.full, { hand: 'R', view: c.view }).shot, pb = A.detectShot(b.full, { hand: 'L', view: c.view }).shot;
  total++; if (pa === pb) same++; if (pa === label) rightR++; if (pb === label) rightL++;
}
console.log(`strokes ${total}: same answer for right- and left-handed version ${(100 * same / total).toFixed(1)}%; correct right-handed ${(100 * rightR / total).toFixed(1)}%, left-handed ${(100 * rightL / total).toFixed(1)}% (training players)`);
