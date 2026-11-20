(function () {
  'use strict';
  const { Forecast, Data, Chart, Live, Sim } = window.Coldigo;
  const $ = id => document.getElementById(id);

  const params = { horizon: 12, simulations: 2000, window: 300, driftFactor: 0.1, tpAtr: 1.5, slAtr: 1, payout: 85 };
  const alertCfg = Object.assign({}, Sim.DEFAULT_CFG);
  const prefs = { stake: 10, auto: false, sound: true };
  const state = { candles: [], analysis: null, source: '', live: null, liveLen: 0, alert: null, alertLog: [], bannerDismissed: null };
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
  Object.assign(prefs, saved.prefs);
  Object.assign(alertCfg, saved.alertCfg);
  function persist() { store.set({ portfolio, prefs, alertCfg }); }

  function showError(msg) {
    const el = $('error');
    el.hidden = !msg; el.textContent = msg || '';
  }

  function load(candles, source) {
    stopLive();
    try {
      state.candles = candles; state.source = source; state.liveLen = candles.length;
      showError('');
      analyze(true, 'silent');
    } catch (e) {
      showError(e.message);
    }
  }

  // alertMode: 'none' (tick), 'silent' (recalcula sem avisar), 'notify' (fechamento de candle ao vivo)
  function analyze(resetView, alertMode) {
    state.analysis = Forecast.analyze(state.candles, params);
    chart.setData(state.candles, state.analysis, resetView);
    renderMeta();
    renderMain();
    if (alertMode === 'silent') refreshAlert(false);
    else if (alertMode === 'notify') refreshAlert(true);
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

  function binaryCard(a) {
    const f = a.forecast, bt = a.backtest;
    const payout = params.payout / 100, be = 1 / (1 + payout);
    const mins = Math.round(f.horizon * a.stepMs / 60000);
    const head = `<div class="card"><h3>Opção binária · expiração em ${f.horizon} candles (~${mins} min)</h3>`;
    const rowBE = `<div class="row"><span>Ponto de empate (payout ${params.payout}%)</span><b>${pct(be)}</b></div>`;
    if (a.bias === 'neutral') {
      return head + rowBE + '<div class="verdict mid">Viés neutro: não há sinal para esta expiração.</div></div>';
    }
    const dirName = a.bias === 'up' ? 'ACIMA (CALL)' : 'ABAIXO (PUT)';
    const modelP = a.bias === 'up' ? f.probUp : 1 - f.probUp;
    const row = bt.rows.filter(r => r.threshold <= Math.abs(a.score)).pop();
    let body = `<div class="row"><span>Direção do sinal</span><b>${dirName}</b></div>${rowBE}` +
      `<div class="row"><span>Probabilidade do modelo</span><b>${pct(modelP)}</b></div>`;
    let verdict;
    if (!row || row.signals === 0) {
      verdict = ['mid', 'Poucos sinais nesta força de score no histórico carregado.'];
    } else {
      body += `<div class="row"><span>Acerto histórico (score ≥ ${num(row.threshold)})</span><b>${pct(row.hitRate)}</b></div>` +
        `<div class="row"><span>Limite inferior (95%)</span><b>${pct(row.hitLow)}</b></div>` +
        `<div class="row"><span>Amostra</span><b>${row.signals} sinais (~${row.effectiveN} independentes)</b></div>`;
      if (row.effectiveN < 30) verdict = ['mid', 'Amostra pequena: carregue mais histórico antes de confiar neste número.'];
      else if (row.hitLow > be) verdict = ['good', 'No histórico, o acerto superou o ponto de empate com margem estatística. Não garante o futuro.'];
      else if (row.hitRate > be) verdict = ['mid', 'O acerto passou do ponto de empate, mas a margem de erro ainda inclui prejuízo. Vantagem não comprovada.'];
      else verdict = ['bad', 'No histórico, o acerto ficou abaixo do ponto de empate. Neste ativo e tempo gráfico o sinal perde dinheiro.'];
    }
    return head + body + `<div class="verdict ${verdict[0]}">${verdict[1]}</div>` +
      '<p class="note" style="margin:8px 0 0">A "probabilidade do modelo" vem da simulação e do viés, sem validação. O que vale é o acerto histórico e seu limite inferior.</p></div>';
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
        <h3>Viés para os próximos ${f.horizon} candles (~${horizonMin} min)</h3>
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

      ${binaryCard(a)}

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
        <h3>Backtest do sinal (horizonte ${f.horizon})</h3>
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
    $('sec-params').innerHTML = `
      <div class="card">
        <h3>Parâmetros</h3>
        <div class="params">
          <label for="p-horizon">Horizonte / expiração (candles)</label><input id="p-horizon" type="number" min="3" max="60" value="${params.horizon}">
          <label for="p-payout">Payout (%)</label><input id="p-payout" type="number" min="50" max="100" step="1" value="${params.payout}">
          <label for="p-tp">Alvo (× ATR)</label><input id="p-tp" type="number" min="0.2" max="10" step="0.1" value="${params.tpAtr}">
          <label for="p-sl">Stop (× ATR)</label><input id="p-sl" type="number" min="0.2" max="10" step="0.1" value="${params.slAtr}">
          <label for="p-win">Janela de volatilidade</label><input id="p-win" type="number" min="30" max="2000" step="10" value="${params.window}">
          <label for="p-drift">Peso do viés (drift)</label><input id="p-drift" type="number" min="0" max="1" step="0.05" value="${params.driftFactor}">
          <label for="p-sims">Simulações</label><input id="p-sims" type="number" min="200" max="20000" step="200" value="${params.simulations}">
        </div>
        <p class="note" id="p-note" style="margin-top:8px"></p>
      </div>

      <div class="card">
        <h3>Critérios do alerta de sinal forte</h3>
        <div class="params">
          <label for="a-score">Força mínima do score</label><input id="a-score" type="number" min="0.1" max="1" step="0.05" value="${alertCfg.minScore}">
          <label for="a-model">Prob. mínima do modelo (%)</label><input id="a-model" type="number" min="50" max="95" step="1" value="${Math.round(alertCfg.minModelP * 100)}">
          <label for="a-effn">Amostra independente mínima</label><input id="a-effn" type="number" min="1" max="500" step="1" value="${alertCfg.minEffN}">
          <label for="a-margin">Margem sobre o empate (p.p.)</label><input id="a-margin" type="number" min="-20" max="30" step="0.5" value="${alertCfg.margin}">
        </div>
        <p class="note" style="margin-top:8px">Quanto mais rígidos os critérios, menos alertas. Afrouxar para ver mais sinais aumenta a chance de falsos alertas.</p>
      </div>`;

    const bind = (id, apply, rerun) => $(id).addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      apply(v);
      persist();
      try { showError(''); rerun(); } catch (err) { showError(err.message); }
    });
    const reanalyze = reset => () => { if (state.analysis) analyze(reset, 'silent'); };
    const realert = () => { if (state.analysis) refreshAlert(false); };
    bind('p-horizon', v => { params.horizon = Math.max(3, Math.min(60, Math.round(v))); }, reanalyze(true));
    bind('p-payout', v => { params.payout = Math.max(50, Math.min(100, v)); }, reanalyze(false));
    bind('p-tp', v => { params.tpAtr = v; }, reanalyze(false));
    bind('p-sl', v => { params.slAtr = v; }, reanalyze(false));
    bind('p-win', v => { params.window = Math.round(v); }, reanalyze(false));
    bind('p-drift', v => { params.driftFactor = v; }, reanalyze(false));
    bind('p-sims', v => { params.simulations = Math.max(200, Math.min(20000, Math.round(v))); }, reanalyze(false));
    bind('a-score', v => { alertCfg.minScore = Math.max(0.1, Math.min(1, v)); }, realert);
    bind('a-model', v => { alertCfg.minModelP = Math.max(50, Math.min(95, v)) / 100; }, realert);
    bind('a-effn', v => { alertCfg.minEffN = Math.max(1, Math.round(v)); }, realert);
    bind('a-margin', v => { alertCfg.margin = v; }, realert);
  }

  // --- Alerta de sinal forte ---
  const CHECK_LABELS = {
    score: ['Força do sinal (|score|)', (v, n) => `${num(v)} ≥ ${num(n)}`],
    model: ['Probabilidade do modelo', (v, n) => `${pct(v)} ≥ ${pct(n)}`],
    sample: ['Amostra histórica independente', (v, n) => `${v} ≥ ${n}`],
    edge: ['Acerto histórico (limite inferior 95%) acima do empate', (v, n) => `${pct(v)} > ${pct(n)}`]
  };

  function refreshAlert(notify) {
    const a = state.analysis;
    if (!a) return;
    const res = Sim.evaluateAlert(state.candles, a, alertCfg, params.payout);
    const hist = Sim.simulateHistory(state.candles, a.ind, params.horizon, alertCfg, params.payout, prefs.stake);
    const last = state.candles[state.candles.length - 1];
    state.alert = { res, hist, candleT: last.t, price: last.c };
    if (notify && res.fire) fireAlert(res, last);
    renderAlertCard();
    renderBanner();
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

  function renderAlertCard() {
    const al = state.alert;
    if (!al) { $('sec-alert').innerHTML = ''; return; }
    const { res, hist } = al, st = hist.stats;
    const checks = res.checks.map(c => {
      const [label, fmt] = CHECK_LABELS[c.key];
      const val = c.value == null ? '–' : fmt(c.value, c.need);
      return `<li><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span><span>${label}</span><span class="val">${val}</span></li>`;
    }).join('');
    const histTxt = st.trades === 0
      ? 'Nenhuma operação teria sido feita com esta regra nos candles carregados.'
      : `Seguindo esta regra nos candles carregados: ${st.trades} operações, acerto ${pct(st.winRate)}, resultado ${smoney(st.pnl)} (valor ${money(prefs.stake)}), maior queda ${money(st.maxDrawdown)}.` +
        (st.trades < 30 ? ' Poucas operações: este resultado não prova nada.' : '');
    const log = state.alertLog.length
      ? '<div class="log"><b>Últimos alertas</b>' + state.alertLog.map(l => `<div>${hhmm(l.t)} · ${SIDE_TXT[l.side]} · ${l.label}${l.auto ? ' · entrada simulada' : ''}</div>`).join('') + '</div>' : '';
    $('sec-alert').innerHTML = `
      <div class="card alert-card ${res.fire ? 'firing' : ''}">
        <h3>Alerta de sinal forte</h3>
        <div class="alert-state ${res.fire ? 'on' : 'off'}">${res.fire ? `${SIDE_TXT[res.side]} · todos os critérios atendidos` : 'Sem sinal forte agora'}</div>
        <ul class="checks">${checks}</ul>
        <p class="note" style="margin:8px 0 0">Avaliado ${state.live ? 'no fechamento do candle, às ' + hhmm(al.candleT + state.live.intervalMs) : 'no último candle carregado'}. O alerta só dispara quando <b>todos</b> os critérios passam, e mesmo assim cada operação pode perder.</p>
        <p class="note" style="margin:6px 0 0">${histTxt}</p>
        ${log}
      </div>`;
  }

  function renderBanner() {
    const el = $('alert-banner'), al = state.alert;
    if (!al || !al.res.fire || state.bannerDismissed === al.candleT) { el.hidden = true; return; }
    const { res } = al, mins = Math.round(res.horizon * (state.analysis.stepMs / 60000));
    el.className = 'alert-banner ' + (res.side === 'down' ? 'put' : '');
    el.hidden = false;
    el.innerHTML = `<span class="grow"><b>SINAL FORTE · ${SIDE_TXT[res.side]}</b> · expiração em ${res.horizon} candles (~${mins} min) · avaliado às ${hhmm(al.candleT + (state.live ? state.live.intervalMs : 0))}</span>` +
      (state.live ? `<button class="btn small primary" data-act="enter" data-side="${res.side}">Simular entrada</button>` : '') +
      '<button class="btn small" data-act="dismiss">Dispensar</button>';
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
    if (Number.isFinite(v) && v > 0) { prefs.stake = v; persist(); if (state.analysis) refreshAlert(false); } else e.target.value = prefs.stake;
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
    try { analyze(false, closed ? 'notify' : 'none'); } catch (e) { showError(e.message); }
  }

  function onLiveData(candles, info) {
    state.candles = candles;
    state.source = `Binance · ${symSel.value.replace('USDT', '/USDT')} · ${intSel.value} (ao vivo)`;
    settleNow();
    if (info.reset) {
      state.liveLen = candles.length; showError('');
      try { analyze(true, 'silent'); } catch (e) { showError(e.message); }
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
    state.alertLog = []; state.alert = null; state.bannerDismissed = null;
    state.live = new Live.LiveFeed({ symbol: symSel.value, interval: intSel.value, onData: onLiveData, onStatus: setStatus });
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
