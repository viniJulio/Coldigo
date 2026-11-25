// Calibração para o maior acerto (qualquer direção) em saídas de 5, 10 e 15 minutos.
// 1) Período de CALIBRAÇÃO: escolhe, por ativo e saída, a combinação (tempo do candle, variáveis,
//    regularização, janela de treino, seletividade) com o maior LIMITE INFERIOR de acerto (não o
//    acerto bruto), exigindo pelo menos 100 operações independentes.
// 2) Período de CONFIRMAÇÃO (nunca usado na escolha): mede a escolhida, com correção de múltiplos
//    testes, e compara com PUT sempre, CALL sempre e a regra atual do app.
// Tudo fora da amostra (walk-forward). Uso: node scripts/calibrar.js pasta-com-dados
const fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', 'js') + path.sep;
const I = require(R + 'indicators.js'), M = require(R + 'model.js'), L = require(R + 'live.js'), S = require(R + 'sim.js');
const dir = process.argv[2];
const DEV_FIM = Date.UTC(2026, 10, 15), TESTE_INI = Date.UTC(2026, 10, 18), BE = 1 / 1.85;
const ATIVOS = ['BTCUSDT', 'ETHUSDT'];
const SAIDAS = { 5: [['1m', 5], ['5m', 1]], 10: [['1m', 10], ['5m', 2]], 15: [['1m', 15], ['5m', 3], ['15m', 1]] };
const VARS = { nucleo8: M.CORE_FEATURES, todas16: null, reversao6: ['ret1', 'ret3', 'pctB', 'rsi', 'vwapDist', 'emaDist'] };
const LAMBDAS = [30, 300, 3000], JANELAS = [1500, 3000], LIMIARES = [0.52, 0.54, 0.56, 0.58, 0.60];
const pc = x => (x == null ? '–' : (100 * x).toFixed(1) + '%');
const series = {};
const load = (sym, iv) => (series[sym + iv] = series[sym + iv] || JSON.parse(fs.readFileSync(path.join(dir, `${sym}_${iv}.json`), 'utf8')).map(L.fromRest));

// operações sem sobreposição a partir de previsões (ou de uma direção fixa)
function opera(preds, c, H, lim, fixo) {
  let next = -Infinity, n = 0, w = 0;
  for (const q of preds) {
    if (q.i < next) continue;
    const s = fixo != null ? fixo : q.p >= 0.5 ? 1 : 0, pd = fixo != null ? 1 : s ? q.p : 1 - q.p;
    if (pd < lim) continue;
    n++; if (s === q.y) w++; next = q.i + H;
  }
  return { n, w, rate: n ? w / n : null };
}
const dev = (c, preds) => preds.filter(q => c[q.i].t < DEV_FIM);
const tst = (c, preds) => preds.filter(q => c[q.i].t >= TESTE_INI);

const t0 = Date.now(); let wfs = 0;
const escolhas = [];
for (const sym of ATIVOS) for (const [saida, opcoes] of Object.entries(SAIDAS)) {
  let melhor = null;
  for (const [iv, H] of opcoes) {
    const c = load(sym, iv), ind = I.computeAll(c);
    for (const [vn, feats] of Object.entries(VARS)) for (const lambda of LAMBDAS) for (const trainN of JANELAS) {
      const wf = M.walkForward(c, ind, H, { features: feats, lambda, trainN }); wfs++;
      const pd = dev(c, wf.preds), dias = (DEV_FIM - c[pd[0].i].t) / 864e5;
      for (const lim of LIMIARES) {
        const r = opera(pd, c, H, lim); if (r.n < 100) continue;
        const [lo] = S.wilson(r.w, r.n);
        if (!melhor || lo > melhor.lo) melhor = { sym, saida, iv, H, vn, feats, lambda, trainN, lim, dev: r, lo, porDia: r.n / dias, wf, c };
      }
    }
  }
  escolhas.push(melhor);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${sym} ${saida} min: escolhida ${melhor.iv}×${melhor.H} · ${melhor.vn} · λ=${melhor.lambda} · janela ${melhor.trainN} · entra com ≥${(melhor.lim * 100).toFixed(0)}% | CALIBRAÇÃO: ${melhor.dev.n} ops (${melhor.porDia.toFixed(0)}/dia), acerto ${pc(melhor.dev.rate)}, limite inferior ${pc(melhor.lo)}`);
}

const K = escolhas.length, zK = M.zForTests(K);
console.log(`\nCONFIRMAÇÃO (18 a 25/11, fora da escolha) · ${K} testes · z=${zK.toFixed(2)} · empate ${pc(BE)} (payout 85%)\n`);
for (const e of escolhas) {
  const pt = tst(e.c, e.wf.preds), r = opera(pt, e.c, e.H, e.lim);
  const [lo] = S.wilson(r.w, r.n, zK), [lo1, hi1] = S.wilson(r.w, r.n);
  // comparações no mesmo período e com o mesmo tempo de saída
  const c1 = load(e.sym, '1m'), H1 = +e.saida;
  const atual = M.walkForward(c1, I.computeAll(c1), H1, {}); // regra atual do app: 1m, núcleo8, λ=1000, janela 2500
  const a = opera(tst(c1, atual.preds), c1, H1, 0.53), put = opera(tst(c1, atual.preds), c1, H1, 0, 0), call = opera(tst(c1, atual.preds), c1, H1, 0, 1);
  const ev = r.n ? (r.w * 0.85 - (r.n - r.w)) / r.n * 100 : null;
  console.log(`${e.sym} ${e.saida} min · escolhida (${e.iv}×${e.H}, ${e.vn}, ≥${(e.lim * 100).toFixed(0)}%): ${r.n} ops, acerto ${pc(r.rate)} [IC95 ${pc(lo1)}–${pc(hi1)}], limite corrigido ${pc(lo)}, por R$100 ${ev == null ? '–' : ev.toFixed(2)} → ${lo > BE ? 'VANTAGEM CONFIRMADA' : 'sem vantagem comprovada'}`);
  console.log(`      comparação: regra atual ${a.n} ops ${pc(a.rate)} | PUT sempre ${pc(put.rate)} | CALL sempre ${pc(call.rate)}`);
}
console.log(`\n${wfs} combinações treinadas em ${((Date.now() - t0) / 1000).toFixed(0)} s`);
