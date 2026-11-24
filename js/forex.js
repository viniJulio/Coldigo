/* Câmbio real (mercado interbancário) pelo Twelve Data, para o modo opção binária.
 * O plano grátis permite 8 consultas por minuto e 800 por dia, sem streaming contínuo. Por isso o
 * feed faz 1 consulta para o histórico e depois 1 consulta logo após o fechamento de cada candle.
 * A chave é do próprio usuário e fica só no navegador dele (o Twelve Data aceita chamadas do navegador). */
(function (root) {
  'use strict';

  const BASE = 'https://api.twelvedata.com';
  const TD_INTERVAL = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h' };
  const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000 };
  const DAILY_LIMIT = 800;

  // Pares comuns nas corretoras de opção binária (fora os OTC, que são da própria corretora)
  const PAIRS = [
    ['EUR/USD', 5], ['GBP/USD', 5], ['USD/JPY', 3], ['AUD/USD', 5], ['USD/CAD', 5], ['USD/CHF', 5], ['NZD/USD', 5],
    ['EUR/GBP', 5], ['EUR/JPY', 3], ['GBP/JPY', 3], ['AUD/JPY', 3], ['EUR/AUD', 5], ['AUD/CAD', 5], ['CAD/JPY', 3],
    ['CHF/JPY', 3], ['EUR/CAD', 5], ['GBP/CHF', 5], ['XAU/USD', 2]
  ].map(([symbol, dec]) => ({ symbol, label: symbol === 'XAU/USD' ? 'Ouro (XAU/USD)' : symbol, group: 'Câmbio real', dec, provider: 'twelvedata' }));
  const isForex = sym => typeof sym === 'string' && sym.includes('/');

  /** "2026-11-24 10:43:00" (UTC) -> ms */
  function parseUtc(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }

  /** Resposta do time_series (mais novo primeiro) -> candles em ordem cronológica. Câmbio não tem volume. */
  function toCandles(json) {
    if (!json || json.status === 'error') throw tdError(json);
    return (json.values || []).map(v => ({ t: parseUtc(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +(v.volume || 0) }))
      .filter(k => Number.isFinite(k.t) && k.c > 0).sort((a, b) => a.t - b.t);
  }

  function tdError(json) {
    const code = json && json.code, msg = (json && json.message) || 'erro desconhecido';
    let txt;
    if (code === 401) txt = 'chave do Twelve Data ausente ou inválida. Confira a chave em Parâmetros.';
    else if (code === 429) txt = 'limite de consultas do plano grátis do Twelve Data atingido (8 por minuto e 800 por dia). Use um tempo gráfico maior ou espere.';
    else if (code === 400 || code === 404) txt = 'par ou tempo gráfico não disponível no Twelve Data: ' + msg;
    else txt = 'Twelve Data: ' + msg;
    return Object.assign(new Error(txt), { code });
  }

  // Contador de consultas do dia (UTC), salvo no navegador
  const usage = {
    key: () => 'coldigo.td.' + new Date().toISOString().slice(0, 10),
    get() { try { return +(root.localStorage && root.localStorage.getItem(this.key())) || 0; } catch (_) { return 0; } },
    add() { try { if (root.localStorage) root.localStorage.setItem(this.key(), String(this.get() + 1)); } catch (_) { /* ignora */ } }
  };

  async function call(params, apiKey, fetchImpl) {
    if (!apiKey) throw new Error('cadastre a sua chave do Twelve Data (Parâmetros → Dados de câmbio real) para usar os pares de câmbio.');
    const q = new URLSearchParams(Object.assign({ timezone: 'UTC', apikey: apiKey }, params)).toString();
    let res;
    try { res = await (fetchImpl || fetch)(`${BASE}/time_series?${q}`); } catch (_) { throw new Error('sem conexão com o Twelve Data.'); }
    usage.add();
    let json; try { json = await res.json(); } catch (_) { throw new Error(`Twelve Data respondeu HTTP ${res.status}`); }
    return toCandles(json);
  }

  /** Preço de abertura do minuto que contém `t` (para liquidar operações vencidas com o app fechado). */
  async function priceAt(symbol, t, apiKey, fetchImpl) {
    const start = Math.floor(t / 60000) * 60000;
    const f = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const rows = await call({ symbol, interval: '1min', start_date: f(start), end_date: f(start + 59000), outputsize: 1 }, apiKey, fetchImpl);
    const k = rows.find(r => r.t === start);
    return k ? k.o : null;
  }

  function mergeCandle(candles, c, max) {
    const last = candles[candles.length - 1];
    if (last && last.t === c.t) { candles[candles.length - 1] = c; return 'update'; }
    if (!last || c.t > last.t) { candles.push(c); if (max && candles.length > max) candles.shift(); return 'new'; }
    return 'ignore';
  }

  /** Feed com a mesma interface do feed da Binance: onData(candles, {reset|closed|added}), onStatus(kind, msg). */
  class ForexFeed {
    constructor(o) {
      this.symbol = o.symbol; this.interval = o.interval; this.apiKey = o.apiKey;
      this.onData = o.onData; this.onStatus = o.onStatus;
      this.history = Math.min(5000, o.history || 5000);
      this.fetch = o.fetchImpl; this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: id => clearTimeout(id) };
      this.now = o.now || (() => Date.now());
      this.candles = []; this.stopped = true; this.timer = null; this.retries = 0;
    }

    get intervalMs() { return INTERVAL_MS[this.interval]; }

    async start() {
      this.stopped = false;
      if (!TD_INTERVAL[this.interval]) { this.onStatus('error', 'o Twelve Data não tem candles de ' + this.interval + '. Use 1, 5, 15 ou 30 min, 1 h ou 4 h.'); return; }
      this.onStatus('loading', 'Twelve Data');
      try {
        this.candles = await call({ symbol: this.symbol, interval: TD_INTERVAL[this.interval], outputsize: this.history }, this.apiKey, this.fetch);
        if (this.candles.length < 2) throw new Error('o Twelve Data não devolveu histórico para ' + this.symbol + '.');
      } catch (e) { if (!this.stopped) this.onStatus('error', e.message); return; }
      if (this.stopped) return;
      this.onData(this.candles, { reset: true, closed: true });
      this.onStatus('live');
      this._schedule();
    }

    stop() { this.stopped = true; if (this.timer != null) this.timers.clearTimeout(this.timer); this.timer = null; }

    // Próxima consulta: 3 s depois do fechamento do candle em formação
    _schedule(delay) {
      if (this.stopped) return;
      const last = this.candles[this.candles.length - 1];
      const wait = delay != null ? delay : Math.max(1000, last.t + this.intervalMs + 3000 - this.now());
      this.timer = this.timers.setTimeout(() => this._poll(), wait);
    }

    async _poll() {
      if (this.stopped) return;
      const prevT = this.candles[this.candles.length - 1].t;
      let rows;
      try {
        rows = await call({ symbol: this.symbol, interval: TD_INTERVAL[this.interval], outputsize: 3 }, this.apiKey, this.fetch);
      } catch (e) {
        if (this.stopped) return;
        this.onStatus('reconnecting');
        this.retries++;
        return this._schedule(e.code === 429 ? 60000 : Math.min(60000, 5000 * this.retries));
      }
      if (this.stopped) return;
      this.retries = 0;
      const closed = rows.find(r => r.t === prevT), fresh = rows.filter(r => r.t > prevT);
      if (!fresh.length) { // o provedor ainda não abriu o candle novo: tenta de novo em 5 s
        if (closed) { mergeCandle(this.candles, closed); this.onData(this.candles, { closed: false }); }
        this.onStatus('live');
        return this._schedule(5000);
      }
      // 1) o candle que fechou, com os valores finais (o alerta é avaliado aqui); 2) os novos
      if (closed) mergeCandle(this.candles, closed);
      this.onData(this.candles, { closed: true });
      for (const r of fresh) { mergeCandle(this.candles, r, this.history + 500); }
      this.onData(this.candles, { closed: false, added: true });
      this.onStatus('live');
      this._schedule();
    }
  }

  /** Fim de semana do câmbio: de sexta 21h a domingo 21h (UTC), aproximadamente. */
  function marketClosed(t) {
    const d = new Date(t), day = d.getUTCDay(), h = d.getUTCHours();
    return day === 6 || (day === 5 && h >= 21) || (day === 0 && h < 21);
  }

  const api = { ForexFeed, PAIRS, TD_INTERVAL, INTERVAL_MS, DAILY_LIMIT, isForex, parseUtc, toCandles, priceAt, usage, marketClosed, call };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Forex: api });
})(typeof self !== 'undefined' ? self : this);
