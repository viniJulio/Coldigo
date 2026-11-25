const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/indicators.js');
const F = require('../js/forecast.js');
const M = require('../js/model.js');

const MIN = 60000;
const gauss = rnd => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/** Série de 1 min. Com signal>0, o fluxo de compra agressiva (taker) antecipa o retorno seguinte. */
function series(n, seed, signal) {
  const rnd = F.mulberry32(seed);
  let price = 100, imb = 0;
  const out = [], t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    imb = 0.9 * imb + 0.436 * gauss(rnd);
    const r = 0.001 * gauss(rnd) + signal * 0.00015 * imb;
    const o = price; price = o * Math.exp(r);
    const v = 100 + 50 * rnd();
    out.push({
      t: t0 + i * MIN, o, h: Math.max(o, price) * (1 + 0.0002 * rnd()), l: Math.min(o, price) * (1 - 0.0002 * rnd()), c: price, v,
      tb: v * Math.min(0.95, Math.max(0.05, 0.5 + 0.2 * Math.tanh(imb) + 0.03 * gauss(rnd)))
    });
  }
  return out;
}

test('normQuantile e zForTests', () => {
  assert.ok(Math.abs(M.normQuantile(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(M.normQuantile(0.5)) < 1e-9);
  assert.ok(Math.abs(M.normQuantile(0.99) - 2.326348) < 1e-4);
  assert.ok(Math.abs(M.zForTests(1) - 1.959964) < 1e-4);
  assert.ok(M.zForTests(10) > M.zForTests(3) && M.zForTests(3) > M.zForTests(1));
  assert.ok(Math.abs(M.zForTests(10) - 2.807) < 0.01);
});

test('wilsonLower: z maior dá limite mais baixo', () => {
  assert.ok(M.wilsonLower(60, 100, 2.8) < M.wilsonLower(60, 100, 1.96));
  assert.ok(M.wilsonLower(60, 100, 1.96) < 0.6);
  assert.equal(M.wilsonLower(0, 0, 1.96), null);
});

test('fitLogistic recupera uma relação conhecida', () => {
  const rnd = F.mulberry32(3), rows = [], y = [];
  for (let i = 0; i < 4000; i++) {
    const x = [gauss(rnd), gauss(rnd), gauss(rnd)];
    const p = 1 / (1 + Math.exp(-(1.2 * x[0] - 0.8 * x[1])));
    rows.push(Float64Array.from(x)); y.push(rnd() < p ? 1 : 0);
  }
  const m = M.fitLogistic(rows, y, 1);
  const scale = j => m.w[j + 1] / m.sd[j];
  assert.ok(Math.abs(scale(0) - 1.2) < 0.2, 'coef x0 ' + scale(0));
  assert.ok(Math.abs(scale(1) + 0.8) < 0.2, 'coef x1 ' + scale(1));
  assert.ok(Math.abs(scale(2)) < 0.15, 'coef x2 ' + scale(2));
});

test('features são causais: alterar o futuro não muda o passado', () => {
  const c = series(1200, 5, 1), K = 700;
  const f1 = M.buildFeatures(c, I.computeAll(c)).X;
  const mut = c.map((k, i) => (i > K ? Object.assign({}, k, { o: k.o * 1.3, h: k.h * 1.3, l: k.l * 1.3, c: k.c * 1.3, v: k.v * 3, tb: k.tb * 3 }) : k));
  const f2 = M.buildFeatures(mut, I.computeAll(mut)).X;
  for (let i = M.WARM; i <= K; i++) assert.deepEqual(Array.from(f1[i]), Array.from(f2[i]), 'feature em ' + i);
});

test('walk-forward não vaza o futuro: previsões em i <= K independem de candles após K', () => {
  const c = series(4200, 11, 1), H = 3, K = 3900;
  const a = M.walkForward(c, I.computeAll(c), H, {});
  const mut = c.map((k, i) => (i > K ? Object.assign({}, k, { c: k.c * 1.5, o: k.o * 1.5, h: k.h * 1.5, l: k.l * 1.5 }) : k));
  const b = M.walkForward(mut, I.computeAll(mut), H, {});
  const pa = a.preds.filter(q => q.i <= K), pb = b.preds.filter(q => q.i <= K);
  assert.ok(pa.length > 500);
  assert.deepEqual(pa.map(q => [q.i, q.p]), pb.map(q => [q.i, q.p]));
});

test('dados insuficientes são sinalizados', () => {
  const c = series(1000, 1, 0);
  const r = M.walkForward(c, I.computeAll(c), 12, {});
  assert.equal(r.insufficient, true);
  assert.ok(r.needed > 1000);
});

test('com sinal real (fluxo de ordens) o modelo supera o acaso fora da amostra', () => {
  const c = series(7000, 21, 1), H = 3;
  const wf = M.walkForward(c, I.computeAll(c), H, {});
  const ev = M.evaluate(wf.preds, H, 85, { marginPct: 1, minN: 30, z: 1.96 });
  assert.ok(ev.auc > 0.56, 'AUC ' + ev.auc);
  assert.ok(ev.brierSkill > 0, 'skill ' + ev.brierSkill);
  assert.ok(ev.accuracy > 0.52, 'acc ' + ev.accuracy);
  assert.equal(ev.validated, true, JSON.stringify({ n: ev.star.n, low: ev.star.hitLow, be: ev.breakeven }));
  // calibração: grupos com p maior têm frequência observada maior
  assert.ok(ev.calibration[ev.calibration.length - 1].freq > ev.calibration[0].freq);
});

test('passeio aleatório: sem vantagem, AUC ~0,5 e quase nunca "validado"', () => {
  let validated = 0, sumAuc = 0; const seeds = 12;
  for (let s = 1; s <= seeds; s++) {
    const c = series(4500, 100 + s, 0), H = 3;
    const wf = M.walkForward(c, I.computeAll(c), H, {});
    const ev = M.evaluate(wf.preds, H, 85, { marginPct: 1, minN: 30, z: 1.96 });
    sumAuc += ev.auc; if (ev.validated) validated++;
  }
  assert.ok(Math.abs(sumAuc / seeds - 0.5) < 0.02, 'AUC médio ' + sumAuc / seeds);
  assert.ok(validated <= 1, 'falsos positivos: ' + validated + ' de ' + seeds);
});

test('estratégia: operações não se sobrepõem e contas batem', () => {
  const preds = [];
  for (let i = 0; i < 100; i++) preds.push({ i, p: i % 2 ? 0.9 : 0.1, y: i % 2 ? 1 : 0 }); // sempre acerta
  const s = M.strategy(preds, 5, 0.6, 85, 1.96);
  assert.ok(s.signalsAll === 100 && s.n === 20 && s.hits === 20);
  for (let k = 1; k < s.trades.length; k++) assert.ok(s.trades[k].i - s.trades[k - 1].i >= 5);
  assert.equal(s.evPerUnit, 0.85);
});

test('correção de múltiplos testes torna o gate mais rígido', () => {
  const preds = [];
  const rnd = F.mulberry32(9);
  for (let i = 0; i < 4000; i++) preds.push({ i, p: 0.6, y: rnd() < 0.62 ? 1 : 0 });
  const k1 = M.evaluate(preds, 3, 85, { z: M.zForTests(1), minN: 30 });
  const k20 = M.evaluate(preds, 3, 85, { z: M.zForTests(20), minN: 30 });
  assert.ok(k20.star.hitLow < k1.star.hitLow);
});

test('quantization: separa preço em passos grandes de preço contínuo', () => {
  const smooth = series(500, 3, 0);
  assert.equal(M.quantization(smooth).quantized, false);
  // mesma série cotada em passos de 0,25% do preço: muitos candles "parados"
  const step = smooth.map(k => { const q = x => Math.round(x / 0.25) * 0.25; return Object.assign({}, k, { o: q(k.o), c: q(k.c) }); });
  const r = M.quantization(step);
  assert.ok(r.flatShare > 0.2 && r.quantized, 'flatShare ' + r.flatShare);
  assert.equal(M.quantization([]).quantized, false);
});

test('subconjunto de variáveis: usa só as colunas pedidas e rejeita nomes desconhecidos', () => {
  const c = series(5500, 33, 1), ind = I.computeAll(c);
  const wf = M.walkForward(c, ind, 3, { features: ['taker', 'taker5'] });
  const ev = M.evaluate(wf.preds, 3, 85, {});
  assert.ok(ev.auc > 0.55, 'AUC só com fluxo de ordens ' + ev.auc);
  assert.throws(() => M.walkForward(c, ind, 3, { features: ['nao_existe'] }), /desconhecida/);
  // o modelo guarda as colunas e prevê a partir da linha completa de variáveis
  const { X } = M.buildFeatures(c, ind);
  const m = M.fitLatest(c, X, M.labels(c, 3), 3, { features: ['taker'] }, c.length - 1);
  assert.deepEqual(m.cols, [M.FEATURES.indexOf('taker')]);
  assert.ok(m.w.length === 2 && M.predictProb(m, X[c.length - 1]) > 0 && M.predictProb(m, X[c.length - 1]) < 1);
});

test('padrão calibrado: não é superconfiante num passeio aleatório (regressão do overfitting)', () => {
  let nw = 0, old = 0; const N = 6;
  for (let s = 1; s <= N; s++) {
    const c = series(4500, 900 + s, 0), ind = I.computeAll(c);
    nw += M.evaluate(M.walkForward(c, ind, 3, {}).preds, 3, 85, {}).brierSkill;
    old += M.evaluate(M.walkForward(c, ind, 3, { lambda: 10, features: null }).preds, 3, 85, {}).brierSkill;
  }
  assert.ok(nw / N > -0.01, 'ganho Brier médio do padrão: ' + nw / N);
  assert.ok(nw / N > old / N + 0.005, 'o padrão deve calibrar melhor que λ=10 com 16 variáveis');
});

// ---------- custos (Binance) ----------
function drifting(n, seed, mu) {
  const rnd = F.mulberry32(seed); let price = 100; const out = [], t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) { const o = price; price = o * Math.exp(mu + 0.002 * gauss(rnd)); out.push({ t: t0 + i * MIN, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: 100 }); }
  return out;
}

test('custos: sinal forte e taxa pequena é validado; à vista nunca vende', () => {
  const c = series(7000, 21, 3), H = 3; // sinal plantado bem forte
  const wf = M.walkForward(c, I.computeAll(c), H, { keepTies: true });
  const fut = M.evaluateCosts(wf.preds, c, H, { market: 'futures', feePct: 0.005 });
  assert.ok(fut.validated, JSON.stringify({ n: fut.n, low: fut.net.low, ex: fut.excess.low }));
  assert.ok(fut.trades.some(t => t.side === 'down'));
  const spot = M.evaluateCosts(wf.preds, c, H, { market: 'spot', feePct: 0.005 });
  assert.ok(spot.n > 0 && spot.trades.every(t => t.side === 'up'));
  for (let k = 1; k < fut.trades.length; k++) assert.ok(fut.trades[k].i - fut.trades[k - 1].i >= H);
  // a conta fecha: líquido = direção × movimento − custo de ida e volta
  const t = fut.trades[0], dir = t.side === 'up' ? 1 : -1;
  assert.ok(Math.abs(t.net - (dir * (c[t.i + H].c / c[t.i].c - 1) - 2 * 0.005 / 100)) < 1e-12);
});

test('custos: taxa alta elimina as entradas; passeio aleatório não é validado', () => {
  const c = series(5000, 7, 1), H = 3;
  const wf = M.walkForward(c, I.computeAll(c), H, { keepTies: true });
  assert.equal(M.evaluateCosts(wf.preds, c, H, { market: 'futures', feePct: 5 }).n, 0);
  let validated = 0;
  for (let s = 1; s <= 8; s++) {
    const r = series(4500, 300 + s, 0), w = M.walkForward(r, I.computeAll(r), H, { keepTies: true });
    if (M.evaluateCosts(w.preds, r, H, { market: 'futures', feePct: 0.02 }).validated) validated++;
  }
  assert.ok(validated <= 1, 'falsos positivos ' + validated);
});

test('custos: subir por subir não conta (mercado em alta sem sinal não é validado)', () => {
  let validated = 0, positive = 0;
  for (let s = 1; s <= 6; s++) {
    const c = drifting(4500, 40 + s, 0.0006), H = 3; // alta forte e constante, sem nenhum sinal previsível
    const w = M.walkForward(c, I.computeAll(c), H, { keepTies: true });
    const ev = M.evaluateCosts(w.preds, c, H, { market: 'spot', feePct: 0.01 });
    if (ev.net.mean > 0) positive++;
    if (ev.validated) validated++;
  }
  assert.ok(positive >= 4, 'em alta, comprar costuma dar lucro bruto: ' + positive);
  assert.equal(validated, 0, 'mas o lucro vem da deriva, não do modelo');
});

test('evaluate (binário) ignora candles sem rótulo quando keepTies está ligado', () => {
  const c = series(4000, 5, 1);
  const a = M.evaluate(M.walkForward(c, I.computeAll(c), 3, {}).preds, 3, 85, {});
  const b = M.evaluate(M.walkForward(c, I.computeAll(c), 3, { keepTies: true }).preds, 3, 85, {});
  assert.equal(a.n, b.n); assert.equal(a.auc, b.auc);
});

test('calibrações prontas: configurações válidas e treináveis, saídas de 5, 10 e 15 min', () => {
  const L = require('../js/live.js');
  assert.deepEqual(M.CALIBRACOES.map(c => c.horizon * L.INTERVAL_MS[c.interval] / MIN), [5, 10, 15]);
  const c = series(4000, 11, 0), { X } = M.buildFeatures(c, I.computeAll(c));
  for (const cal of M.CALIBRACOES) {
    assert.ok(cal.modelo.features.every(f => M.FEATURES.includes(f)), cal.id);
    assert.ok(cal.limiar > 0.5 && cal.limiar < 0.7 && cal.confirmacao.n >= 100, cal.id);
    const m = M.fitLatest(c, X, M.labels(c, cal.horizon), cal.horizon, cal.modelo, c.length - 1);
    assert.equal(m.cols.length, cal.modelo.features.length, cal.id);
    const p = M.predictProb(m, X[c.length - 1]);
    assert.ok(p > 0 && p < 1, cal.id);
  }
});
