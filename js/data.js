/* Entrada de dados: parser de CSV (formatos comuns no Brasil, MetaTrader, Profit, TradingView)
 * e gerador de candles sintéticos para demonstração. */
(function (root) {
  'use strict';

  const ALIASES = {
    date: ['date', 'data', '<date>'],
    time: ['time', 'hora', '<time>'],
    datetime: ['datetime', 'timestamp', 'time', 'data/hora', 'date time', 'abertura_tempo'],
    o: ['open', 'abertura', 'abert', 'o', '<open>'],
    h: ['high', 'maxima', 'máxima', 'max', 'máx', 'h', '<high>'],
    l: ['low', 'minima', 'mínima', 'min', 'mín', 'l', '<low>'],
    c: ['close', 'fechamento', 'fech', 'ultimo', 'último', 'c', '<close>'],
    v: ['volume', 'vol', 'volume financeiro', 'v', '<vol>', '<tickvol>', 'tick_volume']
  };

  function detectDelimiter(line) {
    const counts = { '\t': 0, ';': 0, ',': 0 };
    for (const ch of line) if (ch in counts) counts[ch]++;
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  function parseNumber(s, decimalComma) {
    if (s == null) return NaN;
    s = String(s).trim().replace(/^"|"$/g, '');
    if (decimalComma) s = s.replace(/\./g, '').replace(',', '.');
    return parseFloat(s);
  }

  // Aceita: epoch (s/ms), 2025-01-02 10:00[:00], 2025.01.02, 02/01/2025 10:00 (dd/mm/aaaa)
  function parseDateTime(dateStr, timeStr) {
    let ds = String(dateStr).trim().replace(/^"|"$/g, '');
    const ts = timeStr != null ? String(timeStr).trim().replace(/^"|"$/g, '') : '';
    if (/^\d{9,13}$/.test(ds) && !ts) {
      const v = Number(ds);
      return v < 1e11 ? v * 1000 : v;
    }
    let y, m, d, rest = '';
    let mt = ds.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(.*))?$/);
    if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; rest = mt[4] || ''; }
    else {
      mt = ds.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[T\s]+(.*))?$/);
      if (!mt) return NaN;
      d = +mt[1]; m = +mt[2]; y = +mt[3]; rest = mt[4] || '';
    }
    const tm = (ts || rest).replace(/Z$/, '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const hh = tm ? +tm[1] : 0, mm = tm ? +tm[2] : 0, ss = tm && tm[3] ? +tm[3] : 0;
    return new Date(y, m - 1, d, hh, mm, ss).getTime();
  }

  function parseCSV(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('O arquivo precisa ter ao menos 2 linhas.');
    const delim = detectDelimiter(lines[0]);
    const split = l => l.split(delim).map(x => x.trim());
    const first = split(lines[0]);
    const hasHeader = first.some(x => /[a-zA-Zá-ú]/.test(x.replace(/^"|"$/g, '')) && isNaN(parseNumber(x, false)) && !/^\d{1,4}[-./]\d/.test(x));

    let idx = {}, body = lines;
    if (hasHeader) {
      body = lines.slice(1);
      const names = first.map(x => x.toLowerCase().replace(/^"|"$/g, ''));
      for (const key in ALIASES) {
        const j = names.findIndex(nm => ALIASES[key].includes(nm));
        if (j >= 0) idx[key] = j;
      }
      // "time" pode ser a hora (MetaTrader) ou o datetime completo
      if (idx.date != null && idx.datetime === idx.time) delete idx.datetime;
      if (idx.date == null && idx.time != null) { idx.datetime = idx.time; delete idx.time; }
      if (idx.date != null && idx.time == null) { idx.datetime = idx.date; delete idx.date; }
    } else {
      const cols = first.length;
      if (cols >= 7) idx = { date: 0, time: 1, o: 2, h: 3, l: 4, c: 5, v: 6 };
      else idx = { datetime: 0, o: 1, h: 2, l: 3, c: 4, v: cols > 5 ? 5 : undefined };
    }
    for (const k of ['o', 'h', 'l', 'c']) {
      if (idx[k] == null) throw new Error(`Coluna "${k === 'o' ? 'open' : k === 'h' ? 'high' : k === 'l' ? 'low' : 'close'}" não encontrada.`);
    }
    if (idx.datetime == null && idx.date == null) throw new Error('Coluna de data/hora não encontrada.');

    const decimalComma = delim !== ',' && /\d,\d/.test(body.slice(0, 5).join(' '));
    const out = [];
    for (const line of body) {
      const p = split(line);
      const t = idx.datetime != null ? parseDateTime(p[idx.datetime]) : parseDateTime(p[idx.date], p[idx.time]);
      const o = parseNumber(p[idx.o], decimalComma), h = parseNumber(p[idx.h], decimalComma);
      const l = parseNumber(p[idx.l], decimalComma), c = parseNumber(p[idx.c], decimalComma);
      const v = idx.v != null ? parseNumber(p[idx.v], decimalComma) : 0;
      if ([t, o, h, l, c].some(Number.isNaN)) continue;
      out.push({ t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number.isNaN(v) ? 0 : v });
    }
    out.sort((a, b) => a.t - b.t);
    // remove timestamps duplicados mantendo o último
    const dedup = out.filter((x, i) => i === out.length - 1 || x.t !== out[i + 1].t);
    if (dedup.length < 2) throw new Error('Nenhum candle válido encontrado. Verifique o formato.');
    return dedup;
  }

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

  function gauss(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Candles sintéticos de pregão (10:00–17:55) com regimes de tendência, volatilidade em "U"
   *  e volume maior na abertura/fechamento. Apenas para demonstrar a ferramenta. */
  function generateDemo(opts) {
    opts = Object.assign({ days: 6, intervalMin: 5, start: 120000, seed: 42, volPct: 0.0009 }, opts);
    const rand = mulberry32(opts.seed);
    const perDay = Math.floor((8 * 60) / opts.intervalMin);
    const candles = [];
    let price = opts.start;
    // últimos "days" dias úteis terminando ontem
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const dates = [];
    while (dates.length < opts.days) {
      day.setDate(day.getDate() - 1);
      if (day.getDay() !== 0 && day.getDay() !== 6) dates.unshift(new Date(day));
    }
    let drift = 0;
    for (const d of dates) {
      for (let k = 0; k < perDay; k++) {
        if (k % 18 === 0) drift = gauss(rand) * opts.volPct * 0.35; // novo regime
        const x = k / (perDay - 1);
        const uShape = 1 + 0.9 * (Math.pow(2 * x - 1, 2));
        const sigma = opts.volPct * uShape;
        const o = price;
        const steps = 6;
        let p = o, hi = o, lo = o;
        for (let s = 0; s < steps; s++) {
          p *= Math.exp(drift / steps + (sigma / Math.sqrt(steps)) * gauss(rand));
          hi = Math.max(hi, p); lo = Math.min(lo, p);
        }
        const t = new Date(d); t.setHours(10, k * opts.intervalMin, 0, 0);
        const v = Math.round((800 + rand() * 600) * uShape * (1 + Math.abs(Math.log(p / o)) * 600));
        candles.push({ t: t.getTime(), o, h: hi, l: lo, c: p, v });
        price = p;
      }
    }
    return candles;
  }

  function toCSV(candles) {
    const f = n => { const d = new Date(n); const z = x => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
    return 'datetime,open,high,low,close,volume\n' +
      candles.map(c => `${f(c.t)},${c.o.toFixed(2)},${c.h.toFixed(2)},${c.l.toFixed(2)},${c.c.toFixed(2)},${c.v}`).join('\n');
  }

  const api = { parseCSV, parseDateTime, generateDemo, toCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { Data: api });
})(typeof self !== 'undefined' ? self : this);
