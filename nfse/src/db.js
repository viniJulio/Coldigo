'use strict';
const { DatabaseSync } = require('node:sqlite');

// Isolamento entre escritórios: toda tabela de negócio carrega tenant_id, e as chaves
// estrangeiras compostas (tenant_id, cliente_id) impedem, no próprio banco, que uma nota,
// certificado ou alerta de um escritório aponte para um cliente de outro.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS escritorios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES escritorios(id),
  email TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('dono','admin','membro')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tenant_id INTEGER NOT NULL,
  expira_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES escritorios(id),
  cnpj TEXT NOT NULL,
  razao_social TEXT NOT NULL,
  modo_cert TEXT NOT NULL DEFAULT 'proprio' CHECK (modo_cert IN ('proprio','escritorio')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, cnpj),
  UNIQUE (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS certificados (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES escritorios(id),
  cliente_id INTEGER,
  nome_arquivo TEXT,
  titular TEXT,
  cnpj_titular TEXT,
  validade TEXT NOT NULL,
  pfx_cifrado BLOB NOT NULL,
  senha_cifrada BLOB NOT NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id, cliente_id) REFERENCES clientes(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cert_cliente ON certificados(tenant_id, cliente_id) WHERE cliente_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cert_escritorio ON certificados(tenant_id) WHERE cliente_id IS NULL;
CREATE TABLE IF NOT EXISTS notas (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  cliente_id INTEGER NOT NULL,
  chave_acesso TEXT NOT NULL,
  nsu INTEGER,
  direcao TEXT NOT NULL CHECK (direcao IN ('emitida','recebida')),
  numero TEXT,
  competencia TEXT NOT NULL,
  data_emissao TEXT,
  prestador_cnpj TEXT, prestador_nome TEXT,
  tomador_doc TEXT, tomador_nome TEXT,
  valor_centavos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','cancelada')),
  xml TEXT NOT NULL,
  pdf BLOB,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, chave_acesso),
  FOREIGN KEY (tenant_id, cliente_id) REFERENCES clientes(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_notas_lista ON notas(tenant_id, cliente_id, competencia, direcao);
CREATE TABLE IF NOT EXISTS sync_estado (
  cliente_id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  ultimo_nsu INTEGER NOT NULL DEFAULT 0,
  ultima_execucao TEXT,
  ultimo_erro TEXT,
  FOREIGN KEY (tenant_id, cliente_id) REFERENCES clientes(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  cliente_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  referencia TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  resolvido INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cliente_id, tipo, referencia),
  FOREIGN KEY (tenant_id, cliente_id) REFERENCES clientes(tenant_id, id) ON DELETE CASCADE
);
`;

function abrir(arquivo) {
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function transacao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { abrir, transacao };
