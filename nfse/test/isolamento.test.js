'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subir, gerarPfx } = require('./ajuda');
const { cnpjComDv } = require('../src/util');
const { chaveDoEscritorio, decifrar } = require('../src/seguranca');

const CNPJ_A = cnpjComDv('112223330001');
const CNPJ_B = cnpjComDv('554443330001');
let amb; let a; let b; let clienteA; let notaA; let alertaA;

before(async () => {
  amb = await subir();
  a = await amb.novoEscritorio('Contábil Alfa', 'dono@alfa.test');
  b = await amb.novoEscritorio('Contábil Beta', 'dono@beta.test');
  clienteA = (await a.post('/api/clientes', { cnpj: CNPJ_A, razao_social: 'Cliente do Alfa' })).dados.id;
  const pfx = gerarPfx(amb.dir);
  const up = await a.put(`/api/clientes/${clienteA}/certificado`, { nome_arquivo: 'a.pfx', pfx_base64: pfx.base64, senha: pfx.senha });
  assert.equal(up.status, 200, JSON.stringify(up.dados));
  const s = await a.post(`/api/clientes/${clienteA}/sincronizar`);
  assert.equal(s.dados.ok, true, JSON.stringify(s.dados));
  notaA = (await a.get(`/api/clientes/${clienteA}/notas`)).dados.itens[0].id;
  amb.simulador.cancelar(CNPJ_A, (await a.get(`/api/clientes/${clienteA}/notas`)).dados.itens[0].chave_acesso);
  await a.post(`/api/clientes/${clienteA}/sincronizar`);
  alertaA = (await a.get('/api/alertas')).dados.itens[0].id;
});
after(() => amb.encerrar());

test('o escritório B não enxerga nada do escritório A', async () => {
  assert.equal((await b.get('/api/painel')).dados.clientes.length, 0);
  for (const rota of [`/api/clientes/${clienteA}`, `/api/clientes/${clienteA}/notas`, `/api/clientes/${clienteA}/zip?competencia=2026-01`, `/api/notas/${notaA}/xml`, `/api/notas/${notaA}/pdf`]) {
    assert.equal((await b.get(rota)).status, 404, rota);
  }
  assert.equal((await b.patch(`/api/clientes/${clienteA}`, { razao_social: 'invadido' })).status, 404);
  assert.equal((await b.del(`/api/clientes/${clienteA}`)).status, 404);
  assert.equal((await b.post(`/api/clientes/${clienteA}/sincronizar`)).status, 404);
  assert.equal((await b.put(`/api/clientes/${clienteA}/certificado`, { pfx_base64: 'AAAA', senha: 'x' })).status, 404);
  assert.equal((await b.post(`/api/alertas/${alertaA}/resolver`)).status, 404);
  assert.deepEqual((await b.get('/api/alertas')).dados.itens, []);
  const eq = await b.get('/api/usuarios'); assert.equal(eq.dados.itens.length, 1);
  assert.equal((await b.patch('/api/usuarios/1', { ativo: false })).status, 404);
});

test('os dados do A continuam intactos depois das tentativas de B', async () => {
  const c = (await a.get(`/api/clientes/${clienteA}`)).dados;
  assert.equal(c.razao_social, 'Cliente do Alfa');
  assert.ok((await a.get(`/api/notas/${notaA}/xml`)).status === 200);
});

test('o mesmo CNPJ pode ser cliente de dois escritórios, com dados separados', async () => {
  const idB = (await b.post('/api/clientes', { cnpj: CNPJ_A, razao_social: 'Mesmo CNPJ no Beta' })).dados.id;
  assert.notEqual(idB, clienteA);
  assert.equal((await b.get(`/api/clientes/${idB}/notas`)).dados.total, 0);
  assert.ok((await a.get(`/api/clientes/${clienteA}/notas`)).dados.total > 0);
});

test('o banco recusa nota ligada a cliente de outro escritório (chave estrangeira composta)', () => {
  const tidA = amb.db.prepare('SELECT tenant_id FROM clientes WHERE id = ?').get(clienteA).tenant_id;
  const outro = amb.db.prepare('SELECT id FROM escritorios WHERE id <> ?').get(tidA).id;
  assert.throws(() => amb.db.prepare(`INSERT INTO notas (tenant_id, cliente_id, chave_acesso, direcao, competencia, xml) VALUES (?,?,?,?,?,?)`)
    .run(outro, clienteA, 'x'.repeat(50), 'emitida', '2026-01', '<x/>'), /FOREIGN KEY/);
  assert.throws(() => amb.db.prepare(`INSERT INTO alertas (tenant_id, cliente_id, tipo, referencia, mensagem) VALUES (?,?,?,?,?)`).run(outro, clienteA, 't', 'r', 'm'), /FOREIGN KEY/);
});

test('certificado é guardado cifrado e só abre com a chave do próprio escritório', () => {
  const linha = amb.db.prepare('SELECT * FROM certificados WHERE cliente_id = ?').get(clienteA);
  const pfxClaro = Buffer.from(gerarPfx(amb.dir).base64, 'base64');
  assert.ok(!Buffer.from(linha.pfx_cifrado).includes(pfxClaro.subarray(0, 32)));
  assert.ok(!Buffer.from(linha.senha_cifrada).toString('utf8').includes('segredo123'));
  const ctx = `cert:${linha.tenant_id}:${linha.cliente_id}:pfx`;
  assert.equal(decifrar(chaveDoEscritorio(amb.config.masterKey, linha.tenant_id), linha.pfx_cifrado, ctx).length > 100, true);
  assert.throws(() => decifrar(chaveDoEscritorio(amb.config.masterKey, linha.tenant_id + 1), linha.pfx_cifrado, ctx));
  assert.throws(() => decifrar(chaveDoEscritorio(amb.config.masterKey, linha.tenant_id), linha.pfx_cifrado, `cert:${linha.tenant_id + 1}:${linha.cliente_id}:pfx`));
});

test('a API nunca devolve o certificado nem a senha', async () => {
  const txt = JSON.stringify([(await a.get(`/api/clientes/${clienteA}`)).dados, (await a.get('/api/painel')).dados, (await a.get('/api/certificado-escritorio')).dados]);
  assert.ok(!/pfx_cifrado|pfx_base64|senha_cifrada|segredo123|"senha"/i.test(txt), txt);
});
