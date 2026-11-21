import { SHOTS, SHOT_BY_ID, VIEWS, AUTO, METRICS, shotFromName } from './shots.js';
import * as A from './analysis.js';
import { createEstimator } from './pose.js';
import { openVideo, processClip, extractFrames, bitmapsToBlobs, blobsToBitmaps, LiveSession } from './capture.js';
import * as store from './store.js';
import { StrokeViewer } from './viewer.js';
import { makeDemoSamples, DEMO_SIZE } from './demo.js';

const APP_VERSION = 'Version 4 · cleaner detection, live swing overlay';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const viewName = (id) => VIEWS.find((v) => v.id === id)?.name || id;
const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// ---------- preferences (per device) ----------
const PREF_KEY = 'stroke-match-prefs';
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

const state = {
  shot: SHOT_BY_ID[prefs.shot] ? prefs.shot : 'auto', // 'auto' = detect the shot type
  hand: prefs.hand === 'L' ? 'L' : 'R',
  view: VIEWS.some((v) => v.id === prefs.view) ? prefs.view : 'side',
  student: prefs.student || '',
  refs: [],
  sessions: [],
  current: null,
  clip: null,
  liveStrokes: [],
  liveTally: {},
  live: null,
  refBitmaps: new Map(),
  busy: null,
};

// ---------- pose models ----------
const estimators = {};
async function getEstimator(kind, onStatus) {
  if (!estimators[kind]) {
    onStatus?.(kind === 'thunder' ? 'Loading the accurate pose model (12 MB, first time only)…' : 'Loading the fast pose model…');
    estimators[kind] = createEstimator(kind).catch((e) => { delete estimators[kind]; throw e; });
  }
  return estimators[kind];
}

// ---------- messages & progress ----------
function showMessage(el, text, kind = '') {
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}
function setProgress(prefix, text, frac) {
  $(`${prefix}progress`).hidden = false;
  $(`${prefix}progress-text`).textContent = text;
  $(`${prefix}progress-fill`).style.width = `${Math.round((frac || 0) * 100)}%`;
}
const hideProgress = (prefix) => { $(`${prefix}progress`).hidden = true; };

// ---------- tabs ----------
function route() {
  const tab = (location.hash || '#analyze').slice(1);
  const valid = ['analyze', 'library', 'history'].includes(tab) ? tab : 'analyze';
  for (const t of ['analyze', 'library', 'history']) $(`view-${t}`).hidden = t !== valid;
  document.querySelectorAll('[data-tab]').forEach((a) => {
    if (a.dataset.tab === valid) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (valid === 'library') renderLibrary();
  if (valid === 'history') renderHistory();
  if (valid === 'analyze') viewer.resize();
}
window.addEventListener('hashchange', route);

// ---------- setup form ----------
function buildSetup() {
  $('shot-chips').innerHTML = [AUTO, ...SHOTS].map((s) => `
    <label class="chip${s.id === 'auto' ? ' chip-auto' : ''}"><input type="radio" name="shot" value="${s.id}" ${s.id === state.shot ? 'checked' : ''}>${esc(s.name)}</label>`).join('');
  const viewOpts = VIEWS.map((v) => `<option value="${v.id}">${v.name}</option>`).join('');
  $('view-select').innerHTML = viewOpts;
  $('view-select').value = state.view;
  $('ref-view').innerHTML = viewOpts;
  $('ref-shot').innerHTML = [AUTO, ...SHOTS].map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('ref-shot').value = 'auto';
  $(`hand-${state.hand.toLowerCase()}`).checked = true;
  $('student-name').value = state.student;

  $('shot-chips').addEventListener('change', (e) => {
    state.shot = e.target.value; prefs.shot = state.shot; savePrefs();
    if (state.live) state.live.config.shot = state.shot;
    const c = state.current;
    // Picking a shot also corrects the one on screen; Auto goes back to the detected one.
    if (c && c.source !== 'demo') setCurrentShot(state.shot === 'auto' ? c.detected.shot : state.shot);
    else refreshSetup();
  });
  document.querySelectorAll('input[name="hand"]').forEach((r) => r.addEventListener('change', () => {
    state.hand = r.value; prefs.hand = state.hand; savePrefs();
    if (state.live) state.live.config.hand = state.hand;
    const c = state.current;
    if (c && c.source !== 'demo') {
      c.detected = A.classifyStroke(c.full.stroke, { hand: state.hand });
      setCurrentShot(state.shot === 'auto' ? c.detected.shot : c.shot);
    }
  }));
  $('view-select').addEventListener('change', (e) => { state.view = e.target.value; prefs.view = state.view; savePrefs(); refreshSetup(); });
  $('ref-select').addEventListener('change', (e) => {
    const shot = effectiveShot();
    if (shot) prefs.refByShot = { ...(prefs.refByShot || {}), [shot]: e.target.value || 'none' };
    savePrefs();
    renderCurrent();
  });
  $('student-name').addEventListener('input', (e) => { state.student = e.target.value.trim(); prefs.student = state.student; savePrefs(); });
  $('setup').addEventListener('submit', (e) => e.preventDefault());
}

function refsForShot(shot) { return state.refs.filter((r) => r.shot === shot).sort((a, b) => b.createdAt - a.createdAt); }

const BEST = '__best';

function selectedRef() {
  const id = $('ref-select').value;
  return id && id !== BEST ? state.refs.find((r) => r.id === id) || null : null;
}

// References a stroke can be compared with: same shot, and the same camera
// angle when the library has any from that angle.
function candidateRefs(shot) {
  const refs = refsForShot(shot);
  const same = refs.filter((r) => r.view === state.view);
  return same.length ? same : refs;
}

// The reference most similar to this stroke.
function closestRef(analysis, shot) {
  let best = null;
  for (const ref of candidateRefs(shot)) {
    const cmp = A.compareStrokes(analysis, refAnalysis(ref));
    if (cmp.score != null && (!best || cmp.score > best.score)) best = { ref, score: cmp.score };
  }
  return best?.ref || null;
}

// The shot being worked on: the one on screen, else the chosen one (null
// while auto-detecting with nothing captured yet).
function effectiveShot() {
  const c = state.current;
  if (c && c.source !== 'demo') return c.shot;
  return state.shot === 'auto' ? null : state.shot;
}

function refreshSetup() {
  const shot = effectiveShot();
  const cfg = shot ? SHOT_BY_ID[shot] : AUTO;
  $('film-tip').innerHTML = state.shot === 'auto' && !shot
    ? `<strong>Filming any shot:</strong> ${esc(AUTO.film)} The shot type is detected for each swing.`
    : `<strong>Filming ${esc(cfg.name.toLowerCase())}:</strong> ${esc(cfg.film)}`;
  const sel = $('ref-select');
  if (!shot) {
    sel.innerHTML = '<option value="">Matched to each detected shot</option>';
    sel.disabled = true;
  } else sel.disabled = false;
  const names = new Set(state.sessions.map((s) => s.student).filter(Boolean));
  $('student-list').innerHTML = [...names].sort().map((n) => `<option value="${esc(n)}"></option>`).join('');
  if (!shot) return;
  const refs = refsForShot(shot);
  const nBest = candidateRefs(shot).length;
  sel.innerHTML = (refs.length > 1 ? `<option value="${BEST}">Closest match of ${nBest} ${nBest === 1 ? 'reference' : 'references'}${nBest < refs.length ? ` (${viewName(state.view).toLowerCase()})` : ''}</option>` : '')
    + refs.map((r) => `<option value="${r.id}">${esc(r.label)} · ${viewName(r.view)}${r.view !== state.view ? ' (different angle)' : ''}</option>`).join('')
    + `<option value="">${refs.length ? 'Guide ranges only (no reference)' : `No ${esc(cfg.name.toLowerCase())} reference yet: guide ranges`}</option>`;
  const pref = prefs.refByShot?.[shot];
  if (pref === 'none') sel.value = '';
  else if (pref === BEST && refs.length > 1) sel.value = BEST;
  else if (pref && refs.some((r) => r.id === pref)) sel.value = pref;
  else if (refs.length > 1) sel.value = BEST;
  else sel.value = refs[0]?.id || '';
}

// ---------- reference helpers ----------
const refAnalyses = new Map();
function refAnalysis(ref) {
  if (!refAnalyses.has(ref.id)) {
    refAnalyses.set(ref.id, A.analyzeStroke({ frames: ref.frames, fps: ref.fps, contact: ref.contact }, { shot: ref.shot, hand: ref.hand }));
  }
  return refAnalyses.get(ref.id);
}

function refSide(ref) {
  return { analysis: refAnalysis(ref), frames: ref.frames, width: ref.width, height: ref.height, images: state.refBitmaps.get(ref.id) || null, label: ref.label, ref };
}

// Decoded frames are large, so only the last few references keep them.
async function loadRefBitmaps(ref) {
  if (!ref?.images?.length) return;
  if (state.refBitmaps.has(ref.id)) {
    const v = state.refBitmaps.get(ref.id);
    state.refBitmaps.delete(ref.id); state.refBitmaps.set(ref.id, v); // most recent last
    return;
  }
  try { state.refBitmaps.set(ref.id, await blobsToBitmaps(ref.images)); } catch { state.refBitmaps.set(ref.id, null); }
  while (state.refBitmaps.size > 3) {
    const [oldId, bmps] = state.refBitmaps.entries().next().value;
    state.refBitmaps.delete(oldId);
    bmps?.forEach((b) => b.close?.());
  }
}

async function reloadData() {
  state.refs = await store.getAll('refs');
  state.sessions = await store.getAll('sessions');
  refreshSetup();
}

// ---------- current result ----------
const viewer = new StrokeViewer($('viewer'));

function setCurrent(cur) {
  state.current = cur;
  renderCurrent();
}

function analyzeCurrent() {
  const c = state.current;
  if (!c || c.source === 'demo') return;
  c.analysis = A.analyzeStroke(c.stroke, { shot: c.shot, hand: state.hand });
}

// A captured stroke keeps its full capture window, so it can be re-cut when
// the shot type changes (a serve needs more lead-in than a volley).
function buildCurrent(source, full, images, width, height, extra = {}) {
  const c = { source, createdAt: Date.now(), full: { stroke: full, images }, width, height, ...extra };
  c.detected = A.classifyStroke(full, { hand: state.hand });
  applyShot(c, state.shot === 'auto' ? c.detected.shot : state.shot);
  return c;
}

function applyShot(c, shot) {
  c.shot = shot;
  const { range, stroke } = A.recut(c.full.stroke, shot);
  c.stroke = stroke;
  c.images = c.full.images ? c.full.images.slice(range[0], range[1] + 1) : null;
  c.analysis = A.analyzeStroke(c.stroke, { shot, hand: state.hand });
}

function setCurrentShot(shot) {
  const c = state.current;
  if (!c || c.source === 'demo') return;
  applyShot(c, shot);
  renderCurrent();
}

async function renderCurrent() {
  const c = state.current;
  if (!c) { $('result').hidden = true; return; }
  const isDemo = c.source === 'demo';
  const shotId = isDemo ? 'forehand' : c.shot;
  const cfg = SHOT_BY_ID[shotId];
  refreshSetup();
  let refData = null;
  if (isDemo) refData = c.demoRef;
  else {
    const best = $('ref-select').value === BEST;
    const ref = best ? closestRef(c.analysis, c.shot) : selectedRef();
    if (ref) {
      await loadRefBitmaps(ref);
      refData = refSide(ref);
      if (best) refData.label = `${ref.label} (closest of ${candidateRefs(c.shot).length})`;
    }
    c.refUsed = ref || null;
  }
  const studentLabel = isDemo ? 'Demo student' : (state.student || 'Student');
  const studentSide = { analysis: c.analysis, frames: c.stroke.frames, width: c.width, height: c.height, images: c.images, label: studentLabel };

  $('result').hidden = false;
  $('example-note').hidden = !isDemo;
  $('save-session').hidden = isDemo;
  $('save-as-ref').hidden = isDemo;
  $('discard-stroke').hidden = c.source !== 'live';
  $('save-ref-form').hidden = true;
  document.querySelector('.result .contact-adjust').hidden = isDemo;

  const evalRes = A.evaluate(c.analysis.metrics, refData?.analysis.metrics || null, shotId, refData?.label || 'the pro');
  let cmp = refData ? A.compareStrokes(c.analysis, refData.analysis) : null;
  if (cmp && cmp.score == null) cmp = null; // nothing comparable was tracked
  c.evaluation = evalRes;
  c.comparison = cmp;

  // Score
  const ring = $('score-ring'), num = $('score-num');
  if (cmp) {
    ring.style.setProperty('--p', cmp.score);
    ring.style.setProperty('--ring', cmp.score >= 75 ? 'var(--good)' : cmp.score >= 55 ? 'var(--close)' : 'var(--work)');
    num.textContent = String(cmp.score);
    num.className = 'score-num';
    ring.setAttribute('aria-label', `Match score ${cmp.score} out of 100`);
  } else {
    const p = evalRes.rated ? Math.round((100 * evalRes.onTarget) / evalRes.rated) : 0;
    ring.style.setProperty('--p', p);
    ring.style.setProperty('--ring', 'var(--court)');
    num.textContent = `${evalRes.onTarget}/${evalRes.rated}`;
    num.className = 'score-num small';
    ring.setAttribute('aria-label', `${evalRes.onTarget} of ${evalRes.rated} checkpoints on target`);
  }
  const auto = !isDemo && state.shot === 'auto';
  $('result-eyebrow').textContent = `${studentLabel} · ${c.source === 'live' ? 'Live' : isDemo ? 'Example' : 'Clip'} · ${new Date(c.createdAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}${auto ? ' · Shot detected automatically' : ''}`;
  $('result-title').textContent = cfg.name;
  let sub = cmp ? `Match with ${refData.label}` : `Checked against guide ranges. Add a ${cfg.name.toLowerCase()} reference in the Pro library for a match score.`;
  if (auto && c.detected.confidence < 0.65) sub += ' · Not certain about the shot type. If it\'s wrong, pick the right shot above.';
  if (c.analysis.handSwapped) sub += ` · The hitting arm looked like the ${c.analysis.hand === 'L' ? 'left' : 'right'} one; check the "Plays" setting.`;
  if (!isDemo && c.analysis.legsHidden) sub += ' · The legs weren\'t clearly in view, so the knee and stance checks were skipped. Move the camera back so the whole body is in frame.';
  if (!isDemo && c.analysis.armHidden) sub += ' · The hitting arm was hard to track, so arm checks may be missing. Try better light or a faster frame rate.';
  $('result-sub').textContent = sub;

  const pb = $('phase-bars');
  if (cmp) {
    pb.hidden = false;
    pb.innerHTML = [['prep', cfg.phases[0]], ['contact', cfg.phases[1]], ['finish', cfg.phases[2]]].map(([k, name]) => {
      const v = cmp.phases[k];
      const col = v >= 75 ? 'var(--good)' : v >= 55 ? 'var(--close)' : 'var(--work)';
      return `<dt>${esc(name)}</dt><dd><div class="track"><div class="fill" style="width:${v ?? 0}%;background:${col}"></div></div></dd><dd class="num">${v ?? '–'}</dd>`;
    }).join('');
  } else pb.hidden = true;

  // Tips
  $('tips').innerHTML = evalRes.tips.length
    ? evalRes.tips.map((t) => `<li><span>${esc(t.text)}</span></li>`).join('')
    : `<li class="good"><span>${evalRes.rated ? 'All checkpoints are within range of ' + esc(refData ? refData.label : 'the guide ranges') + '. Use the overlay to fine-tune the swing shape.' : 'No checkpoints could be measured. Make sure the whole body is visible.'}</span></li>`;

  // Checkpoints
  $('target-col').textContent = refData ? 'Reference' : 'Guide';
  const statusText = { good: 'On target', close: 'Close', work: 'Work on', none: '–' };
  document.querySelector('#checkpoints tbody').innerHTML = evalRes.rows.map((r) => `
    <tr>
      <td>${esc(r.label)}<span class="cp-help">${esc(r.help)}</span></td>
      <td>${esc(r.studentText)}</td>
      <td>${esc(r.targetText)}</td>
      <td><span class="status ${r.status}">${statusText[r.status]}</span></td>
    </tr>`).join('');

  viewer.setData({ student: studentSide, ref: refData, phases: cfg.phases });
}

// ---------- demo ----------
function showDemo() {
  const mk = (kind) => {
    const seq = A.buildSequence(makeDemoSamples(kind), { fps: 30, ...DEMO_SIZE });
    const contact = A.detectStrokes(seq, { hand: 'R', shot: 'forehand' })[0];
    const stroke = A.cutStroke(seq, contact, 'forehand');
    return { stroke, analysis: A.analyzeStroke(stroke, { shot: 'forehand', hand: 'R' }) };
  };
  const pro = mk('pro'), stu = mk('student');
  setCurrent({
    source: 'demo', createdAt: Date.now(), stroke: stu.stroke, analysis: stu.analysis, images: null, ...DEMO_SIZE,
    demoRef: { analysis: pro.analysis, frames: pro.stroke.frames, ...DEMO_SIZE, images: null, label: 'Demo pro' },
  });
}

// ---------- contact adjust ----------
function nudgeContact(delta) {
  const c = state.current;
  if (!c || c.source === 'demo') return;
  const full = c.full.stroke;
  const at = full.contact + (c.analysis.events.contact - c.stroke.contact) + delta;
  c.full.stroke = { ...full, contact: Math.max(1, Math.min(full.frames.length - 2, at)) };
  applyShot(c, c.shot);
  renderCurrent().then(() => viewer.jumpTo('contact'));
}
$('contact-prev').addEventListener('click', () => nudgeContact(-1));
$('toggle-help').addEventListener('click', (e) => {
  const on = $('checkpoints').classList.toggle('show-help');
  e.currentTarget.setAttribute('aria-pressed', String(on));
  e.currentTarget.textContent = on ? 'Hide explanations' : 'Explain';
});
$('contact-next').addEventListener('click', () => nudgeContact(1));
$('contact-show').addEventListener('click', () => viewer.jumpTo('contact'));

// ---------- clip analysis ----------
let clipAbort = null;
$('progress-cancel').addEventListener('click', () => clipAbort?.abort());

async function analyzeClipFile(file) {
  stopLive();
  showMessage($('analyze-message'), '');
  $('stroke-strip').hidden = true;
  clipAbort = new AbortController();
  const timeScale = +$('slowmo').value || 1;
  try {
    setProgress('', 'Loading the pose model…', 0);
    const est = await getEstimator('thunder', (t) => setProgress('', t, 0));
    setProgress('', 'Opening the clip…', 0);
    const video = await openVideo(file);
    if (video.duration > 90) throw new Error('That clip is longer than 90 seconds. Trim it to the strokes you want analyzed.');
    const res = await processClip(video, est, {
      fps: 30, timeScale, signal: clipAbort.signal,
      onProgress: (i, n) => setProgress('', `Tracking the player: frame ${i} of ${n}`, i / n),
    });
    let strokes = A.detectStrokes(res.seq, { hand: state.hand, shot: state.shot });
    if (!strokes.length) strokes = A.detectStrokes(res.seq, { hand: state.hand, shot: state.shot, sensitivity: 2.5, relative: 0.3 });
    hideProgress('');
    if (state.clip?.video) URL.revokeObjectURL(state.clip.video.src);
    const items = strokes.map((contact) => {
      const full = A.cutStroke(res.seq, contact, 'auto');
      return { contact, full, detected: A.classifyStroke(full, { hand: state.hand }) };
    });
    state.clip = { video, ...res, strokes, items, timeScale };
    if (!strokes.length) {
      showMessage($('analyze-message'), 'No swing was found in this clip. Check that the whole body is in the frame, the "Plays" setting matches the student, and the clip includes the full stroke.', 'error');
      return;
    }
    $('stroke-strip-label').textContent = strokes.length === 1 ? '1 stroke found' : `${strokes.length} strokes found`;
    $('stroke-chips').innerHTML = items.map((it, i) => `<button type="button" class="chip" data-i="${i}" aria-pressed="${i === 0}">${i + 1} · ${state.shot === 'auto' ? `${esc(SHOT_BY_ID[it.detected.shot].short)} · ` : ''}${fmtTime(it.contact / res.seq.fps + res.seq.t0)}</button>`).join('');
    $('stroke-strip').hidden = false;
    await selectClipStroke(0);
  } catch (e) {
    hideProgress('');
    if (e.name !== 'AbortError') showMessage($('analyze-message'), e.message || String(e), 'error');
  }
}

async function selectClipStroke(i) {
  const clip = state.clip;
  if (!clip) return;
  $('stroke-chips').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
  const { full } = clip.items[i];
  setProgress('', 'Preparing frames…', 0.5);
  const images = await extractFrames(clip.video, full.frames.map((_, k) => clip.videoTime(full.offset + k)));
  hideProgress('');
  releaseCurrent();
  state.current = buildCurrent('clip', full, images, clip.width, clip.height);
  await renderCurrent();
}
$('stroke-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  if (state.clip) selectClipStroke(+b.dataset.i);
  else selectLiveStroke(+b.dataset.i);
});

$('clip-input').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) analyzeClipFile(f);
});

function releaseCurrent() {
  const c = state.current;
  if (c && c.source === 'clip' && c.full?.images) c.full.images.forEach((b) => b.close?.());
  if (state.liveStrokes.length) releaseLiveStrokes();
}

// ---------- live camera ----------
let wakeLock = null;
async function startLive() {
  showMessage($('analyze-message'), '');
  if (!window.isSecureContext) {
    showMessage($('analyze-message'), 'The live camera only works when the app is opened over https:// (or on localhost). Upload a clip instead, or open the hosted version.', 'error');
    return;
  }
  if (!LiveSession.supported()) {
    showMessage($('analyze-message'), 'This browser doesn\'t give web pages camera access. Use "Upload or record a clip" instead.', 'error');
    return;
  }
  if (state.live) return;
  state.clip = null;
  if (!state.liveStrokes.length) state.liveTally = {};
  renderTally();
  if (state.liveStrokes.length) renderLiveChips(state.current?.liveIndex ?? -1);
  else $('stroke-strip').hidden = true;
  $('live').hidden = false;
  $('live-status').textContent = 'Loading the pose model…';
  $('live-status').className = 'pill';
  try {
    const est = await getEstimator('lightning');
    const session = new LiveSession($('live-video'), $('live-overlay'));
    session.config = { hand: state.hand, shot: state.shot, sensitivity: +$('live-sensitivity').value || 1 };
    session.addEventListener('frame', (e) => drawLiveOverlay(e.detail));
    session.addEventListener('stroke', (e) => onLiveStroke(e.detail));
    session.addEventListener('error', (e) => showMessage($('analyze-message'), `Pose tracking error: ${e.detail.message}`, 'error'));
    state.live = session;
    $('live-status').textContent = 'Starting camera…';
    await session.start(est, 'environment');
    document.querySelector('.live-stage').classList.toggle('mirror', session.facing === 'user');
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  } catch (e) {
    const msg = e.name === 'NotAllowedError' ? 'Camera access was refused. Allow the camera for this site in the browser settings, or upload a clip instead.'
      : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'No camera was found on this device. Upload a clip instead.'
        : e.message || String(e);
    showMessage($('analyze-message'), msg, 'error');
    stopLive();
  }
}

// Captured strokes keep their frames after the camera stops, so they can
// still be reviewed; they're freed when a clip replaces them.
// Free one captured stroke's frames, keeping any shared with other strokes.
function releaseLiveEntry(entry) {
  if (state.live) { state.live.release(entry.bitmaps); return; }
  const inUse = new Set(state.liveStrokes.filter((s) => s !== entry).flatMap((s) => s.bitmaps));
  new Set(entry.bitmaps).forEach((b) => { if (!inUse.has(b)) b.close?.(); });
}

function releaseLiveStrokes() {
  const bitmaps = new Set(state.liveStrokes.flatMap((s) => s.bitmaps));
  if (state.live) state.liveStrokes.forEach((s) => state.live.release(s.bitmaps));
  else bitmaps.forEach((b) => b.close?.());
  state.liveStrokes = [];
  state.liveTally = {};
  stopReplay();
}

function renderLiveChips(active) {
  $('stroke-strip-label').textContent = 'This session';
  $('stroke-chips').innerHTML = state.liveStrokes.map((x, k) => `<button type="button" class="chip" data-i="${k}" aria-pressed="${k === active}">#${k + 1}${x.current ? ` ${esc(SHOT_BY_ID[x.current.shot].short)}` : ''}${x.score != null ? ` <span class="chip-score">${x.score}</span>` : ''}</button>`).join('');
  $('stroke-strip').hidden = !state.liveStrokes.length;
}

function stopLive() {
  stopReplay();
  $('live-banner').hidden = true;
  if (!state.live) { $('live').hidden = true; return; }
  state.live.stop();
  state.live = null;
  $('live').hidden = true;
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

function drawLiveOverlay({ kps, w, h, visible }) {
  const cv = $('live-overlay');
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const lw = Math.max(2, w / 220);
  ctx.lineCap = 'round';
  for (const [a, b] of A.EDGES) {
    if (kps[a][2] < 0.25 || kps[b][2] < 0.25) continue;
    const hit = (state.hand === 'L' ? [7, 9, 5] : [8, 10, 6]);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = lw + 3;
    ctx.beginPath(); ctx.moveTo(kps[a][0], kps[a][1]); ctx.lineTo(kps[b][0], kps[b][1]); ctx.stroke();
    ctx.strokeStyle = hit.includes(a) && hit.includes(b) ? '#e3f25a' : '#ffffff'; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(kps[a][0], kps[a][1]); ctx.lineTo(kps[b][0], kps[b][1]); ctx.stroke();
  }
  // Hand path over the last 0.8 s, fading out, so the swing shape shows live.
  const buf = state.live?.buffer || [];
  const wi = state.hand === 'L' ? 9 : 10;
  const tNow = buf.length ? buf[buf.length - 1].t : 0;
  const trail = buf.filter((s) => s.t >= tNow - 0.8 && s.kps[wi][2] >= 0.2);
  for (let k = 1; k < trail.length; k++) {
    const age = (tNow - trail[k].t) / 0.8;
    ctx.strokeStyle = `rgba(227, 242, 90, ${(0.9 * (1 - age)).toFixed(2)})`;
    ctx.lineWidth = lw * (1.8 - age);
    ctx.beginPath();
    ctx.moveTo(trail[k - 1].kps[wi][0], trail[k - 1].kps[wi][1]);
    ctx.lineTo(trail[k].kps[wi][0], trail[k].kps[wi][1]);
    ctx.stroke();
  }
  const st = $('live-status');
  const paused = !state.live?.detecting;
  if (paused) { st.textContent = 'Detection paused'; st.className = 'pill'; }
  else if (visible) { st.textContent = `Tracking · ready for ${state.shot === 'auto' ? 'any stroke' : `a ${SHOT_BY_ID[state.shot].name.toLowerCase()}`}`; st.className = 'pill ready'; }
  else { st.textContent = 'Step into view: whole body in the frame'; st.className = 'pill warn'; }
  const fps = state.live?.fpsEstimate;
  $('live-fps').textContent = fps ? `${Math.round(fps)} fps` : '';
  $('live-fps').hidden = !fps;
}

function onLiveStroke({ stroke, bitmaps, width, height }) {
  const entry = { full: stroke, bitmaps, width, height, createdAt: Date.now() };
  state.liveStrokes.push(entry);
  while (state.liveStrokes.length > 8) {
    const old = state.liveStrokes.shift();
    state.live?.release(old.bitmaps);
  }
  selectLiveStroke(state.liveStrokes.length - 1).then(() => {
    const c = entry.current;
    state.liveTally[c.shot] = (state.liveTally[c.shot] || 0) + 1;
    entry.tallied = c.shot;
    renderTally();
    showSwingBanner(c);
    startReplay(c);
  });
}

// ---------- live overlay: swing label, shot count, instant replay ----------
let bannerTimer = null;
function showSwingBanner(c) {
  const b = $('live-banner');
  $('lb-shot').textContent = SHOT_BY_ID[c.shot].name;
  $('lb-score').textContent = c.comparison ? `Match ${c.comparison.score}` : `${c.evaluation.onTarget}/${c.evaluation.rated} on target`;
  const top = c.evaluation.tips[0];
  $('lb-tip').textContent = top ? `Work on: ${METRICS[top.key].short.toLowerCase()}` : (c.evaluation.rated ? 'Nice one' : '');
  b.hidden = false;
  b.classList.remove('fade');
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = ''; // replay the entrance
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.classList.add('fade'); bannerTimer = setTimeout(() => { b.hidden = true; }, 600); }, 2600);
}

function renderTally() {
  const entries = SHOTS.filter((s) => state.liveTally[s.id]).map((s) => `<span>${esc(s.short)}<b>${state.liveTally[s.id]}</b></span>`);
  $('live-tally').innerHTML = entries.join('');
  $('live-tally').hidden = !entries.length;
}

// Loop the last stroke in slow motion in the corner of the live view.
const replay = { raf: 0, c: null };
function startReplay(c) {
  stopReplay();
  if (!c.images?.length) return;
  replay.c = c;
  const box = $('live-replay-box'), cv = $('live-replay');
  const img0 = c.images[0];
  cv.width = Math.min(480, img0.width);
  cv.height = Math.round((cv.width * img0.height) / img0.width);
  $('live-replay-cap').textContent = `Replay · ${SHOT_BY_ID[c.shot].short}`;
  box.hidden = false;
  const n = c.images.length, fps = c.stroke.fps * 0.4; // 0.4x speed
  const hit = c.analysis.hand === 'L' ? [[5, 7], [7, 9]] : [[6, 8], [8, 10]];
  const t0 = performance.now();
  const frame = (now) => {
    if (replay.c !== c) return;
    // rAF timestamps can be slightly earlier than t0, so clamp at 0.
    const i = Math.floor(((Math.max(0, now - t0) / 1000) * fps) % (n + 8)); // short pause at the end
    const k = Math.min(i, n - 1, c.stroke.frames.length - 1);
    const ctx = cv.getContext('2d');
    try { ctx.drawImage(c.images[k], 0, 0, cv.width, cv.height); } catch { ctx.fillStyle = '#0a1a28'; ctx.fillRect(0, 0, cv.width, cv.height); }
    const sx = cv.width / c.width;
    const kps = c.stroke.frames[k];
    ctx.lineCap = 'round';
    for (const [a, b] of A.EDGES) {
      ctx.strokeStyle = hit.some(([x, y]) => (x === a && y === b) || (x === b && y === a)) ? '#e3f25a' : 'rgba(124, 208, 255, 0.95)';
      ctx.lineWidth = Math.max(2, cv.width / 140);
      ctx.beginPath(); ctx.moveTo(kps[a][0] * sx, kps[a][1] * sx); ctx.lineTo(kps[b][0] * sx, kps[b][1] * sx); ctx.stroke();
    }
    if (Math.abs(k - c.analysis.events.contact) <= 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cv.width - 78, 6, 72, 20);
      ctx.fillStyle = '#fff'; ctx.font = '600 12px Barlow, sans-serif'; ctx.fillText('CONTACT', cv.width - 70, 20);
    }
    replay.raf = requestAnimationFrame(frame);
  };
  replay.raf = requestAnimationFrame(frame);
}
function stopReplay() {
  cancelAnimationFrame(replay.raf);
  replay.c = null;
  $('live-replay-box').hidden = true;
}

function selectLiveStroke(i) {
  const s = state.liveStrokes[i];
  if (!s) return Promise.resolve();
  if (!s.current) s.current = buildCurrent('live', s.full, s.bitmaps, s.width, s.height, { createdAt: s.createdAt });
  s.current.liveIndex = i;
  state.current = s.current;
  return renderCurrent().then(() => {
    s.score = s.current.comparison?.score;
    renderLiveChips(i);
    const st = $('live-status');
    if (st) { st.textContent = `Stroke ${i + 1}: ${SHOT_BY_ID[s.current.shot].name}${s.score != null ? ` · match ${s.score}` : ''}`; st.className = 'pill ready'; }
  });
}

$('live-start').addEventListener('click', startLive);
$('live-stop').addEventListener('click', stopLive);
if (['0.75', '1', '1.4'].includes(String(prefs.sensitivity))) $('live-sensitivity').value = String(prefs.sensitivity);
$('live-sensitivity').addEventListener('change', (e) => {
  prefs.sensitivity = +e.target.value; savePrefs();
  if (state.live) state.live.config.sensitivity = +e.target.value;
});
$('discard-stroke').addEventListener('click', () => {
  const c = state.current;
  if (!c || c.source !== 'live') return;
  const i = state.liveStrokes.findIndex((s) => s.current === c);
  if (i < 0) return;
  const gone = state.liveStrokes[i];
  if (gone.tallied && state.liveTally[gone.tallied]) { state.liveTally[gone.tallied]--; renderTally(); }
  if (replay.c === gone.current) stopReplay();
  releaseLiveEntry(gone);
  state.liveStrokes.splice(i, 1);
  if (state.liveStrokes.length) { selectLiveStroke(Math.min(i, state.liveStrokes.length - 1)); return; }
  state.current = null;
  $('result').hidden = true;
  $('stroke-strip').hidden = true;
  refreshSetup();
});
$('live-flip').addEventListener('click', async () => {
  if (!state.live) return;
  try {
    await state.live.flip();
    document.querySelector('.live-stage').classList.toggle('mirror', state.live.facing === 'user');
  } catch (e) { showMessage($('analyze-message'), `Couldn't switch camera: ${e.message}`, 'error'); }
});
$('live-pause').addEventListener('click', (e) => {
  if (!state.live) return;
  state.live.detecting = !state.live.detecting;
  e.currentTarget.setAttribute('aria-pressed', String(!state.live.detecting));
  e.currentTarget.textContent = state.live.detecting ? 'Pause detection' : 'Resume detection';
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.live && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  }
});

// ---------- saving ----------
async function contactThumb(c) {
  const img = c.images?.[c.analysis.events.contact];
  if (!img) return null;
  const k = 160 / Math.max(img.width, img.height);
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.7));
}

const roundFrames = (frames) => frames.map((f) => f.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100]));

$('save-session').addEventListener('click', async () => {
  const c = state.current;
  if (!c || c.source === 'demo') return;
  const ref = c.refUsed;
  const rec = {
    id: store.newId('ses'), createdAt: Date.now(), student: state.student || 'Student', shot: c.shot,
    hand: c.analysis.hand, view: state.view, source: c.source,
    refId: ref?.id || null, refLabel: ref?.label || null,
    score: c.comparison?.score ?? null, phases: c.comparison?.phases || null,
    onTarget: c.evaluation.onTarget, rated: c.evaluation.rated,
    metrics: c.analysis.metrics, tips: c.evaluation.tips.map((t) => t.text),
    thumb: await contactThumb(c),
  };
  try {
    await store.put('sessions', rec);
    store.requestPersistence();
    state.sessions.push(rec);
    refreshSetup();
    showMessage($('analyze-message'), `Saved to ${rec.student}'s history.`, 'ok');
  } catch (e) { showMessage($('analyze-message'), `Couldn't save: ${e.message}`, 'error'); }
});

$('save-as-ref').addEventListener('click', () => {
  $('save-ref-form').hidden = false;
  $('save-ref-name').value = `${state.student || 'Coach'} · ${SHOT_BY_ID[state.current.shot].name}`;
  $('save-ref-name').focus();
});
$('save-ref-cancel').addEventListener('click', () => { $('save-ref-form').hidden = true; });
$('save-ref-confirm').addEventListener('click', async () => {
  const c = state.current;
  if (!c) return;
  await saveReference({
    shot: c.shot, label: $('save-ref-name').value.trim() || SHOT_BY_ID[c.shot].name,
    hand: c.analysis.hand, view: state.view, stroke: c.stroke, contact: c.analysis.events.contact,
    width: c.width, height: c.height, images: c.images,
  });
  $('save-ref-form').hidden = true;
  showMessage($('analyze-message'), 'Saved to the pro library. Pick it under "Compare with" to use it.', 'ok');
});

async function saveReference({ shot, label, hand, view, stroke, contact, width, height, images }) {
  const rec = {
    id: store.newId('ref'), createdAt: Date.now(), shot, label, hand, view,
    fps: stroke.fps, width, height, contact, frames: roundFrames(stroke.frames),
    images: images?.length ? await bitmapsToBlobs(images) : [],
  };
  await store.put('refs', rec);
  store.requestPersistence();
  state.refs.push(rec);
  if (!bulkAbort) refreshSetup();
  return rec;
}

// ---------- library ----------
const refViewer = new StrokeViewer($('ref-viewer'));
const refDraft = { clip: null, current: null };
let refAbort = null;
$('ref-progress-cancel').addEventListener('click', () => refAbort?.abort());

$('ref-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showMessage($('ref-message'), '');
  $('ref-pick').hidden = true;
  refAbort = new AbortController();
  const shot = $('ref-shot').value;
  const hand = document.querySelector('input[name="ref-hand"]:checked').value;
  const timeScale = +$('ref-slowmo').value || 1;
  try {
    setProgress('ref-', 'Loading the pose model…', 0);
    const est = await getEstimator('thunder', (t) => setProgress('ref-', t, 0));
    const video = await openVideo(file);
    if (video.duration > 90) throw new Error('That clip is longer than 90 seconds. Trim it to the strokes you want.');
    const res = await processClip(video, est, {
      fps: 30, timeScale, signal: refAbort.signal,
      onProgress: (i, n) => setProgress('ref-', `Tracking the player: frame ${i} of ${n}`, i / n),
    });
    let strokes = A.detectStrokes(res.seq, { hand, shot });
    if (!strokes.length) strokes = A.detectStrokes(res.seq, { hand, shot, sensitivity: 2.5, relative: 0.3 });
    hideProgress('ref-');
    if (!strokes.length) { showMessage($('ref-message'), 'No swing was found. Check the whole body is visible and "Plays" is set correctly.', 'error'); return; }
    const items = strokes.map((contact) => {
      const full = A.cutStroke(res.seq, contact, 'auto');
      const detected = A.classifyStroke(full, { hand });
      return { contact, full, shot: shot === 'auto' ? detected.shot : shot };
    });
    if (refDraft.clip?.video) URL.revokeObjectURL(refDraft.clip.video.src);
    refDraft.clip = { video, ...res, strokes, items, shot, hand };
    $('ref-stroke-chips').innerHTML = items.map((it, i) => `<button type="button" class="chip" data-i="${i}" aria-pressed="${i === 0}">${i + 1} · ${esc(SHOT_BY_ID[it.shot].short)} · ${fmtTime(it.contact / res.seq.fps + res.seq.t0)}</button>`).join('');
    $('ref-pick').hidden = false;
    await pickRefStroke(0);
  } catch (err) {
    hideProgress('ref-');
    if (err.name !== 'AbortError') showMessage($('ref-message'), err.message || String(err), 'error');
  }
});

async function pickRefStroke(i) {
  const clip = refDraft.clip;
  $('ref-stroke-chips').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
  const it = clip.items[i];
  const { range, stroke } = A.recut(it.full, it.shot);
  const images = await extractFrames(clip.video, stroke.frames.map((_, k) => clip.videoTime(it.full.offset + range[0] + k)));
  refDraft.current?.images?.forEach((b) => b.close?.());
  refDraft.current = { stroke, images, shot: it.shot, width: clip.width, height: clip.height };
  renderRefDraft();
}

function renderRefDraft() {
  const d = refDraft.current, clip = refDraft.clip;
  d.analysis = A.analyzeStroke(d.stroke, { shot: d.shot, hand: clip.hand });
  refViewer.setData({
    student: { analysis: d.analysis, frames: d.stroke.frames, width: d.width, height: d.height, images: d.images, label: `${$('ref-player').value || 'Reference'} · ${SHOT_BY_ID[d.shot].name}` },
    ref: null, phases: SHOT_BY_ID[d.shot].phases,
  });
}

$('ref-stroke-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pickRefStroke(+b.dataset.i); });
const nudgeRef = (delta) => {
  const d = refDraft.current;
  if (!d) return;
  d.stroke = { ...d.stroke, contact: Math.max(1, Math.min(d.stroke.frames.length - 2, d.analysis.events.contact + delta)) };
  renderRefDraft();
  refViewer.jumpTo('contact');
};
$('ref-contact-prev').addEventListener('click', () => nudgeRef(-1));
$('ref-contact-next').addEventListener('click', () => nudgeRef(1));
$('ref-contact-show').addEventListener('click', () => refViewer.jumpTo('contact'));
$('ref-save').addEventListener('click', async () => {
  const d = refDraft.current, clip = refDraft.clip;
  if (!d) return;
  try {
    await saveReference({
      shot: d.shot, label: $('ref-player').value.trim() || `${SHOT_BY_ID[d.shot].name} reference`,
      hand: d.analysis.hand, view: $('ref-view').value, stroke: d.stroke, contact: d.analysis.events.contact,
      width: d.width, height: d.height, images: d.images,
    });
    $('ref-pick').hidden = true;
    URL.revokeObjectURL(clip.video.src);
    refDraft.clip = null;
    showMessage($('ref-message'), `Saved as a ${SHOT_BY_ID[d.shot].name.toLowerCase()} reference. It is used automatically for that shot.`, 'ok');
    renderLibrary();
  } catch (e) { showMessage($('ref-message'), `Couldn't save: ${e.message}`, 'error'); }
});
$('add-ref').addEventListener('submit', (e) => e.preventDefault());

// ---------- bulk import ----------
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|3gp|ogv)$/i;
let bulkAbort = null;
if (!('webkitdirectory' in document.createElement('input'))) $('bulk-folder-btn').hidden = true;
$('bulk-cancel').addEventListener('click', () => bulkAbort?.abort());
for (const id of ['bulk-folder', 'bulk-files']) {
  $(id).addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) bulkImport(files);
  });
}

function bulkRow(li, status, what) {
  li.className = status;
  li.querySelector('.mark').textContent = { ok: '✓', fail: '✕', skip: '–', wait: '…', run: '▸' }[status];
  li.querySelector('.what').textContent = what;
}

async function bulkImport(files) {
  if (bulkAbort) return; // one import at a time
  const path = (f) => f.webkitRelativePath || f.name;
  const clips = files.filter((f) => VIDEO_EXT.test(f.name) || f.type.startsWith('video/'))
    .sort((a, b) => path(a).localeCompare(path(b), undefined, { numeric: true }));
  showMessage($('ref-message'), '');
  $('ref-pick').hidden = true;
  if (!clips.length) { showMessage($('ref-message'), 'No video files were found in that selection.', 'error'); return; }

  const opts = {
    shot: $('ref-shot').value,
    hand: document.querySelector('input[name="ref-hand"]:checked').value,
    view: $('ref-view').value,
    timeScale: +$('ref-slowmo').value || 1,
    keepFrames: $('bulk-frames').checked,
    prefix: $('ref-player').value.trim(),
  };
  bulkAbort = new AbortController();
  const signal = bulkAbort.signal;
  $('bulk-panel').hidden = false;
  $('bulk-list').innerHTML = clips.map((f) => `<li class="wait"><span class="mark">…</span><span class="name">${esc(path(f))}</span><span class="what">Waiting</span></li>`).join('');
  const rows = [...$('bulk-list').children];
  const counts = { ok: 0, fail: 0, skip: 0 };
  const setText = (i, extra = '') => {
    $('bulk-text').textContent = `Clip ${i + 1} of ${clips.length}${extra} · ${counts.ok} saved`;
    $('bulk-fill').style.width = `${Math.round((100 * i) / clips.length)}%`;
  };

  let est;
  try {
    $('bulk-text').textContent = 'Loading the pose model…';
    est = await getEstimator('thunder');
    await store.requestPersistence();
  } catch (e) {
    showMessage($('ref-message'), e.message || String(e), 'error');
    bulkAbort = null;
    return;
  }

  for (let i = 0; i < clips.length; i++) {
    if (signal.aborted) {
      for (let k = i; k < clips.length; k++) { bulkRow(rows[k], 'skip', 'Stopped'); counts.skip++; }
      break;
    }
    const file = clips[i], li = rows[i];
    bulkRow(li, 'run', 'Tracking…');
    li.scrollIntoView({ block: 'nearest' });
    setText(i);
    try {
      const r = await importClip(file, path(file), opts, est, signal, (k, n) => {
        li.querySelector('.what').textContent = `Tracking ${Math.round((100 * k) / n)}%`;
      });
      counts[r.status]++;
      bulkRow(li, r.status, r.text);
    } catch (e) {
      if (e.name === 'AbortError') { bulkRow(li, 'skip', 'Stopped'); counts.skip++; continue; }
      counts.fail++;
      bulkRow(li, 'fail', /could not be read|no picture/i.test(e.message || '')
        ? 'The browser can\'t play this file. Convert it to MP4 (H.264).'
        : (e.message || String(e)));
    }
  }
  $('bulk-fill').style.width = '100%';
  $('bulk-text').textContent = `Done: ${counts.ok} saved, ${counts.fail} failed, ${counts.skip} skipped.`;
  bulkAbort = null;
  refreshSetup();
  renderLibrary();
}

async function importClip(file, filePath, opts, est, signal, onProgress) {
  const named = opts.shot === 'auto' ? shotFromName(filePath) : opts.shot;
  if (named === 'unsupported') return { status: 'skip', text: 'Forehand slice isn\'t analyzed' };
  const video = await openVideo(file);
  try {
    if (video.duration > 90) return { status: 'skip', text: 'Longer than 90 s' };
    const res = await processClip(video, est, { fps: 30, timeScale: opts.timeScale, signal, onProgress });
    const hint = named || 'auto';
    let contacts = A.detectStrokes(res.seq, { hand: opts.hand, shot: hint });
    if (!contacts.length) contacts = A.detectStrokes(res.seq, { hand: opts.hand, shot: hint, sensitivity: 2.5, relative: 0.3 });
    if (!contacts.length) return { status: 'fail', text: 'No swing found' };
    // One reference per clip: the strongest stroke.
    const v = A.speedSeries(res.seq.frames, opts.hand === 'L' ? 9 : 10, res.seq.fps, A.torsoLength(res.seq.frames));
    const contact = contacts.reduce((b, c) => (v[c] > v[b] ? c : b));
    const full = A.cutStroke(res.seq, contact, 'auto');
    const shot = named || A.classifyStroke(full, { hand: opts.hand }).shot;
    const { range, stroke } = A.recut(full, shot);
    const analysis = A.analyzeStroke(stroke, { shot, hand: opts.hand });
    let images = null;
    if (opts.keepFrames) images = await extractFrames(video, stroke.frames.map((_, k) => res.videoTime(full.offset + range[0] + k)));
    const base = filePath.replace(/\.[^./]+$/, '').split('/').slice(-2).join(' / ');
    try {
      await saveReference({
        shot, label: `${opts.prefix ? `${opts.prefix} · ` : ''}${base}`.slice(0, 80),
        hand: analysis.hand, view: opts.view, stroke, contact: analysis.events.contact,
        width: res.width, height: res.height, images,
      });
    } finally { images?.forEach((b) => b.close?.()); }
    return { status: 'ok', text: `${SHOT_BY_ID[shot].name}${named ? '' : ' (detected)'}` };
  } finally {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
}

$('delete-all-refs').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = `Confirm: delete all ${state.refs.length} references`;
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Delete all references'; }, 5000);
    return;
  }
  btn.dataset.confirm = '';
  btn.textContent = 'Delete all references';
  for (const r of state.refs) await store.remove('refs', r.id);
  state.refs = [];
  state.refBitmaps.forEach((b) => b?.forEach((x) => x.close?.()));
  state.refBitmaps.clear();
  refAnalyses.clear();
  refreshSetup();
  renderLibrary();
  showMessage($('library-message'), 'All references deleted. Saved history is kept.', 'ok');
});

function drawThumb(canvas, img, kps, w, h, hand) {
  const W = canvas.width = 320, H = canvas.height = 240;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#11273a';
  ctx.fillRect(0, 0, W, H);
  let tf;
  if (img) {
    const k = Math.min(W / img.width, H / img.height);
    const dw = img.width * k, dh = img.height * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
    ctx.drawImage(img, ox, oy, dw, dh);
    tf = (p) => [ox + (p[0] * dw) / w, oy + (p[1] * dh) / h];
  } else {
    const xs = kps.map((p) => p[0]), ys = kps.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = 0.8 * Math.min(W / (x1 - x0 || 1), H / (y1 - y0 || 1));
    tf = (p) => [W / 2 + (p[0] - (x0 + x1) / 2) * k, H / 2 + (p[1] - (y0 + y1) / 2) * k];
  }
  const hit = hand === 'L' ? [5, 7, 9] : [6, 8, 10];
  ctx.lineCap = 'round';
  for (const [a, b] of A.EDGES) {
    const pa = tf(kps[a]), pb = tf(kps[b]);
    ctx.strokeStyle = hit.includes(a) && hit.includes(b) ? '#e3f25a' : '#7cd0ff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(...pa); ctx.lineTo(...pb); ctx.stroke();
  }
}

const libraryExpanded = new Set();

async function renderLibrary() {
  const list = $('ref-list');
  if (!state.refs.length) {
    list.innerHTML = '<p class="empty">No references yet. Add a pro clip above, or use "Save as pro reference" on any analyzed stroke.</p>';
    $('delete-all-refs').hidden = true;
    return;
  }
  $('delete-all-refs').hidden = false;
  const SHOW = 8;
  list.innerHTML = SHOTS.filter((s) => state.refs.some((r) => r.shot === s.id)).map((s) => {
    const all = refsForShot(s.id);
    const shown = libraryExpanded.has(s.id) ? all : all.slice(0, SHOW);
    return `
    <section class="ref-group"><h2>${esc(s.name)} <span class="count">${all.length}</span></h2><div class="ref-cards">
      ${shown.map((r) => `
        <article class="ref-card" data-id="${r.id}">
          <canvas aria-label="Contact frame of ${esc(r.label)}"></canvas>
          <div class="ref-card-body">
            <div class="ref-card-title">${esc(r.label)}</div>
            <div class="ref-card-meta">${r.hand === 'L' ? 'Left' : 'Right'}-handed · ${viewName(r.view)} · ${fmtDate(r.createdAt)}</div>
            <div class="ref-card-actions">
              <button type="button" class="btn btn-ghost btn-small" data-act="use">Use for ${esc(s.name.toLowerCase())}</button>
              <button type="button" class="btn btn-danger btn-small" data-act="delete">Delete</button>
            </div>
          </div>
        </article>`).join('')}
    </div>${all.length > shown.length ? `<button type="button" class="btn btn-ghost" data-expand="${s.id}">Show all ${all.length}</button>` : ''}</section>`;
  }).join('');
  for (const card of list.querySelectorAll('.ref-card')) {
    const r = state.refs.find((x) => x.id === card.dataset.id);
    let img = null;
    if (r.images?.[r.contact]) { try { img = await createImageBitmap(r.images[r.contact]); } catch { img = null; } }
    drawThumb(card.querySelector('canvas'), img, r.frames[r.contact], r.width, r.height, r.hand);
    img?.close?.();
  }
}

$('ref-list').addEventListener('click', async (e) => {
  const exp = e.target.closest('[data-expand]');
  if (exp) { libraryExpanded.add(exp.dataset.expand); renderLibrary(); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.ref-card').dataset.id;
  const r = state.refs.find((x) => x.id === id);
  if (btn.dataset.act === 'use') {
    // Make it the reference for its shot (works with auto-detect too).
    prefs.refByShot = { ...(prefs.refByShot || {}), [r.shot]: r.id };
    savePrefs();
    location.hash = '#analyze';
    renderCurrent();
    showMessage($('analyze-message'), `"${r.label}" is now the reference for every ${SHOT_BY_ID[r.shot].name.toLowerCase()}.`, 'ok');
  } else if (btn.dataset.act === 'delete') {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm delete';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'Delete'; } }, 4000);
      return;
    }
    await store.remove('refs', id);
    state.refs = state.refs.filter((x) => x.id !== id);
    state.refBitmaps.get(id)?.forEach((b) => b.close?.());
    state.refBitmaps.delete(id);
    refAnalyses.delete(id);
    refreshSetup();
    renderLibrary();
  }
});

$('export-btn').addEventListener('click', async () => {
  try {
    const data = await store.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stroke-match-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showMessage($('library-message'), `Exported ${data.refs.length} references and ${data.sessions.length} saved analyses.`, 'ok');
  } catch (e) { showMessage($('library-message'), `Export failed: ${e.message}`, 'error'); }
});
$('import-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const res = await store.importAll(JSON.parse(await f.text()));
    await reloadData();
    renderLibrary();
    showMessage($('library-message'), `Imported ${res.refs} references and ${res.sessions} saved analyses.`, 'ok');
  } catch (err) { showMessage($('library-message'), `Import failed: ${err.message}`, 'error'); }
});

// ---------- history ----------
const thumbUrls = [];
function renderHistory() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const filter = $('history-filter');
  const names = [...new Set(state.sessions.map((s) => s.student))].sort();
  const cur = filter.value;
  filter.innerHTML = '<option value="">All students</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  filter.value = names.includes(cur) ? cur : '';
  const rows = state.sessions.filter((s) => !filter.value || s.student === filter.value).sort((a, b) => b.createdAt - a.createdAt);
  if (!rows.length) {
    $('history-list').innerHTML = '<p class="empty">Nothing saved yet. After analyzing a stroke, use "Save to history".</p>';
    return;
  }
  $('history-list').innerHTML = rows.map((s) => {
    let src = '';
    if (s.thumb) { src = URL.createObjectURL(s.thumb); thumbUrls.push(src); }
    const score = s.score != null ? `${s.score}<small>match</small>` : `${s.onTarget}/${s.rated}<small>on target</small>`;
    return `<div class="history-row" data-id="${s.id}">
      ${src ? `<img src="${src}" alt="">` : '<img alt="">'}
      <div class="history-score">${score}</div>
      <div class="history-main">
        <div class="history-title">${esc(SHOT_BY_ID[s.shot]?.name || s.shot)} · ${esc(s.student)}</div>
        <div class="history-meta">${fmtDate(s.createdAt)} · ${s.refLabel ? `vs ${esc(s.refLabel)}` : 'guide ranges'}${s.tips?.length ? ` · ${esc(s.tips[0])}` : ''}</div>
      </div>
      <button type="button" class="btn btn-danger btn-small" data-act="delete">Delete</button>
    </div>`;
  }).join('');
}
$('history-filter').addEventListener('change', renderHistory);
$('history-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="delete"]');
  if (!btn) return;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1'; btn.textContent = 'Confirm delete';
    setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'Delete'; } }, 4000);
    return;
  }
  const id = btn.closest('.history-row').dataset.id;
  await store.remove('sessions', id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  renderHistory();
});

// ---------- boot ----------
buildSetup();
refreshSetup();
route();
showDemo();
reloadData().then(() => { if (!location.hash || location.hash === '#analyze') renderCurrent(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
  // When a new version takes over, reload once so the page runs it.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || state.live || bulkAbort) return;
    reloaded = true;
    location.reload();
  });
}
$('app-version').textContent = APP_VERSION;
