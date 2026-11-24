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

test('Portfolio: nunca liquida com candles de outro ativo nem atrasado; settleAt usa o preço consultado', () => {
  const p = new S.Portfolio({ start: 1000 });
  const eth = p.openTrade(Object.assign({ side: 'up' }, base, { symbol: 'ETHUSDT', price: 3554.92, stake: 20 }));
  const demo = bars(eth.expiry - 60000, [113000, 113736.85]); // candles de outro ativo (o erro da captura)
  assert.equal(p.settle(demo, eth.expiry + 1000, 'BTCUSDT').length, 0, 'ativo diferente: não liquida');
  assert.equal(p.settle(demo, eth.expiry + 60000, 'ETHUSDT').length, 0, 'mais de 20 s atrasado: não liquida pelo ao vivo');
  assert.deepEqual(p.needsLookup(eth.expiry + 60000, 'BTCUSDT').map(x => x.id), [eth.id]);
  const d = p.settleAt(eth.id, 3560, 'minute');
  assert.equal(d.result, 'win'); assert.equal(d.how, 'minute'); assert.equal(d.exit, 3560);
  assert.equal(p.open.length, 0);
  assert.equal(p.settleAt(eth.id, 3560), null, 'não liquida duas vezes');
});

test('Portfolio.repair: anula operação liquidada com preço de outro ativo e devolve o valor', () => {
  // estado salvo pela versão com erro: ETH 3.554,92 -> 113.736,85, binária, +R$ 17
  const p = new S.Portfolio({ start: 1000, balance: 1017, closed: [{ id: 1, side: 'up', entry: 3554.92, exit: 113736.85, stake: 20, payoutPct: 85, result: 'win', pnl: 17 }], seq: 1 });
  assert.equal(p.repair(), 1);
  assert.equal(p.balance, 1000);
  assert.equal(p.closed[0].result, 'void');
  assert.equal(S.summarize(p.closed).trades, 0, 'anuladas não entram nas estatísticas');
  assert.equal(p.repair(), 0, 'idempotente');
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

test('report: acerto com intervalo de 95%, sinal validado, a favor/contra o modelo e calibração', () => {
  const T = (id, side, p, result, decision, symbol) => ({ id, side, result, pnl: result === 'win' ? 8.5 : result === 'loss' ? -10 : 0, symbol: symbol || 'EUR/USD', context: p == null ? null : { p, decision: decision || 'none' } });
  const trades = [
    T(1, 'up', 0.62, 'win', 'call'), T(2, 'up', 0.62, 'win', 'call'), T(3, 'up', 0.61, 'loss', 'call'), // a favor, 60%+
    T(4, 'down', 0.40, 'win'),  // PUT com p(alta)=40% → 60% a favor
    T(5, 'up', 0.45, 'loss'), T(6, 'up', 0.45, 'loss'),             // contra o modelo
    T(7, 'up', 0.52, 'tie'),                                          // empate não entra no acerto
    T(8, 'up', null, 'win', null, 'BTCUSDT'),                         // sem contexto (versão antiga)
    { id: 9, side: 'up', result: 'void', pnl: 0, context: { p: 0.7, decision: 'call' } } // anulada: fora
  ];
  const r = S.report(trades);
  assert.deepEqual([r.total.n, r.total.wins, r.total.ties], [7, 4, 1]);
  assert.ok(r.total.low < r.total.rate && r.total.rate < r.total.high);
  assert.deepEqual([r.comSinal.n, r.comSinal.wins], [3, 2]);
  assert.deepEqual([r.semSinal.n, r.semSinal.wins], [3, 1]);
  assert.deepEqual([r.aFavor.n, r.aFavor.wins], [4, 3]);
  assert.deepEqual([r.contra.n, r.contra.wins], [2, 0]);
  const f = Object.fromEntries(r.faixas.map(x => [x.label, x]));
  assert.equal(f['60% ou mais'].n, 4); assert.equal(f['abaixo de 50%'].n, 2); assert.equal(f['50% a 55%'].n, 0); // o empate não conta
  assert.equal(r.semContexto, 1);
  assert.equal(r.porAtivo[0].chave, 'EUR/USD');
});

test('wilson: intervalo conhecido e amostra pequena muito larga', () => {
  const [lo, hi] = S.wilson(55, 100);
  assert.ok(Math.abs(lo - 0.452) < 0.002 && Math.abs(hi - 0.644) < 0.002, lo + ' ' + hi);
  const [a, b] = S.wilson(4, 5);
  assert.ok(b - a > 0.5, 'com 5 operações o intervalo é enorme');
  assert.deepEqual(S.wilson(0, 0), [null, null]);
});

test('toCSV: cabeçalho, separador ";" e decimal com vírgula', () => {
  const csv = S.toCSV([{ id: 1, t: Date.UTC(2026, 10, 24, 13, 2), expiry: Date.UTC(2026, 10, 24, 13, 7), symbol: 'EUR/USD', mode: 'binary', side: 'up', stake: 10, entry: 1.09571, exit: 1.09304, result: 'loss', pnl: -10, payoutPct: 85, context: { p: 0.6123, decision: 'call' }, source: 'manual', interval: '5m', horizon: 1, how: 'live' }]);
  const [h, l] = csv.split('\n');
  assert.ok(h.startsWith('id;entrada_utc;'));
  assert.equal(l, '1;2026-11-24 13:02:00;2026-11-24 13:07:00;EUR/USD;binaria;alta;10,00;1,095710;1,093040;loss;-10,00;0,6123;0,6123;sim;manual;5m;1;85;;live');
});
