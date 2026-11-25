'use strict';
const crypto = require('node:crypto');

// Cada escritório tem a própria chave derivada da chave mestra; o contexto (AAD) amarra o
// texto cifrado ao escritório e à finalidade, então um blob copiado para outro escritório não abre.
function chaveDoEscritorio(mestra, tenantId) {
  return Buffer.from(crypto.hkdfSync('sha256', mestra, 'nfse-escritorio', `tenant:${tenantId}`, 32));
}

function cifrar(chave, dados, contexto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
  c.setAAD(Buffer.from(contexto));
  const ct = Buffer.concat([c.update(dados), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function decifrar(chave, blob, contexto) {
  const b = Buffer.from(blob);
  const d = crypto.createDecipheriv('aes-256-gcm', chave, b.subarray(0, 12));
  d.setAAD(Buffer.from(contexto));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

const N = 16384;
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64, { N });
  return `scrypt$${N}$${sal.toString('base64')}$${h.toString('base64')}`;
}
const HASH_FALSO = hashSenha('senha-falsa-para-igualar-tempo');

// Se o usuário não existe, `guardado` vem vazio: confere contra um hash falso para gastar o
// mesmo tempo e responde sempre falso (não revela quais e-mails existem).
function confereSenha(senha, guardado) {
  const existe = Boolean(guardado);
  const [alg, n, sal, h] = String(existe ? guardado : HASH_FALSO).split('$');
  if (alg !== 'scrypt') return false;
  const esperado = Buffer.from(h, 'base64');
  const obtido = crypto.scryptSync(senha, Buffer.from(sal, 'base64'), esperado.length, { N: Number(n) });
  return crypto.timingSafeEqual(esperado, obtido) && existe;
}

const novoToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

module.exports = { chaveDoEscritorio, cifrar, decifrar, hashSenha, confereSenha, novoToken, hashToken };
