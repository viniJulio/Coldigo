const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/live.js');
const F = require('../js/forecast.js');

test('mergeCandle: atualiza o candle em formação, adiciona o novo e ignora antigos', () => {
  const list = [{ t: 1000, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  assert.equal(L.mergeCandle(list, { t: 1000, o: 1, h: 2, l: 1, c: 2, v: 5 }, 10), 'update');
  assert.equal(list.length, 1); assert.equal(list[0].c, 2);
  assert.equal(L.mergeCandle(list, { t: 2000, o: 2, h: 2, l: 2, c: 2, v: 1 }, 10), 'new');
  assert.equal(list.length, 2);
  assert.equal(L.mergeCandle(list, { t: 500, o: 0, h: 0, l: 0, c: 0, v: 0 }, 10), 'ignore');
  assert.equal(list.length, 2);
});

test('mergeCandle respeita o limite máximo de candles', () => {
  const list = [{ t: 1 }, { t: 2 }, { t: 3 }];
  L.mergeCandle(list, { t: 4 }, 3);
  assert.deepEqual(list.map(c => c.t), [2, 3, 4]);
});

test('converte formatos de kline da Binance (REST e WebSocket)', () => {
  const r = L.fromRest([1700000000000, '100.5', '101', '99', '100.8', '12.5', 1700000059999, '1250', 321, '7.5', '750', '0']);
  assert.deepEqual(r, { t: 1700000000000, o: 100.5, h: 101, l: 99, c: 100.8, v: 12.5, nt: 321, tb: 7.5 });
  const w = L.fromWs({ t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '3', n: 40, V: '1.2' });
  assert.deepEqual(w, { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 3, nt: 40, tb: 1.2 });
});

test('wilsonLower: menor que a taxa observada e cresce com a amostra', () => {
  const small = F.wilsonLower(60, 100, 1), big = F.wilsonLower(600, 1000, 1);
  assert.ok(small < 0.6 && big < 0.6 && big > small);
  assert.ok(F.wilsonLower(600, 1000, 12) < big); // janelas sobrepostas reduzem a amostra efetiva
  assert.equal(F.wilsonLower(0, 0, 1), null);
});

test('LiveFeed pagina o histórico até o total pedido, em ordem cronológica', async () => {
  const MIN = 60000, total = 2500, t0 = 1_700_000_000_000;
  const row = i => [t0 + i * MIN, '1', '1', '1', '1', '1', 0, '0', 1, '0.5', '0', '0'];
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    const u = new URL(url), lim = +u.searchParams.get('limit'), end = u.searchParams.get('endTime');
    const last = end ? Math.floor((+end - t0) / MIN) : total - 1;
    const rows = [];
    for (let i = Math.max(0, last - lim + 1); i <= last; i++) rows.push(row(i));
    return { ok: true, status: 200, json: async () => rows };
  };
  const feed = new L.LiveFeed({ symbol: 'BTCUSDT', interval: '1m', history: 2500, onData() {}, onStatus() {} });
  feed.stopped = false;
  const out = await feed._history();
  assert.equal(calls.length, 3);
  assert.equal(out.length, 2500);
  assert.ok(out.every((c, i) => i === 0 || c.t - out[i - 1].t === MIN));
  delete global.fetch;
});
