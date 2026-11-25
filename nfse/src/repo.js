'use strict';
const { transacao } = require('./db');

// Camada de dados "do escritório". O tenant_id vem SEMPRE da sessão autenticada (nunca do corpo
// ou da URL) e entra em todas as consultas: quem tem uma instância deste objeto só enxerga o
// próprio escritório. IDs de outro escritório se comportam como inexistentes (null / 0 linhas).
function escopo(db, tid) {
  const un = (sql, ...p) => db.prepare(sql).get(...p) ?? null;
  const todos = (sql, ...p) => db.prepare(sql).all(...p);
  const exec = (sql, ...p) => db.prepare(sql).run(...p);

  const clientes = {
    listar(competencia) {
      return todos(`
        SELECT c.id, c.cnpj, c.razao_social, c.modo_cert, c.criado_em,
          (SELECT count(*) FROM notas n WHERE n.tenant_id = c.tenant_id AND n.cliente_id = c.id AND n.competencia = ?) AS notas_mes,
          (SELECT count(*) FROM notas n WHERE n.tenant_id = c.tenant_id AND n.cliente_id = c.id) AS notas_total,
          (SELECT count(*) FROM alertas a WHERE a.tenant_id = c.tenant_id AND a.cliente_id = c.id AND a.resolvido = 0) AS alertas_abertos,
          ce.validade AS cert_validade,
          s.ultima_execucao, s.ultimo_erro
        FROM clientes c
        LEFT JOIN certificados ce ON ce.tenant_id = c.tenant_id AND ce.cliente_id = c.id
        LEFT JOIN sync_estado s ON s.tenant_id = c.tenant_id AND s.cliente_id = c.id
        WHERE c.tenant_id = ? AND c.ativo = 1
        ORDER BY c.razao_social COLLATE NOCASE`, competencia, tid);
    },
    obter: (id) => un('SELECT * FROM clientes WHERE tenant_id = ? AND id = ? AND ativo = 1', tid, id),
    porCnpj: (cnpj) => un('SELECT * FROM clientes WHERE tenant_id = ? AND cnpj = ?', tid, cnpj),
    criar({ cnpj, razao_social, modo_cert }) {
      const r = exec('INSERT INTO clientes (tenant_id, cnpj, razao_social, modo_cert) VALUES (?,?,?,?)', tid, cnpj, razao_social, modo_cert);
      return Number(r.lastInsertRowid);
    },
    reativar: (id) => exec('UPDATE clientes SET ativo = 1 WHERE tenant_id = ? AND id = ?', tid, id).changes,
    atualizar(id, { razao_social, modo_cert }) {
      return exec('UPDATE clientes SET razao_social = ?, modo_cert = ? WHERE tenant_id = ? AND id = ? AND ativo = 1', razao_social, modo_cert, tid, id).changes;
    },
    arquivar: (id) => exec('UPDATE clientes SET ativo = 0 WHERE tenant_id = ? AND id = ?', tid, id).changes,
    ativos: () => todos('SELECT * FROM clientes WHERE tenant_id = ? AND ativo = 1 ORDER BY id', tid),
  };

  const certificados = {
    // Certificado do cliente (clienteId) ou do escritório (null).
    obter: (clienteId) => clienteId == null
      ? un('SELECT * FROM certificados WHERE tenant_id = ? AND cliente_id IS NULL', tid)
      : un('SELECT * FROM certificados WHERE tenant_id = ? AND cliente_id = ?', tid, clienteId),
    meta: (clienteId) => {
      const c = certificados.obter(clienteId);
      return c && { nome_arquivo: c.nome_arquivo, titular: c.titular, cnpj_titular: c.cnpj_titular, validade: c.validade, criado_em: c.criado_em };
    },
    salvar(clienteId, c) {
      transacao(db, () => {
        certificados.remover(clienteId);
        exec(`INSERT INTO certificados (tenant_id, cliente_id, nome_arquivo, titular, cnpj_titular, validade, pfx_cifrado, senha_cifrada)
              VALUES (?,?,?,?,?,?,?,?)`, tid, clienteId, c.nome_arquivo, c.titular, c.cnpj_titular, c.validade, c.pfx_cifrado, c.senha_cifrada);
      });
    },
    remover: (clienteId) => clienteId == null
      ? exec('DELETE FROM certificados WHERE tenant_id = ? AND cliente_id IS NULL', tid).changes
      : exec('DELETE FROM certificados WHERE tenant_id = ? AND cliente_id = ?', tid, clienteId).changes,
  };

  const notas = {
    listar(clienteId, { competencia, direcao, status, limite = 100, deslocamento = 0 } = {}) {
      const w = ['tenant_id = ?', 'cliente_id = ?']; const p = [tid, clienteId];
      if (competencia) { w.push('competencia = ?'); p.push(competencia); }
      if (direcao) { w.push('direcao = ?'); p.push(direcao); }
      if (status) { w.push('status = ?'); p.push(status); }
      const onde = w.join(' AND ');
      const itens = todos(`SELECT id, chave_acesso, direcao, numero, competencia, data_emissao, prestador_cnpj, prestador_nome,
          tomador_doc, tomador_nome, valor_centavos, status, (pdf IS NOT NULL) AS tem_pdf
        FROM notas WHERE ${onde} ORDER BY data_emissao DESC, id DESC LIMIT ? OFFSET ?`, ...p, limite, deslocamento);
      const total = un(`SELECT count(*) AS n FROM notas WHERE ${onde}`, ...p).n;
      return { itens, total };
    },
    obter: (id) => un('SELECT * FROM notas WHERE tenant_id = ? AND id = ?', tid, id),
    doMes: (clienteId, competencia) => todos('SELECT * FROM notas WHERE tenant_id = ? AND cliente_id = ? AND competencia = ? ORDER BY direcao, data_emissao, id', tid, clienteId, competencia),
    porChave: (clienteId, chave) => un('SELECT id, status FROM notas WHERE tenant_id = ? AND cliente_id = ? AND chave_acesso = ?', tid, clienteId, chave),
    inserir(clienteId, n) {
      const r = exec(`INSERT OR IGNORE INTO notas (tenant_id, cliente_id, chave_acesso, nsu, direcao, numero, competencia, data_emissao,
          prestador_cnpj, prestador_nome, tomador_doc, tomador_nome, valor_centavos, status, xml)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, tid, clienteId, n.chave_acesso, n.nsu ?? null, n.direcao, n.numero, n.competencia, n.data_emissao,
        n.prestador_cnpj, n.prestador_nome, n.tomador_doc, n.tomador_nome, n.valor_centavos, n.status || 'normal', n.xml);
      return r.changes === 1;
    },
    marcarCancelada: (clienteId, chave) => exec("UPDATE notas SET status = 'cancelada' WHERE tenant_id = ? AND cliente_id = ? AND chave_acesso = ? AND status <> 'cancelada'", tid, clienteId, chave).changes,
    guardarPdf: (id, pdf) => exec('UPDATE notas SET pdf = ? WHERE tenant_id = ? AND id = ?', pdf, tid, id),
    fornecedorConhecido: (clienteId, cnpj) => !!un("SELECT 1 AS x FROM notas WHERE tenant_id = ? AND cliente_id = ? AND direcao = 'recebida' AND prestador_cnpj = ? LIMIT 1", tid, clienteId, cnpj),
    contarMes: (clienteId, competencia) => un('SELECT count(*) AS n FROM notas WHERE tenant_id = ? AND cliente_id = ? AND competencia = ?', tid, clienteId, competencia).n,
    totalMes: (competencia) => un('SELECT count(*) AS n FROM notas WHERE tenant_id = ? AND competencia = ?', tid, competencia).n,
  };

  const sync = {
    estado: (clienteId) => un('SELECT * FROM sync_estado WHERE tenant_id = ? AND cliente_id = ?', tid, clienteId),
    salvar(clienteId, { ultimo_nsu, erro }) {
      exec(`INSERT INTO sync_estado (cliente_id, tenant_id, ultimo_nsu, ultima_execucao, ultimo_erro)
            VALUES (?,?,?,datetime('now'),?)
            ON CONFLICT(cliente_id) DO UPDATE SET ultimo_nsu = excluded.ultimo_nsu, ultima_execucao = excluded.ultima_execucao, ultimo_erro = excluded.ultimo_erro
            WHERE sync_estado.tenant_id = excluded.tenant_id`, clienteId, tid, ultimo_nsu, erro ?? null);
    },
  };

  const alertas = {
    listar({ resolvido = 0, limite = 200 } = {}) {
      return todos(`SELECT a.id, a.cliente_id, c.razao_social, c.cnpj, a.tipo, a.referencia, a.mensagem, a.resolvido, a.criado_em
        FROM alertas a JOIN clientes c ON c.tenant_id = a.tenant_id AND c.id = a.cliente_id
        WHERE a.tenant_id = ? AND a.resolvido = ? ORDER BY a.id DESC LIMIT ?`, tid, resolvido ? 1 : 0, limite);
    },
    criar(clienteId, tipo, referencia, mensagem) {
      return exec('INSERT OR IGNORE INTO alertas (tenant_id, cliente_id, tipo, referencia, mensagem) VALUES (?,?,?,?,?)', tid, clienteId, tipo, referencia, mensagem).changes === 1;
    },
    resolver: (id) => exec('UPDATE alertas SET resolvido = 1 WHERE tenant_id = ? AND id = ?', tid, id).changes,
    resolverPorTipo: (clienteId, tipo) => exec('UPDATE alertas SET resolvido = 1 WHERE tenant_id = ? AND cliente_id = ? AND tipo = ? AND resolvido = 0', tid, clienteId, tipo).changes,
    abertos: () => un('SELECT count(*) AS n FROM alertas WHERE tenant_id = ? AND resolvido = 0', tid).n,
  };

  const usuarios = {
    listar: () => todos('SELECT id, email, nome, papel, ativo, criado_em FROM usuarios WHERE tenant_id = ? ORDER BY nome COLLATE NOCASE', tid),
    obter: (id) => un('SELECT id, email, nome, papel, ativo FROM usuarios WHERE tenant_id = ? AND id = ?', tid, id),
    criar({ email, nome, senha_hash, papel }) {
      return Number(exec('INSERT INTO usuarios (tenant_id, email, nome, senha_hash, papel) VALUES (?,?,?,?,?)', tid, email, nome, senha_hash, papel).lastInsertRowid);
    },
    atualizar(id, { papel, ativo, senha_hash }) {
      if (senha_hash) exec('UPDATE usuarios SET senha_hash = ? WHERE tenant_id = ? AND id = ?', senha_hash, tid, id);
      return exec('UPDATE usuarios SET papel = COALESCE(?, papel), ativo = COALESCE(?, ativo) WHERE tenant_id = ? AND id = ?', papel ?? null, ativo ?? null, tid, id).changes;
    },
    revogarSessoes: (id) => exec('DELETE FROM sessoes WHERE tenant_id = ? AND usuario_id = ?', tid, id).changes,
    donosAtivos: () => un("SELECT count(*) AS n FROM usuarios WHERE tenant_id = ? AND papel = 'dono' AND ativo = 1", tid).n,
  };

  return { tid, clientes, certificados, notas, sync, alertas, usuarios };
}

// Operações de plataforma (fora de qualquer escritório): cadastro e login.
function plataforma(db) {
  const un = (sql, ...p) => db.prepare(sql).get(...p) ?? null;
  const exec = (sql, ...p) => db.prepare(sql).run(...p);
  return {
    criarEscritorio({ escritorio, nome, email, senha_hash }) {
      return transacao(db, () => {
        const tid = Number(exec('INSERT INTO escritorios (nome) VALUES (?)', escritorio).lastInsertRowid);
        const uid = Number(exec("INSERT INTO usuarios (tenant_id, email, nome, senha_hash, papel) VALUES (?,?,?,?,'dono')", tid, email, nome, senha_hash).lastInsertRowid);
        return { tid, uid };
      });
    },
    usuarioPorEmail: (email) => un('SELECT * FROM usuarios WHERE email = ?', email),
    escritorio: (id) => un('SELECT id, nome, ativo FROM escritorios WHERE id = ?', id),
    escritoriosAtivos: () => db.prepare('SELECT id FROM escritorios WHERE ativo = 1').all().map((r) => r.id),
    criarSessao: (hash, uid, tid, expira) => exec('INSERT INTO sessoes (token_hash, usuario_id, tenant_id, expira_em) VALUES (?,?,?,?)', hash, uid, tid, expira),
    sessao: (hash) => un(`SELECT s.expira_em, u.id AS uid, u.tenant_id, u.email, u.nome, u.papel, e.nome AS escritorio
      FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id AND u.tenant_id = s.tenant_id
      JOIN escritorios e ON e.id = u.tenant_id
      WHERE s.token_hash = ? AND u.ativo = 1 AND e.ativo = 1`, hash),
    apagarSessao: (hash) => exec('DELETE FROM sessoes WHERE token_hash = ?', hash),
    limparSessoes: () => exec('DELETE FROM sessoes WHERE expira_em < ?', Date.now()),
  };
}

module.exports = { escopo, plataforma };
