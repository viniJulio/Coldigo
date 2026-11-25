'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Endereços do ADN (Ambiente de Dados Nacional). A VALIDAR contra o manual oficial
// "Guia para utilização das APIs do ADN" antes de usar em produção.
const ADN_URLS = {
  producao: 'https://adn.nfse.gov.br',
  homologacao: 'https://adn.producaorestrita.nfse.gov.br',
};

function carregar(env = process.env) {
  const dataDir = env.NFSE_DATA || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Chave mestra: cifra os certificados. Em produção vem do ambiente (cofre de segredos).
  let mestra = env.NFSE_MASTER_KEY;
  if (!mestra) {
    if (env.NODE_ENV === 'production') throw new Error('NFSE_MASTER_KEY é obrigatória em produção (64 hex).');
    const arq = path.join(dataDir, 'master.key');
    if (!fs.existsSync(arq)) fs.writeFileSync(arq, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    mestra = fs.readFileSync(arq, 'utf8').trim();
  }
  if (!/^[0-9a-f]{64}$/i.test(mestra)) throw new Error('NFSE_MASTER_KEY deve ter 64 caracteres hex.');

  const modoAdn = env.NFSE_ADN || 'simulador'; // simulador | homologacao | producao
  const simPorta = Number(env.NFSE_SIM_PORTA || 8099);
  return {
    porta: Number(env.PORT || 8090),
    dataDir,
    dbFile: env.NFSE_DB || path.join(dataDir, 'nfse.db'),
    masterKey: Buffer.from(mestra, 'hex'),
    cadastroAberto: env.NFSE_CADASTRO_ABERTO !== '0',
    cookieSeguro: env.NFSE_COOKIE_SECURE === '1',
    modoAdn,
    adnUrl: env.NFSE_ADN_URL || ADN_URLS[modoAdn] || `http://127.0.0.1:${simPorta}`,
    simuladorPorta: simPorta,
    agendador: env.NFSE_AGENDADOR !== '0',
  };
}

module.exports = { carregar, ADN_URLS };
