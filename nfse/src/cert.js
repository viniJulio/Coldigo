'use strict';
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { soDigitos } = require('./util');

// Lê um certificado A1 (.pfx/.p12) usando o openssl do sistema (o Node não abre PKCS#12 para
// inspeção). Valida a senha e extrai titular, CNPJ e validade. A senha vai por variável de
// ambiente do processo filho, nunca na linha de comando.
function lerPfx(pfx, senha) {
  if (!Buffer.isBuffer(pfx) || pfx.length < 100 || pfx.length > 200_000) throw new Error('Arquivo de certificado inválido.');
  const tentar = (extra) => execFileSync('openssl', ['pkcs12', '-nokeys', '-clcerts', '-passin', 'env:NFSE_PFX_SENHA', ...extra],
    { input: pfx, env: { PATH: process.env.PATH, NFSE_PFX_SENHA: senha }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
  let pem;
  try { pem = tentar([]); }
  catch (e1) {
    try { pem = tentar(['-legacy']); } // certificados antigos (RC2/3DES) no OpenSSL 3
    catch (e2) {
      if (e2.code === 'ENOENT') throw new Error('openssl não está instalado no servidor.');
      const msg = String(e2.stderr || e1.stderr || '');
      throw new Error(/mac verify|password|Mac verify/i.test(msg) ? 'Senha do certificado incorreta.' : 'Não foi possível ler o certificado (esperado .pfx/.p12 do tipo A1).');
    }
  }
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem.toString());
  if (!m) throw new Error('O arquivo não contém um certificado.');
  const x = new X509Certificate(m[0]);
  const cn = /CN=([^\n]+)/.exec(x.subject)?.[1]?.trim() || null;
  // e-CNPJ ICP-Brasil costuma trazer "RAZAO SOCIAL:00000000000000" no CN.
  const cnpj = /:(\d{14})\b/.exec(cn || '')?.[1] || soDigitos(cn).match(/\d{14}/)?.[0] || null;
  return { titular: cn, cnpj_titular: cnpj, validade: new Date(x.validTo).toISOString().slice(0, 10), valido_desde: new Date(x.validFrom).toISOString().slice(0, 10) };
}

module.exports = { lerPfx };
