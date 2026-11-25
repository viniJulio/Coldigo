'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { carregar } = require('./src/config');
const { abrir } = require('./src/db');
const { criarServicoSync } = require('./src/sync');
const { criarApi, Http } = require('./src/api');
const { criarSimulador } = require('./src/simulador');

const PUBLICO = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const LIMITE_CORPO = 2 * 1024 * 1024;

const CABECALHOS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
};

function criarServidor({ config, db, sync }) {
  const api = criarApi({ db, config, sync });

  const lerCorpoDe = (req) => () => new Promise((resolve, reject) => {
    const partes = []; let tam = 0;
    req.on('data', (c) => { tam += c.length; if (tam > LIMITE_CORPO) { reject(new Http(413, 'Corpo grande demais.')); req.destroy(); } else partes.push(c); });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(partes).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch { reject(new Http(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });

  function estatico(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const arq = path.join(PUBLICO, rel);
    if (!arq.startsWith(PUBLICO + path.sep) || !TIPOS[path.extname(arq)] || !fs.existsSync(arq)) { res.writeHead(404, CABECALHOS); return res.end('Não encontrado'); }
    res.writeHead(200, { ...CABECALHOS, 'Content-Type': TIPOS[path.extname(arq)] });
    fs.createReadStream(arq).pipe(res);
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') { res.writeHead(405, CABECALHOS); return res.end(); }
        return estatico(req, res, url.pathname);
      }
      for (const [k, v] of Object.entries(CABECALHOS)) res.setHeader(k, v);
      const saida = await api.tratar(req, res, url, lerCorpoDe(req));
      if (saida?.__arquivo) {
        const { nome, tipo, dados } = saida.__arquivo;
        res.writeHead(200, { 'Content-Type': tipo, 'Content-Disposition': `attachment; filename="${nome.replace(/[^\w.-]/g, '_')}"` });
        return res.end(dados);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(saida ?? {}));
    } catch (e) {
      const status = e instanceof Http ? e.status : 500;
      if (status === 500) console.error('[erro]', e);
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ erro: status === 500 ? 'Erro interno.' : e.message }));
    }
  });
}

async function main() {
  const config = carregar();
  const db = abrir(config.dbFile);
  let simulador = null;
  if (config.modoAdn === 'simulador') {
    simulador = criarSimulador();
    await simulador.iniciar(config.simuladorPorta);
    console.log(`ADN SIMULADO em http://127.0.0.1:${config.simuladorPorta} (dados fictícios)`);
  } else {
    console.log(`ADN ${config.modoAdn}: ${config.adnUrl}`);
  }
  const sync = criarServicoSync({ db, config });
  const servidor = criarServidor({ config, db, sync });
  servidor.listen(config.porta, () => console.log(`NFS-e Contadores em http://localhost:${config.porta}`));
  if (config.agendador) sync.iniciarAgendador();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { criarServidor };
