'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { carregar } = require('../src/config');
const { abrir } = require('../src/db');
const { criarServicoSync } = require('../src/sync');
const { criarServidor } = require('../server');
const { criarSimulador } = require('../src/simulador');

function gerarPfx(dir, { cn = 'EMPRESA TESTE:11222333000181', dias = 30, senha = 'segredo123' } = {}) {
  const k = path.join(dir, `k-${Math.random()}.pem`); const c = path.join(dir, `c-${Math.random()}.pem`); const p = path.join(dir, `x-${Math.random()}.pfx`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', c, '-subj', `/CN=${cn}`, '-days', String(dias)], { stdio: 'pipe' });
  execFileSync('openssl', ['pkcs12', '-export', '-out', p, '-inkey', k, '-in', c, '-passout', `pass:${senha}`], { stdio: 'pipe' });
  return { base64: fs.readFileSync(p).toString('base64'), senha };
}

async function subir({ hoje } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-teste-'));
  const simulador = criarSimulador({ hoje });
  const simPorta = await simulador.iniciar(0);
  const config = carregar({ NFSE_DATA: dir, NFSE_MASTER_KEY: crypto.randomBytes(32).toString('hex'), NFSE_ADN: 'simulador', NFSE_SIM_PORTA: String(simPorta), NFSE_AGENDADOR: '0' });
  const db = abrir(config.dbFile);
  const sync = criarServicoSync({ db, config, agora: hoje });
  const servidor = criarServidor({ config, db, sync });
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  // Cliente HTTP com "cookie jar" próprio: cada instância é um navegador/usuário.
  function navegador() {
    let cookie = '';
    const chamar = async (metodo, caminho, corpo, { cabecalhos = {} } = {}) => {
      const r = await fetch(base + caminho, {
        method: metodo,
        headers: { ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(metodo !== 'GET' ? { 'X-NFSE': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...cabecalhos },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const tipo = r.headers.get('content-type') || '';
      const dados = tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
      return { status: r.status, dados, tipo };
    };
    return { get: (c) => chamar('GET', c), post: (c, b = {}) => chamar('POST', c, b), put: (c, b) => chamar('PUT', c, b), patch: (c, b) => chamar('PATCH', c, b), del: (c) => chamar('DELETE', c), semCabecalho: (m, c, b) => chamar(m, c, b, { cabecalhos: { 'X-NFSE': '' } }), chamar };
  }

  async function novoEscritorio(nome, email) {
    const b = navegador();
    const r = await b.post('/api/cadastro', { escritorio: nome, nome: `Dono ${nome}`, email, senha: 'senha-bem-longa-1' });
    if (r.status !== 200) throw new Error(`cadastro falhou: ${JSON.stringify(r.dados)}`);
    return b;
  }

  async function encerrar() {
    await simulador.parar();
    await new Promise((ok) => servidor.close(ok));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { base, db, config, sync, simulador, navegador, novoEscritorio, encerrar, dir };
}

module.exports = { subir, gerarPfx };
