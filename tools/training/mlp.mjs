// Small one-hidden-layer network (tanh) with Adam, class-balanced loss.
export function fitMLP(train, CLASSES, { H = 32, epochs = 250, lr = 0.01, l2 = 1e-3, seed = 1 } = {}) {
  const D = train[0].x.length, K = CLASSES.length;
  let rs = seed;
  const rnd = () => { rs = (rs * 1103515245 + 12345) % 2147483648; return rs / 2147483648 - 0.5; };
  const mu = Array(D).fill(0), sd = Array(D).fill(0);
  for (const r of train) r.x.forEach((v, j) => { mu[j] += v / train.length; });
  for (const r of train) r.x.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / train.length; });
  for (let j = 0; j < D; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const X = train.map((r) => r.x.map((v, j) => (v - mu[j]) / sd[j]));
  const counts = CLASSES.map((_, k) => train.filter((r) => r.y === k).length);
  const present = counts.filter((c) => c).length;
  const cw = counts.map((c) => (c ? train.length / (present * c) : 0));
  const W1 = Array.from({ length: H }, () => Array.from({ length: D + 1 }, () => rnd() * 2 / Math.sqrt(D)));
  const W2 = Array.from({ length: K }, () => Array.from({ length: H + 1 }, () => rnd() * 2 / Math.sqrt(H)));
  const params = [W1, W2];
  const m = params.map((W) => W.map((w) => w.map(() => 0))), v = params.map((W) => W.map((w) => w.map(() => 0)));
  let t = 0;
  const idx = X.map((_, i) => i);
  for (let e = 0; e < epochs; e++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor((rnd() + 0.5) * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let b = 0; b < idx.length; b += 32) {
      const G = params.map((W) => W.map((w) => w.map(() => 0)));
      const batch = idx.slice(b, b + 32);
      for (const n of batch) {
        const x = X[n];
        const h = W1.map((w) => Math.tanh(w[D] + x.reduce((s, xv, j) => s + xv * w[j], 0)));
        const z = W2.map((w) => w[H] + h.reduce((s, hv, j) => s + hv * w[j], 0));
        const mx = Math.max(...z); const ex = z.map((q) => Math.exp(q - mx)); const se = ex.reduce((a, c) => a + c, 0);
        const dz = ex.map((q, k) => (q / se - (k === train[n].y ? 1 : 0)) * cw[train[n].y]);
        const dh = h.map(() => 0);
        dz.forEach((g, k) => { for (let j = 0; j < H; j++) { G[1][k][j] += g * h[j]; dh[j] += g * W2[k][j]; } G[1][k][H] += g; });
        dh.forEach((g, j) => { const gg = g * (1 - h[j] * h[j]); for (let i = 0; i < D; i++) G[0][j][i] += gg * x[i]; G[0][j][D] += gg; });
      }
      t++;
      params.forEach((W, p) => W.forEach((w, a) => w.forEach((_, c) => {
        const g = G[p][a][c] / batch.length + l2 * w[c];
        m[p][a][c] = 0.9 * m[p][a][c] + 0.1 * g;
        v[p][a][c] = 0.999 * v[p][a][c] + 0.001 * g * g;
        w[c] -= (lr * (m[p][a][c] / (1 - 0.9 ** t))) / (Math.sqrt(v[p][a][c] / (1 - 0.999 ** t)) + 1e-8);
      })));
    }
  }
  return { classes: CLASSES, mu, sd, W1, W2 };
}
export function predictMLP(model, x) {
  const D = model.mu.length, H = model.W1.length;
  const xs = x.map((val, j) => (val - model.mu[j]) / model.sd[j]);
  const h = model.W1.map((w) => Math.tanh(w[D] + xs.reduce((s, xv, j) => s + xv * w[j], 0)));
  const z = model.W2.map((w) => w[H] + h.reduce((s, hv, j) => s + hv * w[j], 0));
  const mx = Math.max(...z); const ex = z.map((q) => Math.exp(q - mx)); const se = ex.reduce((a, c) => a + c, 0);
  const p = ex.map((q) => q / se); const k = p.indexOf(Math.max(...p));
  return { k, p: p[k] };
}
