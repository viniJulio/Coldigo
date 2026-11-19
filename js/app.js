(function () {
  'use strict';
  const { Forecast, Data, Chart } = window.Coldigo;
  const $ = id => document.getElementById(id);

  const params = { horizon: 12, simulations: 2000, window: 300, driftFactor: 0.1, tpAtr: 1.5, slAtr: 1 };
  const state = { candles: [], analysis: null, source: '' };
  const chart = new Chart($('chart'), $('tooltip'));

  const PART_LABELS = { trend: 'Tendência', vwap: 'VWAP', momentum: 'Momentum', rsi: 'RSI', bollinger: 'Bollinger' };
  const BIAS_TEXT = { up: 'ALTA', down: 'BAIXA', neutral: 'NEUTRO' };
  const pct = v => (v * 100).toFixed(1).replace('.', ',') + '%';
  const num = (v, d = 2) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sgn = v => (v >= 0 ? '+' : '') + num(v);

  function showError(msg) {
    const el = $('error');
    el.hidden = !msg; el.textContent = msg || '';
  }

  function load(candles, source) {
    try {
      state.candles = candles; state.source = source;
      showError('');
      analyze(true);
    } catch (e) {
      showError(e.message);
    }
  }

  function analyze(resetView) {
    state.analysis = Forecast.analyze(state.candles, params);
    chart.setData(state.candles, state.analysis, resetView);
    renderMeta();
    renderSide();
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

  function renderSide() {
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

    $('side').innerHTML = `
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
      </div>

      <div class="card">
        <h3>Parâmetros</h3>
        <div class="params">
          <label for="p-horizon">Horizonte (candles)</label><input id="p-horizon" type="number" min="3" max="60" value="${params.horizon}">
          <label for="p-tp">Alvo (× ATR)</label><input id="p-tp" type="number" min="0.2" max="10" step="0.1" value="${params.tpAtr}">
          <label for="p-sl">Stop (× ATR)</label><input id="p-sl" type="number" min="0.2" max="10" step="0.1" value="${params.slAtr}">
          <label for="p-win">Janela de volatilidade</label><input id="p-win" type="number" min="30" max="2000" step="10" value="${params.window}">
          <label for="p-drift">Peso do viés (drift)</label><input id="p-drift" type="number" min="0" max="1" step="0.05" value="${params.driftFactor}">
          <label for="p-sims">Simulações</label><input id="p-sims" type="number" min="200" max="20000" step="200" value="${params.simulations}">
        </div>
        <p class="note" style="margin-top:8px">${f.simulations} trajetórias por bootstrap dos candles recentes (σ por candle ${num(f.sigma * 100, 3)}%). Se alvo e stop caírem no mesmo candle, conta-se o stop.</p>
      </div>

      <div class="disclaimer">Estimativa estatística, não recomendação de investimento nem previsão garantida. Day trade envolve risco de perda; custos, slippage e liquidez não estão incluídos. ${state.source.startsWith('Demonstração') ? '<b>Dados de demonstração são sintéticos.</b>' : ''}</div>`;

    const bind = (id, key, parse) => $(id).addEventListener('change', e => {
      const v = parse(e.target.value);
      if (!Number.isFinite(v)) return;
      params[key] = v;
      try { showError(''); analyze(key === 'horizon'); } catch (err) { showError(err.message); }
    });
    bind('p-horizon', 'horizon', v => Math.max(3, Math.min(60, parseInt(v, 10))));
    bind('p-tp', 'tpAtr', parseFloat); bind('p-sl', 'slAtr', parseFloat);
    bind('p-win', 'window', v => parseInt(v, 10)); bind('p-drift', 'driftFactor', parseFloat);
    bind('p-sims', 'simulations', v => Math.max(200, Math.min(20000, parseInt(v, 10))));
  }

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

  demo();
  window.__coldigo = { state, chart, load };
})();
