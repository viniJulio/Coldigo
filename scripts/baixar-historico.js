// Baixa histórico paginado da Binance (feed público) para a pasta passada como argumento.
// Uso: node scripts/baixar-historico.js pasta-de-destino   (a pasta precisa existir)
const fs = require('fs'), path = require('path');
const out = process.argv[2];
const BASE = 'https://data-api.binance.vision/api/v3/klines';
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'EURUSDT', 'PAXGUSDT'];
const INTS = ['1m', '5m'], WANT = 10000;
(async () => {
  for (const sym of SYMS) for (const iv of INTS) {
    let rows = [], end = null, fail = null;
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
