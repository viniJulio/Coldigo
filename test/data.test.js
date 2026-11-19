const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');

test('CSV ISO com cabeçalho em inglês', () => {
  const r = D.parseCSV('datetime,open,high,low,close,volume\n2025-01-02 10:00:00,100,101,99,100.5,1000\n2025-01-02 10:05:00,100.5,102,100,101,800');
  assert.equal(r.length, 2);
  assert.equal(r[1].c, 101);
  assert.equal(r[1].t - r[0].t, 5 * 60000);
});

test('CSV brasileiro: ; e vírgula decimal, dd/mm/aaaa', () => {
  const r = D.parseCSV('Data;Hora;Abertura;Máxima;Mínima;Fechamento;Volume\n02/01/2025;10:00;125.100,50;125.200,00;125.000,00;125.150,50;1.234\n02/01/2025;10:05;125.150,50;125.300,00;125.100,00;125.250,00;980');
  assert.equal(r[0].o, 125100.5);
  assert.equal(new Date(r[0].t).getMonth(), 0);
  assert.equal(new Date(r[0].t).getDate(), 2);
  assert.equal(r[0].v, 1234);
});

test('MetaTrader: <DATE> <TIME> separados por tab', () => {
  const r = D.parseCSV('<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\n2025.01.02\t10:00:00\t10\t11\t9\t10.5\t5\n2025.01.02\t10:05:00\t10.5\t12\t10\t11\t7');
  assert.equal(r.length, 2);
  assert.equal(r[0].h, 11);
});

test('sem cabeçalho, 7 colunas = data,hora,o,h,l,c,v', () => {
  const r = D.parseCSV('2025-01-02,10:00,1,2,0.5,1.5,10\n2025-01-02,10:01,1.5,2,1,1.2,12');
  assert.equal(r.length, 2);
  assert.equal(r[1].l, 1);
});

test('erro quando faltam colunas', () => {
  assert.throws(() => D.parseCSV('datetime,open\n2025-01-02 10:00,1'), /não encontrada/);
});

test('demo gera candles coerentes (h>=max(o,c), l<=min(o,c))', () => {
  const c = D.generateDemo({ days: 2 });
  assert.equal(c.length, 2 * 96);
  assert.ok(c.every(x => x.h >= Math.max(x.o, x.c) && x.l <= Math.min(x.o, x.c)));
});

test('toCSV -> parseCSV é reversível', () => {
  const c = D.generateDemo({ days: 1 });
  const back = D.parseCSV(D.toCSV(c));
  assert.equal(back.length, c.length);
  assert.ok(Math.abs(back[10].c - c[10].c) < 0.01);
});
