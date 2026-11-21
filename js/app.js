(function () {
  'use strict';
  const { Forecast, Data, Chart, Live, Sim, Model, Indicators } = window.Coldigo;
  const $ = id => document.getElementById(id);

  const params = { horizon: 12, simulations: 2000, window: 300, driftFactor: 0.1, tpAtr: 1.5, slAtr: 1, payout: 85, history: 6000, trainN: 2500 };
  const alertCfg = Object.assign({}, Sim.DEFAULT_CFG);
  const prefs = { stake: 10, auto: false, sound: true };
  const state = { candles: [], analysis: null, source: '', live: null, liveLen: 0, alert: null, alertLog: [], bannerDismissed: null, research: null, pred: null, closedSince: 0 };
  const chart = new Chart($('chart'), $('tooltip'));

  const PART_LABELS = { trend: 'Tendência', vwap: 'VWAP', momentum: 'Momentum', rsi: 'RSI', bollinger: 'Bollinger' };
  const BIAS_TEXT = { up: 'ALTA', down: 'BAIXA', neutral: 'NEUTRO' };
  const pct = v => (v == null ? '–' : (v * 100).toFixed(1).replace('.', ',') + '%');
  const num = (v, d = 2) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sgn = v => (v >= 0 ? '+' : '') + num(v);
  const money = v => (v < 0 ? '−' : '') + 'R$ ' + num(Math.abs(v));
  const smoney = v => (v > 0 ? '+' : v < 0 ? '−' : '') + 'R$ ' + num(Math.abs(v));
  const z2 = v => String(v).padStart(2, '0');
  const hhmm = t => { const d = new Date(t); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${z2(s % 60)}`; };
  const SIDE_TXT = { up: '▲ CALL', down: '▼ PUT' };

  // --- Persistência local (tolerante a falhas) ---
  const KEY = 'coldigo.sim.v1';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (_) { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* ignora */ } }
  };
  const saved = store.get() || {};
  let portfolio = new Sim.Portfolio(saved.portfolio);
  let tests = Array.isArray(saved.tests) ? saved.tests : [];
  Object.assign(prefs, saved.prefs);
  Object.assign(alertCfg, saved.alertCfg);
  Object.assign(params, saved.params);
  function persist() { store.set({ portfolio, prefs, alertCfg, tests, params: { horizon: params.horizon, payout: params.payout, history: params.history, trainN: params.trainN } }); }

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
    } catch (e) {
      showError(e.message);
    }
  }

  function analyze(resetView) {
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
    $('meta').innerHTML = `<b>${state.source}</b> · ${c.length} candles de ${stepMin} min · ${d(first)} → ${d(last)} · último <b>${num(a.last)}</b> · ATR(14) <b>${num(a.atr)}</b>`;
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

    const lvl = (arr, name) => arr.length ? arr.map((l, i) => `<div class="row"><span>${name}${i + 1} · ${l.touches} toque(s)</span><b>${num(l.price)}</b></div>`).join('') : `<div class="note">Sem ${name === 'R' ? 'resistências' : 'suportes'} identificados.</div>`;

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
        <div class="row"><span>Mediana no fim do horizonte</span><b>${num(last.p50)} (${sgn((last.p50 - f.entry) / f.entry * 100)}%)</b></div>
        <div class="row"><span>Faixa 50% provável</span><b>${num(last.p25)} – ${num(last.p75)}</b></div>
        <div class="row"><span>Faixa 80% provável</span><b>${num(last.p10)} – ${num(last.p90)}</b></div>
        <div class="row"><span>Probabilidade de fechar acima</span><b>${pct(f.probUp)}</b></div>
        <div class="row"><span>Máxima esperada (mediana)</span><b>${num(f.expectedHigh.p50)}</b></div>
        <div class="row"><span>Mínima esperada (mediana)</span><b>${num(f.expectedLow.p50)}</b></div>
        <div class="legend" style="margin-top:6px"><span><i style="background:var(--c-forecast)"></i>cone no gráfico: 50% e 80%</span></div>
      </div>

      <div class="card">
        <h3>${sideName} · alvo ${params.tpAtr}× ATR / stop ${params.slAtr}× ATR</h3>
        <div class="row"><span>Entrada</span><b>${num(f.entry)}</b></div>
        <div class="row"><span>Alvo</span><b class="pos">${num(f.entry + dirTp * f.tpDistance)}</b></div>
        <div class="row"><span>Stop</span><b class="neg">${num(f.entry - dirTp * f.slDistance)}</b></div>
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
        ${a.pivots ? `<div class="row"><span>Pivô (PP) pregão anterior</span><b>${num(a.pivots.PP)}</b></div>` : ''}
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
          ${row('p-horizon', 'Expiração (candles)', 'min="3" max="60"', params.horizon)}
          ${row('p-payout', 'Payout (%)', 'min="50" max="100" step="1"', params.payout)}
        </div>
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
    bind('p-horizon', v => { params.horizon = Math.max(3, Math.min(60, Math.round(v))); }, reanalyze(true, true));
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
    prob: ['Probabilidade atual acima do limiar de entrada', c => `${pct(c.value)} ≥ ${pct(c.need)}`]
  };
  const REASONS = {
    sample: c => `poucos sinais independentes validados fora da amostra (${c.value} de ${c.need} necessários)`,
    edge: c => `sem vantagem comprovada fora da amostra (limite inferior ${pct(c.value)} não passa do empate ${pct(c.need)})`,
    skill: () => 'o modelo não supera o acaso fora da amostra',
    prob: c => `probabilidade atual (${pct(c.value)}) abaixo do limiar de entrada (${pct(c.need)})`
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
    const key = `${state.live ? state.live.symbol + '|' + state.live.interval : state.source}|H${params.horizon}|M${alertCfg.marginPct}`;
    const k = countTests(key), z = Model.zForTests(k);
    state.research = { status: 'running', key, k, z, n: state.candles.length };
    state.closedSince = 0;
    renderDecision();
    setTimeout(() => {
      try {
        const t0 = performance.now();
        const wf = Model.walkForward(state.candles, Indicators.computeAll(state.candles), params.horizon, { trainN: params.trainN });
        if (wf.insufficient) {
          state.research = { status: 'insufficient', key, k, z, n: state.candles.length, needed: wf.needed };
        } else {
          registerTest(key);
          const ev = Model.evaluate(wf.preds, params.horizon, params.payout, { marginPct: alertCfg.marginPct, minN: alertCfg.minN, z });
          state.research = { status: 'done', key, k, z, n: state.candles.length, ev, fits: wf.fits, hasTakerFlow: wf.hasTakerFlow, ms: Math.round(performance.now() - t0), at: Date.now() };
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
    const res = state.pred ? Sim.evaluateAlert({ p: state.pred.p, research: r.ev }, alertCfg, params.payout) : null;
    state.alert = res && { res, candleT: c[m].t };
    if (notify && res && res.fire) fireAlert(res, c[m]);
    renderDecision();
  }

  function fireAlert(res, last) {
    const label = state.live ? state.live.symbol.replace('USDT', '/USDT') + ' · ' + state.live.interval : state.source;
    const entry = { t: last.t + (state.live ? state.live.intervalMs : 0), side: res.side, label, auto: false };
    if (prefs.auto && state.live && portfolio.open.length === 0) {
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
    if (r.status === 'error') return { kind: 'none', text: 'NÃO OPERAR · erro ao validar o modelo: ' + r.message };
    if (!al) return { kind: 'wait', text: 'Aguardando o candle fechar para prever.' };
    if (al.res.fire) return { kind: al.res.side === 'down' ? 'put' : 'call', text: null };
    const failed = al.res.checks.find(c => !c.ok);
    return { kind: 'none', text: `NÃO OPERAR · ${failed ? REASONS[failed.key](failed) : 'sem sinal'}` };
  }

  function renderDecision() { renderBanner(); renderDecisionCard(); }

  function renderBanner() {
    const el = $('alert-banner'), d = decisionState(), al = state.alert;
    if (d.kind === 'call' || d.kind === 'put') {
      if (state.bannerDismissed === al.candleT) { el.hidden = true; return; }
      const { res } = al, mins = Math.round(params.horizon * (state.analysis.stepMs / 60000));
      el.className = 'alert-banner ' + (d.kind === 'put' ? 'put' : '');
      el.innerHTML = `<span class="grow"><b>SINAL VALIDADO · ${SIDE_TXT[res.side]}</b> · probabilidade ${pct(res.pDir)} · expiração em ${params.horizon} candles (~${mins} min)</span>` +
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
      const ev = r.ev, star = ev.star;
      const pos = Math.min(100, Math.max(0, (pUp - 0.4) / 0.2 * 100));
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
    const log = state.alertLog.length
      ? '<div class="log"><b>Últimos alertas</b>' + state.alertLog.map(l => `<div>${hhmm(l.t)} · ${SIDE_TXT[l.side]} · ${l.label}${l.auto ? ' · entrada simulada' : ''}</div>`).join('') + '</div>' : '';
    const head = d.kind === 'call' || d.kind === 'put' ? `${SIDE_TXT[al.res.side]} · sinal validado`
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

  // --- Simulador ---
  function simReady() { return !!state.live && !!state.analysis && state.candles.length > 0; }

  function enterTrade(side, source) {
    if (!simReady()) throw new Error('Ative o modo Ao vivo para operar no simulador.');
    const last = state.candles[state.candles.length - 1];
    portfolio.openTrade({
      side, price: last.c, t: Date.now(), stake: prefs.stake, payoutPct: params.payout, horizon: params.horizon,
      intervalMs: state.live.intervalMs, symbol: state.live.symbol, source
    });
    persist(); syncMarkers(); renderSim();
  }

  function settleNow() {
    if (!portfolio.open.length || !state.candles.length) return;
    const done = portfolio.settle(state.candles, Date.now());
    if (done.length) { persist(); syncMarkers(); renderSim(); }
  }

  function syncMarkers() {
    const sym = state.live && state.live.symbol;
    const mk = t => ({ t: t.t, price: t.entry, side: t.side, result: t.result || 'open' });
    chart.markers = sym ? portfolio.open.concat(portfolio.closed.slice(-60)).filter(t => t.symbol === sym).map(mk) : [];
    chart.render();
  }

  function renderSim() {
    const st = portfolio.stats(), pnl = portfolio.balance + portfolio.open.reduce((s, t) => s + t.stake, 0) - portfolio.start;
    const be = Sim.breakeven(params.payout);
    $('sim-summary').innerHTML =
      `<div class="row"><span>Saldo fictício</span><b>${money(portfolio.balance)}</b></div>` +
      `<div class="row"><span>Resultado</span><b class="${pnl >= 0 ? 'pos' : 'neg'}">${smoney(Math.round(pnl * 100) / 100)}</b></div>` +
      `<div class="row"><span>Operações encerradas</span><b>${st.trades}</b></div>` +
      `<div class="row"><span>Acerto (ponto de empate ${pct(be)})</span><b>${pct(st.winRate)}</b></div>` +
      (st.trades < 100 ? '<p class="note" style="margin:6px 0 0">Com menos de 100 operações o acerto ainda oscila demais. Acumule bastante antes de tirar conclusões.</p>' : '');
    const ready = simReady();
    $('sim-call').disabled = !ready; $('sim-put').disabled = !ready;
    $('sim-hint').hidden = ready;
    renderTrades();
  }

  function renderTrades() {
    const now = Date.now();
    const open = portfolio.open.map(t =>
      `<div class="tr open"><span>${hhmm(t.t)}</span><span>${SIDE_TXT[t.side]}</span><span>${num(t.entry)} · ${money(t.stake)}</span><span>${mmss(t.expiry - now)}</span></div>`).join('');
    $('sim-open').innerHTML = open ? `<div class="trades"><h4>Em andamento</h4>${open}</div>` : '';
    const closed = portfolio.closed.slice(-8).reverse().map(t => {
      const cls = t.result === 'win' ? 'pos' : t.result === 'loss' ? 'neg' : '';
      const mark = t.result === 'win' ? '✓' : t.result === 'loss' ? '✗' : '=';
      return `<div class="tr"><span>${hhmm(t.t)}</span><span>${SIDE_TXT[t.side]}</span><span>${num(t.entry)} → ${num(t.exit)}${t.approx ? ' (aprox.)' : ''}</span><span class="${cls}">${mark} ${smoney(t.pnl)}</span></div>`;
    }).join('');
    $('sim-history').innerHTML = closed ? `<div class="trades"><h4>Encerradas</h4>${closed}</div>` : '';
  }

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
  Live.SYMBOLS.forEach(sy => symSel.add(new Option(sy.replace('USDT', '/USDT'), sy)));

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

  function tick() { tickCountdown(); settleNow(); renderTrades(); }

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
    state.source = `Binance · ${symSel.value.replace('USDT', '/USDT')} · ${intSel.value} (ao vivo)`;
    settleNow();
    if (info.reset) {
      state.liveLen = candles.length; showError('');
      try { analyze(true); runResearch(); } catch (e) { showError(e.message); }
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
    countdownTimer = setInterval(tick, 1000);
    state.live.start();
  }

  function stopLive() {
    if (state.live) { state.live.stop(); state.live = null; }
    clearInterval(countdownTimer); clearTimeout(pendingTimer); pendingTimer = null;
    unlockScreen();
    liveBtn.classList.remove('on'); liveBtn.setAttribute('aria-pressed', 'false');
    setStatus('idle');
    syncMarkers();
  }

  liveBtn.addEventListener('click', () => (state.live ? stopLive() : startLive()));
  [symSel, intSel].forEach(el => el.addEventListener('change', () => { if (state.live) startLive(); }));
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

  renderParams();
  renderSim();
  demo();
  window.__coldigo = { state, chart, load, portfolio: () => portfolio, enterTrade, prefs, alertCfg };
})();
