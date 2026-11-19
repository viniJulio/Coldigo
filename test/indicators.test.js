const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/indicators.js');

test('sma e ema', () => {
  assert.deepEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = I.ema([10, 10, 10, 10], 3);
  assert.equal(e[3], 10);
});

test('rsi: só alta = 100, só queda = 0', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(I.rsi(up, 14)[29], 100);
  assert.equal(I.rsi(down, 14)[29], 0);
});

test('atr de candles com range constante', () => {
  const c = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 102, l: 100, c: 101, v: 1 }));
  assert.ok(Math.abs(I.atr(c, 14)[29] - 2) < 1e-9);
});

test('vwap reinicia a cada pregão', () => {
  const d1 = new Date(2025, 0, 2, 10, 0).getTime(), d2 = new Date(2025, 0, 3, 10, 0).getTime();
  const c = [
    { t: d1, o: 10, h: 10, l: 10, c: 10, v: 100 },
    { t: d1 + 60000, o: 20, h: 20, l: 20, c: 20, v: 100 },
    { t: d2, o: 50, h: 50, l: 50, c: 50, v: 100 }
  ];
  const v = I.vwap(c);
  assert.equal(v[1], 15);
  assert.equal(v[2], 50);
});

test('bollinger: série constante tem bandas coladas', () => {
  const b = I.bollinger(new Array(25).fill(5), 20, 2);
  assert.equal(b.up[24], 5);
  assert.equal(b.lo[24], 5);
});

test('swingLevels agrupa topos próximos', () => {
  const mk = (h, l) => ({ t: 0, o: l, h, l, c: l, v: 1 });
  const base = [mk(10, 9), mk(10, 9), mk(10, 9), mk(15, 9), mk(10, 9), mk(10, 9), mk(10, 9),
    mk(15.1, 9), mk(10, 9), mk(10, 9), mk(10, 9)];
  const lv = I.swingLevels(base, 3, 0.5).filter(l => l.price > 14);
  assert.equal(lv.length, 1);
  assert.equal(lv[0].touches, 2);
});

test('pivotPoints usa o pregão anterior', () => {
  const t1 = new Date(2025, 0, 2, 10).getTime(), t2 = new Date(2025, 0, 3, 10).getTime();
  const p = I.pivotPoints([
    { t: t1, o: 10, h: 12, l: 8, c: 10, v: 1 },
    { t: t2, o: 10, h: 11, l: 9, c: 10, v: 1 }
  ]);
  assert.equal(p.PP, 10);
  assert.equal(p.R1, 12);
  assert.equal(p.S1, 8);
});
