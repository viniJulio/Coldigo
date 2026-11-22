// Baixa histórico paginado da Binance (feed público) para a pasta passada como argumento.
// Uso: node scripts/baixar-historico.js pasta-de-destino [ate] [tempos]   (a pasta precisa existir)
// `ate` opcional: baixa o histórico ANTERIOR a esse instante, por tempo. Ex.: 1m=2026-11-15T10:55:00Z,5m=2026-10-18T16:15:00Z
const fs = require('fs'), path = require('path');
const out = process.argv[2];
const UNTIL = {};
(process.argv[3] || '').split(',').filter(Boolean).forEach(x => { const [iv, t] = x.split('='); UNTIL[iv] = Date.parse(t) - 1; });
const BASE = 'https://data-api.binance.vision/api/v3/klines';
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'EURUSDT', 'PAXGUSDT'];
const INTS = (process.argv[4] || '1m,5m').split(','), WANT = 10000;
(async () => {
  for (const sym of SYMS) for (const iv of INTS) {
    let rows = [], end = UNTIL[iv] || null, fail = null;
    while (rows.length < WANT) {
      const url = `${BASE}?symbol=${sym}&interval=${iv}&limit=1000` + (end ? `&endTime=${end}` : '');
      let res; try { res = await fetch(url); } catch (e) { fail = 'rede: ' + e.message; break; }
      if (!res.ok) { fail = 'HTTP ' + res.status; break; }
      const page = await res.json(); if (!page.length) break;
      rows = page.concat(rows); end = page[0][0] - 1;
      if (page.length < 1000) break;
    }
    fs.writeFileSync(path.join(out, `${sym}_${iv}.json`), JSON.stringify(rows));
    console.log(sym.padEnd(9), iv.padEnd(3), String(rows.length).padStart(6), 'candles', rows.length ? new Date(rows[0][0]).toISOString().slice(0, 16) + ' → ' + new Date(rows.at(-1)[0]).toISOString().slice(0, 16) : '', fail ? '| FALHA ' + fail : '');
  }
})();
