'use strict';
const fs = require('node:fs');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { soDigitos } = require('./util');

// Leitura de certificado A1 (.pfx/.p12): valida a senha e extrai titular, CNPJ e validade.
//  1) Pelo próprio Node (sem programa externo): sobe um servidor TLS local com o .pfx e lê o
//     certificado que ele apresenta. Funciona para o formato moderno (AES), o mais comum hoje.
//  2) Reserva: openssl do sistema, para certificados em formato antigo (RC2/3DES), que o Node
//     recusa. A senha vai por variável de ambiente do processo filho, nunca na linha de comando.

// Procura o openssl: variável NFSE_OPENSSL, PATH, e (no Windows) as pastas do Git for Windows.
function caminhoOpenssl() {
  if (process.env.NFSE_OPENSSL) return process.env.NFSE_OPENSSL;
  if (process.platform !== 'win32') return 'openssl';
  const candidatos = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe', 'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  ];
  return candidatos.find((c) => fs.existsSync(c)) || 'openssl';
}

function lerComNode(pfx, senha) {
  return new Promise((resolve, reject) => {
    let srv; let fim = false;
    const terminar = (fn, v) => { if (fim) return; fim = true; clearTimeout(timer); try { srv?.close(); } catch { /* já fechado */ } fn(v); };
    const timer = setTimeout(() => terminar(reject, new Error('Tempo esgotado ao ler o certificado.')), 10000);
    try { srv = tls.createServer({ pfx, passphrase: senha }, (s) => s.end()); } catch (e) { return terminar(reject, e); }
    srv.on('error', (e) => terminar(reject, e));
    srv.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: srv.address().port, rejectUnauthorized: false }, () => {
        const x = c.getPeerX509Certificate(); c.end(); terminar(resolve, x);
      });
      c.on('error', (e) => terminar(reject, e));
    });
  });
}

function lerComOpenssl(pfx, senha) {
  const tentar = (extra) => execFileSync(caminhoOpenssl(), ['pkcs12', '-nokeys', '-clcerts', '-passin', 'env:NFSE_PFX_SENHA', ...extra],
    { input: pfx, env: { ...process.env, NFSE_PFX_SENHA: senha }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
  let pem;
  try { pem = tentar([]); } catch (e1) {
    try { pem = tentar(['-legacy']); } catch (e2) {
      if (e2.code === 'ENOENT') {
        throw new Error('Este certificado está em formato antigo e o servidor precisa do openssl para lê-lo. Instale o Git for Windows (inclui o openssl) ou defina NFSE_OPENSSL com o caminho do openssl.exe.');
      }
      throw new Error(/mac verify|password/i.test(String(e2.stderr || e1.stderr || '')) ? 'Senha do certificado incorreta.' : 'Não foi possível ler o certificado (esperado .pfx/.p12 do tipo A1).');
    }
  }
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem.toString());
  if (!m) throw new Error('O arquivo não contém um certificado.');
  return new X509Certificate(m[0]);
}

function resumir(x) {
  const cn = /CN=([^\n]+)/.exec(x.subject)?.[1]?.trim() || null;
  // e-CNPJ ICP-Brasil costuma trazer "RAZAO SOCIAL:00000000000000" no CN.
  const cnpj = /:(\d{14})\b/.exec(cn || '')?.[1] || soDigitos(cn).match(/\d{14}/)?.[0] || null;
  return { titular: cn, cnpj_titular: cnpj, validade: new Date(x.validTo).toISOString().slice(0, 10), valido_desde: new Date(x.validFrom).toISOString().slice(0, 10) };
}

async function lerPfx(pfx, senha) {
  if (!Buffer.isBuffer(pfx) || pfx.length < 100 || pfx.length > 200_000) throw new Error('Arquivo de certificado inválido.');
  try { return resumir(await lerComNode(pfx, senha)); } catch (e) {
    if (/mac verify|invalid password|bad decrypt/i.test(e.message)) throw new Error('Senha do certificado incorreta.');
    // formato antigo (ou outro motivo que o Node não leu): tenta o openssl
    return resumir(lerComOpenssl(pfx, senha));
  }
}

module.exports = { lerPfx, caminhoOpenssl };
