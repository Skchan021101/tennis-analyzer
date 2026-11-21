import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shotFromName } from '../js/shots.js';

test('shot names are read from folder and file names', () => {
  const cases = {
    'VIDEO_RGB/backhand2hands/p1_backhand2h_s1.avi': 'backhand2',
    'VIDEO_RGB/backhand/p3_backhand_s2.mp4': 'backhand1',
    'VIDEO_RGB/backhand_slice/p3_slice_s1.mp4': 'slice',
    'VIDEO_RGB/backhand_volley/p5_bvolley_s3.mp4': 'bhVolley',
    'VIDEO_RGB/forehand_volley/p5_fvolley_s3.mp4': 'fhVolley',
    'VIDEO_RGB/forehand_flat/p9_foreflat_s1.mp4': 'forehand',
    'VIDEO_RGB/forehand_openstands/p9_forestand_s1.mp4': 'forehand',
    'VIDEO_RGB/forehand_slice/p9_foreslice_s1.mp4': 'unsupported',
    'VIDEO_RGB/flat_service/p2_serflat_s1.mp4': 'serve',
    'VIDEO_RGB/kick_service/p2_serkick_s1.mp4': 'serve',
    'VIDEO_RGB/smash/p4_smash_s2.mp4': 'overhead',
    'Federer FH side-on.mov': 'forehand',
    'my clips/two-handed backhand 3.mp4': 'backhand2',
    'IMG_4021.MOV': null,
    'p40_foreflat_s1.mp4': 'forehand',
    'p41_foreopen_s1.mp4': 'forehand',
    'p42_backhand2h_s1.mp4': 'backhand2',
    'p43_bslice_s1.mp4': 'slice',
    'p44_bvolley_s1.mp4': 'bhVolley',
    'p45_fvolley_s1.mp4': 'fhVolley',
    'p46_serkick_s1.mp4': 'serve',
    'p47_fslice_s1.mp4': 'unsupported',
    'p48_smash_s1.mp4': 'overhead',
    'p49_backhand_s1.mp4': 'backhand1',
  };
  for (const [path, shot] of Object.entries(cases)) assert.equal(shotFromName(path), shot, path);
});
