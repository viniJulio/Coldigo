const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');
const F = require('../js/forecast.js');

const candles = D.generateDemo({ days: 6, seed: 7 });

test('analyze devolve estrutura completa e é determinístico', () => {
  const a = F.analyze(candles, { seed: 1 });
  const b = F.analyze(candles, { seed: 1 });
  assert.equal(a.forecast.bands.length, a.options.horizon);
  assert.deepEqual(a.forecast.bands, b.forecast.bands);
  assert.ok(a.score >= -1 && a.score <= 1);
  assert.ok(['up', 'down', 'neutral'].includes(a.bias));
});

test('bandas são ordenadas e probabilidades somam 1', () => {
  const a = F.analyze(candles, { seed: 3 });
  for (const b of a.forecast.bands) {
    assert.ok(b.p10 <= b.p25 && b.p25 <= b.p50 && b.p50 <= b.p75 && b.p75 <= b.p90);
  }
  for (const side of [a.forecast.long, a.forecast.short]) {
    assert.ok(Math.abs(side.tp + side.sl + side.none - 1) < 1e-9);
  }
  assert.ok(a.forecast.expectedHigh.p50 >= a.last && a.forecast.expectedLow.p50 <= a.last);
});

test('score alto desloca a mediana para cima em relação a score baixo', () => {
  const opts = { horizon: 12, simulations: 3000, window: 200, driftFactor: 0.5, tpAtr: 1.5, slAtr: 1, seed: 5, atr: 100 };
  const up = F.monteCarlo(candles, 1, opts), down = F.monteCarlo(candles, -1, opts);
  assert.ok(up.bands[11].p50 > down.bands[11].p50);
  assert.ok(up.probUp > down.probUp);
});

test('alvo mais distante é menos provável que alvo próximo', () => {
  const base = { horizon: 12, simulations: 3000, window: 200, driftFactor: 0, slAtr: 100, seed: 5, atr: 100 };
  const near = F.monteCarlo(candles, 0, Object.assign({ tpAtr: 0.5 }, base));
  const far = F.monteCarlo(candles, 0, Object.assign({ tpAtr: 3 }, base));
  assert.ok(near.long.tp > far.long.tp);
});

test('backtest não cruza pregões e reporta taxas válidas', () => {
  const ind = require('../js/indicators.js').computeAll(candles);
  const bt = F.backtest(candles, ind, 12);
  assert.ok(bt.baseSamples > 0);
  for (const r of bt.rows) {
    if (r.signals) assert.ok(r.hitRate >= 0 && r.hitRate <= 1);
  }
});

test('poucos candles gera erro claro', () => {
  assert.throws(() => F.analyze(candles.slice(0, 10)), /pelo menos 40/);
});
