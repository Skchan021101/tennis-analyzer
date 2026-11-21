// Turn extracted THETIS pose samples into strokes + feature vectors.
import fs from 'node:fs';
import * as A from '../../js/analysis.js';

export const LABEL = {
  backhand: 'backhand1', backhand2hands: 'backhand2', backhand_slice: 'slice', backhand_volley: 'bhVolley',
  flat_service: 'serve', kick_service: 'serve', slice_service: 'serve', smash: 'overhead',
  forehand_flat: 'forehand', forehand_openstands: 'forehand', forehand_volley: 'fhVolley',
};

export function loadClips(files) {
  const clips = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      const c = JSON.parse(line);
      const folder = c.file.split('/').slice(-2)[0];
      const name = c.file.split('/').pop().replace('.avi', '');
      c.label = LABEL[folder];
      c.folder = folder;
      c.player = +name.match(/^p(\d+)/i)[1];
      c.take = +name.match(/_s(\d+)$/)[1];
      c.name = name;
      if (c.label) clips.push(c);
    }
  }
  return clips;
}

// One stroke per clip: the strongest detected swing (THETIS clips hold one).
export function strokeOf(clip, hand = 'R', view = clip.view || 'side') {
  const seq = A.buildSequence(clip.samples, { fps: 30, width: clip.w, height: clip.h });
  let contacts = A.detectStrokes(seq, { hand, shot: 'auto', view });
  let relaxed = false;
  if (!contacts.length) { contacts = A.detectStrokes(seq, { hand, shot: 'auto', view, sensitivity: 2.5, relative: 0.3 }); relaxed = true; }
  if (!contacts.length) return null;
  const contact = A.strongestStroke(seq, contacts, hand);
  return { seq, full: A.cutStroke(seq, contact, 'auto'), relaxed, nDetected: contacts.length };
}

// Generic loader for the converted MoCap / MvST strokes (one stroke per line,
// label already known). Backhands without a one/two-handed label are split by
// the gap between the hands at contact.
export function loadStrokeFile(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const c = JSON.parse(line);
    out.push(c);
  }
  return out;
}

export function labelBackhand(stroke, hand = 'R') {
  const f = stroke.frames[stroke.contact];
  const torso = A.torsoLength(stroke.frames);
  const gap = A.dist(f[9], f[10]) / torso;
  return gap < 0.45 ? 'backhand2' : 'backhand1';
}

// One- or two-handed backhand per player, read from the gap between the hands
// at contact across all their backhands (players don't switch mid-session).
// null = ambiguous (gap ~0.45-0.6 torso lengths): their backhands are left out.
export const BACKHAND_STYLE = {
  'mocap/astrejos': 'backhand1', 'mocap/jangel': null, 'mocap/mrios': null, 'mocap/jsguevara': null,
  'mvst/mvst_A': 'backhand1', 'mvst/mvst_B': 'backhand1', 'mvst/mvst_E': 'backhand1',
  'mvst/mvst_C': 'backhand2', 'mvst/mvst_S': 'backhand2',
  'mvst/mvst_H': null, 'mvst/mvst_F': null, 'mvst/mvst_G': null,
};
// Returns the label to train on, or null to skip the stroke.
export function backhandLabel(c) {
  if (!/^backhand[12]?$/.test(c.label) || c.source === 'thetis') return c.label;
  const k = `${c.source}/${c.player}`;
  return k in BACKHAND_STYLE ? BACKHAND_STYLE[k] : 'backhand2';
}
