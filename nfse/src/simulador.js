'use strict';
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { cnpjComDv, soDigitos } = require('./util');

// Simulador local do ADN, no contrato assumido em adn.js. Serve para desenvolver e testar sem
// certificado nem acesso ao governo. Não valida certificado (HTTP puro). Os dados são fictícios.
const FORNECEDORES = [
  ['Alfa Tecnologia Ltda', '100200300001'], ['Beta Consultoria ME', '200300400001'],
  ['Gama Serviços Gráficos', '300400500001'], ['Delta Contabilidade SS', '400500600001'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function gerarChave(cnpjPrestador, numero, data) {
  const base = `3550308` + '2' + '2' + cnpjPrestador + String(numero).padStart(13, '0') + data.slice(2, 4);
  const resto = crypto.createHash('sha256').update(base).digest('hex').replace(/\D/g, '').padEnd(12, '7');
  return (base + resto).slice(0, 50);
}

function gerarXmlNfse({ chave, numero, data, competencia, prestador, tomador, valor }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS${chave}"><xLocEmi>Sao Paulo</xLocEmi><nNFSe>${numero}</nNFSe><dhProc>${data}T10:00:00-03:00</dhProc>
<emit><CNPJ>${prestador.cnpj}</CNPJ><xNome>${esc(prestador.nome)}</xNome></emit>
<valores><vLiq>${valor.toFixed(2)}</vLiq></valores>
<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infDPS><dhEmi>${data}T09:55:00-03:00</dhEmi><dCompet>${competencia}-01</dCompet>
<prest><CNPJ>${prestador.cnpj}</CNPJ></prest><toma><CNPJ>${tomador.cnpj}</CNPJ><xNome>${esc(tomador.nome)}</xNome></toma>
<serv><cServ><cTribNac>010101</cTribNac><xDescServ>Servico de teste</xDescServ></cServ></serv>
<valores><vServPrest><vServ>${valor.toFixed(2)}</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`;
}

function gerarXmlEvento(chave, tpEvento) {
  return `<?xml version="1.0" encoding="UTF-8"?><evento xmlns="http://www.sped.fazenda.gov.br/nfse"><infPedReg Id="EVT${chave}${tpEvento}"><chNFSe>${chave}</chNFSe><tpEvento>${tpEvento}</tpEvento></infPedReg></evento>`;
}

const empacotar = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');

function criarSimulador({ hoje = () => new Date() } = {}) {
  const contas = new Map(); // cnpj -> { nsu, docs: [{nsu, ...}], contadorNumero }
  let server = null;
  const falhas = { proxima: null }; // para testar erros: simulador.falhas.proxima = 503

  function conta(cnpj) {
    if (!contas.has(cnpj)) { contas.set(cnpj, { nsu: 0, docs: [], numero: 0 }); semear(cnpj); }
    return contas.get(cnpj);
  }

  function adicionar(cnpj, { direcao = 'emitida', data, valor, contraparte, numero } = {}) {
    const c = contas.get(cnpj) || (contas.set(cnpj, { nsu: 0, docs: [], numero: 0 }), contas.get(cnpj));
    const d = data || hoje().toISOString().slice(0, 10);
    const cp = contraparte || { cnpj: cnpjComDv(FORNECEDORES[0][1]), nome: FORNECEDORES[0][0] };
    const eu = { cnpj, nome: `Empresa ${cnpj.slice(0, 8)}` };
    const n = numero ?? ++c.numero;
    const prestador = direcao === 'emitida' ? eu : cp;
    const tomador = direcao === 'emitida' ? cp : eu;
    const chave = gerarChave(prestador.cnpj, n, d);
    const xml = gerarXmlNfse({ chave, numero: n, data: d, competencia: d.slice(0, 7), prestador, tomador, valor: valor ?? 1000 + n * 37.5 });
    c.docs.push({ nsu: ++c.nsu, chave, tipoDocumento: 'NFSE', tipoEvento: null, xml });
    return chave;
  }

  function cancelar(cnpj, chave) {
    const c = conta(cnpj);
    c.docs.push({ nsu: ++c.nsu, chave, tipoDocumento: 'EVENTO', tipoEvento: '101101', xml: gerarXmlEvento(chave, '101101') });
  }

  // Massa inicial determinística: ~10 notas no mês anterior e no atual.
  function semear(cnpj) {
    const h = hoje();
    const meses = [new Date(h.getFullYear(), h.getMonth() - 1, 1), new Date(h.getFullYear(), h.getMonth(), 1)];
    let i = 0;
    for (const m of meses) {
      for (let k = 0; k < 5; k++, i++) {
        const dia = String(3 + k * 4).padStart(2, '0');
        const data = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${dia}`;
        if (data > h.toISOString().slice(0, 10)) continue;
        const [nome, base] = FORNECEDORES[(parseInt(cnpj.slice(0, 4), 10) + i) % FORNECEDORES.length];
        adicionar(cnpj, { direcao: i % 3 === 0 ? 'recebida' : 'emitida', data, contraparte: { cnpj: cnpjComDv(base), nome } });
      }
    }
  }

  function atender(req, res) {
    const url = new URL(req.url, 'http://x');
    const m = /^\/contribuintes\/DFe\/(\d+)$/.exec(url.pathname);
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (falhas.proxima) { const s = falhas.proxima; falhas.proxima = null; return json(s, { erro: 'falha simulada' }); }
    if (!m) { res.writeHead(404); return res.end(); }
    const cnpj = soDigitos(url.searchParams.get('cnpjConsulta'));
    if (cnpj.length !== 14) return json(400, { erro: 'cnpjConsulta inválido' });
    const nsu = Number(m[1]);
    const lote = conta(cnpj).docs.filter((d) => d.nsu >= Math.max(nsu, 1)).slice(0, 50);
    if (!lote.length) { res.writeHead(404); return res.end(); }
    json(200, {
      StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
      LoteDFe: lote.map((d) => ({ NSU: d.nsu, ChaveAcesso: d.chave, TipoDocumento: d.tipoDocumento, TipoEvento: d.tipoEvento,
        ArquivoXml: empacotar(d.xml), DataHoraGeracao: hoje().toISOString() })),
    });
  }

  return {
    falhas, adicionar, cancelar,
    iniciar(porta = 0) {
      server = http.createServer(atender);
      return new Promise((ok) => server.listen(porta, '127.0.0.1', () => ok(server.address().port)));
    },
    parar: () => new Promise((ok) => (server ? server.close(() => ok()) : ok())),
  };
}

module.exports = { criarSimulador, gerarXmlNfse, gerarChave };
