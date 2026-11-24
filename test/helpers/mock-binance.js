// Simulador da API Spot da Binance para testes: confere a assinatura HMAC, cobra 0,1% de taxa e
// respeita o passo de quantidade e o valor mínimo do par, como descrito na documentação.
'use strict';
const http = require('http');
const B = require('../../ponte/binance.js');

function mockBinance(o) {
  const st = { price: 60000, balances: { USDT: 10000, BTC: 0 }, orders: 0, apiKey: o.apiKey, secret: o.secret };
  const step = 0.00001, fee = 0.001;
  const floorStep = x => Math.floor(x / step + 1e-9) * step;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const signed = () => {
      const raw = req.url.split('?')[1] || '';
      const i = raw.lastIndexOf('&signature=');
      if (req.headers['x-mbx-apikey'] !== st.apiKey) return send(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }), false;
      if (i < 0 || B.signHmac(raw.slice(0, i), st.secret) !== decodeURIComponent(raw.slice(i + 11))) return send(400, { code: -1022, msg: 'Signature for this request is not valid.' }), false;
      if (Math.abs(+url.searchParams.get('timestamp') - Date.now()) > 5000) return send(400, { code: -1021, msg: 'Timestamp outside recvWindow.' }), false;
      return true;
    };
    const p = url.pathname;
    if (p === '/api/v3/time') return send(200, { serverTime: Date.now() });
    if (p === '/api/v3/exchangeInfo') return send(200, { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
      filters: [{ filterType: 'LOT_SIZE', minQty: '0.00001000', maxQty: '9000', stepSize: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '5.00000000' }] }] });
    if (p === '/api/v3/ticker/price') return send(200, { symbol: url.searchParams.get('symbol'), price: String(st.price) });
    if (p === '/api/v3/account') { if (!signed()) return; return send(200, { canTrade: true, accountType: 'SPOT', balances: Object.entries(st.balances).map(([a, v]) => ({ asset: a, free: v.toFixed(8), locked: '0' })) }); }
    if (p === '/api/v3/order' && req.method === 'POST') {
      if (!signed()) return;
      const side = url.searchParams.get('side'), id = ++st.orders;
      if (side === 'BUY') {
        const qty = floorStep(+url.searchParams.get('quoteOrderQty') / st.price), spend = qty * st.price, f = qty * fee;
        if (spend > st.balances.USDT) return send(400, { code: -2010, msg: 'Account has insufficient balance.' });
        st.balances.USDT -= spend; st.balances.BTC += qty - f;
        return send(200, { orderId: id, executedQty: qty.toFixed(8), cummulativeQuoteQty: spend.toFixed(8), fills: [{ price: String(st.price), qty: qty.toFixed(8), commission: f.toFixed(8), commissionAsset: 'BTC' }] });
      }
      const qty = +url.searchParams.get('quantity');
      if (Math.abs(qty / step - Math.round(qty / step)) > 1e-6) return send(400, { code: -1013, msg: 'Filter failure: LOT_SIZE' });
      if (qty > st.balances.BTC + 1e-12) return send(400, { code: -2010, msg: 'Account has insufficient balance.' });
      const got = qty * st.price, f = got * fee;
      st.balances.BTC -= qty; st.balances.USDT += got - f;
      return send(200, { orderId: id, executedQty: qty.toFixed(8), cummulativeQuoteQty: got.toFixed(8), fills: [{ price: String(st.price), qty: qty.toFixed(8), commission: f.toFixed(8), commissionAsset: 'USDT' }] });
    }
    send(404, { code: -1, msg: 'not found' });
  });
  return { server, st, async start() { await new Promise(ok => server.listen(0, '127.0.0.1', ok)); return `http://127.0.0.1:${server.address().port}`; } };
}

module.exports = { mockBinance };
