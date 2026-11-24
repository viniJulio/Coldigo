// Avaliação com as taxas da Binance (à vista: só compra; futuros: compra e venda), em dados reais.
// Uso: node scripts/avaliar-custos.js pasta-com-os-dados [plano] [taxaVista%] [taxaFuturos%]
// plano: tempo:expiração separados por vírgula (padrão 15m:4,1h:4,4h:3,4h:6).
// O protocolo (ativos, horizontes, taxas) é fixado AQUI, antes de ver resultados; cada ativo x
// horizonte x mercado é um teste e o limite de confiança é corrigido para o total.
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js') + path.sep;
const I = require(R + 'indicators.js'), L = require(R + 'live.js'), M = require(R + 'model.js');
const dir = process.argv[2];
const PLAN = (process.argv[3] || '15m:4,1h:4,4h:3,4h:6').split(',').map(x => { const [iv, h] = x.split(':'); return [iv, +h]; });
const MARKETS = [['spot', +(process.argv[4] || 0.1)], ['futures', +(process.argv[5] || 0.05)]];
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'EURUSDT', 'PAXGUSDT'];
const K = SYMS.length * PLAN.length * MARKETS.length, zK = M.zForTests(K);
const pc = (x, d = 3) => (x == null ? '–' : (100 * x).toFixed(d) + '%');
console.log(`Plano: ${PLAN.map(([iv, h]) => iv + ' x' + h).join(', ')} | mercados: ${MARKETS.map(([m, f]) => `${m} ${f}%/lado`).join(', ')}`);
console.log(`Testes: ${K} | z corrigido ${zK.toFixed(2)} | entrada só quando p cobre a taxa | sem slippage\n`);
console.log('ativo     tempo  H mercado | ops  | acerto | líquido médio/op (lim.inf) | excesso s/ deriva (lim.inf) | soma líquida | maior queda | comprar sempre/op | validado (sem correção)');
const rows = [];
for (const sym of SYMS) for (const [iv, H] of PLAN) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, `${sym}_${iv}.json`), 'utf8')).map(L.fromRest);
  const q = M.quantization(c);
  const wf = M.walkForward(c, I.computeAll(c), H, { keepTies: true });
  for (const [market, feePct] of MARKETS) {
    const ev = M.evaluateCosts(wf.preds, c, H, { market, feePct, z: zK });
    const ev1 = M.evaluateCosts(wf.preds, c, H, { market, feePct, z: 1.96 });
    const val = ev.validated && !q.quantized, val1 = ev1.validated && !q.quantized;
    rows.push({ sym, iv, H, market, ev, val, val1 });
    console.log(`${sym.padEnd(9)} ${iv.padEnd(4)} ${String(H).padStart(2)} ${market.padEnd(7)} | ${String(ev.n).padStart(4)} | ${pc(ev.hitRate, 1).padStart(6)} | ${pc(ev.net.mean).padStart(8)} (${pc(ev.net.low).padStart(8)})     | ${pc(ev.excess.mean).padStart(8)} (${pc(ev.excess.low).padStart(8)})      | ${pc(ev.sumNet, 1).padStart(8)}  | ${pc(ev.maxDrawdown, 1).padStart(7)}   | ${pc(ev.holdAllNet).padStart(8)}         | ${val ? 'SIM' : 'não'} (${val1 ? 'SIM' : 'não'})${q.quantized ? ' [quantizado]' : ''}`);
  }
}
const withTrades = rows.filter(r => r.ev.n > 0);
console.log(`\nValidados com correção: ${rows.filter(r => r.val).length}/${K} | sem correção: ${rows.filter(r => r.val1).length}/${K}`);
console.log(`Testes com alguma operação: ${withTrades.length}/${K} | líquido médio > 0 em ${withTrades.filter(r => r.ev.net.mean > 0).length} deles`);
