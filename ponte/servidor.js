/* Ponte local entre o Coldigo e a conta DEMO da Binance.
 *
 * - Roda no seu computador e só escuta em 127.0.0.1 (nada de fora do PC alcança).
 * - Guarda a chave da conta demo em ponte/config.json (nunca vai para o app nem para o GitHub).
 * - Só atende quem envia o código de acesso e vem de uma origem permitida (o seu app).
 * - Executa as operações: compra a mercado, vende sozinha no vencimento (mesmo com o navegador
 *   fechado) e registra o resultado real (preço médio, taxas, lucro em USDT) em ponte/operacoes.json.
 * - Só fala com a conta DEMO. Limite de valor por ordem configurável.
 *
 * Uso: node ponte/servidor.js   (no Windows: dois cliques em ponte/iniciar.bat) */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./binance.js');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'config.json');
const OPERACOES = path.join(DIR, 'operacoes.json');
const ORIGENS_PADRAO = ['https://vinijulio.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080', 'null'];
const DIA = 86400000;

function log(...a) { console.log(new Date().toLocaleTimeString('pt-BR'), '·', ...a); }

function carregarConfig() {
  let cfg = {};
  if (fs.existsSync(CONFIG)) cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  let mudou = false;
  const padrao = { apiKey: '', secretKey: '', tipoChave: 'hmac', chavePrivadaArquivo: '', porta: 8787, limitePorOrdemUSDT: 100, origens: ORIGENS_PADRAO };
  for (const [k, v] of Object.entries(padrao)) if (cfg[k] === undefined) { cfg[k] = v; mudou = true; }
  if (!cfg.codigo) { cfg.codigo = crypto.randomBytes(9).toString('base64url'); mudou = true; }
  if (mudou) fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Cria a ponte. `opts`: config, base (só em testes), arquivo de operações, fetchImpl, minDuracaoMs. */
function criarPonte(opts) {
  const cfg = opts.config;
  let base = B.DEMO_BASE;
  if (opts.base) { // somente para testes automáticos, e só aceitando um simulador local
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(opts.base)) throw new Error('base de teste inválida');
    base = opts.base;
  }
  const keyType = cfg.tipoChave === 'ed25519' ? 'ed25519' : 'hmac';
  const privateKeyPem = keyType === 'ed25519' && cfg.chavePrivadaArquivo ? fs.readFileSync(path.resolve(DIR, cfg.chavePrivadaArquivo), 'utf8') : '';
  const bn = new B.BinanceClient({ base, apiKey: cfg.apiKey, secret: cfg.secretKey, privateKeyPem, keyType, fetchImpl: opts.fetchImpl });
  const arquivo = opts.arquivoOperacoes || OPERACOES;
  const minDuracao = opts.minDuracaoMs != null ? opts.minDuracaoMs : 60000;
  let ops = [];
  try { ops = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (_) { ops = []; }
  let seq = ops.reduce((m, o) => Math.max(m, o.id), 0);
  const timers = new Map();
  const salvar = () => fs.writeFileSync(arquivo, JSON.stringify(ops, null, 2));

  // ---------- operações ----------
  async function abrir({ symbol, valorUSDT, duracaoMs, origem, contexto }) {
    if (!/^[A-Z0-9]{2,15}USDT$/.test(symbol || '')) throw Object.assign(new Error('par inválido: use um par contra USDT (ex.: BTCUSDT).'), { http: 400 });
    const valor = Number(valorUSDT);
    if (!(valor > 0)) throw Object.assign(new Error('informe um valor em USDT maior que zero.'), { http: 400 });
    if (valor > cfg.limitePorOrdemUSDT) throw Object.assign(new Error(`valor acima do limite por ordem (${cfg.limitePorOrdemUSDT} USDT, ajustável em ponte/config.json).`), { http: 400 });
    const dur = Number(duracaoMs);
    if (!(dur >= minDuracao && dur <= 7 * DIA)) throw Object.assign(new Error('duração deve ficar entre 1 minuto e 7 dias.'), { http: 400 });
    const r = await bn.symbolRules(symbol);
    if (r.status !== 'TRADING') throw Object.assign(new Error(`o par ${symbol} não está em negociação agora.`), { http: 400 });
    if (r.minNotional && valor < r.minNotional) throw Object.assign(new Error(`valor abaixo do mínimo do par (${r.minNotional} USDT).`), { http: 400 });
    const ordem = await bn.marketBuy(symbol, valor);
    const compra = B.summarizeOrder(ordem, r.base, r.quote);
    const agora = Date.now();
    const op = {
      id: ++seq, symbol, base: r.base, valorUSDT: valor, estado: 'aberta', origem: origem || 'manual', contexto: contexto || null,
      abertura: Object.assign({ t: agora }, compra), vencimento: agora + dur, fechamento: null, resultadoUSDT: null, erro: null, tentativas: 0
    };
    ops.push(op); salvar(); agendar(op);
    log(`COMPRA #${op.id} ${symbol}: ${compra.qty} a ${compra.avgPrice} (${compra.quote.toFixed(2)} USDT). Vence às ${new Date(op.vencimento).toLocaleTimeString('pt-BR')}.`);
    return op;
  }

  async function fechar(op, motivo) {
    if (op.estado !== 'aberta') return op;
    const r = await bn.symbolRules(op.symbol);
    try {
      const conta = await bn.account();
      const livre = Number(((conta.balances || []).find(b => b.asset === r.base) || {}).free || 0);
      const liquido = Math.min(op.abertura.qty - op.abertura.feeBase, livre);
      const qtd = B.floorToStep(liquido, r.stepSize);
      if (Number(qtd) <= 0 || Number(qtd) < r.minQty) throw new Error('quantidade abaixo do mínimo para vender; a posição ficou na conta demo.');
      const ordem = await bn.marketSell(op.symbol, qtd);
      const venda = B.summarizeOrder(ordem, r.base, r.quote);
      const prices = {};
      const outras = Object.keys(Object.assign({}, op.abertura.feeOther, venda.feeOther));
      for (const a of outras) { try { prices[a] = await bn.price(a + 'USDT'); } catch (_) { prices[a] = 0; } }
      const sobra = Math.max(0, op.abertura.qty - op.abertura.feeBase - Number(qtd));
      const res = B.computeResult(op.abertura, venda, { prices, dustQty: sobra });
      Object.assign(op, {
        estado: 'fechada', motivo, atrasada: Date.now() - op.vencimento > 30000,
        fechamento: Object.assign({ t: Date.now(), sobra }, venda), resultadoUSDT: res.pnl, taxasUSDT: res.feesUSDT, erro: null
      });
      salvar();
      log(`VENDA #${op.id} ${op.symbol}: ${venda.qty} a ${venda.avgPrice}. Resultado ${res.pnl >= 0 ? '+' : ''}${res.pnl.toFixed(4)} USDT.`);
    } catch (e) {
      op.tentativas = (op.tentativas || 0) + 1; op.erro = e.message; salvar();
      log(`Falha ao vender #${op.id} (tentativa ${op.tentativas}): ${e.message}`);
      if (op.tentativas < 10 && !/abaixo do mínimo/.test(e.message)) timers.set(op.id, setTimeout(() => fechar(op, motivo), 30000));
      else { op.estado = 'erro'; salvar(); }
    }
    return op;
  }

  function agendar(op) {
    if (op.estado !== 'aberta') return;
    clearTimeout(timers.get(op.id));
    const espera = Math.max(0, op.vencimento - Date.now());
    timers.set(op.id, setTimeout(() => fechar(op, espera === 0 ? 'vencida com a ponte desligada' : 'vencimento'), espera));
  }

  // ---------- HTTP ----------
  const iguais = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const enviar = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const lerCorpo = req => new Promise((ok, falha) => {
    let s = ''; req.on('data', d => { s += d; if (s.length > 1e5) falha(new Error('corpo grande demais')); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (_) { falha(Object.assign(new Error('JSON inválido'), { http: 400 })); } });
  });

  const server = http.createServer(async (req, res) => {
    const origem = req.headers.origin;
    if (origem !== undefined) {
      if (!cfg.origens.includes(origem)) return enviar(res, 403, { erro: 'origem não permitida: ' + origem });
      res.setHeader('Access-Control-Allow-Origin', origem);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Coldigo-Codigo');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/saude') return enviar(res, 200, { ok: true, app: 'ponte-coldigo', ambiente: 'demo' });
    if (!iguais(req.headers['x-coldigo-codigo'] || '', cfg.codigo)) return enviar(res, 401, { erro: 'código de acesso ausente ou errado. Copie o código mostrado na janela da ponte.' });
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const out = { ok: true, ambiente: 'demo', chave: bn.hasKey(), limitePorOrdemUSDT: cfg.limitePorOrdemUSDT };
        if (bn.hasKey()) {
          try { const a = await bn.account(); out.conta = { podeNegociar: !!a.canTrade, tipo: a.accountType || null }; }
          catch (e) { out.ok = false; out.erro = e.message; }
        } else { out.ok = false; out.erro = 'chave da conta demo não configurada em ponte/config.json.'; }
        return enviar(res, 200, out);
      }
      if (req.method === 'GET' && url.pathname === '/saldo') {
        const a = await bn.account();
        const saldos = (a.balances || []).map(b => ({ moeda: b.asset, livre: Number(b.free), travado: Number(b.locked) })).filter(b => b.livre + b.travado > 0);
        return enviar(res, 200, { saldos });
      }
      if (req.method === 'GET' && url.pathname === '/operacoes') return enviar(res, 200, { operacoes: ops.slice(-200) });
      if (req.method === 'POST' && url.pathname === '/operacoes') return enviar(res, 200, { operacao: await abrir(await lerCorpo(req)) });
      const m = url.pathname.match(/^\/operacoes\/(\d+)\/fechar$/);
      if (req.method === 'POST' && m) {
        const op = ops.find(o => o.id === +m[1]);
        if (!op) return enviar(res, 404, { erro: 'operação não encontrada' });
        clearTimeout(timers.get(op.id));
        return enviar(res, 200, { operacao: await fechar(op, 'fechada manualmente') });
      }
      return enviar(res, 404, { erro: 'rota não encontrada' });
    } catch (e) {
      log('Erro:', e.message);
      return enviar(res, e.http || (e instanceof B.BinanceError ? 502 : 500), { erro: e.message });
    }
  });

  return {
    server, client: bn, operacoes: () => ops,
    async iniciar(porta) {
      try { await bn.syncTime(); } catch (e) { log('Aviso: não consegui sincronizar o relógio com a Binance:', e.message); }
      ops.filter(o => o.estado === 'aberta').forEach(agendar); // inclusive as que venceram com a ponte desligada
      await new Promise(ok => server.listen(porta, '127.0.0.1', ok));
      return server.address().port;
    },
    fechar() { timers.forEach(t => clearTimeout(t)); return new Promise(ok => server.close(ok)); }
  };
}

if (require.main === module) {
  if (typeof fetch !== 'function') { console.error('A ponte precisa do Node.js 18 ou mais novo. Instale a versão LTS em https://nodejs.org e tente de novo.'); process.exit(1); }
  (async () => {
    const cfg = carregarConfig();
    const ponte = criarPonte({ config: cfg });
    const porta = await ponte.iniciar(cfg.porta);
    console.log('\n  Ponte Coldigo ligada (conta DEMO da Binance)');
    console.log(`  Endereço:          http://127.0.0.1:${porta}`);
    console.log(`  Código de acesso:  ${cfg.codigo}`);
    console.log(`  Limite por ordem:  ${cfg.limitePorOrdemUSDT} USDT`);
    if (!ponte.client.hasKey()) console.log('\n  ATENÇÃO: falta a chave. Edite ponte/config.json (apiKey e secretKey da conta demo) e reinicie.');
    console.log('\n  Deixe esta janela aberta enquanto usa o app. Para desligar, feche-a ou aperte Ctrl+C.\n');
  })().catch(e => { console.error('Não foi possível iniciar a ponte:', e.message); process.exitCode = 1; });
}

module.exports = { criarPonte, carregarConfig };
