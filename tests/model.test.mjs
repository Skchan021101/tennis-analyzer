import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../js/analysis.js';
import { SHOT_MODELS, SHOT_MODEL_REPORT } from '../js/shotmodel.js';
import { SHOTS } from '../js/shots.js';
import { makeDemoSamples, DEMO_SIZE } from '../js/demo.js';

const demoStroke = (samples) => {
  const seq = A.buildSequence(samples, { fps: 30, ...DEMO_SIZE });
  return A.cutStroke(seq, A.detectStrokes(seq, { hand: 'R', shot: 'auto' })[0], 'auto');
};

test('a model ships for every camera angle, with its held-out accuracy', () => {
  for (const view of ['side', 'behind', 'front']) {
    const m = SHOT_MODELS[view];
    assert.equal(m.type, 'mlp');
    assert.deepEqual(m.classes, SHOTS.map((s) => s.id));
    assert.equal(m.mu.length, A.strokeFeatures(demoStroke(makeDemoSamples('pro'))).length, 'feature count matches');
    assert.ok(SHOT_MODEL_REPORT[view].heldOutAccuracy > 0.7);
  }
});

test('detectShot returns a shot, a confidence and the two best guesses', () => {
  const r = A.detectShot(demoStroke(makeDemoSamples('pro')), { hand: 'R', view: 'side' });
  assert.ok(SHOTS.some((s) => s.id === r.shot));
  assert.ok(r.confidence > 0 && r.confidence <= 1);
  assert.equal(r.alternatives.length, 2);
  assert.equal(r.alternatives[0].shot, r.shot);
  assert.equal(r.sure, r.confidence >= A.SURE);
});

test('a left-hander gets the same answer as the mirrored right-hander', () => {
  const SWAP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15];
  for (const kind of ['pro', 'student']) {
    const right = makeDemoSamples(kind);
    const left = right.map((s) => ({ t: s.t, kps: SWAP.map((j) => [DEMO_SIZE.width - s.kps[j][0], s.kps[j][1], s.kps[j][2]]) }));
    for (const view of ['side', 'behind', 'front']) {
      const a = A.detectShot(demoStroke(right), { hand: 'R', view });
      const seqL = A.buildSequence(left, { fps: 30, ...DEMO_SIZE });
      const b = A.detectShot(A.cutStroke(seqL, A.detectStrokes(seqL, { hand: 'L', shot: 'auto' })[0], 'auto'), { hand: 'L', view });
      assert.equal(b.shot, a.shot, `${kind} ${view}`);
      assert.ok(Math.abs(a.confidence - b.confidence) < 1e-6);
    }
  }
});
