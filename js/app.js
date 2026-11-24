(function () {
  'use strict';
  const { Forecast, Data, Chart, Live, Sim, Model, Indicators } = window.Coldigo;
  const $ = id => document.getElementById(id);

  const params = { horizon: 12, simulations: 2000, window: 300, driftFactor: 0.1, tpAtr: 1.5, slAtr: 1, payout: 85, history: 6000, trainN: 2500, market: 'spot', feePct: 0.1 };
  const alertCfg = Object.assign({}, Sim.DEFAULT_CFG);
  const prefs = { stake: 10, auto: false, sound: true, ponteUrl: 'http://127.0.0.1:8787', ponteCodigo: '', ponteValor: 20, ponteEnviar: false };
  const state = { candles: [], analysis: null, source: '', live: null, liveLen: 0, alert: null, alertLog: [], bannerDismissed: null, research: null, pred: null, closedSince: 0, dec: 2 };
  const chart = new Chart($('chart'), $('tooltip'));

  const PART_LABELS = { trend: 'Tendência', vwap: 'VWAP', momentum: 'Momentum', rsi: 'RSI', bollinger: 'Bollinger' };
  const BIAS_TEXT = { up: 'ALTA', down: 'BAIXA', neutral: 'NEUTRO' };
  const pct = v => (v == null ? '–' : (v * 100).toFixed(1).replace('.', ',') + '%');
  const num = (v, d = 2) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sgn = v => (v >= 0 ? '+' : '') + num(v);
  // Preços usam as casas do ativo (EUR/USD = 4, BTC = 2). Sem ativo conhecido, deduz pela magnitude.
  const decFromPrice = p => (p >= 100 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : p >= 0.1 ? 5 : 6);
  const px = v => num(v, state.dec);
  const pxa = v => num(v, state.dec + (state.dec >= 3 ? 1 : 0));
  const money = v => (v < 0 ? '−' : '') + 'R$ ' + num(Math.abs(v));
  const smoney = v => (v > 0 ? '+' : v < 0 ? '−' : '') + 'R$ ' + num(Math.abs(v));
  const z2 = v => String(v).padStart(2, '0');
  const hhmm = t => { const d = new Date(t); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}:${z2(Math.floor(s / 60) % 60)}:${z2(s % 60)}` : `${Math.floor(s / 60)}:${z2(s % 60)}`; };
  const isFee = () => params.market !== 'binary';
  const MARKET_TXT = { binary: 'Opção binária (payout fixo)', spot: 'Binance à vista (só compra)', futures: 'Binance futuros (compra e venda)' };
  const sideTxt = (s, mode) => ((mode || (isFee() ? 'fee' : 'binary')) === 'fee' ? (s === 'up' ? '▲ COMPRA' : '▼ VENDA') : (s === 'up' ? '▲ CALL' : '▼ PUT'));
  const pctp = v => (v == null ? '–' : (v >= 0 ? '+' : '') + (v * 100).toFixed(3).replace('.', ',') + '%');

  // --- Persistência local (tolerante a falhas) ---
  const KEY = 'coldigo.sim.v1';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* ignora */ } }
  };
  const saved = store.get() || {};
  let portfolio = new Sim.Portfolio(saved.portfolio);
  const repaired = portfolio.repair(); // anula operações liquidadas com preço de outro ativo (erro antigo)
  let tests = Array.isArray(saved.tests) ? saved.tests : [];
  Object.assign(prefs, saved.prefs);
  Object.assign(alertCfg, saved.alertCfg);
  Object.assign(params, saved.params);
  function persist() { store.set({ portfolio, prefs, alertCfg, tests, params: { horizon: params.horizon, payout: params.payout, history: params.history, trainN: params.trainN, market: params.market, feePct: params.feePct } }); }

  function showError(msg) {
    const el = $('error');
    el.hidden = !msg; el.textContent = msg || '';
  }

  function load(candles, source) {
    stopLive();
    try {
      state.candles = candles; state.source = source; state.liveLen = candles.length;
      state.research = null; state.pred = null; state.alert = null;
      showError('');
      analyze(true);
      runResearch();
      renderDuracoes();
    } catch (e) {
      showError(e.message);
    }
  }

  function analyze(resetView) {
    const known = state.live && Live.asset(state.live.symbol);
    state.dec = known ? known.dec : decFromPrice(state.candles[state.candles.length - 1].c);
    chart.dec = state.dec;
    state.analysis = Forecast.analyze(state.candles, params);
    chart.setData(state.candles, state.analysis, resetView);
    renderMeta();
    renderMain();
  }

  function renderMeta() {
    const c = state.candles, a = state.analysis;
    const first = new Date(c[0].t), last = new Date(c[c.length - 1].t);
    const d = t => t.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const stepMin = Math.round(a.stepMs / 60000);
    $('meta').innerHTML = `<b>${state.source}</b> · ${c.length} candles de ${stepMin} min · ${d(first)} → ${d(last)} · último <b>${px(a.last)}</b> · ATR(14) <b>${pxa(a.atr)}</b>`;
  }

  function reasons(a) {
    const out = [];
    const p = a.parts;
    if (Math.abs(p.trend) > 0.25) out.push(p.trend > 0 ? 'EMA 9 acima da EMA 21 (tendência de alta)' : 'EMA 9 abaixo da EMA 21 (tendência de baixa)');
    if (Math.abs(p.vwap) > 0.25) out.push(p.vwap > 0 ? 'preço acima do VWAP' : 'preço abaixo do VWAP');
    if (Math.abs(p.momentum) > 0.25) out.push(p.momentum > 0 ? 'momentum positivo nos últimos candles' : 'momentum negativo nos últimos candles');
    if (p.rsi < -0.05) out.push('RSI em sobrecompra (risco de reversão)');
    if (p.rsi > 0.05) out.push('RSI em sobrevenda (risco de repique)');
    if (p.bollinger < -0.05) out.push('preço esticado acima da banda de Bollinger');
    if (p.bollinger > 0.05) out.push('preço esticado abaixo da banda de Bollinger');
    return out.length ? out.join('; ') + '.' : 'Sinais mistos: nenhum indicador domina.';
  }

  // Cartões de análise: refeitos a cada atualização (não contêm campos editáveis)
  function renderMain() {
    const a = state.analysis, f = a.forecast, last = f.bands[f.horizon - 1];
    const pos = ((a.score + 1) / 2) * 100;
    const side = a.bias === 'down' ? 'short' : 'long';
    const sideData = f[side];
    const sideName = side === 'long' ? 'Compra' : 'Venda';
    const dirTp = side === 'long' ? 1 : -1;
    const horizonMin = Math.round(f.horizon * a.stepMs / 60000);

    const partsHtml = Object.keys(a.weights).map(k => {
      const v = a.parts[k];
      const w = Math.abs(v) * 50;
      const style = v >= 0 ? `left:50%;width:${w}%;background:var(--up)` : `left:${50 - w}%;width:${w}%;background:var(--down)`;
      return `<div class="bar"><span>${PART_LABELS[k]} <small class="note">${Math.round(a.weights[k] * 100)}%</small></span><div class="track"><i style="${style}"></i></div><span class="val">${sgn(v)}</span></div>`;
    }).join('');

    const lvl = (arr, name) => arr.length ? arr.map((l, i) => `<div class="row"><span>${name}${i + 1} · ${l.touches} toque(s)</span><b>${px(l.price)}</b></div>`).join('') : `<div class="note">Sem ${name === 'R' ? 'resistências' : 'suportes'} identificados.</div>`;

    const bt = a.backtest;
    const btRows = bt.rows.map(r => `<tr><td>≥ ${num(r.threshold)}</td><td>${r.signals}</td><td>${r.hitRate == null ? '–' : pct(r.hitRate)}</td><td>${r.avgReturnPct == null ? '–' : num(r.avgReturnPct, 3) + '%'}</td></tr>`).join('');
    const main = bt.rows[0];
    let verdict;
    if (!main || main.signals < 30) verdict = 'Amostra pequena: carregue mais pregões para validar o sinal.';
    else if (main.hitRate > 0.55 && main.avgReturnPct > 0) verdict = 'Neste histórico o sinal acertou acima do acaso. É resultado em amostra, sem garantia futura.';
    else verdict = 'Neste histórico o sinal não mostrou vantagem estatística clara. Use com cautela.';

    $('sec-main').innerHTML = `
      <div class="card">
        <h3>Viés por indicadores · referência, não validado</h3>
        <div class="bias ${a.bias}"><span class="label">${BIAS_TEXT[a.bias]}</span><b>${sgn(a.score)}</b></div>
        <div class="gauge"><i style="left:${pos}%"></i></div>
        <div class="legend"><span>−1 baixa</span><span style="margin-left:auto">+1 alta</span></div>
        <p class="note" style="margin:8px 0 0">${reasons(a)}</p>
      </div>

      <div class="card">
        <h3>Movimentação estimada</h3>
        <div class="row"><span>Mediana no fim do horizonte</span><b>${px(last.p50)} (${sgn((last.p50 - f.entry) / f.entry * 100)}%)</b></div>
        <div class="row"><span>Faixa 50% provável</span><b>${px(last.p25)} – ${px(last.p75)}</b></div>
        <div class="row"><span>Faixa 80% provável</span><b>${px(last.p10)} – ${px(last.p90)}</b></div>
        <div class="row"><span>Probabilidade de fechar acima</span><b>${pct(f.probUp)}</b></div>
        <div class="row"><span>Máxima esperada (mediana)</span><b>${px(f.expectedHigh.p50)}</b></div>
        <div class="row"><span>Mínima esperada (mediana)</span><b>${px(f.expectedLow.p50)}</b></div>
        <div class="legend" style="margin-top:6px"><span><i style="background:var(--c-forecast)"></i>cone no gráfico: 50% e 80%</span></div>
      </div>

      <div class="card">
        <h3>${sideName} · alvo ${params.tpAtr}× ATR / stop ${params.slAtr}× ATR</h3>
        <div class="row"><span>Entrada</span><b>${px(f.entry)}</b></div>
        <div class="row"><span>Alvo</span><b class="pos">${px(f.entry + dirTp * f.tpDistance)}</b></div>
        <div class="row"><span>Stop</span><b class="neg">${px(f.entry - dirTp * f.slDistance)}</b></div>
        <div class="prob" title="alvo / stop / nenhum"><i style="width:${sideData.tp * 100}%"></i><i style="width:${sideData.sl * 100}%"></i><i style="width:${sideData.none * 100}%"></i></div>
        <div class="legend"><span><i style="background:var(--up)"></i>alvo ${pct(sideData.tp)}</span><span><i style="background:var(--down)"></i>stop ${pct(sideData.sl)}</span><span><i style="background:var(--muted)"></i>nenhum ${pct(sideData.none)}</span></div>
        <div class="row" style="margin-top:6px"><span>Razão risco/retorno</span><b>1 : ${num(params.tpAtr / params.slAtr)}</b></div>
        ${a.bias === 'neutral' ? '<p class="note">Viés neutro: mostrando o lado comprado como referência.</p>' : ''}
      </div>

      <div class="card parts">
        <h3>Composição do score</h3>
        ${partsHtml}
      </div>

      <div class="card">
        <h3>Níveis relevantes</h3>
        ${lvl(a.resistances, 'R')}
        ${a.pivots ? `<div class="row"><span>Pivô (PP) pregão anterior</span><b>${px(a.pivots.PP)}</b></div>` : ''}
        ${lvl(a.supports, 'S')}
      </div>

      <div class="card">
        <h3>Backtest do score por indicadores (horizonte ${f.horizon})</h3>
        <table><thead><tr><th>Score</th><th>Sinais</th><th>Acerto</th><th>Retorno médio</th></tr></thead><tbody>${btRows}</tbody></table>
        <p class="note" style="margin:8px 0 0">Taxa de alta do período: ${bt.baseUpRate == null ? '–' : pct(bt.baseUpRate)} em ${bt.baseSamples} janelas (sobrepostas: os sinais não são independentes). ${verdict}</p>
      </div>`;

    const note = $('p-note');
    if (note) note.textContent = `${f.simulations} trajetórias por bootstrap dos candles recentes (σ por candle ${num(f.sigma * 100, 3)}%). Se alvo e stop caírem no mesmo candle, conta-se o stop.`;
    $('disclaimer').innerHTML = 'Estimativa estatística, não recomendação de investimento nem previsão garantida. Day trade e opções binárias envolvem risco de perda total do valor operado; custos, slippage e liquidez não estão incluídos. ' +
      (state.source.startsWith('Demonstração') ? '<b>Dados de demonstração são sintéticos.</b>' : '');
  }

  // Parâmetros: desenhados uma única vez, para os campos não serem apagados pela atualização ao vivo
  function renderParams() {
    const row = (id, label, attrs, val) => `<label for="${id}">${label}</label><input id="${id}" type="number" ${attrs} value="${val}">`;
    $('sec-params').innerHTML = `
      <div class="card">
        <h3>Operação</h3>
        <div class="params">
          <label for="p-market">Mercado</label>
          <select id="p-market">${Object.keys(MARKET_TXT).map(k => `<option value="${k}"${k === params.market ? ' selected' : ''}>${MARKET_TXT[k]}</option>`).join('')}</select>
          ${row('p-horizon', 'Saída / expiração (candles)', 'min="1" max="60"', params.horizon)}
          ${row('p-fee', 'Taxa por lado (%)', 'min="0" max="1" step="0.01"', params.feePct)}
          ${row('p-payout', 'Payout da binária (%)', 'min="50" max="100" step="1"', params.payout)}
        </div>
        <p class="note" style="margin-top:8px">Na Binance você paga a taxa na entrada e na saída e ganha ou perde o tamanho do movimento. Taxas padrão: à vista 0,1% e futuros 0,05% por lado (confira as da sua conta). Na opção binária vale o payout.</p>
      </div>

      <div class="card">
        <h3>Modelo e alerta</h3>
        <div class="params">
          ${row('p-train', 'Janela de treino (candles)', 'min="800" max="8000" step="100"', params.trainN)}
          ${row('p-history', 'Histórico ao vivo (candles)', 'min="3000" max="10000" step="500"', params.history)}
          ${row('a-margin', 'Margem sobre o empate (p.p.)', 'min="0" max="10" step="0.5"', alertCfg.marginPct)}
          ${row('a-minn', 'Operações independentes mínimas', 'min="10" max="500" step="5"', alertCfg.minN)}
        </div>
        <p class="note" style="margin-top:8px">O histórico maior só vale na próxima vez que você ligar o modo Ao vivo. Cada combinação de par, tempo, expiração e margem que você testa aumenta a chance de achar um resultado bom por sorte, e a ferramenta compensa isso deixando o limite de confiança mais rígido.</p>
      </div>

      <div class="card">
        <h3>Cone de projeção (indicadores)</h3>
        <div class="params">
          ${row('p-tp', 'Alvo (× ATR)', 'min="0.2" max="10" step="0.1"', params.tpAtr)}
          ${row('p-sl', 'Stop (× ATR)', 'min="0.2" max="10" step="0.1"', params.slAtr)}
          ${row('p-win', 'Janela de volatilidade', 'min="30" max="2000" step="10"', params.window)}
          ${row('p-drift', 'Peso do viés (drift)', 'min="0" max="1" step="0.05"', params.driftFactor)}
          ${row('p-sims', 'Simulações', 'min="200" max="20000" step="200"', params.simulations)}
        </div>
        <p class="note" id="p-note" style="margin-top:8px"></p>
      </div>`;

    // `research`: o campo muda o que o modelo avalia, então a validação é refeita
    const bind = (id, apply, after) => $(id).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      apply(v);
      persist();
      try { showError(''); after(); } catch (err) { showError(err.message); }
    });
    const reanalyze = (reset, research) => () => {
      if (!state.analysis) return;
      analyze(reset);
      if (research) runResearch();
    };
    bind('p-horizon', v => { params.horizon = Math.max(1, Math.min(60, Math.round(v))); }, () => { reanalyze(true, true)(); renderDuracoes(); });
    bind('p-fee', v => { params.feePct = Math.max(0, Math.min(1, v)); }, reanalyze(false, true));
    $('p-market').addEventListener('change', e => {
      params.market = e.target.value;
      if (params.market !== 'binary') { params.feePct = params.market === 'spot' ? 0.1 : 0.05; $('p-fee').value = params.feePct; }
      persist(); renderSim();
      try { showError(''); reanalyze(false, true)(); } catch (err) { showError(err.message); }
    });
    bind('p-payout', v => { params.payout = Math.max(50, Math.min(100, v)); }, reanalyze(false, true));
    bind('p-train', v => { params.trainN = Math.max(800, Math.min(8000, Math.round(v))); }, reanalyze(false, true));
    bind('p-history', v => { params.history = Math.max(3000, Math.min(10000, Math.round(v))); }, () => {});
    bind('a-margin', v => { alertCfg.marginPct = Math.max(0, Math.min(10, v)); }, reanalyze(false, true));
    bind('a-minn', v => { alertCfg.minN = Math.max(10, Math.round(v)); }, reanalyze(false, true));
    bind('p-tp', v => { params.tpAtr = v; }, reanalyze(false, false));
    bind('p-sl', v => { params.slAtr = v; }, reanalyze(false, false));
    bind('p-win', v => { params.window = Math.round(v); }, reanalyze(false, false));
    bind('p-drift', v => { params.driftFactor = v; }, reanalyze(false, false));
    bind('p-sims', v => { params.simulations = Math.max(200, Math.min(20000, Math.round(v))); }, reanalyze(false, false));
  }

  // --- Pesquisa (validação fora da amostra) e decisão ---
  const CHECK_LABELS = {
    sample: ['Operações independentes validadas (fora da amostra)', c => `${c.value} ≥ ${c.need}`],
    edge: ['Acerto: limite inferior de confiança acima do empate', c => `${pct(c.value)} > ${pct(c.need)}`],
    skill: ['Modelo melhor que o acaso (escore de Brier)', c => `${c.value > 0 ? '+' : ''}${(c.value * 100).toFixed(2).replace('.', ',')}%`],
    prob: ['Probabilidade atual acima do limiar de entrada', c => `${pct(c.value)} ≥ ${pct(c.need)}`],
    net: ['Lucro líquido médio por operação (limite inferior) acima de zero', c => `${pctp(c.value)} > 0`],
    excess: ['Ganho além da tendência do mercado (limite inferior) acima de zero', c => `${pctp(c.value)} > 0`],
    cover: ['Probabilidade atual cobre a taxa de ida e volta', c => (c.need >= 1 ? 'taxa > movimento típico' : `${pct(c.value)} ≥ ${pct(c.need)}`)]
  };
  const REASONS = {
    sample: c => `poucos sinais independentes validados fora da amostra (${c.value} de ${c.need} necessários)`,
    edge: c => `sem vantagem comprovada fora da amostra (limite inferior ${pct(c.value)} não passa do empate ${pct(c.need)})`,
    skill: () => 'o modelo não supera o acaso fora da amostra',
    prob: c => `probabilidade atual (${pct(c.value)}) abaixo do limiar de entrada (${pct(c.need)})`,
    net: c => `fora da amostra, o lucro depois das taxas não é comprovadamente positivo (limite inferior ${pctp(c.value)} por operação)`,
    excess: c => `o lucro, quando aparece, vem da tendência do mercado e não do modelo (limite inferior do excesso ${pctp(c.value)})`,
    cover: c => (c.need >= 1 ? 'a taxa de ida e volta é maior que o movimento típico neste tempo gráfico: nem acertando sempre daria lucro. Use um tempo gráfico ou uma saída maior' : `a probabilidade atual (${pct(c.value)}) não cobre a taxa; precisaria de ${pct(c.need)}`)
  };

  // Configurações distintas pesquisadas na última semana (correção de múltiplos testes).
  // `countTests` diz quantas haveria com esta; `registerTest` grava só depois de a validação rodar de fato.
  const recentTests = () => tests.filter(t => Date.now() - t.ts < 7 * 864e5);
  const countTests = key => recentTests().length + (recentTests().some(t => t.key === key) ? 0 : 1);
  function registerTest(key) {
    tests = recentTests();
    if (!tests.some(t => t.key === key)) tests.push({ key, ts: Date.now() });
    persist();
  }

  function runResearch() {
    if (!state.analysis || !state.candles.length) return;
    const key = `${state.live ? state.live.symbol + '|' + state.live.interval : state.source}|H${params.horizon}|${isFee() ? params.market + params.feePct : 'M' + alertCfg.marginPct}`;
    const k = countTests(key), z = Model.zForTests(k);
    state.research = { status: 'running', key, k, z, n: state.candles.length };
    state.closedSince = 0;
    const q = Model.quantization(state.candles);
    if (q.quantized) { // preço em passos grandes: padrões de curtíssimo prazo costumam ser artefato do feed
      state.research = { status: 'quantized', key, k, z, n: state.candles.length, flatShare: q.flatShare };
      state.pred = null; state.alert = null;
      renderDecision();
      return;
    }
    renderDecision();
    setTimeout(() => {
      try {
        const t0 = performance.now();
        const wf = Model.walkForward(state.candles, Indicators.computeAll(state.candles), params.horizon, { trainN: params.trainN, keepTies: isFee() });
        if (wf.insufficient) {
          state.research = { status: 'insufficient', key, k, z, n: state.candles.length, needed: wf.needed };
        } else {
          registerTest(key);
          const ev = Model.evaluate(wf.preds, params.horizon, params.payout, { marginPct: alertCfg.marginPct, minN: alertCfg.minN, z });
          const evc = isFee() ? Model.evaluateCosts(wf.preds, state.candles, params.horizon, { market: params.market, feePct: params.feePct, minN: alertCfg.minN, z }) : null;
          state.research = { status: 'done', key, k, z, n: state.candles.length, ev, evc, market: params.market, fits: wf.fits, hasTakerFlow: wf.hasTakerFlow, ms: Math.round(performance.now() - t0), at: Date.now() };
        }
        refreshPrediction(lastClosedIndex(), false);
      } catch (e) { state.research = { status: 'error', message: e.message }; showError(e.message); renderDecision(); }
    }, 30);
  }

  function lastClosedIndex() {
    const n = state.candles.length;
    if (!state.live) return n - 1;
    return state.candles[n - 1].t + state.live.intervalMs <= Date.now() + 1500 ? n - 1 : n - 2;
  }

  // Treina com tudo o que já era conhecido no candle m e prevê a direção a partir dele
  function refreshPrediction(m, notify) {
    const r = state.research;
    if (!r || r.status !== 'done' || m < 0) { renderDecision(); return; }
    const c = state.candles, H = params.horizon;
    const { X } = Model.buildFeatures(c, Indicators.computeAll(c));
    const model = Model.fitLatest(c, X, Model.labels(c, H), H, { trainN: params.trainN }, m);
    state.pred = model && X[m] ? { p: Model.predictProb(model, X[m]), t: c[m].t, idx: m } : null;
    const res = !state.pred ? null : r.evc
      ? Sim.evaluateAlertCosts({ p: state.pred.p, research: r.evc, market: r.market }, alertCfg)
      : Sim.evaluateAlert({ p: state.pred.p, research: r.ev }, alertCfg, params.payout);
    state.alert = res && { res, candleT: c[m].t };
    if (notify && res && res.fire) fireAlert(res, c[m]);
    renderDecision();
  }

  function fireAlert(res, last) {
    const label = state.live ? Live.label(state.live.symbol) + ' · ' + state.live.interval : state.source;
    const entry = { t: last.t + (state.live ? state.live.intervalMs : 0), side: res.side, label, auto: false };
    const abertas = prefs.ponteEnviar && conta.conectada ? conta.ops.filter(o => o.estado === 'aberta').length : portfolio.open.length;
    if (prefs.auto && state.live && abertas === 0) {
      try { enterTrade(res.side, 'alerta'); entry.auto = true; } catch (e) { showError(e.message); }
    }
    state.alertLog.unshift(entry);
    state.alertLog = state.alertLog.slice(0, 8);
    state.bannerDismissed = null;
    if (prefs.sound) { beep(); try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (_) { /* ignora */ } }
  }

  function decisionState() {
    const r = state.research, al = state.alert;
    if (!r || r.status === 'running') return { kind: 'wait', text: `Validando o modelo em ${state.candles.length} candles…` };
    if (r.status === 'insufficient') return { kind: 'none', text: `NÃO OPERAR · dados insuficientes para validar o modelo (precisa de ${r.needed} candles, há ${r.n}). No modo Ao vivo o histórico é carregado automaticamente.` };
    if (r.status === 'quantized') return { kind: 'none', text: `NÃO OPERAR · preço muito quantizado: ${(r.flatShare * 100).toFixed(0)}% dos candles fecham no mesmo preço em que abrem. Nesse tipo de dado, padrões de curtíssimo prazo costumam ser artefato do passo de preço do feed, não uma vantagem que exista na sua corretora. Use o histórico do feed da própria corretora (CSV) ou um tempo gráfico maior.` };
    if (r.status === 'error') return { kind: 'none', text: 'NÃO OPERAR · erro ao validar o modelo: ' + r.message };
    if (!al) return { kind: 'wait', text: 'Aguardando o candle fechar para prever.' };
    if (al.res.fire) return { kind: al.res.side === 'down' ? 'put' : 'call', text: null };
    const failed = al.res.checks.find(c => c.key === 'cover' && !c.ok && c.need >= 1) || al.res.checks.find(c => !c.ok);
    return { kind: 'none', text: `NÃO OPERAR · ${failed ? REASONS[failed.key](failed) : 'sem sinal'}` };
  }

  function renderDecision() { renderBanner(); renderDecisionCard(); }

  function renderBanner() {
    const el = $('alert-banner'), d = decisionState(), al = state.alert;
    if (d.kind === 'call' || d.kind === 'put') {
      if (state.bannerDismissed === al.candleT) { el.hidden = true; return; }
      const { res } = al, mins = Math.round(params.horizon * (state.analysis.stepMs / 60000));
      el.className = 'alert-banner ' + (d.kind === 'put' ? 'put' : '');
      el.innerHTML = `<span class="grow"><b>SINAL VALIDADO · ${sideTxt(res.side)}</b> · probabilidade ${pct(res.pDir)} · ${isFee() ? 'saída' : 'expiração'} em ${params.horizon} candles (~${mins} min)</span>` +
        (state.live ? `<button class="btn small primary" data-act="enter" data-side="${res.side}">Simular entrada</button>` : '') +
        '<button class="btn small" data-act="dismiss">Dispensar</button>';
    } else {
      el.className = 'alert-banner none';
      el.innerHTML = `<span class="grow">${d.text}</span>`;
    }
    el.hidden = false;
  }

  function renderDecisionCard() {
    const r = state.research, al = state.alert, d = decisionState();
    if (!r) { $('sec-alert').innerHTML = ''; return; }
    let body = '';
    if (r.status === 'done' && al) {
      const pUp = state.pred.p;
      const checks = al.res.checks.map(c => {
        const [label, fmt] = CHECK_LABELS[c.key];
        return `<li><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span><span>${label}</span><span class="val">${c.value == null ? '–' : fmt(c)}</span></li>`;
      }).join('');
      const ev = r.ev, star = ev.star, evc = r.evc;
      const pos = Math.min(100, Math.max(0, (pUp - 0.4) / 0.2 * 100));
      if (evc) {
        const sumR = evc.n ? `${evc.n} operações (sem sobreposição): acerto ${pct(evc.hitRate)}, líquido médio ${pctp(evc.net.mean)} por operação (${pctp(evc.sumNet)} somando), maior queda ${pctp(-evc.maxDrawdown)}.` : '';
        body = `
        <div class="modelp"><span>Modelo no fechamento das ${hhmm(state.pred.t + (state.live ? state.live.intervalMs : 0))}</span>
          <b>▲ ${pct(pUp)} &nbsp; ▼ ${pct(1 - pUp)}</b></div>
        <div class="gauge mid"><i style="left:${pos}%"></i></div>
        <ul class="checks">${checks}</ul>
        <p class="note" style="margin:8px 0 0">${MARKET_TXT[r.market]}, taxa ${num(params.feePct, 2)}% por lado (${pctp(evc.costRoundTrip)} ida e volta). Movimento típico em ${params.horizon} candles: ${evc.typicalNow ? pctp(evc.typicalNow).replace('+', '') : '–'}. Tudo medido <b>fora da amostra</b>.</p>
        <p class="note" style="margin:6px 0 0">${evc.n ? 'Fora da amostra, a regra teria feito ' + sumR : 'Fora da amostra, a probabilidade nunca cobriu a taxa: a regra não teria feito nenhuma operação.'} Comprar sempre teria dado ${pctp(evc.holdAllNet)} por operação.</p>
        <details class="more"><summary>Detalhes da validação</summary>
          <div class="row"><span>Operações fora da amostra</span><b>${evc.n}</b></div>
          <div class="row"><span>Líquido médio (limite inferior)</span><b>${pctp(evc.net.mean)} (${pctp(evc.net.low)})</b></div>
          <div class="row"><span>Além da tendência (limite inferior)</span><b>${pctp(evc.excess.mean)} (${pctp(evc.excess.low)})</b></div>
          <div class="row"><span>Composto (todas as operações)</span><b>${pctp(evc.compounded)}</b></div>
          <div class="row"><span>AUC (0,50 = acaso)</span><b>${ev.auc == null ? '–' : num(ev.auc, 3)}</b></div>
          <div class="row"><span>Ganho sobre o acaso (Brier)</span><b>${ev.brierSkill == null ? '–' : (ev.brierSkill * 100).toFixed(2).replace('.', ',') + '%'}</b></div>
          <div class="row"><span>Retreinos (janela ${params.trainN})</span><b>${r.fits}</b></div>
          <p class="note" style="margin:8px 0 0">"Além da tendência" desconta a alta ou a queda média do período: num mercado que só sobe, comprar dá lucro sem mérito do modelo. Sem slippage. Você pesquisou <b>${r.k}</b> configuração(ões) na última semana, então o limite de confiança usa z = ${num(r.z, 2)}.</p>
        </details>`;
      } else {
      const trades = Sim.pnlTrades(star.trades, prefs.stake, params.payout), st = Sim.summarize(trades);
      const stratRows = ev.strategies.map(s => `<tr${Math.abs(s.threshold - ev.tStar) < 1e-9 ? ' class="gate"' : ''}><td>${pct(s.threshold)}${Math.abs(s.threshold - ev.tStar) < 1e-9 ? ' ★' : ''}</td><td>${s.n}</td><td>${pct(s.hitRate)}</td><td>${pct(s.hitLow)}</td><td>${s.evPerUnit == null ? '–' : smoney(Math.round(s.evPerUnit * 10000) / 100)}</td></tr>`).join('');
      const calRows = ev.calibration.map((g, i) => `<tr><td>${i + 1}º</td><td>${g.n}</td><td>${pct(g.meanP)}</td><td>${pct(g.freq)}</td></tr>`).join('');
      body = `
        <div class="modelp"><span>Modelo no fechamento das ${hhmm(state.pred.t + (state.live ? state.live.intervalMs : 0))}</span>
          <b>▲ ${pct(pUp)} &nbsp; ▼ ${pct(1 - pUp)}</b></div>
        <div class="gauge mid"><i style="left:${pos}%"></i></div>
        <ul class="checks">${checks}</ul>
        <p class="note" style="margin:8px 0 0">Tudo é medido <b>fora da amostra</b>: o modelo prevê candles que ele não viu no treino. Limiar de entrada ${pct(ev.tStar)} (empate ${pct(ev.breakeven)} + margem), definido antes de olhar os resultados.</p>
        <p class="note" style="margin:6px 0 0">${st.trades === 0 ? 'Fora da amostra, a regra não teria feito nenhuma operação.' :
          `Fora da amostra, a regra teria feito ${st.trades} operações (sem sobreposição): acerto ${pct(st.winRate)}, resultado ${smoney(st.pnl)} com ${money(prefs.stake)} por operação, maior queda ${money(st.maxDrawdown)}.`}</p>
        <details class="more"><summary>Detalhes da validação</summary>
          <div class="row"><span>Candles avaliados fora da amostra</span><b>${ev.n}</b></div>
          <div class="row"><span>Taxa de alta no período</span><b>${pct(ev.base)}</b></div>
          <div class="row"><span>Acerto geral (p ≥ 50%)</span><b>${pct(ev.accuracy)}</b></div>
          <div class="row"><span>AUC (0,50 = acaso)</span><b>${ev.auc == null ? '–' : num(ev.auc, 3)}</b></div>
          <div class="row"><span>Ganho sobre o acaso (Brier)</span><b>${ev.brierSkill == null ? '–' : (ev.brierSkill * 100).toFixed(2).replace('.', ',') + '%'}</b></div>
          <div class="row"><span>Retreinos (janela ${params.trainN})</span><b>${r.fits}</b></div>
          <div class="row"><span>Fluxo de ordens (taker buy)</span><b>${r.hasTakerFlow ? 'usado' : 'indisponível neste dado'}</b></div>
          <h4>Estratégia por limiar de probabilidade</h4>
          <table><thead><tr><th>Limiar</th><th>Operações</th><th>Acerto</th><th>Lim. inf.</th><th>Por operação</th></tr></thead><tbody>${stratRows}</tbody></table>
          <h4>Calibração (do menor ao maior p)</h4>
          <table><thead><tr><th>Grupo</th><th>n</th><th>p médio</th><th>Real</th></tr></thead><tbody>${calRows}</tbody></table>
          <p class="note" style="margin:8px 0 0">Só a linha ★ vale como teste. As demais são informativas: escolher o melhor limiar depois de ver os resultados infla o acerto. Você pesquisou <b>${r.k}</b> configuração(ões) na última semana, então o limite de confiança usa z = ${num(r.z, 2)} (em vez de 1,96).</p>
        </details>`;
      }
    }
    const log = state.alertLog.length
      ? '<div class="log"><b>Últimos alertas</b>' + state.alertLog.map(l => `<div>${hhmm(l.t)} · ${sideTxt(l.side, l.mode)} · ${l.label}${l.auto ? ' · entrada simulada' : ''}</div>`).join('') + '</div>' : '';
    const head = d.kind === 'call' || d.kind === 'put' ? `${sideTxt(al.res.side)} · sinal validado`
      : d.kind === 'wait' ? 'Validando…' : 'Sem sinal validado agora';
    $('sec-alert').innerHTML = `
      <div class="card alert-card ${d.kind === 'call' || d.kind === 'put' ? 'firing' : ''}">
        <h3>Decisão e validação do modelo</h3>
        <div class="alert-state ${d.kind === 'call' || d.kind === 'put' ? 'on' : 'off'}">${head}</div>
        ${d.kind === 'none' || d.kind === 'wait' ? `<p class="note" style="margin:6px 0 0">${d.text || ''}</p>` : ''}
        ${body}${log}
      </div>`;
  }

  $('alert-banner').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'dismiss') { state.bannerDismissed = state.alert && state.alert.candleT; renderBanner(); }
    if (b.dataset.act === 'enter') { ensureAudio(); try { enterTrade(b.dataset.side, 'alerta'); } catch (err) { showError(err.message); } }
  });

  // --- Som, vibração e tela ligada ---
  let audioCtx = null, wake = null;
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { /* sem áudio */ }
  }
  function beep() {
    if (!audioCtx) return;
    [0, 0.28, 0.56].forEach(d => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + d;
      o.frequency.value = 880; g.gain.value = 0.2;
      o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + 0.16);
    });
  }
  async function lockScreen() { try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (_) { /* opcional */ } }
  function unlockScreen() { try { if (wake) wake.release(); } catch (_) { /* ignora */ } wake = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.live) lockScreen(); });

  // --- Tempo da operação ---
  // O tempo é sempre múltiplo do candle do gráfico (o modelo prevê "daqui a H candles"). Ao trocar o
  // tempo gráfico, o tempo da operação escolhido é mantido; se não couber, usa o mais próximo possível.
  const DURACOES = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880];
  const durTxt = m => (m < 60 ? `${m} min` : m % 1440 === 0 ? `${m / 1440} dia${m > 1440 ? 's' : ''}` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`);
  const ivMinOf = iv => Live.INTERVAL_MS[iv] / 60000;
  const intervalMin = () => (state.live ? state.live.intervalMs / 60000 : state.analysis ? Math.max(1, Math.round(state.analysis.stepMs / 60000)) : 1);
  const opcoesDuracao = iv => DURACOES.filter(d => d % iv === 0 && d / iv >= 1 && d / iv <= 60);
  function maisProxima(dur, iv) {
    const opts = opcoesDuracao(iv);
    return opts.reduce((b, d) => (Math.abs(Math.log(d / dur)) < Math.abs(Math.log(b / dur)) ? d : b), opts[0]);
  }

  let avisoDuracao = '';
  function renderDuracoes() {
    const iv = intervalMin(), atual = params.horizon * iv, sel = $('sim-duracao');
    const opts = opcoesDuracao(iv);
    if (!opts.includes(atual)) { opts.push(atual); opts.sort((a, b) => a - b); } // tempo definido à mão em candles
    sel.innerHTML = opts.map(d => `<option value="${d}"${d === atual ? ' selected' : ''}>${durTxt(d)} (${d / iv} candle${d / iv > 1 ? 's' : ''} de ${durTxt(iv)})</option>`).join('');
    $('sim-duracao-nota').textContent = `${avisoDuracao ? avisoDuracao + ' ' : ''}Cada operação termina ${durTxt(atual)} depois da entrada. O modelo e o alerta são validados para esse mesmo tempo.`;
  }

  function setHorizon(H) {
    avisoDuracao = '';
    params.horizon = Math.max(1, Math.min(60, Math.round(H)));
    const inp = $('p-horizon'); if (inp) inp.value = params.horizon;
    persist();
    if (state.analysis) { try { analyze(true); runResearch(); } catch (e) { showError(e.message); } }
    renderDuracoes(); renderSim();
  }
  $('sim-duracao').addEventListener('change', e => setHorizon(+e.target.value / intervalMin()));

  // --- Simulador ---
  function simReady() { return !!state.live && !!state.analysis && state.candles.length > 0; }

  function enterTrade(side, source) {
    if (!simReady()) throw new Error('Ative o modo Ao vivo para operar no simulador.');
    if (params.market === 'spot' && side === 'down') throw new Error('No mercado à vista só é possível comprar.');
    if (prefs.ponteEnviar && conta.conectada) { // ordem real na conta DEMO, executada pela ponte
      if (params.market !== 'spot') throw new Error('A conta demo é operada no mercado à vista: escolha "Binance à vista" em Parâmetros → Operação.');
      if (side !== 'up') throw new Error('No mercado à vista só é possível comprar.');
      enviarParaDemo(source);
      return;
    }
    const last = state.candles[state.candles.length - 1];
    portfolio.openTrade({
      side, price: last.c, t: Date.now(), stake: prefs.stake, payoutPct: params.payout, horizon: params.horizon,
      feePct: isFee() ? params.feePct : undefined, interval: state.live.interval,
      context: (() => { const d = decisionState(); return { p: state.pred ? state.pred.p : null, decision: d.kind, text: d.text, market: params.market }; })(),
      intervalMs: state.live.intervalMs, symbol: state.live.symbol, source
    });
    persist(); syncMarkers(); renderSim();
  }

  // No vencimento, liquida pelo preço ao vivo só as operações do ativo aberto. As demais (outro ativo,
  // app fechado no vencimento) usam o preço do próprio ativo no minuto do vencimento, consultado na Binance.
  const lookups = new Map();
  function settleNow() {
    if (!portfolio.open.length) return;
    const now = Date.now(), sym = state.live && liveStatus === 'live' ? state.live.symbol : null;
    if (sym && state.candles.length && portfolio.settle(state.candles, now, sym).length) { persist(); syncMarkers(); renderSim(); }
    for (const tr of portfolio.needsLookup(now, sym)) {
      if (!tr.symbol || now - (lookups.get(tr.id) || 0) < 60000) continue;
      lookups.set(tr.id, now);
      Live.priceAt(tr.symbol, tr.expiry).then(price => {
        if (price != null && portfolio.settleAt(tr.id, price, 'minute')) { lookups.delete(tr.id); persist(); syncMarkers(); renderSim(); }
      }).catch(() => { /* sem rede: tenta de novo em 1 minuto */ });
    }
  }
  setInterval(settleNow, 15000);

  function syncMarkers() {
    const sym = state.live && state.live.symbol;
    const mk = t => ({ t: t.t, price: t.entry, side: t.side, result: t.result || 'open' });
    const demo = (conta.ops || []).filter(o => o.symbol === sym && o.abertura && o.abertura.avgPrice).slice(-60)
      .map(o => ({ t: o.abertura.t, price: o.abertura.avgPrice, side: 'up', result: o.estado === 'aberta' ? 'open' : o.resultadoUSDT > 0 ? 'win' : o.resultadoUSDT < 0 ? 'loss' : 'tie' }));
    chart.markers = sym ? portfolio.open.concat(portfolio.closed.slice(-60)).filter(t => t.symbol === sym).map(mk).concat(demo) : [];
    chart.render();
  }

  function renderSim() {
    const st = portfolio.stats(), pnl = portfolio.balance + portfolio.open.reduce((s, t) => s + t.stake, 0) - portfolio.start;
    const be = Sim.breakeven(params.payout);
    $('sim-summary').innerHTML =
      `<div class="row"><span>Saldo fictício</span><b>${money(portfolio.balance)}</b></div>` +
      `<div class="row"><span>Resultado</span><b class="${pnl >= 0 ? 'pos' : 'neg'}">${smoney(Math.round(pnl * 100) / 100)}</b></div>` +
      `<div class="row"><span>Operações encerradas</span><b>${st.trades}</b></div>` +
      (isFee() ? `<div class="row"><span>Operações com lucro líquido</span><b>${pct(st.winRate)}</b></div>`
        : `<div class="row"><span>Acerto (ponto de empate ${pct(be)})</span><b>${pct(st.winRate)}</b></div>`) +
      (st.trades < 100 ? '<p class="note" style="margin:6px 0 0">Com menos de 100 operações o acerto ainda oscila demais. Acumule bastante antes de tirar conclusões.</p>' : '') +
      (repaired ? `<p class="note warn-note" style="margin:6px 0 0">${repaired} operação(ões) anulada(s): tinham sido liquidadas com o preço de outro ativo, por um erro já corrigido. O valor foi devolvido.</p>` : '') +
      '<p class="note" style="margin:6px 0 0">Toque numa operação para ver os detalhes.</p>';
    const ready = simReady();
    $('sim-call').textContent = prefs.ponteEnviar && conta.conectada ? '▲ COMPRAR (conta demo)' : isFee() ? '▲ COMPRAR' : '▲ CALL (acima)';
    $('sim-put').textContent = isFee() ? '▼ VENDER' : '▼ PUT (abaixo)';
    $('sim-call').disabled = !ready; $('sim-put').disabled = !ready || params.market === 'spot';
    $('sim-hint').hidden = ready;
    renderTrades();
  }

  function renderTrades() {
    const now = Date.now();
    const row = t => `class="tr click${t.result ? '' : ' open'}" data-id="${t.id}" role="button" tabindex="0" aria-label="Detalhes da operação ${t.id}"`;
    const open = portfolio.open.map(t =>
      `<div ${row(t)}><span>${hhmm(t.t)}</span><span>${sideTxt(t.side, t.mode || 'binary')}</span><span>${pxOf(t, t.entry)} · ${money(t.stake)}</span><span>${t.expiry > now ? mmss(t.expiry - now) : 'liquidando…'}</span></div>`).join('');
    $('sim-open').innerHTML = open ? `<div class="trades"><h4>Em andamento</h4>${open}</div>` : '';
    const closed = portfolio.closed.slice(-8).reverse().map(t => {
      const cls = t.result === 'win' ? 'pos' : t.result === 'loss' ? 'neg' : '';
      const mark = t.result === 'win' ? '✓' : t.result === 'loss' ? '✗' : t.result === 'void' ? '⊘' : '=';
      const res = t.result === 'void' ? 'anulada' : `${mark} ${smoney(t.pnl)}`;
      return `<div ${row(t)}><span>${hhmm(t.t)}</span><span>${sideTxt(t.side, t.mode || 'binary')}</span><span>${pxOf(t, t.entry)} → ${pxOf(t, t.exit)}</span><span class="${cls}">${res}</span></div>`;
    }).join('');
    $('sim-history').innerHTML = closed ? `<div class="trades"><h4>Encerradas</h4>${closed}</div>` : '';
  }

  // Casas decimais pelo ativo da operação (não pelo ativo aberto agora)
  const decOf = t => { const a = t.symbol && Live.asset(t.symbol); return a ? a.dec : decFromPrice(t.entry); };
  const pxOf = (t, v) => num(v, decOf(t));
  const when = ms => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const IV_TXT = { '1m': '1 min', '3m': '3 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hora', '4h': '4 horas' };
  const HOW_TXT = { live: 'preço ao vivo no vencimento', minute: 'abertura do minuto do vencimento, consultada na Binance' };
  let detailId = null;

  function showTradeDetails(id) {
    const t = portfolio.open.concat(portfolio.closed).find(x => x.id === id);
    if (!t) return;
    detailId = id;
    const fee = t.mode === 'fee', now = Date.now(), dir = t.side === 'up' ? 1 : -1;
    const status = !t.result ? ['Em andamento', ''] : t.result === 'win' ? ['Lucro', 'pos'] : t.result === 'loss' ? ['Prejuízo', 'neg'] : t.result === 'void' ? ['Anulada', 'warn'] : ['Empate', ''];
    const mins = t.horizon && t.intervalMs ? Math.round(t.horizon * t.intervalMs / 60000) : null;
    const r = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;
    let body = `<h3>Operação nº ${t.id} · ${sideTxt(t.side, t.mode || 'binary')} <span class="badge ${status[1]}">${status[0]}</span></h3>`;
    body += r('Ativo', t.symbol ? `${Live.label(t.symbol)} (${t.symbol})` : '–');
    body += r('Mercado', fee ? `${t.context && t.context.market === 'futures' ? 'Binance futuros' : 'Binance à vista'} · taxa ${num(t.feePct, 2)}% por lado` : `Opção binária · payout ${t.payoutPct}%`);
    body += r('Tempo gráfico e saída', `${IV_TXT[t.interval] || '–'} · ${t.horizon} candle(s)${mins ? ` (${mins} min)` : ''}`);
    body += r('Origem', t.source === 'alerta' ? 'alerta de sinal validado' : 'entrada manual');
    body += r('Valor', money(t.stake));
    body += r('Entrada', `${pxOf(t, t.entry)} · ${when(t.t)}`);
    body += r('Vencimento', when(t.expiry));
    if (!t.result) {
      const live = state.live && state.live.symbol === t.symbol && state.candles.length ? state.candles[state.candles.length - 1].c : null;
      body += r('Tempo restante', t.expiry > now ? mmss(t.expiry - now) : 'liquidando (consultando o preço do vencimento)');
      if (live) {
        const mv = dir * (live / t.entry - 1);
        const est = fee ? t.stake * (mv - 2 * t.feePct / 100) : (mv > 0 ? t.stake * t.payoutPct / 100 : mv < 0 ? -t.stake : 0);
        body += r('Preço agora', `${pxOf(t, live)} (${pctp(live / t.entry - 1)})`);
        body += r('Resultado se fechasse agora', `<span class="${est >= 0 ? 'pos' : 'neg'}">${smoney(Math.round(est * 100) / 100)}</span>`);
      }
    } else if (t.result === 'void') {
      body += r('Situação', t.voidReason || 'anulada');
    } else {
      const mv = t.exit / t.entry - 1;
      body += r('Saída', `${pxOf(t, t.exit)}`);
      body += r('Como o preço de saída foi obtido', HOW_TXT[t.how] || (t.approx ? 'aproximado (versão antiga)' : '–'));
      body += r('Variação do preço', pctp(mv));
      if (fee) body += r('Taxas pagas (entrada + saída)', money(Math.round(t.stake * 2 * t.feePct) / 100));
      body += r('Resultado', `<span class="${t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : ''}">${smoney(t.pnl)} (${pctp(t.pnl / t.stake)} do valor)</span>`);
    }
    if (t.context) {
      const c = t.context;
      body += `<h4>Na hora da entrada</h4>`;
      if (c.p != null) body += r('Modelo', `▲ ${pct(c.p)} · ▼ ${pct(1 - c.p)}`);
      body += `<p class="note">${c.decision === 'call' || c.decision === 'put' ? 'Havia sinal validado.' : 'Não havia sinal validado' + (c.text ? ': ' + c.text.replace(/^NÃO OPERAR · /, '') : '.')}</p>`;
    }
    $('trade-body').innerHTML = body;
    const canChart = state.live && state.live.symbol === t.symbol && state.candles.length && t.t >= state.candles[0].t;
    $('trade-chart').hidden = !canChart;
    $('trade-sell-now').hidden = true;
    $('trade-dialog').showModal();
  }

  ['sim-open', 'sim-history'].forEach(id => {
    const el = $(id);
    el.addEventListener('click', e => { const r = e.target.closest('[data-id]'); if (r) showTradeDetails(+r.dataset.id); });
    el.addEventListener('keydown', e => { const r = e.target.closest('[data-id]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showTradeDetails(+r.dataset.id); } });
  });
  $('trade-close').addEventListener('click', () => $('trade-dialog').close());
  $('trade-chart').addEventListener('click', () => {
    const t = portfolio.open.concat(portfolio.closed).find(x => x.id === detailId);
    $('trade-dialog').close();
    if (!t) return;
    const c = state.candles; let i = c.length - 1;
    while (i > 0 && c[i].t > t.t) i--;
    chart.view.start = i - chart.view.count * 0.6;
    chart.render();
    $('chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('sim-stake').value = prefs.stake;
  $('sim-auto').checked = !!prefs.auto;
  $('sim-sound').checked = !!prefs.sound;
  $('sim-stake').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) { prefs.stake = v; persist(); renderDecision(); } else e.target.value = prefs.stake;
  });
  $('sim-auto').addEventListener('change', e => { prefs.auto = e.target.checked; persist(); if (prefs.auto) ensureAudio(); });
  $('sim-sound').addEventListener('change', e => { prefs.sound = e.target.checked; persist(); if (prefs.sound) ensureAudio(); });
  const manual = side => () => { ensureAudio(); try { showError(''); enterTrade(side, 'manual'); } catch (err) { showError(err.message); } };
  $('sim-call').addEventListener('click', manual('up'));
  $('sim-put').addEventListener('click', manual('down'));
  $('sim-reset').addEventListener('click', () => {
    if ($('sim-reset').dataset.armed !== '1') {
      $('sim-reset').dataset.armed = '1'; $('sim-reset').textContent = 'Toque de novo para confirmar';
      setTimeout(() => { $('sim-reset').dataset.armed = '0'; $('sim-reset').textContent = 'Zerar simulador'; }, 4000);
      return;
    }
    portfolio.reset(1000); persist(); syncMarkers(); renderSim();
    $('sim-reset').dataset.armed = '0'; $('sim-reset').textContent = 'Zerar simulador';
  });

  // --- Ao vivo (Binance) ---
  let pendingTimer = null, lastRun = 0, countdownTimer = null, liveStatus = 'idle';
  const symSel = $('live-symbol'), intSel = $('live-interval'), liveBtn = $('btn-live'), pill = $('live-status');
  const unavailable = new Set();
  function fillAssets() {
    const keep = symSel.value;
    symSel.innerHTML = '';
    for (const group of ['Cripto', 'Câmbio', 'Ouro']) {
      const items = Live.ASSETS.filter(a => a.group === group && !unavailable.has(a.symbol));
      if (!items.length) continue;
      const og = document.createElement('optgroup');
      og.label = group === 'Câmbio' ? 'Câmbio (referência via Binance)' : group === 'Ouro' ? 'Ouro (referência via Binance)' : group;
      items.forEach(a => og.appendChild(new Option(a.label, a.symbol)));
      symSel.appendChild(og);
    }
    if (keep && Array.from(symSel.options).some(o => o.value === keep)) symSel.value = keep;
  }
  fillAssets();
  // Ao abrir, confere quais pares de câmbio/ouro a Binance ainda lista e esconde os inativos
  if (!window.COLDIGO_NO_LIVE) {
    Live.checkAvailability(Live.ASSETS.filter(a => a.verify).map(a => a.symbol)).then(r => {
      Object.keys(r).forEach(sym => { if (r[sym] === false) unavailable.add(sym); });
      if (unavailable.size) fillAssets();
    });
  }
  function updateAssetNote() {
    const a = state.live && Live.asset(state.live.symbol), el = $('asset-note');
    el.hidden = !(a && a.proxy);
    if (a && a.proxy) el.textContent = `Preço de referência: ${a.symbol} na Binance. Acompanha o ${a.label}, mas não é o mesmo feed da sua corretora e a Binance opera 24h, inclusive no fim de semana, quando o mercado de câmbio real está fechado. Os preços podem divergir um pouco.`;
  }

  function setStatus(kind, msg) {
    liveStatus = kind;
    pill.hidden = kind === 'idle';
    pill.className = 'pill ' + (kind === 'live' ? 'live' : kind === 'error' ? 'error' : 'warn');
    if (kind === 'connecting') pill.textContent = 'conectando…';
    else if (kind === 'loading') pill.textContent = `carregando histórico ${msg}`;
    else if (kind === 'reconnecting') pill.textContent = 'reconectando…';
    else if (kind === 'error') pill.textContent = msg || 'erro';
    else tickCountdown();
    if (kind === 'error') showError(msg);
    renderSim();
  }

  function tickCountdown() {
    if (!state.live || liveStatus !== 'live' || !state.candles.length) return;
    const last = state.candles[state.candles.length - 1];
    pill.textContent = `ao vivo · candle fecha em ${mmss(last.t + state.live.intervalMs - Date.now())}`;
  }

  function tick() { tickCountdown(); settleNow(); renderTrades(); if (conta.conectada) renderConta(); }

  function runLive(closed) {
    clearTimeout(pendingTimer); pendingTimer = null; lastRun = Date.now();
    const n = state.candles.length, H = chart.horizon();
    // se o usuário está acompanhando o candle atual, a janela anda junto com os novos candles
    const following = chart.view.start + chart.view.count - H >= state.liveLen - 1.5;
    if (following) chart.view.start += n - state.liveLen;
    state.liveLen = n;
    try {
      analyze(false);
      if (closed) {
        refreshPrediction(n - 1, true);
        if (++state.closedSince >= 120) runResearch(); // revalida o modelo com dados novos
      }
    } catch (e) { showError(e.message); }
  }

  function onLiveData(candles, info) {
    state.candles = candles;
    state.source = `Binance · ${Live.label(symSel.value)}${(Live.asset(symSel.value) || {}).proxy ? ' (' + symSel.value + ')' : ''} · ${intSel.value} (ao vivo)`;
    settleNow();
    if (info.reset) {
      state.liveLen = candles.length; showError('');
      try { analyze(true); runResearch(); } catch (e) { showError(e.message); }
      renderDuracoes();
      lastRun = Date.now(); syncMarkers(); renderSim(); return;
    }
    // reanalisa no máximo 1x por segundo, e na hora ao fechar um candle (é quando o alerta é avaliado)
    const wait = 1000 - (Date.now() - lastRun);
    if (info.closed) runLive(true);
    else if (wait <= 0) runLive(false);
    else if (!pendingTimer) pendingTimer = setTimeout(() => runLive(false), wait);
  }

  function startLive() {
    stopLive();
    ensureAudio(); lockScreen();
    state.alertLog = []; state.alert = null; state.bannerDismissed = null; state.research = null; state.pred = null;
    state.live = new Live.LiveFeed({ symbol: symSel.value, interval: intSel.value, history: params.history, onData: onLiveData, onStatus: setStatus });
    liveBtn.classList.add('on'); liveBtn.setAttribute('aria-pressed', 'true');
    updateAssetNote();
    countdownTimer = setInterval(tick, 1000);
    state.live.start();
  }

  function stopLive() {
    if (state.live) { state.live.stop(); state.live = null; }
    clearInterval(countdownTimer); clearTimeout(pendingTimer); pendingTimer = null;
    unlockScreen();
    liveBtn.classList.remove('on'); liveBtn.setAttribute('aria-pressed', 'false');
    $('asset-note').hidden = true;
    setStatus('idle');
    syncMarkers();
  }

  liveBtn.addEventListener('click', () => (state.live ? stopLive() : startLive()));
  symSel.addEventListener('change', () => { if (state.live) startLive(); });
  let ivAnterior = intSel.value;
  intSel.addEventListener('change', () => {
    if (state.live) {
      const dur = params.horizon * ivMinOf(ivAnterior), iv = ivMinOf(intSel.value);
      let H = dur / iv;
      if (!(Number.isInteger(H) && H >= 1 && H <= 60)) {
        const d = maisProxima(dur, iv);
        H = d / iv;
        avisoDuracao = `O tempo de ${durTxt(dur)} não cabe em candles de ${durTxt(iv)}; ajustei para ${durTxt(d)}.`;
      }
      params.horizon = H; const inp = $('p-horizon'); if (inp) inp.value = H; persist();
      startLive();
    }
    ivAnterior = intSel.value;
  });
  if (window.COLDIGO_NO_LIVE) $('live-controls').hidden = true;

  // --- Entradas ---
  function demo() {
    const seed = state.candles.length ? Math.floor(Math.random() * 1e6) : 42;
    load(Data.generateDemo({ days: 6, seed }), `Demonstração (dados sintéticos, semente ${seed})`);
  }

  $('btn-demo').addEventListener('click', demo);
  $('file').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { load(Data.parseCSV(await f.text()), f.name); } catch (err) { showError(err.message); }
    e.target.value = '';
  });
  $('btn-paste').addEventListener('click', () => $('paste-dialog').showModal());
  $('paste-dialog').addEventListener('close', () => {
    if ($('paste-dialog').returnValue !== 'ok') return;
    try { load(Data.parseCSV($('paste-text').value), 'Dados colados'); } catch (err) { showError(err.message); }
  });
  $('toggles').addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    chart.show[k] = e.target.checked;
    if (k === 'forecast') chart.resetView();
    chart.render();
  });

  // Arrastar e soltar arquivo
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (!f) return;
    try { load(Data.parseCSV(await f.text()), f.name); } catch (err) { showError(err.message); }
  });

  // --- Conta demo da Binance (via ponte local) ---
  const { PonteCliente } = window.Coldigo;
  const conta = { ponte: null, conectada: false, status: null, saldos: [], ops: [], erro: null, timer: null, saldoEm: 0 };
  const usdt = (v, d = 4) => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), d) + ' USDT');
  const MOTIVO_TXT = { vencimento: 'vendida no vencimento', 'fechada manualmente': 'vendida manualmente', 'vencida com a ponte desligada': 'vendida ao religar a ponte (venceu com ela desligada)' };

  async function conectarPonte() {
    conta.ponte = new PonteCliente.Ponte(prefs.ponteUrl, prefs.ponteCodigo);
    conta.erro = null; renderConta('conectando');
    try {
      const st = await conta.ponte.status();
      conta.status = st;
      if (!st.ok) throw new Error(st.erro || 'a ponte não conseguiu falar com a Binance.');
      conta.conectada = true; conta.saldoEm = 0;
      await atualizarConta();
      clearInterval(conta.timer); conta.timer = setInterval(atualizarConta, 10000);
    } catch (e) { conta.conectada = false; conta.erro = e.message; }
    renderConta(); renderSim();
  }

  function desconectarPonte() {
    clearInterval(conta.timer);
    Object.assign(conta, { conectada: false, status: null, saldos: [], ops: [], erro: null });
    renderConta(); renderSim(); syncMarkers();
  }

  async function atualizarConta() {
    if (!conta.ponte || !conta.conectada) return;
    try {
      conta.ops = (await conta.ponte.operacoes()).operacoes || [];
      if (Date.now() - conta.saldoEm > 30000) { conta.saldos = (await conta.ponte.saldo()).saldos || []; conta.saldoEm = Date.now(); }
      conta.erro = null;
    } catch (e) { conta.erro = e.message; }
    renderConta(); syncMarkers();
  }

  async function enviarParaDemo(source) {
    const d = decisionState();
    const body = {
      symbol: state.live.symbol, valorUSDT: prefs.ponteValor, duracaoMs: params.horizon * state.live.intervalMs, origem: source,
      contexto: { p: state.pred ? state.pred.p : null, decision: d.kind, text: d.text, interval: state.live.interval, horizon: params.horizon }
    };
    $('conta-status').textContent = 'Enviando a ordem à conta demo…';
    try {
      const { operacao } = await conta.ponte.abrir(body);
      conta.ops.push(operacao); conta.saldoEm = 0;
      showError('');
    } catch (e) { showError('Conta demo: ' + e.message); }
    renderConta(); syncMarkers();
  }

  function renderConta(fase) {
    const st = $('conta-status');
    if (fase === 'conectando') { st.className = 'conta-status warn'; st.textContent = 'Conectando à ponte…'; return; }
    if (conta.conectada) {
      const c = conta.status || {};
      st.className = 'conta-status ' + (conta.erro ? 'warn' : 'on');
      st.textContent = conta.erro ? 'Conectada, mas com problema: ' + conta.erro
        : `Conectada · conta DEMO${c.conta && c.conta.podeNegociar === false ? ' · a chave não tem permissão de negociar' : ''} · limite de ${num(c.limitePorOrdemUSDT || 0, 0)} USDT por ordem`;
    } else {
      st.className = 'conta-status ' + (conta.erro ? 'err' : 'off');
      st.textContent = conta.erro ? 'Não conectada: ' + conta.erro : 'Desconectada';
    }
    $('ponte-conectar').hidden = conta.conectada; $('ponte-desconectar').hidden = !conta.conectada;
    $('ponte-opcoes').hidden = !conta.conectada; $('ponte-enviar-wrap').hidden = !conta.conectada;
    $('conta-saldo').innerHTML = !conta.conectada ? '' : '<div class="trades"><h4>Saldo da conta demo</h4>' +
      (conta.saldos.length ? conta.saldos.slice(0, 8).map(b => `<div class="row"><span>${b.moeda}</span><b>${num(b.livre, b.moeda === 'USDT' ? 2 : 6)}${b.travado ? ` (+${num(b.travado, 6)} em ordens)` : ''}</b></div>`).join('') : '<p class="note">Sem saldo.</p>') + '</div>';
    if (!conta.conectada) { $('conta-ops').innerHTML = ''; return; }
    const now = Date.now(), r = PonteCliente.resumo(conta.ops);
    const linhas = conta.ops.slice(-10).reverse().map(o => {
      const cls = o.resultadoUSDT > 0 ? 'pos' : o.resultadoUSDT < 0 ? 'neg' : '';
      const estado = o.estado === 'aberta' ? (o.vencimento > now ? mmss(o.vencimento - now) : 'vendendo…') : o.estado === 'erro' ? 'erro' : '';
      return `<div class="tr click demo" data-demo-id="${o.id}" role="button" tabindex="0" aria-label="Detalhes da operação ${o.id} na conta demo"><span>${o.abertura ? hhmm(o.abertura.t) : '–'}</span><span>${Live.label(o.symbol)}</span><span>${num(o.valorUSDT, 2)} USDT ${estado}</span><span class="${cls}">${o.resultadoUSDT != null ? usdt(o.resultadoUSDT) : ''}</span></div>`;
    }).join('');
    $('conta-ops').innerHTML = `<div class="trades"><h4>Operações na conta demo</h4>${linhas || '<p class="note">Nenhuma ainda. Marque "Enviar minhas entradas" e use COMPRAR, ou deixe a entrada automática nos alertas.</p>'}</div>` +
      (r.fechadas ? `<p class="note" style="margin:6px 0 0">${r.fechadas} encerrada(s): resultado real ${usdt(r.soma)}, ${pct(r.comLucro)} com lucro, ${num(r.taxas, 4)} USDT em taxas. Toque numa operação para ver os detalhes.</p>` : '');
  }

  function showDemoDetails(id) {
    const o = conta.ops.find(x => x.id === id);
    if (!o) return;
    detailId = null;
    const a = o.abertura || {}, f = o.fechamento, dec = (Live.asset(o.symbol) || { dec: 2 }).dec;
    const pr = v => (v == null ? '–' : num(v, dec));
    const taxas = s => [s.feeBase ? `${num(s.feeBase, 8)} ${o.base || ''}` : '', s.feeQuote ? `${num(s.feeQuote, 4)} USDT` : '', ...Object.entries(s.feeOther || {}).map(([k, v]) => `${num(v, 8)} ${k}`)].filter(Boolean).join(' + ') || '0';
    const status = o.estado === 'aberta' ? ['Em andamento', ''] : o.estado === 'erro' ? ['Erro', 'warn'] : o.resultadoUSDT > 0 ? ['Lucro', 'pos'] : o.resultadoUSDT < 0 ? ['Prejuízo', 'neg'] : ['Empate', ''];
    const r = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;
    let body = `<h3>Conta demo nº ${o.id} · ▲ COMPRA <span class="badge ${status[1]}">${status[0]}</span></h3>`;
    body += r('Ativo', `${Live.label(o.symbol)} (${o.symbol})`);
    body += r('Onde', 'conta DEMO da Binance, ordem a mercado');
    body += r('Origem', o.origem === 'alerta' ? 'alerta de sinal validado' : 'entrada manual');
    body += r('Valor enviado', `${num(o.valorUSDT, 2)} USDT`);
    body += `<h4>Compra · ordem nº ${a.orderId != null ? a.orderId : '–'}</h4>`;
    body += r('Executada', `${num(a.qty || 0, 8)} ${o.base || ''} a ${pr(a.avgPrice)} (média)`);
    body += r('Pago', `${num(a.quote || 0, 4)} USDT · ${a.t ? when(a.t) : '–'}`);
    body += r('Taxa da compra', taxas(a));
    body += r('Vencimento', when(o.vencimento));
    if (f) {
      body += `<h4>Venda · ordem nº ${f.orderId != null ? f.orderId : '–'}</h4>`;
      body += r('Executada', `${num(f.qty, 8)} ${o.base || ''} a ${pr(f.avgPrice)} (média)`);
      body += r('Recebido', `${num(f.quote, 4)} USDT · ${when(f.t)}`);
      body += r('Taxa da venda', taxas(f));
      if (f.sobra > 0) body += r('Sobra que não pôde ser vendida', `${num(f.sobra, 8)} ${o.base || ''} (abaixo do passo mínimo do par; fica na conta)`);
      body += r('Como foi vendida', MOTIVO_TXT[o.motivo] || o.motivo || '–');
      body += r('Variação do preço', pctp(f.avgPrice / a.avgPrice - 1));
      body += r('Taxas totais (em USDT)', num(o.taxasUSDT || 0, 4));
      body += r('Resultado real', `<span class="${o.resultadoUSDT > 0 ? 'pos' : o.resultadoUSDT < 0 ? 'neg' : ''}">${usdt(o.resultadoUSDT)} (${pctp(o.resultadoUSDT / a.quote)} do valor)</span>`);
    } else {
      body += r('Tempo restante', o.vencimento > Date.now() ? mmss(o.vencimento - Date.now()) : 'vendendo…');
      const live = state.live && state.live.symbol === o.symbol && state.candles.length ? state.candles[state.candles.length - 1].c : null;
      if (live && a.avgPrice) body += r('Preço agora', `${pr(live)} (${pctp(live / a.avgPrice - 1)} desde a compra, antes das taxas)`);
    }
    if (o.erro) body += r('Último problema', o.erro);
    if (o.contexto) {
      const c = o.contexto;
      body += '<h4>Na hora da entrada</h4>';
      if (c.p != null) body += r('Modelo', `▲ ${pct(c.p)} · ▼ ${pct(1 - c.p)}`);
      body += `<p class="note">${c.decision === 'call' || c.decision === 'put' ? 'Havia sinal validado.' : 'Não havia sinal validado' + (c.text ? ': ' + c.text.replace(/^NÃO OPERAR · /, '') : '.')}</p>`;
    }
    $('trade-body').innerHTML = body;
    $('trade-chart').hidden = true;
    const sell = $('trade-sell-now');
    sell.hidden = o.estado !== 'aberta'; sell.dataset.demoId = o.id; sell.disabled = false;
    $('trade-dialog').showModal();
  }

  $('trade-sell-now').addEventListener('click', async e => {
    const id = +e.target.dataset.demoId;
    e.target.disabled = true;
    try { await conta.ponte.fechar(id); conta.saldoEm = 0; await atualizarConta(); showDemoDetails(id); }
    catch (err) { showError('Conta demo: ' + err.message); e.target.disabled = false; }
  });
  $('conta-ops').addEventListener('click', e => { const r = e.target.closest('[data-demo-id]'); if (r) showDemoDetails(+r.dataset.demoId); });
  $('conta-ops').addEventListener('keydown', e => { const r = e.target.closest('[data-demo-id]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showDemoDetails(+r.dataset.demoId); } });
  $('ponte-url').value = prefs.ponteUrl;
  $('ponte-codigo').value = prefs.ponteCodigo;
  $('ponte-valor').value = prefs.ponteValor;
  $('ponte-enviar').checked = !!prefs.ponteEnviar;
  $('ponte-conectar').addEventListener('click', () => {
    prefs.ponteUrl = $('ponte-url').value.trim() || 'http://127.0.0.1:8787';
    prefs.ponteCodigo = $('ponte-codigo').value.trim();
    persist(); conectarPonte();
  });
  $('ponte-desconectar').addEventListener('click', desconectarPonte);
  $('ponte-valor').addEventListener('change', e => { const v = parseFloat(e.target.value); if (v > 0) { prefs.ponteValor = v; persist(); } else e.target.value = prefs.ponteValor; });
  $('ponte-enviar').addEventListener('change', e => { prefs.ponteEnviar = e.target.checked; persist(); renderSim(); });

  // --- Versão e aviso de atualização ---
  $('app-version').textContent = window.COLDIGO_VERSION ? 'versão ' + window.COLDIGO_VERSION : '';
  async function checkUpdate() {
    if (location.protocol === 'file:' || window.COLDIGO_NO_LIVE || !window.COLDIGO_VERSION) return;
    try {
      const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const { version } = await res.json();
      $('update-banner').hidden = !version || version === window.COLDIGO_VERSION;
    } catch (_) { /* sem rede: tenta depois */ }
  }
  $('btn-update').addEventListener('click', () => location.reload());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
  setInterval(checkUpdate, 5 * 60000);
  checkUpdate();

  renderParams();
  renderSim();
  demo();
  settleNow();
  if (prefs.ponteCodigo && !window.COLDIGO_NO_LIVE) conectarPonte(); // reconecta à ponte ao abrir
  window.__coldigo = { state, chart, load, portfolio: () => portfolio, enterTrade, prefs, alertCfg };
})();
