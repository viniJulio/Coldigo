'use strict';
const { soDigitos } = require('./util');

// Leitura tolerante do XML da NFS-e Nacional (padrão nacional, namespace sped.fazenda.gov.br/nfse).
// Procura por nome local de tag, ignorando prefixo de namespace. Sem dependências.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bloco(xml, nome) {
  if (!xml) return null;
  const re = new RegExp(`<(?:[\\w.-]+:)?${esc(nome)}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${esc(nome)}>`);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

function texto(xml, ...caminho) {
  let atual = xml;
  for (const nome of caminho) { atual = bloco(atual, nome); if (atual == null) return null; }
  return desescapar(atual.trim());
}

function desescapar(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function paraCentavos(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Devolve os campos que o sistema usa; null onde o XML não traz a informação.
function lerNfse(xml) {
  const chave = /Id="NFS(\d{50})"/.exec(xml)?.[1] || texto(xml, 'chNFSe');
  const emit = bloco(xml, 'emit');
  const dps = bloco(xml, 'infDPS') || bloco(xml, 'DPS') || xml;
  const toma = bloco(dps, 'toma');
  const dhEmi = texto(dps, 'dhEmi') || texto(xml, 'dhProc');
  const dCompet = texto(dps, 'dCompet');
  const dataEmissao = dhEmi ? dhEmi.slice(0, 10) : null;
  const competencia = (dCompet || dataEmissao || '').slice(0, 7);
  return {
    chave_acesso: chave,
    numero: texto(xml, 'nNFSe'),
    data_emissao: dataEmissao,
    competencia: /^\d{4}-\d{2}$/.test(competencia) ? competencia : null,
    prestador_cnpj: soDigitos(texto(emit, 'CNPJ') || texto(emit, 'CPF')) || null,
    prestador_nome: texto(emit, 'xNome'),
    tomador_doc: soDigitos(texto(toma, 'CNPJ') || texto(toma, 'CPF')) || null,
    tomador_nome: texto(toma, 'xNome'),
    valor_centavos: paraCentavos(texto(dps, 'vServPrest', 'vServ') ?? texto(xml, 'vServ') ?? texto(xml, 'vLiq')),
  };
}

// Evento (cancelamento etc.): devolve a chave da nota a que se refere.
function lerEvento(xml) {
  const chave = texto(xml, 'chNFSe') || /Id="EVT(\d{50})/.exec(xml)?.[1] || /(\d{50})/.exec(xml)?.[1] || null;
  return { chave_acesso: chave, tipo: texto(xml, 'tpEvento') };
}

module.exports = { lerNfse, lerEvento, texto, bloco };
