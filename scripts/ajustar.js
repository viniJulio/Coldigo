// Ajuste de regularização e variáveis SEM caçar acerto.
//  1) Escolhe a configuração pela CALIBRAÇÃO média (ganho de log-loss sobre o acaso) em dados de
//     DESENVOLVIMENTO que nunca foram usados para avaliar o modelo.
//  2) Mede a configuração escolhida e a antiga em dados de TESTE (disjuntos dos de desenvolvimento).
// Uso: node scripts/ajustar.js pasta-desenvolvimento pasta-teste
// A grade abaixo é fixada ANTES de olhar resultados. Cada ativo x tempo é uma série.
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js') + path.sep;
const I = require(R + 'indicators.js'), L = require(R + 'live.js'), M = require(R + 'model.js');
const [devDir, testDir] = process.argv.slice(2);
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'PAXGUSDT']; // EUR/USDT fica de fora (preço quantizado)
const PLAN = { '1m': 5, '5m': 3 }, PAYOUT = 85;
const LAMBDAS = [10, 100, 1000, 10000];
const SETS = {
  todas16: null,
  nucleo8: ['ret3', 'ret10', 'ret20', 'emaSpread', 'volZ', 'taker', 'taker5', 'volRegime'],
  fluxo3: ['taker', 'taker5', 'ret10']
};
const load = (dir, sym, iv) => JSON.parse(fs.readFileSync(path.join(dir, `${sym}_${iv}.json`), 'utf8')).map(L.fromRest);
const series = dir => { const out = []; for (const sym of SYMS) for (const iv of Object.keys(PLAN)) { const c = load(dir, sym, iv); out.push({ sym, iv, H: PLAN[iv], c, ind: I.computeAll(c) }); } return out; };
const dev = series(devDir), test = series(testDir);
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const fmt = (x, d = 2) => (x == null ? '–' : (100 * x).toFixed(d) + '%');

function runSet(set, opts, z) {
  return set.map(s => {
    const wf = M.walkForward(s.c, s.ind, s.H, opts);
    const ev = M.evaluate(wf.preds, s.H, PAYOUT, { marginPct: 1, minN: 30, z });
    return { s, ev, llSkill: ev.logLossBase ? 1 - ev.logLoss / ev.logLossBase : null };
  });
}

console.log(`DESENVOLVIMENTO: ${dev.length} séries (${devDir.split('/').slice(-1)[0]}) | grade: ${LAMBDAS.length} λ × ${Object.keys(SETS).length} conjuntos = ${LAMBDAS.length * Object.keys(SETS).length} configurações\n`);
console.log('conjunto   λ       | ganho Brier médio | ganho log-loss médio | séries com ganho>0 | AUC médio');
const grid = [];
for (const [name, features] of Object.entries(SETS)) for (const lambda of LAMBDAS) {
  const res = runSet(dev, { lambda, features }, 1.96);
  const row = { name, features, lambda, brier: mean(res.map(r => r.ev.brierSkill)), ll: mean(res.map(r => r.llSkill)), pos: res.filter(r => r.llSkill > 0).length, auc: mean(res.map(r => r.ev.auc)) };
  grid.push(row);
  console.log(`${name.padEnd(9)} ${String(lambda).padEnd(7)} | ${fmt(row.brier, 3).padStart(9)}         | ${fmt(row.ll, 3).padStart(9)}            | ${String(row.pos).padStart(2)}/${dev.length}              | ${row.auc.toFixed(4)}`);
}
const best = grid.slice().sort((a, b) => b.ll - a.ll)[0];
console.log(`\nEscolhida (maior ganho médio de log-loss no desenvolvimento): ${best.name}, λ=${best.lambda}  [ganho ${fmt(best.ll, 3)}]`);

const K = test.length, zK = M.zForTests(K);
console.log(`\nTESTE (${testDir.split('/').slice(-1)[0]}): ${K} séries, z corrigido ${zK.toFixed(2)}\n`);
const configs = { 'ANTIGA (todas16, λ=10)': { lambda: 10, features: null }, [`ESCOLHIDA (${best.name}, λ=${best.lambda})`]: { lambda: best.lambda, features: best.features } };
for (const [label, opts] of Object.entries(configs)) {
  const res = runSet(test, opts, zK);
  console.log(`${label}`);
  console.log(`  ganho Brier médio ${fmt(mean(res.map(r => r.ev.brierSkill)), 3)} | ganho log-loss médio ${fmt(mean(res.map(r => r.llSkill)), 3)} | AUC médio ${mean(res.map(r => r.ev.auc)).toFixed(4)} | séries com ganho Brier>0: ${res.filter(r => r.ev.brierSkill > 0).length}/${K} | sinais (≥30 indep.) ${res.filter(r => r.ev.star.n >= 30).length}/${K} | VALIDADAS: ${res.filter(r => r.ev.validated).length}/${K}`);
  const worst = res.slice().sort((a, b) => a.ev.brierSkill - b.ev.brierSkill)[0];
  console.log(`  melhor série: ${res.slice().sort((a, b) => b.ev.auc - a.ev.auc).map(r => `${r.s.sym} ${r.s.iv} AUC ${r.ev.auc.toFixed(3)}`)[0]} | pior ganho Brier: ${worst.s.sym} ${worst.s.iv} ${fmt(worst.ev.brierSkill, 2)}`);
}
