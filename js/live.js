/* Dados ao vivo da Binance (feed público de mercado, sem chave).
 * Histórico por REST + atualização por WebSocket, com reconexão automática.
 * A Quotex não tem API pública; este feed serve para pares de cripto de mercado real. */
(function (root) {
  'use strict';

  const REST = 'https://data-api.binance.vision/api/v3/klines';
  const WS = 'wss://data-stream.binance.vision/ws/';
  const INTERVAL_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000 };
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];

  // nt = número de negócios; tb = volume comprado a mercado (taker buy), medida de fluxo de ordens
  const fromRest = k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], nt: +k[8], tb: +k[9] });
  const fromWs = k => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, nt: +k.n, tb: +k.V });

  /** Aplica um candle recebido à lista. Retorna 'update' | 'new' | 'ignore'. */
  function mergeCandle(candles, c, max) {
    const last = candles[candles.length - 1];
    if (last && last.t === c.t) { candles[candles.length - 1] = c; return 'update'; }
    if (!last || c.t > last.t) {
      candles.push(c);
      if (max && candles.length > max) candles.shift();
      return 'new';
    }
    return 'ignore';
  }

  class LiveFeed {
    constructor(opts) {
      this.symbol = opts.symbol; this.interval = opts.interval;
      this.onData = opts.onData; this.onStatus = opts.onStatus;
      this.history = Math.min(20000, opts.history || 6000);
      this.max = opts.max || this.history + 500;
      this.candles = [];
      this.stopped = true; this.ws = null; this.retry = 0; this.timers = [];
      this.lastMsg = 0;
    }

    get intervalMs() { return INTERVAL_MS[this.interval]; }

    async start() {
      this.stopped = false;
      await this._connect(true);
    }

    stop() {
      this.stopped = true;
      this.timers.forEach(clearTimeout); this.timers = [];
      if (this.ws) { try { this.ws.close(); } catch (_) { /* ignora */ } this.ws = null; }
    }

    // Histórico paginado (a Binance entrega até 1000 candles por chamada), do mais novo para o mais antigo
    async _history() {
      const want = this.history;
      let out = [], endTime = null;
      while (out.length < want) {
        const lim = Math.min(1000, want - out.length);
        const url = `${REST}?symbol=${this.symbol}&interval=${this.interval}&limit=${lim}` + (endTime ? `&endTime=${endTime}` : '');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance respondeu HTTP ${res.status}`);
        const rows = await res.json();
        if (!Array.isArray(rows)) throw new Error('Resposta inesperada da Binance.');
        if (!rows.length) break;
        out = rows.map(fromRest).concat(out);
        endTime = rows[0][0] - 1;
        if (this.stopped) return out;
        this.onStatus('loading', `${out.length}/${want}`);
        if (rows.length < lim) break;
      }
      if (out.length < 2) throw new Error('Resposta inesperada da Binance.');
      return out;
    }

    async _connect(first) {
      if (this.stopped) return;
      this.onStatus(first ? 'connecting' : 'reconnecting');
      try {
        this.candles = await this._history();
      } catch (e) {
        if (this.stopped) return;
        this.onStatus('error', 'Não foi possível acessar a Binance a partir desta página (' + e.message + '). ' +
          'Abra a versão hospedada ou local do app, ou verifique sua conexão.');
        if (!first) this._scheduleRetry();
        return;
      }
      if (this.stopped) return;
      this.onData(this.candles, { closed: true, reset: first });
      this._openSocket();
    }

    _openSocket() {
      const ws = new WebSocket(`${WS}${this.symbol.toLowerCase()}@kline_${this.interval}`);
      this.ws = ws;
      ws.onopen = () => { this.retry = 0; this.lastMsg = Date.now(); this.onStatus('live'); this._watchdog(); };
      ws.onmessage = ev => {
        this.lastMsg = Date.now();
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (!msg.k) return;
        const res = mergeCandle(this.candles, fromWs(msg.k), this.max);
        if (res !== 'ignore') this.onData(this.candles, { closed: !!msg.k.x, added: res === 'new' });
      };
      ws.onerror = () => { /* onclose cuida da reconexão */ };
      ws.onclose = () => {
        if (this.stopped || this.ws !== ws) return;
        this._scheduleRetry();
      };
    }

    // Se o feed ficar mudo por 20 s, força reconexão
    _watchdog() {
      const t = setTimeout(() => {
        if (this.stopped || !this.ws) return;
        if (Date.now() - this.lastMsg > 20000) { try { this.ws.close(); } catch (_) { /* ignora */ } }
        else this._watchdog();
      }, 5000);
      this.timers.push(t);
    }

    _scheduleRetry() {
      this.onStatus('reconnecting');
      const delay = Math.min(15000, 1000 * Math.pow(2, this.retry++));
      this.timers.push(setTimeout(() => this._connect(false), delay));
    }
  }

  const api = { LiveFeed, mergeCandle, fromRest, fromWs, INTERVAL_MS, SYMBOLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Live: api });
})(typeof self !== 'undefined' ? self : this);
