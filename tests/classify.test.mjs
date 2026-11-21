import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../js/analysis.js';
import { samplesFromKeys, makeDemoSamples } from '../js/demo.js';

// Synthetic right-handed strokes, filmed side-on with the player facing +x.
// Only the arms and shoulder turn change between shots; legs stay similar.
// Keyframes are [ready, end of preparation, contact, finish, end]; the
// generator accelerates into the third key and decelerates out of it.
const base = { hipX: 320, lean: 6, hx: 0, legR: [-100, -110], legL: [-70, -80] };
const k = (t, o) => ({ ...base, t, ...o });

const SHOTS = {
  backhand2: [
    k(0, { rx: 3, armR: [-70, 15], armL: [-70, 15] }),
    k(0.6, { rx: 22, armR: [-140, -185], armL: [-140, -185] }),
    k(0.95, { rx: 2, armR: [-30, -10], armL: [-30, -10] }),
    k(1.35, { rx: -18, armR: [130, 190], armL: [130, 190] }),
    k(1.6, { rx: -18, armR: [125, 195], armL: [125, 195] }),
  ],
  backhand1: [
    k(0, { rx: 3, armR: [-70, 15], armL: [-70, 15] }),
    k(0.6, { rx: 22, armR: [-120, -170], armL: [-120, -170] }),
    k(0.95, { rx: 4, armR: [-35, -15], armL: [-160, -200] }),
    k(1.35, { rx: -6, armR: [110, 140], armL: [-170, -195] }),
    k(1.6, { rx: -6, armR: [105, 140], armL: [-170, -195] }),
  ],
  slice: [
    k(0, { rx: 3, armR: [-70, 15], armL: [-70, 15] }),
    k(0.6, { rx: 22, armR: [-170, 170], armL: [-165, 175] }),
    k(0.95, { rx: 4, armR: [-40, -20], armL: [-160, -200] }),
    k(1.35, { rx: 0, armR: [-10, 10], armL: [-170, -195] }),
    k(1.6, { rx: 0, armR: [-12, 8], armL: [-170, -195] }),
  ],
  fhVolley: [
    k(0, { rx: 3, armR: [-70, 40], armL: [-70, 40] }),
    k(0.5, { rx: -10, armR: [-80, 80], armL: [-20, 10] }),
    k(0.75, { rx: 0, armR: [-30, 0], armL: [-30, 0] }),
    k(1.0, { rx: 0, armR: [-26, -6], armL: [-40, -10] }),
    k(1.3, { rx: 0, armR: [-40, 20], armL: [-50, 0] }),
  ],
  bhVolley: [
    k(0, { rx: 3, armR: [-70, 40], armL: [-70, 40] }),
    k(0.55, { rx: 15, armR: [-100, 60], armL: [-100, 60] }),
    k(0.75, { rx: 5, armR: [-30, 0], armL: [-150, -170] }),
    k(1.0, { rx: 5, armR: [-26, -6], armL: [-150, -175] }),
    k(1.3, { rx: 5, armR: [-40, 20], armL: [-140, -170] }),
  ],
  serve: [
    k(0, { rx: 3, armR: [-70, 20], armL: [-70, 20] }),
    k(0.95, { rx: -10, armR: [170, -100], armL: [80, 90], legR: [-80, -125], legL: [-60, -115] }),
    k(1.3, { rx: 5, armR: [80, 85], armL: [-60, -100] }),
    k(1.8, { rx: 10, armR: [-50, -70], armL: [-90, -90] }),
    k(2.0, { rx: 10, armR: [-55, -75], armL: [-90, -90] }),
  ],
  overhead: [
    k(0, { rx: -10, armR: [170, -100], armL: [70, 80] }),
    k(0.5, { rx: -10, armR: [172, -95], armL: [72, 82] }),
    k(0.85, { rx: 5, armR: [80, 85], armL: [-40, -80] }),
    k(1.35, { rx: 10, armR: [-50, -70], armL: [-90, -90] }),
    k(1.6, { rx: 10, armR: [-55, -75], armL: [-90, -90] }),
  ],
};

function classify(samples, hand = 'R', mirror = false) {
  const s = mirror ? samples.map((x) => ({ t: x.t, kps: x.kps.map((p) => [640 - p[0], p[1], p[2]]) })) : samples;
  const seq = A.buildSequence(s, { fps: 30 });
  const contacts = A.detectStrokes(seq, { hand, shot: 'auto' });
  assert.equal(contacts.length, 1, `one stroke detected (got ${contacts.length})`);
  const full = A.cutStroke(seq, contacts[0], 'auto');
  return A.classifyStroke(full, { hand });
}

test('forehand is recognised', () => {
  const r = classify(makeDemoSamples('pro'));
  assert.equal(r.shot, 'forehand', JSON.stringify(r));
  assert.equal(classify(makeDemoSamples('student')).shot, 'forehand');
});

for (const [shot, keys] of Object.entries(SHOTS)) {
  test(`${shot} is recognised, from either side of the court`, () => {
    const samples = samplesFromKeys(keys);
    const r = classify(samples);
    assert.equal(r.shot, shot, JSON.stringify(r));
    assert.equal(classify(samples, 'R', true).shot, shot, 'mirrored footage');
  });
}

test('recut trims a capture window to the shot window', () => {
  const seq = A.buildSequence(makeDemoSamples('pro'), { fps: 30 });
  const c = A.detectStrokes(seq, { hand: 'R', shot: 'auto' })[0];
  const full = A.cutStroke(seq, c, 'auto');
  const { stroke, range } = A.recut(full, 'forehand');
  assert.equal(stroke.frames[stroke.contact], full.frames[full.contact]);
  assert.equal(range[1] - range[0] + 1, stroke.frames.length);
});
