/* Estimativa de movimentação intradiária.
 *
 * 1. Score de viés (-1..+1) combinando tendência, VWAP, momentum, RSI e Bollinger.
 * 2. Monte Carlo (bootstrap de candles recentes) para projetar bandas de preço,
 *    máxima/mínima esperadas e probabilidade de atingir alvo antes do stop.
 * 3. Backtest walk-forward para medir quanto o score realmente acertou nos dados.
 *
 * É uma estimativa estatística, não uma previsão: o histórico não garante o futuro. */
(function (root) {
  'use strict';

  const I = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./indicators.js') : root.Coldigo.Indicators;

  const WEIGHTS = { trend: 0.30, vwap: 0.25, momentum: 0.25, rsi: 0.10, bollinger: 0.10 };
  const BIAS_THRESHOLD = 0.25;

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Componentes do score no candle i (cada um em -1..+1). null se faltar histórico.
  function scoreAt(candles, ind, i) {
    const a = ind.atr[i], e9 = ind.ema9[i], e21 = ind.ema21[i];
    const r = ind.rsi[i], vw = ind.vwap[i], up = ind.bb.up[i], lo = ind.bb.lo[i];
    if (i < 6 || a == null || a <= 0 || e9 == null || e21 == null || r == null || up == null) return null;
    const c = candles[i].c;

    const trend = Math.tanh((e9 - e21) / a);
    const vwapPart = Math.tanh((c - vw) / a);
    const momentum = Math.tanh((c - candles[i - 5].c) / (2 * a));
    // Reversão nos extremos: contrária ao movimento quando esticado
    const rsiPart = r > 70 ? -(r - 70) / 30 : r < 30 ? (30 - r) / 30 : 0;
    const pctB = (c - lo) / (up - lo || 1);
    const bbPart = pctB > 1 ? -clamp((pctB - 1) * 2, 0, 1) : pctB < 0 ? clamp(-pctB * 2, 0, 1) : 0;

    const parts = { trend, vwap: vwapPart, momentum, rsi: rsiPart, bollinger: bbPart };
    let score = 0;
    for (const k in WEIGHTS) score += WEIGHTS[k] * parts[k];
    return { score: clamp(score, -1, 1), parts };
  }

  function biasLabel(score) {
    return score > BIAS_THRESHOLD ? 'up' : score < -BIAS_THRESHOLD ? 'down' : 'neutral';
  }

  function stepMs(candles) {
    const d = [];
    for (let i = 1; i < candles.length; i++) {
      if (I.sessionKey(candles[i].t) === I.sessionKey(candles[i - 1].t)) d.push(candles[i].t - candles[i - 1].t);
    }
    d.sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : 60000;
  }

  function monteCarlo(candles, score, opts) {
    const n = candles.length;
    const win = Math.min(opts.window, n - 1);
    const samples = [];
    for (let i = n - win; i < n; i++) {
      const p = candles[i - 1].c;
      samples.push({
        r: Math.log(candles[i].c / p),
        hr: Math.log(candles[i].h / p),
        lr: Math.log(candles[i].l / p)
      });
    }
    const mean = samples.reduce((s, x) => s + x.r, 0) / samples.length;
    const sigma = Math.sqrt(samples.reduce((s, x) => s + (x.r - mean) ** 2, 0) / samples.length);
    const drift = score * opts.driftFactor * sigma;
    const shift = drift - mean;

    const rand = mulberry32(opts.seed != null ? opts.seed : (candles[n - 1].t | 0));
    const H = opts.horizon, N = opts.simulations;
    const entry = candles[n - 1].c;
    const atrNow = opts.atr;
    const steps = Array.from({ length: H }, () => new Float64Array(N));
    const pathMax = new Float64Array(N), pathMin = new Float64Array(N);

    const tpD = opts.tpAtr * atrNow, slD = opts.slAtr * atrNow;
    const res = { long: { tp: 0, sl: 0 }, short: { tp: 0, sl: 0 } };

    for (let s = 0; s < N; s++) {
      let price = entry, mx = entry, mn = entry;
      let longDone = false, shortDone = false;
      for (let k = 0; k < H; k++) {
        const x = samples[Math.floor(rand() * samples.length)];
        const hi = price * Math.exp(x.hr + shift);
        const lo = price * Math.exp(x.lr + shift);
        price = price * Math.exp(x.r + shift);
        const bh = Math.max(hi, price), bl = Math.min(lo, price);
        if (bh > mx) mx = bh;
        if (bl < mn) mn = bl;
        steps[k][s] = price;
        // Se alvo e stop caem no mesmo candle, assume-se o stop (conservador)
        if (!longDone) {
          if (bl <= entry - slD) { res.long.sl++; longDone = true; }
          else if (bh >= entry + tpD) { res.long.tp++; longDone = true; }
        }
        if (!shortDone) {
          if (bh >= entry + slD) { res.short.sl++; shortDone = true; }
          else if (bl <= entry - tpD) { res.short.tp++; shortDone = true; }
        }
      }
      pathMax[s] = mx; pathMin[s] = mn;
    }

    const bands = steps.map(arr => {
      const sorted = Array.from(arr).sort((a, b) => a - b);
      return {
        p10: quantile(sorted, 0.10), p25: quantile(sorted, 0.25), p50: quantile(sorted, 0.50),
        p75: quantile(sorted, 0.75), p90: quantile(sorted, 0.90)
      };
    });
    const last = Array.from(steps[H - 1]);
    const probUp = last.filter(p => p > entry).length / N;
    const sMax = Array.from(pathMax).sort((a, b) => a - b);
    const sMin = Array.from(pathMin).sort((a, b) => a - b);

    const side = (r) => ({ tp: r.tp / N, sl: r.sl / N, none: (N - r.tp - r.sl) / N });
    return {
      entry, horizon: H, simulations: N, sigma, drift, bands, probUp,
      expectedHigh: { p50: quantile(sMax, 0.5), p90: quantile(sMax, 0.9) },
      expectedLow: { p50: quantile(sMin, 0.5), p10: quantile(sMin, 0.1) },
      tpDistance: tpD, slDistance: slD,
      long: side(res.long), short: side(res.short)
    };
  }

  // Backtest walk-forward: o score no candle i é comparado ao retorno em i+H,
  // sem atravessar pregões (day trade não carrega posição).
  function backtest(candles, ind, horizon, thresholds) {
    thresholds = thresholds || [0.25, 0.4, 0.6];
    const rows = thresholds.map(t => ({ threshold: t, n: 0, hits: 0, sumRet: 0 }));
    let baseN = 0, baseUp = 0;
    for (let i = 0; i + horizon < candles.length; i++) {
      if (I.sessionKey(candles[i].t) !== I.sessionKey(candles[i + horizon].t)) continue;
      const sc = scoreAt(candles, ind, i);
      if (!sc) continue;
      const ret = (candles[i + horizon].c - candles[i].c) / candles[i].c;
      baseN++; if (ret > 0) baseUp++;
      const dir = Math.sign(sc.score);
      if (!dir) continue;
      for (const row of rows) {
        if (Math.abs(sc.score) >= row.threshold) {
          row.n++; row.sumRet += ret * dir; if (ret * dir > 0) row.hits++;
        }
      }
    }
    return {
      baseSamples: baseN,
      baseUpRate: baseN ? baseUp / baseN : null,
      rows: rows.map(r => ({
        threshold: r.threshold, signals: r.n,
        hitRate: r.n ? r.hits / r.n : null,
        avgReturnPct: r.n ? (r.sumRet / r.n) * 100 : null
      }))
    };
  }

  const DEFAULTS = { horizon: 12, simulations: 2000, window: 300, driftFactor: 0.1, tpAtr: 1.5, slAtr: 1, seed: null };

  function analyze(candles, options) {
    const opts = Object.assign({}, DEFAULTS, options);
    if (candles.length < 40) throw new Error('São necessários pelo menos 40 candles para a análise.');
    const ind = I.computeAll(candles);
    const n = candles.length - 1;
    const sc = scoreAt(candles, ind, n);
    if (!sc) throw new Error('Histórico insuficiente para calcular os indicadores.');
    const atrNow = ind.atr[n];
    const mc = monteCarlo(candles, sc.score, Object.assign({}, opts, { atr: atrNow }));
    const sorted = I.swingLevels(candles, 3, atrNow * 0.5);
    const last = candles[n].c;
    const supports = sorted.filter(l => l.price < last).sort((a, b) => b.price - a.price).slice(0, 3);
    const resistances = sorted.filter(l => l.price > last).sort((a, b) => a.price - b.price).slice(0, 3);
    return {
      options: opts, ind, last, atr: atrNow,
      score: sc.score, parts: sc.parts, weights: WEIGHTS, bias: biasLabel(sc.score),
      stepMs: stepMs(candles),
      forecast: mc,
      pivots: I.pivotPoints(candles),
      supports, resistances,
      backtest: backtest(candles, ind, opts.horizon)
    };
  }

  const api = { analyze, scoreAt, monteCarlo, backtest, biasLabel, mulberry32, quantile, stepMs, WEIGHTS, BIAS_THRESHOLD, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Forecast: api });
})(typeof self !== 'undefined' ? self : this);
