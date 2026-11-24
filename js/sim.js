/* Simulador de operações e alerta de sinal forte.
 *
 * - evaluateAlert: o alerta só dispara quando TODOS os critérios passam: modelo validado fora
 *   da amostra (limite inferior do acerto acima do ponto de empate, amostra suficiente, melhor
 *   que o acaso) e probabilidade atual acima do limiar. Não é certeza: é um filtro rígido.
 * - Portfolio: carteira fictícia de opções binárias (CALL/PUT, expiração fixa, payout). */
(function (root) {
  'use strict';

  const DEFAULT_CFG = { marginPct: 1, minN: 30 };

  const breakeven = payoutPct => 1 / (1 + payoutPct / 100);
  const round2 = x => Math.round(x * 100) / 100;

  /** Alerta baseado no modelo validado fora da amostra. `m` = { p: P(alta) atual, research: resultado de Model.evaluate }.
   *  Só dispara se TODOS os critérios passam. */
  function evaluateAlert(m, cfg, payoutPct) {
    cfg = Object.assign({}, DEFAULT_CFG, cfg);
    const be = breakeven(payoutPct), tStar = be + cfg.marginPct / 100;
    const r = m.research;
    if (!r || !r.star || m.p == null) return { fire: false, pending: true, side: null, checks: [], breakeven: be, tStar };
    const side = m.p >= 0.5 ? 'up' : 'down', pDir = side === 'up' ? m.p : 1 - m.p;
    const checks = [
      { key: 'sample', ok: r.star.n >= cfg.minN, value: r.star.n, need: cfg.minN },
      { key: 'edge', ok: r.star.hitLow != null && r.star.hitLow > be, value: r.star.hitLow, need: be },
      { key: 'skill', ok: r.brierSkill != null && r.brierSkill > 0, value: r.brierSkill, need: 0 },
      { key: 'prob', ok: pDir >= tStar, value: pDir, need: tStar }
    ];
    return { fire: checks.every(c => c.ok), pending: false, side, pDir, checks, breakeven: be, tStar };
  }

  /** Alerta no modo Binance. `m` = { p, research: resultado de Model.evaluateCosts, market }.
   *  Dispara só se: operações suficientes fora da amostra, líquido médio (limite inferior) > 0,
   *  excesso sobre a deriva (limite inferior) > 0 e probabilidade atual cobrindo a taxa. */
  function evaluateAlertCosts(m, cfg) {
    cfg = Object.assign({}, DEFAULT_CFG, cfg);
    const r = m.research;
    if (!r || m.p == null || !r.typicalNow) return { fire: false, pending: true, side: null, checks: [] };
    const need = 0.5 + r.costRoundTrip / (2 * r.typicalNow);
    const side = m.p >= 0.5 || m.market === 'spot' ? 'up' : 'down', pDir = side === 'up' ? m.p : 1 - m.p;
    const checks = [
      { key: 'sample', ok: r.n >= cfg.minN, value: r.n, need: cfg.minN },
      { key: 'net', ok: r.net.low != null && r.net.low > 0, value: r.net.low, need: 0 },
      { key: 'excess', ok: r.excess.low != null && r.excess.low > 0, value: r.excess.low, need: 0 },
      { key: 'cover', ok: pDir >= need, value: pDir, need }
    ];
    return { fire: checks.every(c => c.ok), pending: false, side, pDir, need, checks };
  }

  /** Converte as operações da estratégia (fora da amostra) em resultado financeiro. */
  function pnlTrades(trades, stake, payoutPct) {
    return trades.map(t => ({ ...t, result: t.hit ? 'win' : 'loss', pnl: t.hit ? round2(stake * payoutPct / 100) : -stake }));
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
        mode: o.feePct != null ? 'fee' : 'binary', feePct: o.feePct,
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
        let result, pnl;
        if (tr.mode === 'fee') { // Binance: ganha/perde o movimento e paga a taxa na entrada e na saída
          pnl = round2(tr.stake * (dir * (price / tr.entry - 1) - 2 * tr.feePct / 100));
          result = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'tie';
          this.balance = round2(this.balance + tr.stake + pnl);
        } else { // opção binária: payout fixo, empate devolve
          result = diff > 0 ? 'win' : diff < 0 ? 'loss' : 'tie';
          pnl = result === 'win' ? round2(tr.stake * tr.payoutPct / 100) : result === 'loss' ? -tr.stake : 0;
          this.balance = round2(this.balance + (result === 'win' ? tr.stake + pnl : result === 'tie' ? tr.stake : 0));
        }
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

  const api = { evaluateAlert, evaluateAlertCosts, pnlTrades, summarize, Portfolio, breakeven, candleAt, DEFAULT_CFG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Sim: api });
})(typeof self !== 'undefined' ? self : this);
