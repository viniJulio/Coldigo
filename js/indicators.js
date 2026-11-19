/* Indicadores técnicos. Todos são causais: o valor em i só usa candles <= i.
 * Candle: { t: ms, o, h, l, c, v } */
(function (root) {
  'use strict';

  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (x == null) continue;
      prev = prev == null ? x : x * k + prev * (1 - k);
      if (i >= n - 1) out[i] = prev;
    }
    return out;
  }

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  // RSI de Wilder
  function rsi(closes, n) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (n - 1) + Math.max(d, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  // ATR de Wilder
  function atr(candles, n) {
    const out = new Array(candles.length).fill(null);
    if (candles.length <= n) return out;
    const tr = candles.map((c, i) =>
      i === 0 ? c.h - c.l
        : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)));
    let a = 0;
    for (let i = 1; i <= n; i++) a += tr[i];
    a /= n;
    out[n] = a;
    for (let i = n + 1; i < candles.length; i++) {
      a = (a * (n - 1) + tr[i]) / n;
      out[i] = a;
    }
    return out;
  }

  function bollinger(closes, n, k) {
    const mid = sma(closes, n);
    const up = new Array(closes.length).fill(null);
    const lo = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd;
      lo[i] = mid[i] - k * sd;
    }
    return { mid, up, lo };
  }

  function sessionKey(t) {
    const d = new Date(t);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  // VWAP que reinicia a cada pregão. Sem volume, cai para preço típico simples.
  function vwap(candles) {
    const out = new Array(candles.length).fill(null);
    let key = null, pv = 0, vol = 0, cnt = 0, tp = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const k = sessionKey(c.t);
      if (k !== key) { key = k; pv = 0; vol = 0; cnt = 0; tp = 0; }
      const typical = (c.h + c.l + c.c) / 3;
      pv += typical * c.v; vol += c.v; tp += typical; cnt++;
      out[i] = vol > 0 ? pv / vol : tp / cnt;
    }
    return out;
  }

  // Resumo por pregão (para pivôs e máx/mín do dia anterior)
  function sessions(candles) {
    const list = [];
    let cur = null;
    candles.forEach((c, i) => {
      const k = sessionKey(c.t);
      if (!cur || cur.key !== k) {
        cur = { key: k, start: i, end: i, o: c.o, h: c.h, l: c.l, c: c.c };
        list.push(cur);
      }
      cur.end = i; cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c;
    });
    return list;
  }

  // Pivôs clássicos calculados a partir do pregão anterior
  function pivotPoints(candles) {
    const s = sessions(candles);
    if (s.length < 2) return null;
    const p = s[s.length - 2];
    const pp = (p.h + p.l + p.c) / 3;
    return {
      PP: pp,
      R1: 2 * pp - p.l, S1: 2 * pp - p.h,
      R2: pp + (p.h - p.l), S2: pp - (p.h - p.l),
      prevHigh: p.h, prevLow: p.l, prevClose: p.c
    };
  }

  // Suportes/resistências por fractais (swing highs/lows) agrupados por proximidade.
  function swingLevels(candles, side, tol) {
    side = side || 3;
    const raw = [];
    for (let i = side; i < candles.length - side; i++) {
      let isH = true, isL = true;
      for (let j = 1; j <= side; j++) {
        if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isH = false;
        if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isL = false;
      }
      if (isH) raw.push({ price: candles[i].h, i, type: 'R' });
      if (isL) raw.push({ price: candles[i].l, i, type: 'S' });
    }
    raw.sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const r of raw) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(r.price - last.price) <= tol) {
        last.touches++;
        last.price = (last.price * (last.touches - 1) + r.price) / last.touches;
        last.lastIdx = Math.max(last.lastIdx, r.i);
      } else {
        clusters.push({ price: r.price, touches: 1, lastIdx: r.i });
      }
    }
    return clusters;
  }

  function computeAll(candles) {
    const closes = candles.map(c => c.c);
    return {
      ema9: ema(closes, 9),
      ema21: ema(closes, 21),
      rsi: rsi(closes, 14),
      atr: atr(candles, 14),
      bb: bollinger(closes, 20, 2),
      vwap: vwap(candles)
    };
  }

  const api = { ema, sma, rsi, atr, bollinger, vwap, sessions, pivotPoints, swingLevels, computeAll, sessionKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Indicators: api });
})(typeof self !== 'undefined' ? self : this);
