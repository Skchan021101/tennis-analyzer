// Build Stroke Match library files (Pro library > Import) from the real-stroke
// sources. Skeleton-only references (no video frames), labelled by camera
// angle, from skilled players only:
//   THETIS experts p32-p55 (front)     - research dataset, cite the authors
//   Tennis-MoCap high-performance players (side, behind, front) - CC BY-SA 3.0
//   MvST trained players A, B, C, H (side, behind)               - MIT
// Usage: node library.mjs outdir [perShotPerView]
import fs from 'node:fs';
import path from 'node:path';
import * as A from '../../js/analysis.js';
import { SHOT_BY_ID } from '../../js/shots.js';
import { loadClips, strokeOf, loadStrokeFile, backhandLabel } from './features.mjs';

const [outDir, perArg] = process.argv.slice(2);
const PER = +(perArg || 5);
fs.mkdirSync(outDir, { recursive: true });

const VARIANT = { forehand_flat: 'flat', forehand_openstands: 'open stance', flat_service: 'flat', kick_service: 'kick', slice_service: 'slice' };
const VIEW_NAME = { side: 'side-on', behind: 'from behind', front: 'from the front' };
const SOURCES = {
  thetis: { title: 'THETIS', note: 'THETIS dataset (Gourgari et al., CVPR Workshops 2013), expert player, front view; research dataset, cite the authors' },
  mocap: { title: 'Tennis-MoCap', note: 'Tennis-MoCap (Pulgarin-Giraldo et al., 2017), high-performance player, 3D motion capture rendered to 2D; CC BY-SA 3.0' },
  mvst: { title: 'MvST', note: 'MvST tennis skeleton dataset (Asror et al., 2026), trained player; MIT licence' },
};

const clips = [];
const thetisFiles = fs.readdirSync('.').filter((f) => /^out_\d\.jsonl$/.test(f));
clips.push(...loadClips(thetisFiles).filter((c) => c.player >= 32).map((c) => ({ ...c, source: 'thetis', view: 'front', hand: 'R', hp: true })));
if (fs.existsSync('mocap.jsonl')) clips.push(...loadStrokeFile('mocap.jsonl').filter((c) => c.hp));
if (fs.existsSync('mvst.jsonl')) clips.push(...loadStrokeFile('mvst.jsonl').filter((c) => c.hp));

// Anonymous player numbers per source.
const alias = new Map();
const aliasOf = (c) => {
  if (c.source === 'thetis') return `p${c.player}`;
  const k = `${c.source}/${c.player}`;
  if (!alias.has(k)) alias.set(k, String.fromCharCode(65 + [...alias.keys()].filter((x) => x.startsWith(c.source)).length));
  return `player ${alias.get(k)}`;
};

const cands = [];
for (const c of clips) {
  const label = backhandLabel(c);
  if (!label) continue; // ambiguous one/two-handed backhand
  const s = strokeOf(c, c.hand);
  if (!s || s.relaxed) continue;
  const { stroke } = A.recut(s.full, label);
  const an = A.analyzeStroke(stroke, { shot: label, hand: c.hand });
  if (an.handSwapped || an.legsHidden || an.armHidden) continue;
  const q = A.strokeQuality(stroke, an.events.contact, { hand: c.hand });
  if (!q.ok) continue;
  let conf = 0;
  for (const f of stroke.frames) for (const p of f.slice(5)) conf += p[2];
  conf /= stroke.frames.length * 12;
  cands.push({ c, label, stroke, an, conf });
}

const round = (frames) => frames.map((f) => f.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100]));
const t0 = Date.parse('2026-11-21T00:00:00Z');
const all = [];
const summary = [];
for (const shot of Object.keys(SHOT_BY_ID)) {
  for (const view of ['side', 'behind', 'front']) {
    const pool = cands.filter((x) => x.label === shot && x.c.view === view);
    // One stroke per player (best tracked), then the best players; if there
    // are fewer players than wanted, add each player's next-best strokes.
    const byPlayer = new Map();
    for (const x of pool.sort((a, b) => b.conf - a.conf)) {
      const k = `${x.c.source}/${x.c.player}`;
      if (!byPlayer.has(k)) byPlayer.set(k, []);
      byPlayer.get(k).push(x);
    }
    const chosen = [];
    for (let round = 0; chosen.length < PER && round < 5; round++) {
      for (const list of byPlayer.values()) if (list[round] && chosen.length < PER) chosen.push(list[round]);
    }
    for (const x of chosen) {
      const v = VARIANT[x.c.folder];
      all.push({
        id: `ref_${x.c.source}_${String(x.c.name || x.c.file).replace(/[^a-z0-9]+/gi, '_')}_${view}`,
        createdAt: t0 + all.length,
        shot, view, hand: x.c.hand,
        label: `${SOURCES[x.c.source].title} ${aliasOf(x.c)} · ${SHOT_BY_ID[shot].name}${v ? ` (${v})` : ''} · ${VIEW_NAME[view]}`,
        fps: x.stroke.fps, width: x.c.w, height: x.c.h,
        contact: x.an.events.contact, frames: round(x.stroke.frames), images: [],
        source: SOURCES[x.c.source].note,
      });
    }
    summary.push(`${shot.padEnd(10)} ${view.padEnd(7)} ${chosen.length} refs (${byPlayer.size} players available)`);
  }
}
const write = (file, refs) => {
  fs.writeFileSync(path.join(outDir, file), JSON.stringify({ app: 'stroke-match', version: 1, exportedAt: new Date().toISOString(), refs, sessions: [] }));
  console.log(`${file}: ${refs.length} references, ${(fs.statSync(path.join(outDir, file)).size / 1024).toFixed(0)} KB`);
};
console.log(summary.join('\n'));
// Openly licensed references (Tennis-MoCap CC BY-SA 3.0, MvST MIT) ship with
// the app; THETIS-derived references are written to a separate file.
write('starter.json', all.filter((r) => !r.id.startsWith('ref_thetis_')));
write('thetis-front.json', all.filter((r) => r.id.startsWith('ref_thetis_')));
