import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../js/analysis.js';
import { makeDemoSamples, DEMO_SIZE } from '../js/demo.js';
import { SHOTS } from '../js/shots.js';

const analyzeDemo = (kind, opts = {}) => {
  const seq = A.buildSequence(makeDemoSamples(kind), { fps: 30, ...DEMO_SIZE });
  const contacts = A.detectStrokes(seq, { hand: 'R', shot: 'forehand' });
  const stroke = A.cutStroke(seq, contacts[0], 'forehand');
  return { seq, contacts, stroke, an: A.analyzeStroke(stroke, { shot: 'forehand', hand: 'R', ...opts }) };
};

test('finds one forehand at the forward-swing peak, not the take-back', () => {
  const { contacts, seq } = analyzeDemo('pro');
  assert.equal(contacts.length, 1);
  const t = contacts[0] / seq.fps;
  assert.ok(t > 0.85 && t < 1.05, `contact at ${t}s`);
});

test('events are ordered and metrics are plausible', () => {
  const { an } = analyzeDemo('pro');
  const e = an.events;
  assert.ok(e.start < e.prep && e.prep < e.contact && e.contact < e.finish && e.finish <= e.end);
  assert.equal(an.dir, 1);
  assert.ok(an.metrics.loadKnee > 120 && an.metrics.loadKnee < 145);
  assert.ok(an.metrics.contactFront > 0.8, 'contact in front of the hips');
  assert.ok(an.metrics.finishHeight > 1.2, 'high finish');
});

test('a stroke compared with itself scores 100', () => {
  const { an } = analyzeDemo('pro');
  const cmp = A.compareStrokes(an, an);
  assert.equal(cmp.score, 100);
  assert.deepEqual(cmp.phases, { prep: 100, contact: 100, finish: 100 });
});

test('the demo student scores lower and gets coaching tips', () => {
  const pro = analyzeDemo('pro').an, stu = analyzeDemo('student').an;
  const cmp = A.compareStrokes(stu, pro);
  assert.ok(cmp.score < 85 && cmp.score > 30, `score ${cmp.score}`);
  const ev = A.evaluate(stu.metrics, pro.metrics, 'forehand', 'Demo pro');
  assert.ok(ev.tips.length >= 1 && ev.tips.length <= 3);
  assert.ok(ev.rows.some((r) => r.key === 'loadKnee' && r.status === 'work'));
  assert.ok(ev.tips.every((t) => !/\{[a-z]+\}/.test(t.text)), 'placeholders are filled');
});

test('mirrored footage (other side of the court) gives the same comparison', () => {
  const mirror = (samples) => samples.map((s) => ({ t: s.t, kps: s.kps.map((p) => [DEMO_SIZE.width - p[0], p[1], p[2]]) }));
  const seq = A.buildSequence(mirror(makeDemoSamples('pro')), { fps: 30, ...DEMO_SIZE });
  const c = A.detectStrokes(seq, { hand: 'R', shot: 'forehand' });
  const an = A.analyzeStroke(A.cutStroke(seq, c[0], 'forehand'), { shot: 'forehand', hand: 'R' });
  assert.equal(an.dir, -1);
  const ref = analyzeDemo('pro').an;
  assert.ok(A.compareStrokes(an, ref).score >= 98);
  assert.ok(Math.abs(an.metrics.contactFront - ref.metrics.contactFront) < 0.01);
});

test('left/right swaps in single frames are repaired', () => {
  const samples = makeDemoSamples('pro');
  const broken = samples.map((s, i) => {
    const kps = s.kps.map((p) => p.slice());
    if (i === 20) { [kps[9], kps[10]] = [kps[10], kps[9]]; [kps[7], kps[8]] = [kps[8], kps[7]]; [kps[5], kps[6]] = [kps[6], kps[5]]; }
    return { t: s.t, kps };
  });
  A.fixSwaps(broken);
  assert.deepEqual(broken[20].kps[10], samples[20].kps[10]);
});

test('resample and gap filling handle missing points', () => {
  const samples = makeDemoSamples('pro').map((s, i) => ({ t: s.t * 1.003 + (i % 2) * 0.004, kps: s.kps.map((p) => (i === 10 ? [0, 0, 0.01] : p)) }));
  const seq = A.buildSequence(samples, { fps: 30 });
  const f = seq.frames[10][10];
  assert.ok(f[0] > 100 && f[1] > 100, 'missing wrist interpolated from neighbours');
});

test('anchor mapping round-trips', () => {
  const an = A.anchors({ start: 0, prep: 12, contact: 20, finish: 27, end: 40 });
  for (const i of [0, 5, 12, 16, 20, 25, 33, 40]) assert.ok(Math.abs(A.indexFromU(an, A.uFromIndex(an, i)) - i) < 1e-9);
});

test('every shot has metrics with copy and a phase list', () => {
  for (const s of SHOTS) {
    assert.equal(s.phases.length, 3);
    const ev = A.evaluate(analyzeDemo('student').an.metrics, null, s.id);
    assert.equal(ev.rows.length, Object.keys(s.metrics).length);
  }
});

test('running across the court without swinging is not a stroke', () => {
  const base = makeDemoSamples('pro')[0].kps;
  const samples = Array.from({ length: 60 }, (_, i) => ({ t: i / 30, kps: base.map((p) => [p[0] + i * 25, p[1], p[2]]) }));
  const seq = A.buildSequence(samples, { fps: 30 });
  assert.deepEqual(A.detectStrokes(seq, { hand: 'R', shot: 'forehand' }), []);
});

test('tracking glitches and small movements are not strokes', () => {
  const base = makeDemoSamples('pro')[0].kps;
  // Standing still with the hand jumping away for one frame (a tracking glitch).
  const glitch = Array.from({ length: 60 }, (_, i) => ({
    t: i / 30,
    kps: base.map((p, j) => (j === 10 && i === 30 ? [p[0] + 120, p[1] - 60, 0.4] : p)),
  }));
  assert.deepEqual(A.detectStrokes(A.buildSequence(glitch, { fps: 30 }), { hand: 'R', shot: 'auto' }), []);
  // A quick small flick of the hand (e.g. adjusting the grip).
  const flick = Array.from({ length: 60 }, (_, i) => ({
    t: i / 30,
    kps: base.map((p, j) => (j === 10 ? [p[0] + 25 * Math.exp(-(((i - 30) / 2) ** 2)), p[1], p[2]] : p)),
  }));
  assert.deepEqual(A.detectStrokes(A.buildSequence(flick, { fps: 30 }), { hand: 'R', shot: 'auto' }), []);
});

test('two real swings close together are counted once each', () => {
  const one = makeDemoSamples('pro');
  const dur = one[one.length - 1].t + 1 / 30;
  const two = [...one, ...one.map((s) => ({ t: s.t + dur, kps: s.kps }))];
  const seq = A.buildSequence(two, { fps: 30 });
  assert.equal(A.detectStrokes(seq, { hand: 'R', shot: 'auto' }).length, 2);
});
