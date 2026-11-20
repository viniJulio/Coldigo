const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');
const F = require('../js/forecast.js');
const I = require('../js/indicators.js');
const S = require('../js/sim.js');

const candles = D.generateDemo({ days: 10, seed: 99 });
const ind = I.computeAll(candles);
const MIN = 300000;

test('breakeven: payout 85% => ~54,1%', () => {
  assert.ok(Math.abs(S.breakeven(85) - 0.5405) < 0.001);
  assert.equal(S.breakeven(100), 0.5);
});

test('evaluateAlert: dispara só se todos os critérios passam', () => {
  const a = F.analyze(candles, { seed: 1 });
  const r = S.evaluateAlert(candles, a, {}, 85);
  assert.equal(r.checks.length, 4);
  assert.equal(r.fire, r.checks.every(c => c.ok));
  // critérios impossíveis nunca disparam
  const never = S.evaluateAlert(candles, a, { minScore: 0.99, minEffN: 1e6 }, 85);
  assert.equal(never.fire, false);
  // critérios frouxos + payout 100% disparam quando o sinal atual existe
  const loose = S.evaluateAlert(candles, a, { minScore: 0.01, minModelP: 0, minEffN: 1, margin: -50 }, 100);
  assert.equal(loose.fire, true);
});

test('simulateHistory: contabilidade coerente e uma operação por vez', () => {
  const r = S.simulateHistory(candles, ind, 12, { minScore: 0.3, minEffN: 5, margin: -10 }, 85, 10);
  assert.ok(r.trades.length > 0);
  const wins = r.trades.filter(t => t.result === 'win').length, losses = r.trades.filter(t => t.result === 'loss').length;
  assert.equal(r.stats.pnl, Math.round((wins * 8.5 - losses * 10) * 100) / 100);
  for (let i = 1; i < r.trades.length; i++) assert.ok(r.trades[i].t - r.trades[i - 1].t >= 12 * MIN);
});

test('simulateHistory é causal: alterar candles futuros não muda operações passadas', () => {
  const cfg = { minScore: 0.3, minEffN: 3, margin: -20 };
  const full = S.simulateHistory(candles, ind, 12, cfg, 85, 10);
  assert.ok(full.trades.length >= 4, 'o teste precisa de operações para ser significativo');
  // corte logo depois da 3ª operação: ela e as anteriores precisam permanecer idênticas
  const k = candles.findIndex(c => c.t === full.trades[2].t) + 12;
  const head = candles.slice(0, k + 1);
  const mutated = candles.map((c, i) => (i > k ? Object.assign({}, c, { o: c.o * 1.2, h: c.h * 1.2, l: c.l * 1.2, c: c.c * 1.2 }) : c));
  const b = S.simulateHistory(mutated, I.computeAll(mutated), 12, cfg, 85, 10);
  const a = S.simulateHistory(head, I.computeAll(head), 12, cfg, 85, 10);
  const early = t => t.t <= full.trades[2].t;
  assert.deepEqual(a.trades.filter(early), full.trades.filter(early));
  assert.deepEqual(b.trades.filter(early), full.trades.filter(early));
});

const base = { price: 100, t: 1_000_000, stake: 10, payoutPct: 85, horizon: 3, intervalMs: 60000, symbol: 'BTCUSDT' };
const bars = (t0, closes) => closes.map((c, i) => ({ t: t0 + i * 60000, o: c, h: c, l: c, c, v: 1 }));

test('Portfolio: vitória paga o payout, derrota perde a entrada, empate devolve', () => {
  for (const [side, exit, saldo, res] of [['up', 101, 1008.5, 'win'], ['up', 99, 990, 'loss'], ['down', 99, 1008.5, 'win'], ['up', 100, 1000, 'tie']]) {
    const p = new S.Portfolio({ start: 1000 });
    const tr = p.openTrade(Object.assign({ side }, base));
    assert.equal(p.balance, 990);
    const done = p.settle(bars(tr.expiry - 60000, [100, exit]), tr.expiry + 1000);
    assert.equal(done.length, 1);
    assert.equal(done[0].result, res);
    assert.equal(p.balance, saldo);
    assert.equal(p.open.length, 0);
  }
});

test('Portfolio: não liquida antes do vencimento e valida saldo e valor', () => {
  const p = new S.Portfolio({ start: 100 });
  const tr = p.openTrade(Object.assign({ side: 'up' }, base));
  assert.equal(p.settle(bars(tr.t, [100, 105]), tr.expiry - 1).length, 0);
  assert.equal(p.open.length, 1);
  assert.throws(() => p.openTrade(Object.assign({ side: 'up' }, base, { stake: 500 })), /insuficiente/);
  assert.throws(() => p.openTrade(Object.assign({ side: 'up' }, base, { stake: 0 })), /maior que zero/);
});

test('Portfolio: liquidação tardia usa o candle do vencimento e marca como aproximada', () => {
  const p = new S.Portfolio({ start: 1000 });
  const tr = p.openTrade(Object.assign({ side: 'up' }, base));
  // no vencimento o preço era 103; 10 minutos depois está em 90
  const candles = bars(tr.expiry - 60000, [100, 103, 95, 92, 90]);
  const [d] = p.settle(candles, tr.expiry + 10 * 60000);
  assert.equal(d.result, 'win');
  assert.equal(d.approx, true);
});

test('Portfolio: serialização e reset', () => {
  const p = new S.Portfolio({ start: 500 });
  p.openTrade(Object.assign({ side: 'down' }, base));
  const q = new S.Portfolio(JSON.parse(JSON.stringify(p)));
  assert.equal(q.balance, 490); assert.equal(q.open.length, 1);
  q.reset(); assert.equal(q.balance, 500); assert.equal(q.open.length, 0);
});
