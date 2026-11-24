const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/sim.js');

const MIN = 300000;

test('breakeven: payout 85% => ~54,1%', () => {
  assert.ok(Math.abs(S.breakeven(85) - 0.5405) < 0.001);
  assert.equal(S.breakeven(100), 0.5);
});

const research = (over) => Object.assign({ star: { n: 80, hitLow: 0.58, hitRate: 0.62 }, brierSkill: 0.01 }, over);

test('evaluateAlert: dispara só com todos os critérios', () => {
  const ok = S.evaluateAlert({ p: 0.60, research: research() }, {}, 85);
  assert.equal(ok.fire, true); assert.equal(ok.side, 'up'); assert.equal(ok.checks.length, 4);
  const down = S.evaluateAlert({ p: 0.38, research: research() }, {}, 85);
  assert.equal(down.fire, true); assert.equal(down.side, 'down');
  // cada critério, sozinho, derruba o alerta
  assert.equal(S.evaluateAlert({ p: 0.60, research: research({ star: { n: 10, hitLow: 0.58 } }) }, {}, 85).fire, false); // amostra
  assert.equal(S.evaluateAlert({ p: 0.60, research: research({ star: { n: 80, hitLow: 0.50 } }) }, {}, 85).fire, false); // limite inferior abaixo do empate
  assert.equal(S.evaluateAlert({ p: 0.60, research: research({ brierSkill: -0.001 }) }, {}, 85).fire, false); // pior que o acaso
  assert.equal(S.evaluateAlert({ p: 0.52, research: research() }, {}, 85).fire, false); // probabilidade abaixo do limiar
});

test('evaluateAlert: sem pesquisa ainda fica pendente e não dispara', () => {
  const r = S.evaluateAlert({ p: 0.9, research: null }, {}, 85);
  assert.equal(r.fire, false); assert.equal(r.pending, true);
});

test('evaluateAlert: payout maior baixa o ponto de empate e o limiar', () => {
  const a = S.evaluateAlert({ p: 0.56, research: research() }, {}, 85), b = S.evaluateAlert({ p: 0.56, research: research() }, {}, 95);
  assert.ok(b.tStar < a.tStar);
});

test('pnlTrades: contabilidade das operações fora da amostra', () => {
  const tr = S.pnlTrades([{ i: 1, side: 'up', hit: true }, { i: 9, side: 'down', hit: false }, { i: 20, side: 'up', hit: true }], 10, 85);
  assert.deepEqual(tr.map(t => t.pnl), [8.5, -10, 8.5]);
  assert.equal(S.summarize(tr).pnl, 7);
  assert.equal(S.summarize(tr).wins, 2);
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

test('Portfolio com taxa (Binance): ganha o movimento menos a taxa de ida e volta', () => {
  const p = new S.Portfolio({ start: 1000 });
  const tr = p.openTrade(Object.assign({ side: 'up', feePct: 0.1 }, base, { stake: 100 }));
  assert.equal(tr.mode, 'fee');
  const [d] = p.settle(bars(tr.expiry - 60000, [100, 101]), tr.expiry + 1000); // +1%
  assert.equal(d.pnl, 0.8); // 100 × (1% − 0,2%)
  assert.equal(d.result, 'win');
  assert.equal(p.balance, 1000.8);
  const q = new S.Portfolio({ start: 1000 });
  const sh = q.openTrade(Object.assign({ side: 'down', feePct: 0.05 }, base, { stake: 100 }));
  const [e] = q.settle(bars(sh.expiry - 60000, [100, 100.05]), sh.expiry + 1000); // sobe 0,05% contra a venda
  assert.equal(e.pnl, -0.15); assert.equal(e.result, 'loss');
  // preço parado ainda paga a taxa
  const r = new S.Portfolio({ start: 1000 });
  const fl = r.openTrade(Object.assign({ side: 'up', feePct: 0.1 }, base, { stake: 100 }));
  assert.equal(r.settle(bars(fl.expiry - 60000, [100, 100]), fl.expiry + 1000)[0].pnl, -0.2);
});

test('evaluateAlertCosts: exige amostra, líquido e excesso positivos e probabilidade que cubra a taxa', () => {
  const research = over => Object.assign({ n: 80, net: { low: 0.001 }, excess: { low: 0.0005 }, costRoundTrip: 0.002, typicalNow: 0.01 }, over);
  // need = 0,5 + 0,002 / 0,02 = 0,6
  assert.equal(S.evaluateAlertCosts({ p: 0.62, research: research(), market: 'spot' }, {}).fire, true);
  assert.equal(S.evaluateAlertCosts({ p: 0.58, research: research(), market: 'spot' }, {}).fire, false);
  assert.equal(S.evaluateAlertCosts({ p: 0.62, research: research({ net: { low: -0.001 } }), market: 'spot' }, {}).fire, false);
  assert.equal(S.evaluateAlertCosts({ p: 0.62, research: research({ excess: { low: -0.001 } }), market: 'spot' }, {}).fire, false);
  assert.equal(S.evaluateAlertCosts({ p: 0.62, research: research({ n: 5 }), market: 'spot' }, {}).fire, false);
  const fut = S.evaluateAlertCosts({ p: 0.37, research: research(), market: 'futures' }, {});
  assert.equal(fut.side, 'down'); assert.equal(fut.fire, true);
  // à vista nunca sugere venda
  const sp = S.evaluateAlertCosts({ p: 0.37, research: research(), market: 'spot' }, {});
  assert.equal(sp.side, 'up'); assert.equal(sp.fire, false);
});
