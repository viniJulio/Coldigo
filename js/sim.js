/* Simulador de operações e alerta de sinal forte.
 *
 * - evaluateAlert: o alerta só dispara quando TODOS os critérios passam (força do score,
 *   probabilidade do modelo, amostra histórica suficiente e limite inferior do acerto
 *   acima do ponto de empate). Não é certeza: é um filtro estatístico rígido.
 * - Portfolio: carteira fictícia de opções binárias (CALL/PUT, expiração fixa, payout).
 * - simulateHistory: aplica a mesma regra ao histórico carregado, usando só informação
 *   disponível em cada momento (sem olhar o futuro). */
(function (root) {
  'use strict';

  const dep = (name, file) => (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require(file) : root.Coldigo[name];
  const F = dep('Forecast', './forecast.js');
  const I = dep('Indicators', './indicators.js');

  const DEFAULT_CFG = { minScore: 0.5, minModelP: 0.55, minEffN: 20, margin: 0 };

  const breakeven = payoutPct => 1 / (1 + payoutPct / 100);
  const round2 = x => Math.round(x * 100) / 100;

  function evaluateAlert(candles, a, cfg, payoutPct) {
    cfg = Object.assign({}, DEFAULT_CFG, cfg);
    const be = breakeven(payoutPct), H = a.options.horizon;
    const side = a.score > 0 ? 'up' : 'down';
    const modelP = side === 'up' ? a.forecast.probUp : 1 - a.forecast.probUp;
    const row = F.backtest(candles, a.ind, H, [cfg.minScore]).rows[0];
    const need = be + cfg.margin / 100;
    const checks = [
      { key: 'score', ok: Math.abs(a.score) >= cfg.minScore, value: Math.abs(a.score), need: cfg.minScore },
      { key: 'model', ok: modelP >= cfg.minModelP, value: modelP, need: cfg.minModelP },
      { key: 'sample', ok: row.effectiveN >= cfg.minEffN, value: row.effectiveN, need: cfg.minEffN },
      { key: 'edge', ok: row.hitLow != null && row.hitLow > need, value: row.hitLow, need }
    ];
    return { fire: checks.every(c => c.ok), side, checks, row, breakeven: be, score: a.score, horizon: H };
  }

  /** Aplica a regra de alerta ao histórico, de forma causal, com no máximo uma operação aberta. */
  function simulateHistory(candles, ind, horizon, cfg, payoutPct, stake) {
    cfg = Object.assign({}, DEFAULT_CFG, cfg);
    const be = breakeven(payoutPct), payout = payoutPct / 100, n = candles.length, H = horizon;
    const sc = candles.map((_, i) => F.scoreAt(candles, ind, i));
    const sameDay = (i, j) => I.sessionKey(candles[i].t) === I.sessionKey(candles[j].t);
    let hits = 0, cnt = 0, nextFree = 0;
    const trades = [];
    for (let i = 0; i < n; i++) {
      const j = i - H; // o resultado do sinal em j só é conhecido em i
      if (j >= 0 && sc[j] && Math.abs(sc[j].score) >= cfg.minScore && sameDay(j, i)) {
        cnt++;
        if (Math.sign(sc[j].score) * (candles[i].c - candles[j].c) > 0) hits++;
      }
      const s = sc[i];
      if (!s || Math.abs(s.score) < cfg.minScore || i + H >= n || i < nextFree || !sameDay(i, i + H)) continue;
      if (cnt / H < cfg.minEffN) continue;
      const low = F.wilsonLower(hits, cnt, H);
      if (!(low > be + cfg.margin / 100)) continue;
      const side = s.score > 0 ? 'up' : 'down', dir = s.score > 0 ? 1 : -1;
      const diff = (candles[i + H].c - candles[i].c) * dir;
      const result = diff > 0 ? 'win' : diff < 0 ? 'loss' : 'tie';
      trades.push({ t: candles[i].t, side, entry: candles[i].c, exit: candles[i + H].c, result,
        pnl: result === 'win' ? round2(stake * payout) : result === 'loss' ? -stake : 0 });
      nextFree = i + H;
    }
    return { trades, stats: summarize(trades) };
  }

  function summarize(trades) {
    const wins = trades.filter(t => t.result === 'win').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    let eq = 0, peak = 0, maxDD = 0;
    for (const t of trades) { eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
    return {
      trades: trades.length, wins, losses, ties: trades.length - wins - losses,
      winRate: wins + losses ? wins / (wins + losses) : null,
      pnl: round2(eq), maxDrawdown: round2(maxDD)
    };
  }

  // Candle que contém o instante t (último com candle.t <= t)
  function candleAt(candles, t) {
    let lo = 0, hi = candles.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  class Portfolio {
    constructor(data) {
      data = data || {};
      this.start = data.start != null ? data.start : 1000;
      this.balance = data.balance != null ? data.balance : this.start;
      this.open = data.open || [];
      this.closed = data.closed || [];
      this.seq = data.seq || 0;
    }

    openTrade(o) {
      if (!(o.stake > 0)) throw new Error('Informe um valor de operação maior que zero.');
      if (o.stake > this.balance + 1e-9) throw new Error('Saldo fictício insuficiente.');
      this.balance = round2(this.balance - o.stake);
      const trade = {
        id: ++this.seq, side: o.side, entry: o.price, t: o.t, stake: o.stake, payoutPct: o.payoutPct,
        horizon: o.horizon, intervalMs: o.intervalMs, expiry: o.t + o.horizon * o.intervalMs,
        symbol: o.symbol || '', source: o.source || 'manual'
      };
      this.open.push(trade);
      return trade;
    }

    /** Liquida as operações vencidas. Retorna as que foram encerradas agora. */
    settle(candles, now) {
      const done = [], keep = [];
      for (const tr of this.open) {
        if (now < tr.expiry || !candles.length) { keep.push(tr); continue; }
        const last = candles[candles.length - 1];
        const late = now - tr.expiry > 20000;
        let price = last.c, approx = false;
        if (late) { // aba parada ou reconexão: usa o candle que continha o vencimento
          const k = candleAt(candles, tr.expiry);
          if (k >= 0) price = candles[k].c;
          approx = true;
        }
        const dir = tr.side === 'up' ? 1 : -1, diff = (price - tr.entry) * dir;
        const result = diff > 0 ? 'win' : diff < 0 ? 'loss' : 'tie';
        const pnl = result === 'win' ? round2(tr.stake * tr.payoutPct / 100) : result === 'loss' ? -tr.stake : 0;
        this.balance = round2(this.balance + (result === 'win' ? tr.stake + pnl : result === 'tie' ? tr.stake : 0));
        const closed = Object.assign({}, tr, { exit: price, result, pnl, approx });
        this.closed.push(closed); done.push(closed);
      }
      this.open = keep;
      if (this.closed.length > 300) this.closed = this.closed.slice(-300);
      return done;
    }

    stats() { return summarize(this.closed); }
    reset(balance) { Object.assign(this, new Portfolio({ start: balance != null ? balance : this.start })); }
    toJSON() { return { start: this.start, balance: this.balance, open: this.open, closed: this.closed, seq: this.seq }; }
  }

  const api = { evaluateAlert, simulateHistory, summarize, Portfolio, breakeven, candleAt, DEFAULT_CFG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Sim: api });
})(typeof self !== 'undefined' ? self : this);
