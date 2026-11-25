'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subir } = require('./ajuda');
const { cnpjComDv } = require('../src/util');

let amb; let dono; let membro;
before(async () => { amb = await subir(); dono = await amb.novoEscritorio('Escritório', 'dono@x.test'); });
after(() => amb.encerrar());

test('sem sessão: 401; sem cabeçalho anti-CSRF: 403', async () => {
  const anon = amb.navegador();
  assert.equal((await anon.get('/api/painel')).status, 401);
  assert.equal((await anon.get('/api/clientes/1')).status, 401);
  assert.equal((await dono.semCabecalho('POST', '/api/clientes', { cnpj: cnpjComDv('123456780001'), razao_social: 'X' })).status, 403);
});

test('login: senha errada, e-mail inexistente e limite de tentativas', async () => {
  const n = amb.navegador();
  assert.equal((await n.post('/api/login', { email: 'dono@x.test', senha: 'errada-errada' })).status, 401);
  assert.equal((await n.post('/api/login', { email: 'ninguem@x.test', senha: 'errada-errada' })).status, 401);
  assert.equal((await n.post('/api/login', { email: 'dono@x.test', senha: 'senha-bem-longa-1' })).status, 200);
  assert.equal((await n.get('/api/eu')).dados.escritorio, 'Escritório');
  const spam = amb.navegador(); let ultimo;
  for (let i = 0; i < 12; i++) ultimo = await spam.post('/api/login', { email: 'alvo@x.test', senha: 'x' });
  assert.equal(ultimo.status, 429);
});

test('cadastro exige senha forte e e-mail único', async () => {
  const n = amb.navegador();
  assert.equal((await n.post('/api/cadastro', { escritorio: 'E', nome: 'N', email: 'a@b.test', senha: 'curta' })).status, 400);
  assert.equal((await n.post('/api/cadastro', { escritorio: 'E', nome: 'N', email: 'dono@x.test', senha: 'senha-bem-longa-1' })).status, 409);
});

test('membro lê e baixa, mas não cria cliente, certificado nem usuário', async () => {
  const c = await dono.post('/api/usuarios', { nome: 'Maria', email: 'maria@x.test', senha: 'senha-da-maria-1', papel: 'membro' });
  assert.equal(c.status, 200);
  membro = amb.navegador();
  assert.equal((await membro.post('/api/login', { email: 'maria@x.test', senha: 'senha-da-maria-1' })).status, 200);
  assert.equal((await membro.get('/api/painel')).status, 200);
  assert.equal((await membro.post('/api/clientes', { cnpj: cnpjComDv('123456780001'), razao_social: 'X' })).status, 403);
  assert.equal((await membro.get('/api/usuarios')).status, 403);
  assert.equal((await membro.put('/api/certificado-escritorio', { pfx_base64: 'AAAA', senha: 'x' })).status, 403);
});

test('desativar usuário derruba a sessão dele; dono não pode ser desativado', async () => {
  const lista = (await dono.get('/api/usuarios')).dados.itens;
  const maria = lista.find((x) => x.email === 'maria@x.test'); const d = lista.find((x) => x.papel === 'dono');
  assert.equal((await dono.patch(`/api/usuarios/${d.id}`, { ativo: false })).status, 400);
  assert.equal((await dono.patch(`/api/usuarios/${maria.id}`, { ativo: false })).status, 200);
  assert.equal((await membro.get('/api/painel')).status, 401);
});

test('CNPJ inválido e duplicado são recusados', async () => {
  assert.equal((await dono.post('/api/clientes', { cnpj: '12345678000100', razao_social: 'X' })).status, 400);
  const cnpj = cnpjComDv('222333440001');
  assert.equal((await dono.post('/api/clientes', { cnpj, razao_social: 'Ok' })).status, 200);
  assert.equal((await dono.post('/api/clientes', { cnpj, razao_social: 'Ok' })).status, 409);
});

test('logout encerra a sessão', async () => {
  const n = amb.navegador();
  await n.post('/api/login', { email: 'dono@x.test', senha: 'senha-bem-longa-1' });
  await n.post('/api/logout');
  const r = await fetch(amb.base + '/api/painel', { headers: { Cookie: 'nfse_sessao=invalido' } });
  assert.equal(r.status, 401);
});
