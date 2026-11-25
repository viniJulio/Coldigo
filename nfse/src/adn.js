'use strict';
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');

// ============================================================================
// ADAPTADOR DA API DO ADN (Ambiente de Dados Nacional) — distribuição de DF-e.
//
// ATENÇÃO: o contrato abaixo (rota, parâmetros e formato do JSON) foi escrito a partir de
// documentação secundária e NÃO foi conferido contra o manual oficial ("Guia para utilização
// das APIs do ADN", gov.br/nfse). Conferir tudo em produção restrita (homologação) antes de
// usar com clientes reais. Todo o conhecimento do formato fica concentrado neste arquivo.
//
// Contrato assumido:
//   GET {base}/contribuintes/DFe/{NSU}?cnpjConsulta={cnpj}&lote=true
//   TLS mútuo (mTLS) com o certificado A1 (.pfx).
//   200 -> { StatusProcessamento, LoteDFe: [{ NSU, ChaveAcesso, TipoDocumento, TipoEvento,
//            ArquivoXml (base64 de gzip), DataHoraGeracao }] }
//   404 -> sem documentos novos a partir daquele NSU.
//   cnpjConsulta pode diferir do CNPJ do certificado se a raiz (8 primeiros dígitos) for a
//   mesma (novidade do manual v1.1 — vale p/ matriz/filial; procuração a confirmar).
// ============================================================================

class ErroAdn extends Error {
  constructor(msg, { status, transitorio = false } = {}) { super(msg); this.status = status; this.transitorio = transitorio; }
}

function decodificarXml(b64) {
  const buf = Buffer.from(b64 || '', 'base64');
  const xml = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  return xml.toString('utf8');
}

function requisitar(urlStr, { pfx, passphrase, timeoutMs = 30000, headers = {} }) {
  const url = new URL(urlStr);
  const mod = url.protocol === 'https:' ? https : http;
  const opcoes = { method: 'GET', headers: { Accept: 'application/json', ...headers }, timeout: timeoutMs };
  if (url.protocol === 'https:') Object.assign(opcoes, { pfx, passphrase, minVersion: 'TLSv1.2' });
  return new Promise((resolve, reject) => {
    const req = mod.request(url, opcoes, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, corpo: Buffer.concat(partes), tipo: res.headers['content-type'] || '' }));
    });
    req.on('timeout', () => req.destroy(new ErroAdn('Tempo esgotado ao falar com o ADN.', { transitorio: true })));
    req.on('error', (e) => reject(e instanceof ErroAdn ? e : new ErroAdn(`Falha de conexão com o ADN: ${e.message}`, { transitorio: true })));
    req.end();
  });
}

// pfx/passphrase só vivem na memória durante a sincronização.
function criarClienteAdn({ baseUrl, pfx, passphrase }) {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    // Devolve até um lote de documentos com NSU a partir de `nsu`.
    async buscarLote(nsu, cnpjConsulta) {
      const url = `${base}/contribuintes/DFe/${nsu}?cnpjConsulta=${encodeURIComponent(cnpjConsulta)}&lote=true`;
      const r = await requisitar(url, { pfx, passphrase });
      if (r.status === 404) return { docs: [], vazio: true };
      if (r.status === 429 || r.status >= 500) throw new ErroAdn(`ADN indisponível (HTTP ${r.status}).`, { status: r.status, transitorio: true });
      if (r.status === 401 || r.status === 403) throw new ErroAdn('ADN recusou o certificado (HTTP ' + r.status + '). Confira validade e se o CNPJ consultado é permitido para este certificado.', { status: r.status });
      if (r.status !== 200) throw new ErroAdn(`Resposta inesperada do ADN (HTTP ${r.status}).`, { status: r.status });
      let json;
      try { json = JSON.parse(r.corpo.toString('utf8')); } catch { throw new ErroAdn('Resposta do ADN não é JSON válido.'); }
      const docs = (json.LoteDFe || []).map((d) => ({
        nsu: Number(d.NSU),
        chave: d.ChaveAcesso,
        tipoDocumento: String(d.TipoDocumento ?? ''),
        tipoEvento: d.TipoEvento == null ? null : String(d.TipoEvento),
        geradoEm: d.DataHoraGeracao || null,
        xml: decodificarXml(d.ArquivoXml),
      }));
      return { docs, vazio: docs.length === 0 };
    },

    // DANFSe (PDF). Há indício de que o gerador nacional de PDF saiu do ar; por isso é
    // "melhor esforço": devolve null se não houver PDF e o chamador mostra o XML.
    async baixarPdf(chave) {
      const r = await requisitar(`${base}/danfse/${chave}`, { pfx, passphrase, headers: { Accept: 'application/pdf' } });
      if (r.status === 200 && r.corpo.subarray(0, 4).toString() === '%PDF') return r.corpo;
      return null;
    },
  };
}

module.exports = { criarClienteAdn, ErroAdn, decodificarXml };
