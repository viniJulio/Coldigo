/* Cliente da ponte local (ponte/servidor.js), que executa as ordens na conta DEMO da Binance.
 * O app nunca vê a chave da Binance: só fala com a ponte, no próprio computador, com o código de acesso. */
(function (root) {
  'use strict';

  class Ponte {
    constructor(url, codigo, fetchImpl) {
      this.url = String(url || '').replace(/\/+$/, '');
      this.codigo = codigo || '';
      this.fetch = fetchImpl || ((...a) => fetch(...a));
    }

    async req(method, path, body) {
      let res;
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctrl && setTimeout(() => ctrl.abort(), 20000);
      try {
        res = await this.fetch(this.url + path, {
          method, signal: ctrl && ctrl.signal,
          headers: Object.assign({ 'X-Coldigo-Codigo': this.codigo }, body ? { 'Content-Type': 'application/json' } : {}),
          body: body ? JSON.stringify(body) : undefined
        });
      } catch (_) {
        throw new Error(`não encontrei a ponte em ${this.url}. Ela está ligada? No Windows, dois cliques em ponte\\iniciar.bat. Se o navegador perguntar, permita o acesso à rede local.`);
      } finally { if (t) clearTimeout(t); }
      let data = {};
      try { data = await res.json(); } catch (_) { /* resposta vazia */ }
      if (!res.ok) throw new Error(data.erro || `a ponte respondeu HTTP ${res.status}`);
      return data;
    }

    status() { return this.req('GET', '/status'); }
    saldo() { return this.req('GET', '/saldo'); }
    operacoes() { return this.req('GET', '/operacoes'); }
    abrir(o) { return this.req('POST', '/operacoes', o); }
    fechar(id) { return this.req('POST', `/operacoes/${id}/fechar`); }
  }

  /** Resumo das operações reais encerradas. */
  function resumo(ops) {
    const fechadas = ops.filter(o => o.estado === 'fechada' && o.resultadoUSDT != null);
    const soma = fechadas.reduce((s, o) => s + o.resultadoUSDT, 0);
    return {
      abertas: ops.filter(o => o.estado === 'aberta').length, fechadas: fechadas.length,
      soma, comLucro: fechadas.length ? fechadas.filter(o => o.resultadoUSDT > 0).length / fechadas.length : null,
      taxas: fechadas.reduce((s, o) => s + (o.taxasUSDT || 0), 0)
    };
  }

  const api = { Ponte, resumo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coldigo = Object.assign(root.Coldigo || {}, { PonteCliente: api });
})(typeof self !== 'undefined' ? self : this);
