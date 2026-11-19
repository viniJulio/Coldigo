/* Gráfico de candles em canvas: painel de preço (+ overlays e cone de projeção), volume e RSI.
 * Roda de scroll = zoom, arrastar = deslocar, duplo clique = reiniciar visão. */
(function (root) {
  'use strict';

  const AXIS_W = 74, TIME_H = 24, GAP = 6;

  class Chart {
    constructor(canvas, tooltipEl) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tooltip = tooltipEl;
      this.candles = []; this.an = null;
      this.show = { vwap: true, ema: true, bb: false, levels: true, forecast: true, volume: true, rsi: true, targets: true };
      this.view = { start: 0, count: 100 };
      this.mouse = null; this.drag = null;
      this._bind();
      new ResizeObserver(() => this.render()).observe(canvas.parentElement);
    }

    setData(candles, analysis, resetView = true) {
      this.candles = candles; this.an = analysis;
      if (resetView) this.resetView();
      this.render();
    }

    horizon() { return this.an && this.show.forecast ? this.an.forecast.horizon : 0; }

    resetView() {
      const H = this.horizon();
      const count = Math.min(this.candles.length, 110) + H;
      this.view = { start: this.candles.length - (count - H), count };
    }

    _theme() {
      const cs = getComputedStyle(document.documentElement);
      const g = n => cs.getPropertyValue(n).trim();
      return {
        bg: g('--chart-bg'), grid: g('--chart-grid'), text: g('--chart-text'), up: g('--up'), down: g('--down'),
        vwap: g('--c-vwap'), ema9: g('--c-ema9'), ema21: g('--c-ema21'), bb: g('--c-bb'),
        fc: g('--c-forecast'), sup: g('--up'), res: g('--down'), rsi: g('--c-rsi'), cross: g('--chart-cross')
      };
    }

    _layout(w, h) {
      const plotW = w - AXIS_W;
      const avail = h - TIME_H - GAP * 2;
      const volH = this.show.volume ? Math.round(avail * 0.14) : 0;
      const rsiH = this.show.rsi ? Math.round(avail * 0.17) : 0;
      const priceH = avail - volH - rsiH;
      const price = { x: 0, y: 0, w: plotW, h: priceH };
      const vol = { x: 0, y: priceH + GAP, w: plotW, h: volH };
      const rsi = { x: 0, y: priceH + GAP + volH + (volH ? GAP : 0), w: plotW, h: rsiH };
      return { w, h, plotW, price, vol, rsi, timeY: h - TIME_H };
    }

    _clampView() {
      const n = this.candles.length, H = this.horizon();
      this.view.count = Math.max(15, Math.min(this.view.count, n + H + 10));
      const maxStart = n + H - this.view.count * 0.35;
      const minStart = -this.view.count * 0.5;
      this.view.start = Math.max(minStart, Math.min(this.view.start, maxStart));
    }

    render() {
      const c = this.canvas, parent = c.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth, h = parent.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.style.width = w + 'px'; c.style.height = h + 'px';
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const th = this._theme();
      ctx.fillStyle = th.bg; ctx.fillRect(0, 0, w, h);
      if (!this.candles.length) return;

      this._clampView();
      const L = this._layout(w, h);
      this.L = L;
      const n = this.candles.length, H = this.horizon();
      const { start, count } = this.view;
      const barW = L.plotW / count;
      this.barW = barW;
      const X = i => (i - start + 0.5) * barW;
      this.X = X;
      const i0 = Math.max(0, Math.floor(start)), i1 = Math.min(n - 1, Math.ceil(start + count));

      // Escala de preço
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) { lo = Math.min(lo, this.candles[i].l); hi = Math.max(hi, this.candles[i].h); }
      if (H && this.an) {
        for (const b of this.an.forecast.bands) { lo = Math.min(lo, b.p10); hi = Math.max(hi, b.p90); }
      }
      if (!isFinite(lo)) { lo = this.an ? this.an.last * 0.99 : 0; hi = this.an ? this.an.last * 1.01 : 1; }
      const pad = (hi - lo) * 0.06 || 1;
      lo -= pad; hi += pad;
      const P = L.price;
      const Y = p => P.y + (hi - p) / (hi - lo) * P.h;
      this.Y = Y; this.priceRange = [lo, hi];

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';

      // Grid + eixo de preço
      const step = niceStep((hi - lo) / 7);
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1; ctx.fillStyle = th.text; ctx.textAlign = 'left';
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
        const y = Math.round(Y(p)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.plotW, y); ctx.stroke();
        ctx.fillText(fmt(p, step), L.plotW + 6, y);
      }

      // Separadores de pregão e eixo de tempo
      this._timeAxis(ctx, th, L, X, i0, i1, n, H);

      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, L.plotW, L.timeY); ctx.clip();

      // Região de projeção
      if (H) {
        ctx.fillStyle = 'rgba(128,128,160,0.07)';
        ctx.fillRect(X(n - 1) + barW / 2, 0, barW * H + barW, P.h);
      }

      // Bollinger
      if (this.show.bb && this.an) this._band(ctx, X, Y, this.an.ind.bb.up, this.an.ind.bb.lo, i0, i1, th.bb);

      // Cone de projeção
      if (H && this.an) this._forecast(ctx, th, X, Y, n);

      // Níveis (suporte/resistência/pivôs)
      if (this.show.levels && this.an) this._levels(ctx, th, L, Y);

      // Candles
      const bw = Math.max(1, Math.min(barW * 0.7, 14));
      for (let i = i0; i <= i1; i++) {
        const k = this.candles[i], x = X(i);
        const col = k.c >= k.o ? th.up : th.down;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(k.h)); ctx.lineTo(Math.round(x) + 0.5, Y(k.l)); ctx.stroke();
        const yo = Y(k.o), yc = Y(k.c);
        ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      }

      // Médias, VWAP
      if (this.an) {
        if (this.show.ema) { this._line(ctx, X, Y, this.an.ind.ema9, i0, i1, th.ema9, 1.3); this._line(ctx, X, Y, this.an.ind.ema21, i0, i1, th.ema21, 1.3); }
        if (this.show.vwap) this._line(ctx, X, Y, this.an.ind.vwap, i0, i1, th.vwap, 1.8, true);
      }
      // Alvo e stop sugeridos
      if (this.show.targets && this.an && H) this._targets(ctx, th, L, Y, n, X);
      ctx.restore();

      // Preço atual
      const lastC = this.candles[n - 1];
      const yl = Y(lastC.c);
      if (yl > P.y && yl < P.y + P.h) {
        ctx.setLineDash([2, 3]); ctx.strokeStyle = lastC.c >= lastC.o ? th.up : th.down;
        ctx.beginPath(); ctx.moveTo(0, yl); ctx.lineTo(L.plotW, yl); ctx.stroke(); ctx.setLineDash([]);
        tag(ctx, L.plotW, yl, fmt(lastC.c, step), lastC.c >= lastC.o ? th.up : th.down, '#fff');
      }

      if (L.vol.h) this._volume(ctx, th, L, X, bw, i0, i1);
      if (L.rsi.h && this.an) this._rsi(ctx, th, L, X, i0, i1);

      // Crosshair
      if (this.mouse && this.mouse.x < L.plotW && this.mouse.y < L.timeY) this._crosshair(ctx, th, L, lo, hi);
    }

    _timeAxis(ctx, th, L, X, i0, i1, n, H) {
      ctx.fillStyle = th.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const stepMs = this.an ? this.an.stepMs : 300000;
      const minGap = 62;
      let lastX = -1e9, prevKey = null;
      const tAt = i => i < n ? this.candles[i].t : this.candles[n - 1].t + (i - n + 1) * stepMs;
      const z = v => String(v).padStart(2, '0');
      const marks = []; // { x, label, day }
      for (let i = Math.max(0, i0 - 1); i <= Math.min(n - 1 + H, i1 + H); i++) {
        const d = new Date(tAt(i)), key = d.toDateString(), x = X(i);
        const newDay = i < n && prevKey != null && key !== prevKey;
        if (newDay) {
          ctx.strokeStyle = th.grid; ctx.setLineDash([3, 4]);
          const lx = Math.round(x - this.barW / 2) + 0.5;
          ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, L.timeY); ctx.stroke(); ctx.setLineDash([]);
        }
        if (i < n) prevKey = key;
        if (x < 20 || x > L.plotW - 20) continue;
        marks.push({ x, day: newDay, label: newDay ? `${z(d.getDate())}/${z(d.getMonth() + 1)}` : `${z(d.getHours())}:${z(d.getMinutes())}` });
      }
      const dayXs = marks.filter(m => m.day).map(m => m.x);
      for (const m of marks) {
        if (!m.day && (m.x - lastX < minGap || dayXs.some(dx => Math.abs(dx - m.x) < minGap * 0.7))) continue;
        if (m.day && m.x - lastX < 30) continue;
        ctx.fillText(m.label, m.x, L.timeY + TIME_H / 2);
        lastX = m.x;
      }
    }

    _line(ctx, X, Y, arr, i0, i1, color, width, dashed) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dashed ? [5, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        if (arr[i] == null) { started = false; continue; }
        // VWAP reinicia por pregão: não liga o último ponto de um dia ao primeiro do seguinte
        if (started && dashed && this.candles[i].t - this.candles[i - 1].t > 12 * 3600000) started = false;
        started ? ctx.lineTo(X(i), Y(arr[i])) : ctx.moveTo(X(i), Y(arr[i]));
        started = true;
      }
      ctx.stroke(); ctx.setLineDash([]);
    }

    _band(ctx, X, Y, up, lo, i0, i1, color) {
      ctx.fillStyle = color; ctx.globalAlpha = 0.10; ctx.beginPath();
      let first = -1;
      for (let i = i0; i <= i1; i++) if (up[i] != null) { first = first < 0 ? i : first; ctx.lineTo(X(i), Y(up[i])); }
      for (let i = i1; i >= i0; i--) if (lo[i] != null) ctx.lineTo(X(i), Y(lo[i]));
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      this._line(ctx, X, Y, up, i0, i1, color, 1); this._line(ctx, X, Y, lo, i0, i1, color, 1);
    }

    _forecast(ctx, th, X, Y, n) {
      const f = this.an.forecast, bands = f.bands;
      const xs = [X(n - 1)].concat(bands.map((_, k) => X(n + k)));
      const poly = (upKey, loKey, alpha) => {
        ctx.beginPath();
        ctx.moveTo(xs[0], Y(f.entry));
        bands.forEach((b, k) => ctx.lineTo(xs[k + 1], Y(b[upKey])));
        for (let k = bands.length - 1; k >= 0; k--) ctx.lineTo(xs[k + 1], Y(bands[k][loKey]));
        ctx.closePath(); ctx.globalAlpha = alpha; ctx.fillStyle = th.fc; ctx.fill(); ctx.globalAlpha = 1;
      };
      poly('p90', 'p10', 0.14);
      poly('p75', 'p25', 0.25);
      ctx.strokeStyle = th.fc; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(xs[0], Y(f.entry));
      bands.forEach((b, k) => ctx.lineTo(xs[k + 1], Y(b.p50)));
      ctx.stroke(); ctx.setLineDash([]);
    }

    _levels(ctx, th, L, Y) {
      const an = this.an, items = [];
      an.supports.forEach((s, i) => items.push([s.price, `S${i + 1} (${s.touches}x)`, th.sup, [8, 4]]));
      an.resistances.forEach((r, i) => items.push([r.price, `R${i + 1} (${r.touches}x)`, th.res, [8, 4]]));
      if (an.pivots) {
        items.push([an.pivots.PP, 'PP', th.text, [2, 4]]);
        items.push([an.pivots.prevHigh, 'Máx. ant.', th.text, [2, 4]]);
        items.push([an.pivots.prevLow, 'Mín. ant.', th.text, [2, 4]]);
      }
      const labelYs = [];
      for (const [price, label, color, dash] of items) {
        const y = Y(price);
        if (y < 0 || y > L.price.h) continue;
        ctx.strokeStyle = color; ctx.globalAlpha = 0.7; ctx.lineWidth = 1; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(L.plotW, Math.round(y) + 0.5); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        // rótulo só se não colidir com outro já desenhado
        if (labelYs.some(ly => Math.abs(ly - y) < 13)) continue;
        labelYs.push(y);
        const w = ctx.measureText(label).width + 8;
        ctx.fillStyle = th.bg; ctx.globalAlpha = 0.85; ctx.fillRect(4, y - 16, w, 14); ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.fillText(label, 8, y - 9);
      }
    }

    _targets(ctx, th, L, Y, n, X) {
      const f = this.an.forecast;
      const dir = this.an.bias === 'down' ? -1 : 1;
      if (this.an.bias === 'neutral') return;
      const tp = f.entry + dir * f.tpDistance, sl = f.entry - dir * f.slDistance;
      const x0 = X(n - 1), x1 = X(n - 1 + f.horizon);
      const seg = (p, color, label) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x0, Y(p)); ctx.lineTo(x1 + this.barW, Y(p)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.fillText(label, L.plotW - 4, Y(p) + (label === 'ALVO' ? -8 : 8));
      };
      seg(tp, th.up, 'ALVO'); seg(sl, th.down, 'STOP');
    }

    _volume(ctx, th, L, X, bw, i0, i1) {
      const V = L.vol;
      let mx = 1;
      for (let i = i0; i <= i1; i++) mx = Math.max(mx, this.candles[i].v);
      ctx.save(); ctx.beginPath(); ctx.rect(0, V.y, V.w, V.h); ctx.clip();
      for (let i = i0; i <= i1; i++) {
        const k = this.candles[i], hh = k.v / mx * (V.h - 4);
        ctx.globalAlpha = 0.55; ctx.fillStyle = k.c >= k.o ? th.up : th.down;
        ctx.fillRect(X(i) - bw / 2, V.y + V.h - hh, bw, hh);
      }
      ctx.restore(); ctx.globalAlpha = 1;
      ctx.fillStyle = th.text; ctx.textAlign = 'left'; ctx.fillText('Vol', 6, V.y + 9);
      ctx.strokeStyle = th.grid; ctx.strokeRect(0.5, V.y + 0.5, V.w - 1, V.h - 1);
    }

    _rsi(ctx, th, L, X, i0, i1) {
      const R = L.rsi, Y = v => R.y + (100 - v) / 100 * R.h;
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1;
      ctx.strokeRect(0.5, R.y + 0.5, R.w - 1, R.h - 1);
      ctx.setLineDash([3, 3]);
      [30, 70].forEach(v => { ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(R.w, Y(v)); ctx.stroke(); });
      ctx.setLineDash([]);
      ctx.save(); ctx.beginPath(); ctx.rect(0, R.y, R.w, R.h); ctx.clip();
      this._line(ctx, X, Y, this.an.ind.rsi, i0, i1, th.rsi, 1.4);
      ctx.restore();
      ctx.fillStyle = th.text; ctx.textAlign = 'left';
      ctx.fillText('70', R.w + 6, Y(70)); ctx.fillText('30', R.w + 6, Y(30));
      ctx.fillText('RSI 14', 6, R.y + 9);
    }

    _crosshair(ctx, th, L, lo, hi) {
      const { x, y } = this.mouse;
      ctx.strokeStyle = th.cross; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, L.timeY); ctx.stroke();
      if (y <= L.price.h) { ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(L.plotW, Math.round(y) + 0.5); ctx.stroke(); }
      ctx.setLineDash([]);
      if (y <= L.price.h) {
        const price = hi - y / L.price.h * (hi - lo);
        tag(ctx, L.plotW, y, price.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), th.cross, '#fff');
      }
      this._updateTooltip();
    }

    _indexAt(x) { return Math.round(x / this.barW - 0.5 + this.view.start); }

    _updateTooltip() {
      if (!this.tooltip || !this.mouse) return;
      const i = this._indexAt(this.mouse.x), n = this.candles.length;
      const z = v => String(v).padStart(2, '0');
      if (i >= 0 && i < n) {
        const k = this.candles[i], d = new Date(k.t);
        const chg = ((k.c - k.o) / k.o * 100);
        this.tooltip.innerHTML = `<b>${z(d.getDate())}/${z(d.getMonth() + 1)} ${z(d.getHours())}:${z(d.getMinutes())}</b> ` +
          `A <b>${k.o.toFixed(2)}</b> Máx <b>${k.h.toFixed(2)}</b> Mín <b>${k.l.toFixed(2)}</b> F <b>${k.c.toFixed(2)}</b> ` +
          `<span class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span> Vol <b>${k.v.toLocaleString('pt-BR')}</b>`;
      } else if (i >= n && this.an && i - n < this.an.forecast.horizon) {
        const b = this.an.forecast.bands[i - n];
        this.tooltip.innerHTML = `<b>Projeção +${i - n + 1}</b> mediana <b>${b.p50.toFixed(2)}</b> · 50%: ${b.p25.toFixed(2)}–${b.p75.toFixed(2)} · 80%: ${b.p10.toFixed(2)}–${b.p90.toFixed(2)}`;
      }
    }

    _bind() {
      const c = this.canvas;
      const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      c.addEventListener('mousemove', e => {
        this.mouse = pos(e);
        if (this.drag) {
          const dx = this.mouse.x - this.drag.x;
          this.view.start = this.drag.start - dx / this.barW;
        }
        this.render();
      });
      c.addEventListener('mouseleave', () => { this.mouse = null; this.drag = null; this.render(); });
      c.addEventListener('mousedown', e => { const p = pos(e); this.drag = { x: p.x, start: this.view.start }; c.style.cursor = 'grabbing'; });
      window.addEventListener('mouseup', () => { this.drag = null; c.style.cursor = 'crosshair'; });
      c.addEventListener('dblclick', () => { this.resetView(); this.render(); });
      c.addEventListener('wheel', e => {
        e.preventDefault();
        const p = pos(e);
        const idx = p.x / this.barW + this.view.start;
        const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        this.view.count *= factor;
        this._clampView();
        const nb = this.L.plotW / this.view.count;
        this.view.start = idx - p.x / nb;
        this.render();
      }, { passive: false });
      c.style.cursor = 'crosshair';
    }
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function fmt(v, step) {
    const dec = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)) + 0);
    return v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function tag(ctx, x, y, text, bg, fg) {
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg; ctx.fillRect(x, y - 9, w, 18);
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.fillText(text, x + 5, y);
  }

  root.Coldigo = Object.assign(root.Coldigo || {}, { Chart });
})(typeof self !== 'undefined' ? self : this);
