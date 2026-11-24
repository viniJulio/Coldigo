const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../js/forex.js');

const MIN = 60000;
const fmt = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const row = (t, c) => ({ datetime: fmt(t), open: String(c), high: String(c + 0.0001), low: String(c - 0.0001), close: String(c) });

test('converte a resposta do Twelve Data (mais novo primeiro, UTC) em candles cronológicos', () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 41);
  const c = F.toCandles({ status: 'ok', values: [row(t0 + 2 * MIN, 1.0934), row(t0 + MIN, 1.0933), row(t0, 1.0932)] });
  assert.deepEqual(c.map(k => k.t), [t0, t0 + MIN, t0 + 2 * MIN]);
  assert.equal(c[0].c, 1.0932); assert.equal(c[0].v, 0);
  assert.equal(F.parseUtc('2026-11-24 10:41:00'), t0);
  assert.throws(() => F.toCandles({ status: 'error', code: 429, message: 'x' }), /limite de consultas/);
  assert.throws(() => F.toCandles({ status: 'error', code: 401, message: 'x' }), /chave do Twelve Data/);
});

test('catálogo de pares: casas decimais e identificação', () => {
  const p = Object.fromEntries(F.PAIRS.map(a => [a.symbol, a.dec]));
  assert.equal(p['EUR/USD'], 5); assert.equal(p['USD/JPY'], 3); assert.equal(p['XAU/USD'], 2);
  assert.ok(F.isForex('EUR/USD') && !F.isForex('BTCUSDT'));
  assert.equal(F.TD_INTERVAL['3m'], undefined, 'o Twelve Data não tem 3 min');
});

test('fim de semana do câmbio', () => {
  assert.equal(F.marketClosed(Date.UTC(2026, 10, 21, 12)), true);  // sábado
  assert.equal(F.marketClosed(Date.UTC(2026, 10, 20, 22)), true);  // sexta 22h
  assert.equal(F.marketClosed(Date.UTC(2026, 10, 22, 22)), false); // domingo 22h (reabre)
  assert.equal(F.marketClosed(Date.UTC(2026, 10, 24, 12)), false); // terça
});

// relógio e agendador manuais para testar o feed sem esperar
function harness(responses) {
  let now = Date.UTC(2026, 10, 24, 10, 44, 30), queue = [], calls = [];
  const timers = { setTimeout: (f, ms) => { queue.push({ at: now + ms, f }); return queue.length; }, clearTimeout: () => {} };
  const fetchImpl = async url => { calls.push(new URL(url)); const r = responses.shift(); return { status: 200, json: async () => (typeof r === 'function' ? r() : r) }; };
  return {
    timers, fetchImpl, calls, now: () => now,
    async advance(ms) { // roda os temporizadores vencidos, em ordem
      const end = now + ms;
      for (;;) { queue.sort((a, b) => a.at - b.at); const n = queue[0]; if (!n || n.at > end) break; queue.shift(); now = n.at; await n.f(); }
      now = end;
    }
  };
}

test('feed: histórico, depois 1 consulta por candle; entrega o candle fechado antes do novo', async () => {
  const t = Date.UTC(2026, 10, 24, 10, 44); // candle em formação no momento do início
  const hist = { status: 'ok', values: [row(t, 1.1), row(t - MIN, 1.09), row(t - 2 * MIN, 1.08)] };
  const poll1 = { status: 'ok', values: [row(t + MIN, 1.2), row(t, 1.15), row(t - MIN, 1.09)] };
  const h = harness([hist, poll1]);
  const events = [], status = [];
  const feed = new F.ForexFeed({ symbol: 'EUR/USD', interval: '1m', apiKey: 'k', fetchImpl: h.fetchImpl, timers: h.timers, now: h.now,
    onData: (c, info) => events.push({ n: c.length, last: c.at(-1).t, lastC: c.at(-1).c, ...info }), onStatus: s => status.push(s) });
  await feed.start();
  assert.deepEqual(events[0], { n: 3, last: t, lastC: 1.1, reset: true, closed: true });
  assert.equal(h.calls[0].searchParams.get('interval'), '1min');
  assert.equal(h.calls[0].searchParams.get('timezone'), 'UTC');
  await h.advance(29000); // 10:44:59: ainda não fechou
  assert.equal(h.calls.length, 1);
  await h.advance(5000); // 10:45:03: consulta
  assert.equal(h.calls.length, 2);
  assert.deepEqual(events[1], { n: 3, last: t, lastC: 1.15, closed: true }, 'primeiro o candle que fechou, com o valor final');
  assert.deepEqual(events[2], { n: 4, last: t + MIN, lastC: 1.2, closed: false, added: true }, 'depois o candle novo');
  assert.ok(status.includes('live'));
  feed.stop();
});

test('feed: se o provedor ainda não abriu o candle novo, tenta de novo em 5 s; limite do plano espera 1 min', async () => {
  const t = Date.UTC(2026, 10, 24, 10, 44);
  const hist = { status: 'ok', values: [row(t, 1.1), row(t - MIN, 1.09)] };
  const atrasado = { status: 'ok', values: [row(t, 1.12), row(t - MIN, 1.09)] };
  const limite = { status: 'error', code: 429, message: 'limit' };
  const ok = { status: 'ok', values: [row(t + MIN, 1.2), row(t, 1.13)] };
  const h = harness([hist, atrasado, limite, ok]);
  const events = [];
  const feed = new F.ForexFeed({ symbol: 'EUR/USD', interval: '1m', apiKey: 'k', fetchImpl: h.fetchImpl, timers: h.timers, now: h.now, onData: (c, i) => events.push(i), onStatus: () => {} });
  await feed.start();
  await h.advance(33000); // consulta: candle novo ainda não existe
  assert.equal(h.calls.length, 2);
  assert.deepEqual(events.at(-1), { closed: false });
  await h.advance(5000); // nova tentativa: limite do plano
  assert.equal(h.calls.length, 3);
  await h.advance(59000);
  assert.equal(h.calls.length, 3, 'espera 1 minuto depois do limite');
  await h.advance(1500); // passa do minuto de espera (a consulta seguinte, atrasada, viria 1 s depois)
  assert.equal(h.calls.length, 4);
  assert.deepEqual(events.slice(-2), [{ closed: true }, { closed: false, added: true }]);
  feed.stop();
});

test('feed: sem chave ou tempo gráfico sem suporte avisa e não consulta', async () => {
  const st = [];
  const f1 = new F.ForexFeed({ symbol: 'EUR/USD', interval: '3m', apiKey: 'k', fetchImpl: async () => { throw new Error('não deveria'); }, onData() {}, onStatus: (k, m) => st.push([k, m]) });
  await f1.start();
  assert.match(st.at(-1)[1], /não tem candles de 3m/);
  const f2 = new F.ForexFeed({ symbol: 'EUR/USD', interval: '5m', apiKey: '', onData() {}, onStatus: (k, m) => st.push([k, m]) });
  await f2.start();
  assert.match(st.at(-1)[1], /cadastre a sua chave/);
});

test('priceAt: abertura do minuto consultado', async () => {
  const t = Date.UTC(2026, 10, 24, 10, 41);
  let q;
  const p = await F.priceAt('EUR/USD', t + 25000, 'k', async url => { q = new URL(url); return { status: 200, json: async () => ({ status: 'ok', values: [row(t, 1.09314)] }) }; });
  assert.equal(p, 1.09314);
  assert.equal(q.searchParams.get('start_date'), '2026-11-24 10:41:00');
  assert.equal(q.searchParams.get('end_date'), '2026-11-24 10:41:59');
});
