const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const B = require('../ponte/binance.js');
const { criarPonte } = require('../ponte/servidor.js');

test('assinatura HMAC: exemplo da documentação da Binance', () => {
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(B.signHmac(q, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('assinatura Ed25519 confere com a chave pública', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const sig = B.signEd25519('symbol=BTCUSDT&timestamp=1', pem);
  assert.ok(crypto.verify(null, Buffer.from('symbol=BTCUSDT&timestamp=1'), publicKey, Buffer.from(sig, 'base64')));
});

test('arredonda a quantidade para baixo no passo do par', () => {
  assert.equal(B.floorToStep(0.00082917, '0.00001000'), '0.00082');
  assert.equal(B.floorToStep(1.999999, '0.01'), '1.99');
  assert.equal(B.floorToStep(0.3, '0.1'), '0.3'); // sem erro de ponto flutuante
  assert.equal(B.floorToStep(15, '1.00000000'), '15');
  assert.equal(B.decimalsOf('0.00010000'), 4);
});

test('resultado real: taxa na moeda comprada não é descontada duas vezes; BNB convertido; sobra avaliada', () => {
  const buy = { qty: 1, quote: 100, avgPrice: 100, feeBase: 0.001, feeQuote: 0, feeOther: {} };
  const sell = { qty: 0.99, quote: 101.97, avgPrice: 103, feeBase: 0, feeQuote: 0.10197, feeOther: { BNB: 0.0001 } };
  const r = B.computeResult(buy, sell, { prices: { BNB: 600 }, dustQty: 0.009 });
  // 101,97 − 100 − 0,10197 − 0,06 (BNB) + 0,009 × 103
  assert.ok(Math.abs(r.pnl - (101.97 - 100 - 0.10197 - 0.06 + 0.927)) < 1e-9, r.pnl);
});

const { mockBinance } = require('./helpers/mock-binance.js');

const ORIGEM = 'http://127.0.0.1:8123';
const espera = ms => new Promise(ok => setTimeout(ok, ms));

async function montar(over) {
  const mock = mockBinance({ apiKey: 'chave-teste', secret: 'segredo-teste' });
  const base = await mock.start();
  const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ponte-')), 'operacoes.json');
  if (over && over.operacoes) fs.writeFileSync(arquivo, JSON.stringify(over.operacoes));
  const config = Object.assign({ apiKey: 'chave-teste', secretKey: 'segredo-teste', tipoChave: 'hmac', codigo: 'codigo-123', limitePorOrdemUSDT: 100, origens: [ORIGEM] }, over && over.config);
  const ponte = criarPonte({ config, base, arquivoOperacoes: arquivo, minDuracaoMs: 50 });
  const porta = await ponte.iniciar(0);
  const url = `http://127.0.0.1:${porta}`;
  const call = (method, p, body, headers) => fetch(url + p, { method, headers: Object.assign({ Origin: ORIGEM, 'X-Coldigo-Codigo': 'codigo-123', 'Content-Type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, body: await r.json(), headers: r.headers }));
  return { mock, ponte, call, url, arquivo, async fim() { await ponte.fechar(); mock.server.close(); } };
}

test('ponte: exige código de acesso e origem permitida; responde ao pedido de rede local do navegador', async () => {
  const t = await montar();
  try {
    assert.equal((await t.call('GET', '/saude', null, { 'X-Coldigo-Codigo': '' })).status, 200);
    assert.equal((await t.call('GET', '/status', null, { 'X-Coldigo-Codigo': 'errado' })).status, 401);
    assert.equal((await t.call('GET', '/status', null, { Origin: 'https://site-malicioso.example' })).status, 403);
    const pre = await fetch(t.url + '/operacoes', { method: 'OPTIONS', headers: { Origin: ORIGEM, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGEM);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    const s = await t.call('GET', '/status');
    assert.equal(s.body.ok, true); assert.equal(s.body.ambiente, 'demo'); assert.equal(s.body.conta.podeNegociar, true);
    const saldo = await t.call('GET', '/saldo');
    assert.deepEqual(saldo.body.saldos.map(x => x.moeda), ['USDT']);
  } finally { await t.fim(); }
});

test('ponte: compra, vende sozinha no vencimento e calcula o resultado real com as taxas', async () => {
  const t = await montar();
  try {
    const r = await t.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 50, duracaoMs: 250, origem: 'manual' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const op = r.body.operacao;
    assert.equal(op.estado, 'aberta');
    assert.ok(Math.abs(op.abertura.qty - 0.00083) < 1e-12 && Math.abs(op.abertura.quote - 49.8) < 1e-9);
    t.mock.st.price = 61000; // o preço sobe antes do vencimento
    await espera(700);
    const f = (await t.call('GET', '/operacoes')).body.operacoes[0];
    assert.equal(f.estado, 'fechada', JSON.stringify(f));
    assert.equal(f.motivo, 'vencimento');
    // vende 0,00082 (líquido 0,00082917 arredondado ao passo); sobra 0,00000917 fica na conta
    assert.equal(f.fechamento.qty, 0.00082);
    const esperado = 0.00082 * 61000 - 49.8 - 0.00082 * 61000 * 0.001 + (0.00083 * 0.999 - 0.00082) * 61000;
    assert.ok(Math.abs(f.resultadoUSDT - esperado) < 1e-6, `${f.resultadoUSDT} vs ${esperado}`);
    // a conta da Binance bate com o resultado: USDT + BTC restante a 61000 − 10000 iniciais
    const patrimonio = t.mock.st.balances.USDT + t.mock.st.balances.BTC * 61000 - 10000;
    assert.ok(Math.abs(patrimonio - f.resultadoUSDT) < 1e-6, `${patrimonio} vs ${f.resultadoUSDT}`);
  } finally { await t.fim(); }
});

test('ponte: limites e validações', async () => {
  const t = await montar();
  try {
    assert.equal((await t.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 500, duracaoMs: 60000 })).status, 400); // acima do limite
    assert.equal((await t.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 2, duracaoMs: 60000 })).status, 400);   // abaixo do mínimo do par
    assert.equal((await t.call('POST', '/operacoes', { symbol: 'BTCBRL', valorUSDT: 10, duracaoMs: 60000 })).status, 400);   // não é contra USDT
    assert.equal((await t.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 10, duracaoMs: 30 * 86400000 })).status, 400);
    assert.equal(t.mock.st.orders, 0, 'nenhuma ordem enviada');
  } finally { await t.fim(); }
});

test('ponte: fechar manualmente antes do vencimento', async () => {
  const t = await montar();
  try {
    const op = (await t.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 20, duracaoMs: 3600000 })).body.operacao;
    t.mock.st.price = 59000;
    const f = (await t.call('POST', `/operacoes/${op.id}/fechar`)).body.operacao;
    assert.equal(f.estado, 'fechada'); assert.equal(f.motivo, 'fechada manualmente');
    assert.ok(f.resultadoUSDT < 0);
  } finally { await t.fim(); }
});

test('ponte: operação que venceu com a ponte desligada é vendida ao religar', async () => {
  const t0 = await montar();
  const op = (await t0.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 30, duracaoMs: 3600000 })).body.operacao;
  const salvo = JSON.parse(fs.readFileSync(t0.arquivo, 'utf8'));
  await t0.fim();
  salvo[0].vencimento = Date.now() - 60000; // venceu há 1 minuto
  // nova ponte, mesma conta: o simulador novo precisa ter o BTC comprado
  const t = await montar({ operacoes: salvo });
  t.mock.st.balances.BTC = op.abertura.qty - op.abertura.feeBase;
  try {
    await espera(300);
    const f = (await t.call('GET', '/operacoes')).body.operacoes[0];
    assert.equal(f.estado, 'fechada', JSON.stringify(f)); assert.equal(f.motivo, 'vencida com a ponte desligada'); assert.equal(f.atrasada, true);
  } finally { await t.fim(); }
});

test('ponte: chave errada vira mensagem clara, sem enviar ordem', async () => {
  const t = await montar({ config: { secretKey: 'segredo-errado' } });
  try {
    const s = await t.call('GET', '/status');
    assert.equal(s.body.ok, false); assert.match(s.body.erro, /assinatura inválida/);
    const r = await t.call('POST', '/operacoes', { symbol: 'BTCUSDT', valorUSDT: 20, duracaoMs: 60000 });
    assert.equal(r.status, 502); assert.match(r.body.erro, /assinatura inválida/);
    assert.equal(t.mock.st.orders, 0);
  } finally { await t.fim(); }
});

test('ponte: só aceita o endereço da conta demo (ou um simulador local em testes)', () => {
  assert.throws(() => criarPonte({ config: { origens: [] }, base: 'https://api.binance.com' }), /base de teste inválida/);
});

test('cliente da ponte no app: envia o código, traduz falta de conexão e resume as operações', async () => {
  const P = require('../js/ponte.js');
  const chamadas = [];
  const p = new P.Ponte('http://127.0.0.1:8787/', 'abc', async (url, o) => { chamadas.push([url, o.method, o.headers['X-Coldigo-Codigo']]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; });
  await p.status(); await p.fechar(7);
  assert.deepEqual(chamadas, [['http://127.0.0.1:8787/status', 'GET', 'abc'], ['http://127.0.0.1:8787/operacoes/7/fechar', 'POST', 'abc']]);
  const off = new P.Ponte('http://127.0.0.1:8787', 'abc', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(off.status(), /não encontrei a ponte/);
  const erro = new P.Ponte('http://127.0.0.1:8787', 'x', async () => ({ ok: false, status: 401, json: async () => ({ erro: 'código de acesso ausente ou errado.' }) }));
  await assert.rejects(erro.status(), /código de acesso/);
  const r = P.resumo([{ estado: 'fechada', resultadoUSDT: 1.5, taxasUSDT: 0.1 }, { estado: 'fechada', resultadoUSDT: -0.5, taxasUSDT: 0.1 }, { estado: 'aberta' }]);
  assert.deepEqual([r.abertas, r.fechadas, r.soma, r.comLucro], [1, 2, 1, 0.5]);
});
