'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lerPfx, caminhoOpenssl } = require('../src/cert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfse-cert-'));
const ssl = (...a) => execFileSync(caminhoOpenssl(), a, { stdio: 'pipe' });
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-subj', '/CN=WAYNE ENTERPRISES:11222333000181', '-days', '200');
const exportar = (nome, ...extra) => { ssl('pkcs12', '-export', ...extra, '-out', path.join(dir, nome), '-inkey', path.join(dir, 'k.pem'), '-in', path.join(dir, 'c.pem'), '-passout', 'pass:abc12345'); return fs.readFileSync(path.join(dir, nome)); };
const moderno = exportar('moderno.pfx');
const antigo = exportar('antigo.pfx', '-legacy');

test('formato moderno é lido só pelo Node, mesmo sem openssl no servidor', async () => {
  const antes = process.env.NFSE_OPENSSL; process.env.NFSE_OPENSSL = path.join(dir, 'nao-existe');
  try {
    const i = await lerPfx(moderno, 'abc12345');
    assert.equal(i.cnpj_titular, '11222333000181'); assert.match(i.titular, /WAYNE/); assert.match(i.validade, /^\d{4}-\d{2}-\d{2}$/);
    await assert.rejects(lerPfx(moderno, 'errada'), /Senha do certificado incorreta/);
  } finally { if (antes === undefined) delete process.env.NFSE_OPENSSL; else process.env.NFSE_OPENSSL = antes; }
});

test('formato antigo usa o openssl como reserva; sem openssl, a mensagem diz o que fazer', async () => {
  assert.equal((await lerPfx(antigo, 'abc12345')).cnpj_titular, '11222333000181');
  await assert.rejects(lerPfx(antigo, 'errada'), /Senha do certificado incorreta|Não foi possível/);
  const antes = process.env.NFSE_OPENSSL; process.env.NFSE_OPENSSL = path.join(dir, 'nao-existe');
  try { await assert.rejects(lerPfx(antigo, 'abc12345'), /formato antigo.*openssl/); }
  finally { if (antes === undefined) delete process.env.NFSE_OPENSSL; else process.env.NFSE_OPENSSL = antes; }
});

test('arquivo que não é certificado é recusado', async () => {
  await assert.rejects(lerPfx(Buffer.alloc(500, 1), 'x'));
  await assert.rejects(lerPfx(Buffer.from('curto'), 'x'), /inválido/);
});
