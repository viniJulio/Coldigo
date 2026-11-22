/* Modelo estatístico com validação fora da amostra (walk-forward).
 *
 * - Features causais (só usam candles <= i): retornos normalizados, distância às médias, RSI,
 *   Bollinger, VWAP, volume, fluxo de ordens (taker buy), regime de volatilidade e hora do dia.
 * - Regressão logística com regularização L2, treinada por Newton (IRLS).
 * - Walk-forward: treina numa janela, prevê o bloco seguinte, avança. Os rótulos dos últimos H
 *   candles do treino são descartados (purga) para o futuro não vazar para o treino.
 * - Avaliação: acerto, AUC, escore de Brier, calibração e uma estratégia com limiar fixado
 *   ANTES de olhar os resultados. Operações não se sobrepõem, então a amostra é honesta.
 * - Correção para múltiplos testes: quanto mais pares/tempos/horizontes você testa, mais
 *   rígido fica o limite de confiança. */
(function (root) {
  'use strict';

  const I = (typeof require !== 'undefined' && typeof module !== 'undefined')
    ? require('./indicators.js') : root.Coldigo.Indicators;

  const FEATURES = ['ret1', 'ret3', 'ret5', 'ret10', 'ret20', 'emaDist', 'emaSpread', 'rsi', 'pctB',
    'vwapDist', 'volZ', 'taker', 'taker5', 'volRegime', 'todSin', 'todCos'];
  const WARM = 220;
  // Padrão escolhido por calibração em dados de desenvolvimento (scripts/ajustar.js): 8 variáveis e
  // regularização forte. O padrão anterior (16 variáveis, λ=10) tinha ganho negativo sobre o acaso em
  // 14 de 14 séries (probabilidades superconfiantes).
  const CORE_FEATURES = ['ret3', 'ret10', 'ret20', 'emaSpread', 'volZ', 'taker', 'taker5', 'volRegime'];
  const DEFAULTS = { trainN: 2500, block: 250, lambda: 1000, features: CORE_FEATURES };
  const pickCols = names => (names ? names.map(n => { const j = FEATURES.indexOf(n); if (j < 0) throw new Error('variável desconhecida: ' + n); return j; }) : null);
  const sel = (row, cols) => { if (!cols) return row; const r = new Float64Array(cols.length); for (let k = 0; k < cols.length; k++) r[k] = row[cols[k]]; return r; };

  const clip = (x, a) => (x > a ? a : x < -a ? -a : x);
  const sigmoid = x => 1 / (1 + Math.exp(-clip(x, 30)));

  /** Quantil da normal padrão (algoritmo de Acklam, erro ~1e-9). */
  function normQuantile(p) {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425;
    if (p < pl) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - pl) {
      const q = p - 0.5, r = q * q;
      return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  /** Limite inferior do intervalo de Wilson para uma proporção. z = 1,96 dá 95% bilateral. */
  function wilsonLower(hits, n, z) {
    if (!n) return null;
    z = z || 1.96;
    const p = hits / n, z2 = z * z;
    return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  }

  /** z do limite inferior unilateral de 97,5%, corrigido (Bonferroni) para k configurações testadas. */
  function zForTests(k) { return normQuantile(1 - 0.025 / Math.max(1, k)); }

  /** Qualidade do preço: parcela de candles que fecham exatamente onde abriram. Em dados cotados em
   *  passos grandes (EUR/USDT anda de 0,0001 em 0,0001) o "quique" entre dois preços vizinhos gera
   *  padrões de reversão que parecem vantagem e são artefato do feed (medido: 28% a 50% no EUR/USDT;
   *  no máximo ~12% nos demais ativos testados). */
  const QUANTIZED_LIMIT = 0.20;
  function quantization(candles) {
    const share = candles.length ? candles.filter(k => k.c === k.o).length / candles.length : 0;
    return { flatShare: share, quantized: share >= QUANTIZED_LIMIT };
  }

  // ---------- Features ----------
  function buildFeatures(candles, ind) {
    const n = candles.length, d = FEATURES.length;
    const X = new Array(n).fill(null);
    const c = candles.map(k => k.c);
    const r1 = new Float64Array(n);
    for (let i = 1; i < n; i++) r1[i] = Math.log(c[i] / c[i - 1]);
    // somas acumuladas para janelas móveis em O(n)
    const S1 = new Float64Array(n + 1), S2 = new Float64Array(n + 1), SV = new Float64Array(n + 1),
      STB = new Float64Array(n + 1), SAP = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      S1[i + 1] = S1[i] + r1[i]; S2[i + 1] = S2[i] + r1[i] * r1[i];
      SV[i + 1] = SV[i] + candles[i].v;
      STB[i + 1] = STB[i] + (candles[i].tb != null && !Number.isNaN(candles[i].tb) ? candles[i].tb : 0);
      SAP[i + 1] = SAP[i] + (ind.atr[i] != null ? ind.atr[i] / c[i] : 0);
    }
    const hasTB = candles.some(k => k.tb != null && !Number.isNaN(k.tb));
    for (let i = WARM; i < n; i++) {
      const a = ind.atr[i], e9 = ind.ema9[i], e21 = ind.ema21[i], rs = ind.rsi[i], up = ind.bb.up[i], lo = ind.bb.lo[i], vw = ind.vwap[i];
      if (a == null || a <= 0 || e9 == null || e21 == null || rs == null || up == null || vw == null) continue;
      const W = 100;
      const m1 = (S1[i + 1] - S1[i + 1 - W]) / W;
      const sd = Math.sqrt(Math.max(1e-18, (S2[i + 1] - S2[i + 1 - W]) / W - m1 * m1));
      const lag = k => clip(Math.log(c[i] / c[i - k]) / (sd * Math.sqrt(k)), 4);
      const volMean = (SV[i] - SV[i - 50]) / 50;
      const volZ = clip(Math.log((candles[i].v + 1) / (volMean + 1)), 3);
      let taker = 0, taker5 = 0;
      if (hasTB) {
        const v = candles[i].v;
        taker = v > 0 ? clip((candles[i].tb || 0) / v - 0.5, 0.5) : 0;
        const v5 = SV[i + 1] - SV[i - 4];
        taker5 = v5 > 0 ? clip((STB[i + 1] - STB[i - 4]) / v5 - 0.5, 0.5) : 0;
      }
      const apNow = a / c[i], apMean = (SAP[i + 1] - SAP[i - 199]) / 200;
      const volRegime = apMean > 0 ? clip(Math.log(apNow / apMean), 2) : 0;
      const ang = 2 * Math.PI * ((candles[i].t % 86400000) / 86400000);
      const row = new Float64Array(d);
      row[0] = lag(1); row[1] = lag(3); row[2] = lag(5); row[3] = lag(10); row[4] = lag(20);
      row[5] = clip((c[i] - e21) / a, 5);
      row[6] = clip((e9 - e21) / a, 5);
      row[7] = (rs - 50) / 50;
      row[8] = clip((c[i] - lo) / ((up - lo) || 1) - 0.5, 1.5);
      row[9] = clip((c[i] - vw) / a, 6);
      row[10] = volZ; row[11] = taker; row[12] = taker5; row[13] = volRegime;
      row[14] = Math.sin(ang); row[15] = Math.cos(ang);
      X[i] = row;
    }
    return { X, hasTakerFlow: hasTB };
  }

  /** Rótulo no candle i: 1 se o fechamento em i+H é maior, 0 se menor, null se empate ou sem futuro. */
  function labels(candles, H) {
    const n = candles.length, y = new Array(n).fill(null);
    for (let i = 0; i + H < n; i++) y[i] = candles[i + H].c > candles[i].c ? 1 : candles[i + H].c < candles[i].c ? 0 : null;
    return y;
  }

  // ---------- Regressão logística (L2) por Newton ----------
  function solve(A, b, m) {
    const M = Float64Array.from(A), v = Float64Array.from(b);
    for (let col = 0; col < m; col++) {
      let piv = col;
      for (let r = col + 1; r < m; r++) if (Math.abs(M[r * m + col]) > Math.abs(M[piv * m + col])) piv = r;
      if (Math.abs(M[piv * m + col]) < 1e-14) continue;
      if (piv !== col) {
        for (let k = 0; k < m; k++) { const t = M[col * m + k]; M[col * m + k] = M[piv * m + k]; M[piv * m + k] = t; }
        const t = v[col]; v[col] = v[piv]; v[piv] = t;
      }
      for (let r = col + 1; r < m; r++) {
        const f = M[r * m + col] / M[col * m + col];
        if (!f) continue;
        for (let k = col; k < m; k++) M[r * m + k] -= f * M[col * m + k];
        v[r] -= f * v[col];
      }
    }
    const x = new Float64Array(m);
    for (let r = m - 1; r >= 0; r--) {
      let s = v[r];
      for (let k = r + 1; k < m; k++) s -= M[r * m + k] * x[k];
      x[r] = Math.abs(M[r * m + r]) < 1e-14 ? 0 : s / M[r * m + r];
    }
    return x;
  }

  function fitLogistic(rows, y, lambda, maxIter) {
    lambda = lambda == null ? DEFAULTS.lambda : lambda; maxIter = maxIter || 30;
    const n = rows.length, d = rows[0].length, m = d + 1;
    const mu = new Float64Array(d), sd = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let s = 0; for (let i = 0; i < n; i++) s += rows[i][j];
      mu[j] = s / n;
      let q = 0; for (let i = 0; i < n; i++) q += (rows[i][j] - mu[j]) ** 2;
      sd[j] = Math.sqrt(q / n) || 1;
    }
    const Z = new Float64Array(n * m);
    for (let i = 0; i < n; i++) {
      Z[i * m] = 1;
      for (let j = 0; j < d; j++) Z[i * m + 1 + j] = (rows[i][j] - mu[j]) / sd[j];
    }
    const w = new Float64Array(m);
    for (let it = 0; it < maxIter; it++) {
      const g = new Float64Array(m), H = new Float64Array(m * m);
      for (let i = 0; i < n; i++) {
        const o = i * m;
        let eta = 0; for (let a = 0; a < m; a++) eta += w[a] * Z[o + a];
        const p = sigmoid(eta), wt = Math.max(p * (1 - p), 1e-6), err = p - y[i];
        for (let a = 0; a < m; a++) {
          const za = Z[o + a];
          g[a] += err * za;
          const wza = wt * za;
          for (let b = a; b < m; b++) H[a * m + b] += wza * Z[o + b];
        }
      }
      for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) H[a * m + b] = H[b * m + a];
      for (let a = 1; a < m; a++) { H[a * m + a] += lambda; g[a] += lambda * w[a]; }
      H[0] += 1e-8;
      const step = solve(H, g, m);
      let mx = 0;
      for (let a = 0; a < m; a++) { w[a] -= step[a]; mx = Math.max(mx, Math.abs(step[a])); }
      if (mx < 1e-7) break;
    }
    return { mu, sd, w, n };
  }

  function predictProb(model, row) {
    row = sel(row, model.cols);
    let eta = model.w[0];
    for (let j = 0; j < row.length; j++) eta += model.w[j + 1] * (row[j] - model.mu[j]) / model.sd[j];
    return sigmoid(eta);
  }

  /** Treina com as últimas `trainN` amostras rotuladas até `upTo` (inclusive), considerando só o que
   *  já era conhecido: o rótulo de j depende de j+H, que precisa ser <= upTo. */
  function fitLatest(candles, X, y, H, opts, upTo) {
    opts = Object.assign({}, DEFAULTS, opts);
    const cols = pickCols(opts.features), rows = [], ys = [];
    for (let j = upTo - H; j >= WARM && rows.length < opts.trainN; j--) {
      if (X[j] && y[j] != null) { rows.push(sel(X[j], cols)); ys.push(y[j]); }
    }
    if (rows.length < 500) return null;
    const model = fitLogistic(rows, ys, opts.lambda);
    model.cols = cols;
    return model;
  }

  /** Walk-forward: previsões fora da amostra para todos os candles após a primeira janela de treino. */
  function walkForward(candles, ind, H, opts) {
    opts = Object.assign({}, DEFAULTS, opts);
    const n = candles.length;
    const needed = WARM + H + opts.trainN + opts.block;
    if (n < needed) return { preds: [], fits: 0, needed, insufficient: true };
    const { X, hasTakerFlow } = buildFeatures(candles, ind);
    const y = labels(candles, H);
    const cols = pickCols(opts.features);
    const preds = [];
    let fits = 0;
    for (let s = WARM + H + opts.trainN; s < n; s += opts.block) {
      const rows = [], ys = [];
      for (let j = s - H - 1; j >= WARM && rows.length < opts.trainN; j--) { // purga: j + H < s
        if (X[j] && y[j] != null) { rows.push(sel(X[j], cols)); ys.push(y[j]); }
      }
      if (rows.length < 500) continue;
      const model = fitLogistic(rows, ys, opts.lambda); model.cols = cols; fits++;
      for (let i = s; i < Math.min(s + opts.block, n); i++) {
        if (X[i] && y[i] != null) preds.push({ i, p: predictProb(model, X[i]), y: y[i] });
      }
    }
    return { preds, fits, needed, insufficient: false, hasTakerFlow, firstOos: preds.length ? preds[0].i : null };
  }

  // ---------- Avaliação ----------
  function auc(preds) {
    const s = preds.slice().sort((a, b) => a.p - b.p);
    let rankSum = 0, pos = 0, i = 0;
    while (i < s.length) {
      let j = i; while (j + 1 < s.length && s[j + 1].p === s[i].p) j++;
      const rank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) if (s[k].y === 1) { rankSum += rank; pos++; }
      i = j + 1;
    }
    const neg = s.length - pos;
    return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : null;
  }

  /** Estratégia: opera quando p >= t (alta) ou p <= 1-t (baixa), sem sobrepor operações. */
  function strategy(preds, H, t, payoutPct, z) {
    const payout = payoutPct / 100;
    let nextFree = -Infinity, hits = 0, n = 0, signalsAll = 0;
    const trades = [];
    for (const q of preds) {
      const dir = q.p >= t ? 1 : q.p <= 1 - t ? 0 : null;
      if (dir == null) continue;
      signalsAll++;
      if (q.i < nextFree) continue;
      const hit = q.y === dir;
      n++; if (hit) hits++;
      trades.push({ i: q.i, side: dir === 1 ? 'up' : 'down', hit });
      nextFree = q.i + H;
    }
    const hitRate = n ? hits / n : null;
    const hitLow = wilsonLower(hits, n, z);
    return {
      threshold: t, signalsAll, n, hits, hitRate, hitLow, trades,
      evPerUnit: n ? (hits * payout - (n - hits)) / n : null,
      evLowPerUnit: hitLow == null ? null : hitLow * payout - (1 - hitLow)
    };
  }

  /** Avalia as previsões fora da amostra. `tStar` é o limiar do gate, definido antes dos resultados. */
  function evaluate(preds, H, payoutPct, opts) {
    opts = Object.assign({ marginPct: 1, minN: 30, z: 1.96 }, opts);
    const be = 1 / (1 + payoutPct / 100), tStar = be + opts.marginPct / 100;
    const n = preds.length;
    if (!n) return { n: 0, breakeven: be, tStar, validated: false, reason: 'sem previsões' };
    const base = preds.reduce((s, q) => s + q.y, 0) / n;
    let brier = 0, ll = 0, correct = 0;
    for (const q of preds) {
      brier += (q.p - q.y) ** 2;
      const pc = Math.min(1 - 1e-6, Math.max(1e-6, q.p));
      ll -= q.y ? Math.log(pc) : Math.log(1 - pc);
      if ((q.p >= 0.5) === (q.y === 1)) correct++;
    }
    brier /= n; ll /= n;
    const brierBase = base * (1 - base);
    const llBase = base > 0 && base < 1 ? -(base * Math.log(base) + (1 - base) * Math.log(1 - base)) : null;
    const sorted = preds.slice().sort((a, b) => a.p - b.p);
    const calibration = [];
    const groups = 5;
    for (let g = 0; g < groups; g++) {
      const part = sorted.slice(Math.floor(g * n / groups), Math.floor((g + 1) * n / groups));
      if (!part.length) continue;
      calibration.push({ n: part.length, meanP: part.reduce((s, q) => s + q.p, 0) / part.length, freq: part.reduce((s, q) => s + q.y, 0) / part.length });
    }
    const thresholds = Array.from(new Set([tStar, be + 0.02, 0.55, 0.60, 0.65].map(x => Math.round(x * 10000) / 10000))).sort((a, b) => a - b);
    const strategies = thresholds.map(t => strategy(preds, H, t, payoutPct, opts.z));
    const star = strategy(preds, H, tStar, payoutPct, opts.z);
    const skill = brierBase > 0 ? 1 - brier / brierBase : null;
    const validated = star.n >= opts.minN && star.hitLow != null && star.hitLow > be && skill != null && skill > 0;
    return {
      n, base, accuracy: correct / n, auc: auc(preds), brier, brierBase, brierSkill: skill,
      logLoss: ll, logLossBase: llBase, calibration, strategies, star, breakeven: be, tStar, z: opts.z,
      minN: opts.minN, validated
    };
  }

  const api = {
    FEATURES, CORE_FEATURES, WARM, DEFAULTS, buildFeatures, labels, fitLogistic, predictProb, fitLatest, walkForward,
    evaluate, strategy, auc, normQuantile, wilsonLower, zForTests, solve, quantization, QUANTIZED_LIMIT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Model: api });
})(typeof self !== 'undefined' ? self : this);
