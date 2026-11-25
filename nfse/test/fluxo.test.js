'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { subir, gerarPfx } = require('./ajuda');
const { cnpjComDv, cnpjValido } = require('../src/util');
const { lerNfse } = require('../src/xml');
const { gerarXmlNfse } = require('../src/simulador');

// Leitor mínimo de ZIP: confere CRC e tamanho de cada entrada e devolve os nomes.
function nomesDoZip(buf) {
  const fim = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(fim >= 0, 'ZIP sem diretório central');
  const total = buf.readUInt16LE(fim + 10); let pos = buf.readUInt32LE(fim + 16); const nomes = [];
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50);
    const crc = buf.readUInt32LE(pos + 16); const comp = buf.readUInt32LE(pos + 20); const tam = buf.readUInt32LE(pos + 24);
    const nNome = buf.readUInt16LE(pos + 28); const extra = buf.readUInt16LE(pos + 30); const coment = buf.readUInt16LE(pos + 32); const desloc = buf.readUInt32LE(pos + 42);
    nomes.push(buf.subarray(pos + 46, pos + 46 + nNome).toString('utf8'));
    const ini = desloc + 30 + buf.readUInt16LE(desloc + 26) + buf.readUInt16LE(desloc + 28);
    const dados = zlib.inflateRawSync(buf.subarray(ini, ini + comp));
    assert.equal(dados.length, tam); assert.equal(zlib.crc32(dados), crc);
    pos += 46 + nNome + extra + coment;
  }
  return nomes;
}

const HOJE = new Date('2026-11-25T12:00:00Z');
const CNPJ = cnpjComDv('112223330001');
let amb; let u; let id;

before(async () => {
  amb = await subir({ hoje: () => HOJE });
  u = await amb.novoEscritorio('Contábil Teste', 'dono@teste.test');
  id = (await u.post('/api/clientes', { cnpj: CNPJ, razao_social: 'Cliente Um Ltda' })).dados.id;
});
after(() => amb.encerrar());

test('CNPJ: validação dos dígitos', () => {
  assert.ok(cnpjValido(CNPJ));
  assert.ok(!cnpjValido('11111111111111'));
  assert.ok(!cnpjValido('12345678000100'));
  assert.equal(lerNfse(gerarXmlNfse({ chave: '1'.repeat(50), numero: 7, data: '2026-10-03', competencia: '2026-10', prestador: { cnpj: CNPJ, nome: 'A & B' }, tomador: { cnpj: cnpjComDv('999888770001'), nome: 'T' }, valor: 1234.5 })).valor_centavos, 123450);
});

test('sem certificado: não sincroniza e abre alerta', async () => {
  const r = await u.post(`/api/clientes/${id}/sincronizar`);
  assert.equal(r.dados.ok, false);
  assert.match(r.dados.erro, /certificado/i);
  assert.ok((await u.get('/api/alertas')).dados.itens.some((a) => a.tipo === 'sem_certificado'));
});

test('certificado com senha errada é recusado', async () => {
  const pfx = gerarPfx(amb.dir);
  const r = await u.put(`/api/clientes/${id}/certificado`, { pfx_base64: pfx.base64, senha: 'errada' });
  assert.equal(r.status, 400); assert.match(r.dados.erro, /senha/i);
});

test('sincroniza, classifica emitidas/recebidas e é idempotente', async () => {
  const pfx = gerarPfx(amb.dir);
  const up = await u.put(`/api/clientes/${id}/certificado`, { nome_arquivo: 'c.pfx', pfx_base64: pfx.base64, senha: pfx.senha });
  assert.equal(up.status, 200); assert.equal(up.dados.cnpj_titular, '11222333000181');
  const s1 = await u.post(`/api/clientes/${id}/sincronizar`);
  assert.equal(s1.dados.ok, true, JSON.stringify(s1.dados));
  assert.ok(s1.dados.novas >= 8);
  const todas = (await u.get(`/api/clientes/${id}/notas`)).dados;
  assert.equal(todas.total, s1.dados.novas);
  const emit = (await u.get(`/api/clientes/${id}/notas?direcao=emitida`)).dados.itens;
  const rec = (await u.get(`/api/clientes/${id}/notas?direcao=recebida`)).dados.itens;
  assert.ok(emit.length > 0 && rec.length > 0 && emit.length + rec.length === todas.total);
  assert.ok(emit.every((n) => n.prestador_cnpj === CNPJ) && rec.every((n) => n.tomador_doc === CNPJ));
  const s2 = await u.post(`/api/clientes/${id}/sincronizar`);
  assert.equal(s2.dados.novas, 0);
  assert.equal((await u.get(`/api/clientes/${id}/notas`)).dados.total, todas.total);
  assert.ok(!(await u.get('/api/alertas')).dados.itens.some((a) => a.tipo === 'sem_certificado'), 'alerta de certificado some ao enviar o certificado');
});

test('nota nova de fornecedor novo e cancelamento geram alertas', async () => {
  const forn = { cnpj: cnpjComDv('777666550001'), nome: 'Fornecedor Inédito SA' };
  const chave = amb.simulador.adicionar(CNPJ, { direcao: 'recebida', data: '2026-11-20', contraparte: forn });
  const alvo = (await u.get(`/api/clientes/${id}/notas?direcao=emitida`)).dados.itens[0];
  amb.simulador.cancelar(CNPJ, alvo.chave_acesso);
  const s = await u.post(`/api/clientes/${id}/sincronizar`);
  assert.equal(s.dados.novas, 1); assert.equal(s.dados.canceladas, 1);
  const tipos = (await u.get('/api/alertas')).dados.itens.map((a) => a.tipo);
  assert.ok(tipos.includes('fornecedor_novo') && tipos.includes('nota_cancelada'));
  assert.equal((await u.get(`/api/clientes/${id}/notas?direcao=emitida`)).dados.itens.find((n) => n.id === alvo.id).status, 'cancelada');
  assert.ok(chave);
});

test('cliente sem nota no mês anterior gera alerta', async () => {
  const outroCnpj = cnpjComDv('888777660001');
  const id2 = (await u.post('/api/clientes', { cnpj: outroCnpj, razao_social: 'Sem Movimento' })).dados.id;
  // esse CNPJ não tem notas no simulador: zere o que foi semeado usando outro cliente sem semente
  const pfx = gerarPfx(amb.dir);
  await u.put(`/api/clientes/${id2}/certificado`, { pfx_base64: pfx.base64, senha: pfx.senha });
  amb.db.exec('DELETE FROM notas WHERE cliente_id = ' + id2);
  const antes = amb.simulador; // semeado automaticamente na 1ª consulta; removemos as notas do mês anterior no banco
  await u.post(`/api/clientes/${id2}/sincronizar`);
  amb.db.exec(`DELETE FROM notas WHERE cliente_id = ${id2} AND competencia = '2026-10'`);
  await u.post(`/api/clientes/${id2}/sincronizar`); // nsu já avançou: nada reinserido
  assert.ok((await u.get('/api/alertas')).dados.itens.some((a) => a.tipo === 'sem_nota_no_mes' && a.cliente_id === id2));
  assert.ok(antes);
});

test('ZIP do mês é válido e organizado por cliente/mês/direção', async () => {
  const r = await u.get(`/api/clientes/${id}/zip?competencia=2026-10`);
  assert.equal(r.status, 200); assert.equal(r.tipo, 'application/zip');
  const lista = nomesDoZip(r.dados).join('\n');
  assert.match(lista, new RegExp(`${CNPJ}-Cliente_Um_Ltda/2026-10/emitidas/`));
  assert.match(lista, /\/recebidas\//); assert.match(lista, /resumo\.csv/);
  assert.equal((await u.get(`/api/clientes/${id}/zip?competencia=2020-01`)).status, 404);
});

test('modo "certificado do escritório" usa o certificado do escritório com o CNPJ do cliente', async () => {
  const cnpj3 = cnpjComDv('666555440001');
  const id3 = (await u.post('/api/clientes', { cnpj: cnpj3, razao_social: 'Via Certificado do Escritório', modo_cert: 'escritorio' })).dados.id;
  assert.equal((await u.post(`/api/clientes/${id3}/sincronizar`)).dados.ok, false);
  const pfx = gerarPfx(amb.dir, { cn: 'ESCRITORIO CONTABIL:99888777000166' });
  assert.equal((await u.put('/api/certificado-escritorio', { pfx_base64: pfx.base64, senha: pfx.senha })).status, 200);
  const s = await u.post(`/api/clientes/${id3}/sincronizar`);
  assert.equal(s.dados.ok, true, JSON.stringify(s.dados)); assert.ok(s.dados.novas > 0);
});

test('erro temporário do ADN não perde posição e a próxima tentativa conclui', async () => {
  amb.simulador.adicionar(CNPJ, { direcao: 'emitida', data: '2026-11-21' });
  amb.simulador.falhas.proxima = 503;
  const r1 = await u.post(`/api/clientes/${id}/sincronizar`);
  assert.equal(r1.dados.ok, false); assert.equal(r1.dados.transitorio, true);
  const r2 = await u.post(`/api/clientes/${id}/sincronizar`);
  assert.equal(r2.dados.ok, true); assert.equal(r2.dados.novas, 1);
});

test('painel resume a situação do escritório', async () => {
  const p = (await u.get('/api/painel')).dados;
  assert.equal(p.totais.clientes, 3); assert.ok(p.totais.notas_mes > 0); assert.ok(p.totais.alertas_abertos > 0);
});
