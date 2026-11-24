/* Cliente mínimo da API Spot da Binance para a ponte local (sem dependências).
 * Assina as requisições com a chave da conta (HMAC-SHA256 ou Ed25519), sincroniza o relógio com
 * a Binance e traduz os erros mais comuns. A chave só existe no computador onde a ponte roda. */
'use strict';
const crypto = require('crypto');

const DEMO_BASE = 'https://demo-api.binance.com';

function signHmac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function signEd25519(payload, privateKeyPem) {
  return crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

// Casas decimais de um passo como "0.00001000" (5)
function decimalsOf(step) {
  const s = String(step);
  if (!s.includes('.')) return 0;
  const frac = s.split('.')[1].replace(/0+$/, '');
  return frac.length;
}

/** Arredonda para baixo ao múltiplo do passo do par (regra LOT_SIZE da Binance). */
function floorToStep(qty, step) {
  const st = Number(step), d = decimalsOf(step);
  if (!(st > 0)) return String(qty);
  const units = Math.floor(Number(qty) / st + 1e-9);
  return (units * st).toFixed(d);
}

/** Resume uma ordem executada (resposta FULL): quantidade, valor, preço médio e taxas por moeda. */
function summarizeOrder(order, baseAsset, quoteAsset) {
  const qty = Number(order.executedQty), quote = Number(order.cummulativeQuoteQty);
  const fees = {};
  for (const f of order.fills || []) fees[f.commissionAsset] = (fees[f.commissionAsset] || 0) + Number(f.commission);
  return {
    orderId: order.orderId, qty, quote, avgPrice: qty > 0 ? quote / qty : null,
    feeBase: fees[baseAsset] || 0, feeQuote: fees[quoteAsset] || 0,
    feeOther: Object.fromEntries(Object.entries(fees).filter(([a]) => a !== baseAsset && a !== quoteAsset))
  };
}

/** Resultado real em USDT de uma compra seguida de venda.
 *  Taxa cobrada na moeda comprada já reduziu a quantidade vendida (não se desconta de novo);
 *  taxa em USDT é descontada; taxa em BNB é convertida pelo preço informado; sobra que não pôde ser
 *  vendida (abaixo do passo do par) é avaliada ao preço de venda. */
function computeResult(buy, sell, opts) {
  opts = opts || {};
  const otherFees = Object.assign({}, buy.feeOther);
  for (const [a, v] of Object.entries(sell.feeOther || {})) otherFees[a] = (otherFees[a] || 0) + v;
  let otherUSDT = 0;
  for (const [a, v] of Object.entries(otherFees)) otherUSDT += v * (opts.prices && opts.prices[a] ? opts.prices[a] : 0);
  const dustValue = (opts.dustQty || 0) * (sell.avgPrice || 0);
  const feesUSDT = buy.feeQuote + sell.feeQuote + otherUSDT + buy.feeBase * (buy.avgPrice || 0);
  const pnl = sell.quote - buy.quote - buy.feeQuote - sell.feeQuote - otherUSDT + dustValue;
  return { pnl, feesUSDT, dustValue, otherFees };
}

const MENSAGENS = {
  '-2015': 'chave de API inválida, sem permissão de negociação ou bloqueada por IP. Confira a chave da conta demo e as permissões dela.',
  '-2014': 'formato da chave de API inválido.',
  '-1022': 'assinatura inválida: confira a chave secreta (ou a chave privada Ed25519).',
  '-1021': 'o relógio do computador está fora de sincronia com a Binance. Ative o ajuste automático de hora do Windows.',
  '-2010': 'a Binance recusou a ordem (saldo insuficiente ou mercado indisponível).',
  '-1013': 'quantidade ou valor abaixo do mínimo permitido para este par.',
  '-1121': 'par inexistente.',
  '-1003': 'muitas requisições: aguarde um pouco.'
};

class BinanceError extends Error {
  constructor(status, code, msg) {
    super(`${MENSAGENS[String(code)] || msg || 'erro desconhecido'} (Binance ${code != null ? code : status})`);
    this.status = status; this.code = code; this.binanceMsg = msg;
  }
}

class BinanceClient {
  constructor(o) {
    this.base = o.base || DEMO_BASE;
    this.apiKey = o.apiKey || '';
    this.secret = o.secret || '';
    this.privateKeyPem = o.privateKeyPem || '';
    this.keyType = o.keyType || 'hmac';
    this.fetch = o.fetchImpl || fetch;
    this.offset = 0;
    this.rules = new Map();
  }

  hasKey() { return !!(this.apiKey && (this.keyType === 'ed25519' ? this.privateKeyPem : this.secret)); }

  async _json(res) {
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (_) { body = { msg: text.slice(0, 200) }; }
    if (!res.ok) throw new BinanceError(res.status, body.code, body.msg);
    return body;
  }

  async publicGet(path, params) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return this._json(await this.fetch(this.base + path + qs));
  }

  async signed(method, path, params) {
    if (!this.hasKey()) throw new Error('a chave da conta demo não foi configurada em ponte/config.json.');
    const all = Object.assign({}, params, { recvWindow: 5000, timestamp: Date.now() + this.offset });
    const payload = new URLSearchParams(all).toString();
    const sig = this.keyType === 'ed25519' ? signEd25519(payload, this.privateKeyPem) : signHmac(payload, this.secret);
    const url = `${this.base}${path}?${payload}&signature=${encodeURIComponent(sig)}`;
    return this._json(await this.fetch(url, { method, headers: { 'X-MBX-APIKEY': this.apiKey } }));
  }

  async syncTime() {
    const t0 = Date.now();
    const { serverTime } = await this.publicGet('/api/v3/time');
    this.offset = serverTime - Math.round((t0 + Date.now()) / 2);
    return this.offset;
  }

  async symbolRules(symbol) {
    if (this.rules.has(symbol)) return this.rules.get(symbol);
    const info = await this.publicGet('/api/v3/exchangeInfo', { symbol });
    const s = info.symbols && info.symbols[0];
    if (!s) throw new Error('par não encontrado na Binance: ' + symbol);
    const f = type => (s.filters || []).find(x => x.filterType === type) || {};
    const lot = f('MARKET_LOT_SIZE').stepSize && Number(f('MARKET_LOT_SIZE').stepSize) > 0 ? f('MARKET_LOT_SIZE') : f('LOT_SIZE');
    const notional = f('NOTIONAL').minNotional ? f('NOTIONAL') : f('MIN_NOTIONAL');
    const r = {
      symbol, status: s.status, base: s.baseAsset, quote: s.quoteAsset,
      stepSize: lot.stepSize || f('LOT_SIZE').stepSize || '0.00000001', minQty: Number(lot.minQty || f('LOT_SIZE').minQty || 0),
      minNotional: Number(notional.minNotional || 0)
    };
    this.rules.set(symbol, r);
    return r;
  }

  account() { return this.signed('GET', '/api/v3/account', { omitZeroBalances: 'true' }); }
  async price(symbol) { return Number((await this.publicGet('/api/v3/ticker/price', { symbol })).price); }
  marketBuy(symbol, quoteQty) {
    return this.signed('POST', '/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: Number(quoteQty).toFixed(2), newOrderRespType: 'FULL' });
  }
  marketSell(symbol, quantity) {
    return this.signed('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity, newOrderRespType: 'FULL' });
  }
}

module.exports = { DEMO_BASE, BinanceClient, BinanceError, signHmac, signEd25519, floorToStep, decimalsOf, summarizeOrder, computeResult };
