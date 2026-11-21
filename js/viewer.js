// Synced playback of a student stroke and a reference stroke:
// side-by-side video with skeletons, or both skeletons overlaid.

import { EDGES, CANON_EDGES, C, anchors, indexFromU, uFromIndex, poseAt } from './analysis.js';

const COLORS = {
  student: '#e3f25a',
  ref: '#7cd0ff',
  bg: '#11273a',
  court: '#1c3d59',
  line: 'rgba(255,255,255,0.55)',
};

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function interpFrame(frames, idx) {
  const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(idx)));
  const i1 = Math.min(frames.length - 1, i0 + 1);
  const f = Math.max(0, Math.min(1, idx - i0));
  return frames[i0].map((p, j) => [p[0] + (frames[i1][j][0] - p[0]) * f, p[1] + (frames[i1][j][1] - p[1]) * f, p[2]]);
}

function bbox(frames) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of frames) for (const p of f) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  const pad = 0.12 * Math.max(x1 - x0, y1 - y0);
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

export class StrokeViewer {
  constructor(root, { phases = ['Preparation', 'Contact', 'Finish'] } = {}) {
    this.root = root;
    this.mode = 'side';
    this.speed = 0.5;
    this.pos = 0;
    this.playing = false;
    this.phases = phases;
    root.classList.add('viewer');
    root.innerHTML = `
      <div class="viewer-stage">
        <div class="viewer-panels">
          <figure class="panel"><canvas data-side="student"></canvas><figcaption data-cap="student"></figcaption></figure>
          <figure class="panel" data-ref-panel><canvas data-side="ref"></canvas><figcaption data-cap="ref"></figcaption></figure>
        </div>
        <figure class="panel overlay" hidden><canvas data-side="overlay"></canvas>
          <figcaption><span class="key key-student">Student</span><span class="key key-ref">Reference</span></figcaption></figure>
      </div>
      <div class="viewer-controls">
        <button type="button" class="btn btn-icon" data-act="play" aria-label="Play">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div class="scrub">
          <input type="range" min="0" max="100" step="0.01" value="0" aria-label="Stroke timeline" data-act="scrub">
          <div class="ticks" aria-hidden="true"></div>
        </div>
        <select data-act="speed" aria-label="Playback speed">
          <option value="0.25">¼×</option><option value="0.5" selected>½×</option><option value="1">1×</option>
        </select>
        <div class="seg" role="group" aria-label="View">
          <button type="button" data-mode="side" aria-pressed="true">Side by side</button>
          <button type="button" data-mode="overlay" aria-pressed="false">Overlay</button>
        </div>
      </div>`;
    this.canvases = {
      student: root.querySelector('[data-side="student"]'),
      ref: root.querySelector('[data-side="ref"]'),
      overlay: root.querySelector('[data-side="overlay"]'),
    };
    this.scrub = root.querySelector('[data-act="scrub"]');
    this.playBtn = root.querySelector('[data-act="play"]');
    this.ticks = root.querySelector('.ticks');
    this.scrub.addEventListener('input', () => { this.pause(); this.pos = +this.scrub.value; this.draw(); });
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    root.querySelector('[data-act="speed"]').addEventListener('change', (e) => { this.speed = +e.target.value; });
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
  }

  setMode(mode) {
    this.mode = mode;
    this.root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    this.root.querySelector('.viewer-panels').hidden = mode !== 'side';
    this.root.querySelector('.overlay').hidden = mode !== 'overlay';
    this.resize();
  }

  // side: { analysis, frames (pixel keypoints), width, height, images?, label }
  setData({ student, ref, phases }) {
    this.pause();
    this.student = student;
    this.ref = ref || null;
    if (phases) this.phases = phases;
    for (const s of [student, ref]) if (s && !s.images?.length) s.box = bbox(s.frames);
    this.master = this.ref || this.student;
    this.aM = anchors(this.master.analysis.events);
    this.aS = anchors(student.analysis.events);
    this.aR = this.ref ? anchors(this.ref.analysis.events) : null;
    this.root.querySelector('[data-ref-panel]').hidden = !this.ref;
    this.root.classList.toggle('single', !this.ref);
    this.root.querySelector('[data-cap="student"]').textContent = student.label || 'Student';
    this.root.querySelector('[data-cap="ref"]').textContent = ref?.label || '';
    this.root.querySelector('.overlay figcaption .key-ref').hidden = !this.ref;
    const n = this.master.frames.length - 1;
    this.scrub.max = String(n);
    this.pos = this.master.analysis.events.contact;
    this.scrub.value = String(this.pos);
    const ev = this.master.analysis.events;
    const marks = [[ev.prep, this.phases[0]], [ev.contact, this.phases[1]], [ev.finish, this.phases[2]]];
    // Stagger labels that would collide.
    let lastPct = -100, low = false, anyLow = false;
    this.ticks.innerHTML = marks.map(([i, name]) => {
      const pct = (100 * i) / n;
      low = pct - lastPct < 16 ? !low : false;
      anyLow = anyLow || low;
      lastPct = pct;
      return `<span class="${low ? 'low' : ''}" style="left:${pct}%">${name}</span>`;
    }).join('');
    this.ticks.parentElement.classList.toggle('two-rows', anyLow);
    this.resize();
  }

  jumpTo(event) {
    if (!this.master) return;
    this.pause();
    this.pos = this.master.analysis.events[event];
    this.scrub.value = String(this.pos);
    this.draw();
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = (canvas, aspect) => {
      const w = canvas.clientWidth || canvas.parentElement.clientWidth;
      if (!w) return;
      canvas.style.aspectRatio = String(aspect);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round((w / aspect) * dpr);
    };
    if (this.student) {
      const asp = (s) => (s.images?.length ? s.images[0].width / s.images[0].height : s.width && s.height ? s.width / s.height : 4 / 3);
      const a = this.ref ? Math.max(0.6, Math.min(asp(this.student), 1.4)) : asp(this.student);
      size(this.canvases.student, Math.max(0.5, Math.min(a, 1.8)));
      if (this.ref) size(this.canvases.ref, Math.max(0.5, Math.min(a, 1.8)));
      size(this.canvases.overlay, 4 / 3);
    }
    this.draw();
  }

  play() {
    if (!this.master) return;
    this.playing = true;
    this.playBtn.setAttribute('aria-label', 'Pause');
    this.playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
    const n = this.master.frames.length - 1;
    if (this.pos >= n) this.pos = 0;
    let last = performance.now();
    const fps = this.master.analysis.fps / (this.master.analysis.timeScale || 1);
    const stepFn = (now) => {
      if (!this.playing) return;
      this.pos += ((now - last) / 1000) * fps * this.speed;
      last = now;
      if (this.pos >= n) { this.pos = n; this.draw(); this.pause(); return; }
      this.scrub.value = String(this.pos);
      this.draw();
      this.raf = requestAnimationFrame(stepFn);
    };
    this.raf = requestAnimationFrame(stepFn);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.playBtn.setAttribute('aria-label', 'Play');
    this.playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  }

  indices() {
    const u = uFromIndex(this.aM, this.pos);
    return {
      u,
      s: this.ref ? indexFromU(this.aS, u) : this.pos,
      r: this.ref ? this.pos : null,
    };
  }

  draw() {
    if (!this.student) return;
    const { s, r } = this.indices();
    if (this.mode === 'side') {
      this.drawPanel(this.canvases.student, this.student, s, COLORS.student);
      if (this.ref) this.drawPanel(this.canvases.ref, this.ref, r, COLORS.ref);
    } else {
      this.drawOverlay(this.canvases.overlay, s, r);
    }
  }

  drawPanel(canvas, side, idx, color) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = cssVar('--stage', COLORS.bg);
    ctx.fillRect(0, 0, W, H);
    let tf;
    if (side.images?.length) {
      const img = side.images[Math.max(0, Math.min(side.images.length - 1, Math.round(idx)))];
      const k = Math.min(W / img.width, H / img.height);
      const dw = img.width * k, dh = img.height * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
      try { ctx.drawImage(img, ox, oy, dw, dh); } catch { /* frame no longer available; still draw the skeleton */ }
      const sx = dw / side.width;
      tf = (p) => [ox + p[0] * sx, oy + p[1] * sx];
    } else {
      const b = side.box;
      const k = Math.min(W / b.w, H / b.h);
      const ox = (W - b.w * k) / 2, oy = (H - b.h * k) / 2;
      tf = (p) => [ox + (p[0] - b.x) * k, oy + (p[1] - b.y) * k];
      // Ground line under the feet.
      let feet = -Infinity;
      for (const f of side.frames) feet = Math.max(feet, f[15][1], f[16][1]);
      ctx.strokeStyle = COLORS.line; ctx.lineWidth = Math.max(1, W / 300);
      const gy = tf([0, feet + 6])[1];
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }
    const kps = interpFrame(side.frames, idx);
    const hit = side.analysis.hand === 'L' ? 9 : 10;
    // Hand path up to now.
    ctx.strokeStyle = color; ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(1.5, W / 260);
    ctx.beginPath();
    for (let i = 0; i <= Math.floor(idx); i++) {
      const p = tf(side.frames[i][hit]);
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
    this.drawSkeleton(ctx, kps.map(tf), EDGES, color, W, side.analysis.hand === 'L' ? [[5, 7], [7, 9]] : [[6, 8], [8, 10]]);
    // Head
    const sh = tf(kps[5]), sr = tf(kps[6]), hp = tf([(kps[11][0] + kps[12][0]) / 2, (kps[11][1] + kps[12][1]) / 2]);
    const torsoPx = Math.hypot((sh[0] + sr[0]) / 2 - hp[0], (sh[1] + sr[1]) / 2 - hp[1]);
    if (kps[0][2] > 0.2 && torsoPx > 4) {
      const hd = tf(kps[0]);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, W / 170);
      ctx.beginPath(); ctx.arc(hd[0], hd[1], torsoPx * 0.17, 0, Math.PI * 2); ctx.stroke();
    }
    this.drawStamp(ctx, side, idx, W, H);
  }

  drawStamp(ctx, side, idx, W, H) {
    const ev = side.analysis.events;
    const near = (e) => Math.abs(idx - ev[e]) < 0.75;
    const label = near('contact') ? this.phases[1] : near('prep') ? this.phases[0] : near('finish') ? this.phases[2] : '';
    if (!label) return;
    const fs = Math.max(11, W / 26);
    ctx.font = `600 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    const tw = ctx.measureText(label.toUpperCase()).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(fs * 0.6, fs * 0.6, tw + fs, fs * 1.6);
    ctx.fillStyle = '#fff';
    ctx.fillText(label.toUpperCase(), fs * 1.1, fs * 1.75);
  }

  drawSkeleton(ctx, pts, edges, color, W, thick = []) {
    const isThick = (a, b) => thick.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    const lw = Math.max(2, W / 170);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = lw + 2.5;
    for (const [a, b] of edges) { ctx.beginPath(); ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); ctx.stroke(); }
    ctx.strokeStyle = color;
    for (const [a, b] of edges) {
      ctx.lineWidth = isThick(a, b) ? lw * 1.6 : lw;
      ctx.beginPath(); ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); ctx.stroke();
    }
    ctx.fillStyle = color;
    const used = new Set(edges.flat());
    for (const i of used) { ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], lw * 0.9, 0, Math.PI * 2); ctx.fill(); }
  }

  drawOverlay(canvas, s, r) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = cssVar('--stage', COLORS.bg);
    ctx.fillRect(0, 0, W, H);
    // Canonical space: hips at the origin, torso = 1, y up, swing toward +x.
    const yTop = 3.1, yBot = -1.5;
    const k = H / (yTop - yBot);
    const tf = (p) => [W / 2 + p[0] * k, (yTop - p[1]) * k];
    ctx.strokeStyle = COLORS.line; ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    for (const y of [0, 1]) { const yy = tf([0, y])[1]; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke(); }
    ctx.setLineDash([]);
    const fs = Math.max(10, W / 48);
    ctx.font = `500 ${fs}px Barlow, system-ui, sans-serif`;
    ctx.fillStyle = COLORS.line;
    ctx.fillText('shoulders', 8, tf([0, 1])[1] - 5);
    ctx.fillText('hips', 8, tf([0, 0])[1] - 5);
    ctx.fillText('swing direction →', W - ctx.measureText('swing direction →').width - 8, H - 8);
    const hitArm = [[C.hitSho, C.hitElb], [C.hitElb, C.hitWri]];
    const trail = (an, upto, color) => {
      ctx.strokeStyle = color; ctx.globalAlpha = 0.4; ctx.lineWidth = Math.max(1.5, W / 300);
      ctx.beginPath();
      for (let i = 0; i <= Math.floor(upto); i++) {
        const p = tf(an.canon[i][C.hitWri]);
        if (i === 0) ctx.moveTo(...p); else ctx.lineTo(...p);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    };
    if (this.ref) {
      trail(this.ref.analysis, r, COLORS.ref);
      this.drawSkeleton(ctx, poseAt(this.ref.analysis, r).map(tf), CANON_EDGES, COLORS.ref, W, hitArm);
    }
    trail(this.student.analysis, s, COLORS.student);
    this.drawSkeleton(ctx, poseAt(this.student.analysis, s).map(tf), CANON_EDGES, COLORS.student, W, hitArm);
    const head = (an, idx, color) => {
      const p = tf(poseAt(an, idx)[C.head]);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, W / 170);
      ctx.beginPath(); ctx.arc(p[0], p[1], k * 0.16, 0, Math.PI * 2); ctx.stroke();
    };
    if (this.ref) head(this.ref.analysis, r, COLORS.ref);
    head(this.student.analysis, s, COLORS.student);
  }

  destroy() {
    this.pause();
    this.ro.disconnect();
  }
}
