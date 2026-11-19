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
  const r = L.fromRest([1700000000000, '100.5', '101', '99', '100.8', '12.5', 1700000059999]);
  assert.deepEqual(r, { t: 1700000000000, o: 100.5, h: 101, l: 99, c: 100.8, v: 12.5 });
  const w = L.fromWs({ t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '3' });
  assert.deepEqual(w, { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 });
});

test('wilsonLower: menor que a taxa observada e cresce com a amostra', () => {
  const small = F.wilsonLower(60, 100, 1), big = F.wilsonLower(600, 1000, 1);
  assert.ok(small < 0.6 && big < 0.6 && big > small);
  assert.ok(F.wilsonLower(600, 1000, 12) < big); // janelas sobrepostas reduzem a amostra efetiva
  assert.equal(F.wilsonLower(0, 0, 1), null);
});
