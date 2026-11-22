// Avaliação walk-forward do modelo em dados reais baixados por scripts/baixar-historico.js.
// Uso: node scripts/avaliar.js pasta-com-os-dados [plano]
// plano: lista tempo:expiração separada por vírgula (padrão 1m:5,5m:3). Ex.: 5m:6,15m:2,1h:1
// O protocolo (ativos, tempos, expirações, payout, margem) é fixado AQUI, antes de ver resultados.
// Cada ativo x tempo é um teste; o limite de confiança é corrigido para o total de testes.
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js') + path.sep;
const I = require(R + 'indicators.js'), L = require(R + 'live.js'), M = require(R + 'model.js');
const dir = process.argv[2];
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'EURUSDT', 'PAXGUSDT'];
const PLAN = (process.argv[3] || '1m:5,5m:3').split(',').map(x => { const [iv, h] = x.split(':'); return [iv, +h]; }), PAYOUT = 85;
const K = SYMS.length * PLAN.length, zK = M.zForTests(K);
console.log(`Plano: ${PLAN.map(([iv, h]) => iv + ' x' + h).join(', ')}\nTestes pré-registrados: ${K} | z corrigido = ${zK.toFixed(3)} (sem correção seria 1,960) | payout ${PAYOUT}% => empate ${(100 / 1.85).toFixed(1)}% | margem 1 p.p. | minN 30\n`);
const pct = x => x == null ? '   –  ' : (100 * x).toFixed(1).padStart(5) + '%';
console.log('ativo     tempo H  | OOS n | taxa alta | acerto  AUC   skill(Brier) | sinais indep. acerto  lim.inf.(z corr.) | validado  (sem correção)');
const rows = [];
for (const sym of SYMS) for (const [iv, H] of PLAN) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, `${sym}_${iv}.json`), 'utf8'));
  const c = raw.map(L.fromRest);
  const flat = c.filter(k => k.c === k.o).length / c.length;
  const ind = I.computeAll(c);
  const wf = M.walkForward(c, ind, H, {});
  const ev = M.evaluate(wf.preds, H, PAYOUT, { marginPct: 1, minN: 30, z: zK });
  const ev1 = M.evaluate(wf.preds, H, PAYOUT, { marginPct: 1, minN: 30, z: 1.96 });
  rows.push({ sym, iv, H, ev, ev1, flat });
  const q = M.quantization(c);
  console.log(`${sym.padEnd(9)} ${iv.padEnd(3)}  ${H} | ${String(ev.n).padStart(5)} | ${pct(ev.base)}   | ${pct(ev.accuracy)} ${ev.auc.toFixed(3)} ${(ev.brierSkill * 100).toFixed(2).padStart(6)}%     | ${String(ev.star.n).padStart(4)}  ${pct(ev.star.hitRate)}  ${pct(ev.star.hitLow)}          | ${ev.validated ? 'SIM' : 'não'}       ${ev1.validated ? 'SIM' : 'não'}   ${q.quantized ? '[BLOQUEADO: ' + (100 * q.flatShare).toFixed(0) + '% dos candles parados]' : ''}`);
}
const aucs = rows.map(r => r.ev.auc), mean = aucs.reduce((a, b) => a + b, 0) / aucs.length;
console.log(`\nAUC médio: ${mean.toFixed(4)} | máx ${Math.max(...aucs).toFixed(3)} | mín ${Math.min(...aucs).toFixed(3)}`);
console.log(`Validados com correção: ${rows.filter(r => r.ev.validated).length}/${K} | sem correção: ${rows.filter(r => r.ev1.validated).length}/${K}`);
console.log(`Skill (Brier) > 0 em: ${rows.filter(r => r.ev.brierSkill > 0).length}/${K}`);
