'use strict';
const { escopo, plataforma } = require('./repo');
const { chaveDoEscritorio, cifrar, hashSenha, confereSenha, novoToken, hashToken } = require('./seguranca');
const { lerPfx } = require('./cert');
const { criarZip } = require('./zip');
const { soDigitos, cnpjValido, fmtCnpj, competenciaDe, competenciaValida, emailValido } = require('./util');
const { criarClienteAdn } = require('./adn');

const SESSAO_MS = 12 * 3600_000;
const COOKIE = 'nfse_sessao';

class Http extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const erro = (status, msg) => new Http(status, msg);

function criarApi({ db, config, sync }) {
  const plat = plataforma(db);
  const tentativas = new Map(); // limitador de login: chave -> [timestamps]

  function limitarLogin(chave) {
    const agora = Date.now();
    const lista = (tentativas.get(chave) || []).filter((t) => agora - t < 15 * 60_000);
    if (lista.length >= 10) throw erro(429, 'Muitas tentativas. Aguarde alguns minutos.');
    lista.push(agora); tentativas.set(chave, lista);
  }

  function abrirSessao(res, uid, tid) {
    const token = novoToken();
    plat.criarSessao(hashToken(token), uid, tid, Date.now() + SESSAO_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSAO_MS / 1000}${config.cookieSeguro ? '; Secure' : ''}`);
  }

  const cookieDe = (req) => (/(?:^|;\s*)nfse_sessao=([\w-]+)/.exec(req.headers.cookie || '') || [])[1];

  function autenticar(req) {
    const token = cookieDe(req);
    if (!token) throw erro(401, 'Entre para continuar.');
    const s = plat.sessao(hashToken(token));
    if (!s || s.expira_em < Date.now()) throw erro(401, 'Sessão expirada. Entre novamente.');
    return { uid: s.uid, tid: s.tenant_id, email: s.email, nome: s.nome, papel: s.papel, escritorio: s.escritorio, token };
  }

  const exigeAdmin = (u) => { if (u.papel === 'membro') throw erro(403, 'Apenas administradores podem fazer isso.'); };
  const comoId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw erro(404, 'Não encontrado.'); return n; };
  const str = (v, max, campo) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || s.length > max) throw erro(400, `${campo} é obrigatório (até ${max} caracteres).`);
    return s;
  };
  const checaSenha = (s) => { if (typeof s !== 'string' || s.length < 10 || s.length > 200) throw erro(400, 'A senha precisa ter pelo menos 10 caracteres.'); return s; };

  const clienteOu404 = (repo, id) => repo.clientes.obter(comoId(id)) || (() => { throw erro(404, 'Cliente não encontrado.'); })();
  const notaOu404 = (repo, id) => repo.notas.obter(comoId(id)) || (() => { throw erro(404, 'Nota não encontrada.'); })();

  async function salvarCertificado(repo, clienteId, corpo) {
    const nome = str(corpo.nome_arquivo || 'certificado.pfx', 200, 'Nome do arquivo');
    const senha = str(corpo.senha, 200, 'Senha do certificado');
    const pfx = Buffer.from(String(corpo.pfx_base64 || ''), 'base64');
    let info;
    try { info = await lerPfx(pfx, senha); } catch (e) { throw erro(400, e.message); }
    if (info.validade < new Date().toISOString().slice(0, 10)) throw erro(400, `Este certificado venceu em ${info.validade}.`);
    const chave = chaveDoEscritorio(config.masterKey, repo.tid);
    const ctx = (fim) => `cert:${repo.tid}:${clienteId ?? 'escritorio'}:${fim}`;
    repo.certificados.salvar(clienteId, {
      nome_arquivo: nome, titular: info.titular, cnpj_titular: info.cnpj_titular, validade: info.validade,
      pfx_cifrado: cifrar(chave, pfx, ctx('pfx')), senha_cifrada: cifrar(chave, Buffer.from(senha, 'utf8'), ctx('senha')),
    });
    if (clienteId != null) repo.alertas.resolverPorTipo(clienteId, 'sem_certificado');
    return repo.certificados.meta(clienteId);
  }

  const nomePasta = (c) => `${c.cnpj}-${c.razao_social.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}`;
  const csv = (linhas) => linhas.map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');

  // ---- tabela de rotas -------------------------------------------------------------------
  // [método, padrão, { publica?, handler(ctx) }]. ctx.repo existe nas rotas autenticadas.
  const rotas = [];
  const r = (metodo, padrao, handler, publica = false) => {
    const nomes = []; const re = new RegExp(`^${padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; })}$`);
    rotas.push({ metodo, re, nomes, handler, publica });
  };

  r('POST', '/api/cadastro', ({ corpo, res, ip }) => {
    if (!config.cadastroAberto) throw erro(403, 'O cadastro de novos escritórios está fechado.');
    limitarLogin(`cadastro:${ip}`);
    const escritorio = str(corpo.escritorio, 120, 'Nome do escritório');
    const nome = str(corpo.nome, 120, 'Seu nome');
    const email = str(corpo.email, 254, 'E-mail').toLowerCase();
    if (!emailValido(email)) throw erro(400, 'E-mail inválido.');
    checaSenha(corpo.senha);
    if (plat.usuarioPorEmail(email)) throw erro(409, 'Este e-mail já está cadastrado.');
    const { tid, uid } = plat.criarEscritorio({ escritorio, nome, email, senha_hash: hashSenha(corpo.senha) });
    abrirSessao(res, uid, tid);
    return { ok: true };
  }, true);

  r('POST', '/api/login', ({ corpo, res, ip }) => {
    const email = String(corpo.email || '').trim().toLowerCase();
    limitarLogin(`login:${ip}:${email}`);
    const u = plat.usuarioPorEmail(email);
    const ok = confereSenha(String(corpo.senha || ''), u?.senha_hash);
    if (!u || !ok || !u.ativo || !plat.escritorio(u.tenant_id)?.ativo) throw erro(401, 'E-mail ou senha incorretos.');
    abrirSessao(res, u.id, u.tenant_id);
    return { ok: true };
  }, true);

  r('POST', '/api/logout', ({ req, res }) => {
    const t = cookieDe(req); if (t) plat.apagarSessao(hashToken(t));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  }, true);

  r('GET', '/api/eu', ({ user }) => ({ nome: user.nome, email: user.email, papel: user.papel, escritorio: user.escritorio, modo_adn: config.modoAdn }));

  r('GET', '/api/painel', ({ repo }) => {
    const mes = competenciaDe(new Date());
    const clientes = repo.clientes.listar(mes);
    const hoje = new Date().toISOString().slice(0, 10);
    const em30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const certEsc = repo.certificados.meta(null);
    const validadeEfetiva = (c) => (c.modo_cert === 'escritorio' ? certEsc?.validade : c.cert_validade) || null;
    return {
      competencia: mes,
      clientes: clientes.map((c) => ({ ...c, cert_validade: validadeEfetiva(c), cnpj_fmt: fmtCnpj(c.cnpj) })),
      totais: {
        clientes: clientes.length,
        notas_mes: repo.notas.totalMes(mes),
        alertas_abertos: repo.alertas.abertos(),
        sem_certificado: clientes.filter((c) => !validadeEfetiva(c)).length,
        certificados_vencendo: clientes.filter((c) => { const v = validadeEfetiva(c); return v && v <= em30; }).length,
        certificados_vencidos: clientes.filter((c) => { const v = validadeEfetiva(c); return v && v < hoje; }).length,
      },
    };
  });

  // Clientes
  r('POST', '/api/clientes', ({ repo, user, corpo }) => {
    exigeAdmin(user);
    const cnpj = soDigitos(corpo.cnpj);
    if (!cnpjValido(cnpj)) throw erro(400, 'CNPJ inválido.');
    const razao = str(corpo.razao_social, 200, 'Razão social');
    const modo = corpo.modo_cert === 'escritorio' ? 'escritorio' : 'proprio';
    const existente = repo.clientes.porCnpj(cnpj);
    if (existente) {
      if (existente.ativo) throw erro(409, 'Este CNPJ já está cadastrado.');
      repo.clientes.reativar(existente.id); repo.clientes.atualizar(existente.id, { razao_social: razao, modo_cert: modo });
      return { id: existente.id };
    }
    return { id: repo.clientes.criar({ cnpj, razao_social: razao, modo_cert: modo }) };
  });

  r('GET', '/api/clientes/:id', ({ repo, params }) => {
    const c = clienteOu404(repo, params.id);
    return {
      id: c.id, cnpj: c.cnpj, cnpj_fmt: fmtCnpj(c.cnpj), razao_social: c.razao_social, modo_cert: c.modo_cert,
      certificado: repo.certificados.meta(c.id), certificado_escritorio: repo.certificados.meta(null),
      sync: repo.sync.estado(c.id), em_execucao: sync.estaEmExecucao(repo.tid, c.id),
    };
  });

  r('PATCH', '/api/clientes/:id', ({ repo, user, params, corpo }) => {
    exigeAdmin(user);
    const c = clienteOu404(repo, params.id);
    repo.clientes.atualizar(c.id, {
      razao_social: corpo.razao_social === undefined ? c.razao_social : str(corpo.razao_social, 200, 'Razão social'),
      modo_cert: corpo.modo_cert === undefined ? c.modo_cert : (corpo.modo_cert === 'escritorio' ? 'escritorio' : 'proprio'),
    });
    return { ok: true };
  });

  r('DELETE', '/api/clientes/:id', ({ repo, user, params }) => { exigeAdmin(user); repo.clientes.arquivar(clienteOu404(repo, params.id).id); return { ok: true }; });

  r('PUT', '/api/clientes/:id/certificado', ({ repo, user, params, corpo }) => {
    exigeAdmin(user);
    const c = clienteOu404(repo, params.id);
    return salvarCertificado(repo, c.id, corpo);
  });
  r('DELETE', '/api/clientes/:id/certificado', ({ repo, user, params }) => { exigeAdmin(user); repo.certificados.remover(clienteOu404(repo, params.id).id); return { ok: true }; });

  r('GET', '/api/certificado-escritorio', ({ repo }) => ({ certificado: repo.certificados.meta(null) }));
  r('PUT', '/api/certificado-escritorio', ({ repo, user, corpo }) => { exigeAdmin(user); return salvarCertificado(repo, null, corpo); });
  r('DELETE', '/api/certificado-escritorio', ({ repo, user }) => { exigeAdmin(user); repo.certificados.remover(null); return { ok: true }; });

  // Notas
  r('GET', '/api/clientes/:id/notas', ({ repo, params, query }) => {
    const c = clienteOu404(repo, params.id);
    const competencia = query.get('competencia') || undefined;
    if (competencia && !competenciaValida(competencia)) throw erro(400, 'Competência inválida (use AAAA-MM).');
    const direcao = ['emitida', 'recebida'].includes(query.get('direcao')) ? query.get('direcao') : undefined;
    const pagina = Math.max(1, Number(query.get('pagina')) || 1);
    const limite = 50;
    const { itens, total } = repo.notas.listar(c.id, { competencia, direcao, limite, deslocamento: (pagina - 1) * limite });
    return { itens, total, pagina, por_pagina: limite };
  });

  const baixar = (res, nome, tipo, dados) => ({ __arquivo: { nome, tipo, dados } });
  r('GET', '/api/notas/:id/xml', ({ repo, params, res }) => {
    const n = notaOu404(repo, params.id);
    return baixar(res, `NFSe-${n.chave_acesso}.xml`, 'application/xml; charset=utf-8', n.xml);
  });

  r('GET', '/api/notas/:id/pdf', async ({ repo, params }) => {
    const n = notaOu404(repo, params.id);
    if (n.pdf) return baixar(null, `DANFSe-${n.chave_acesso}.pdf`, 'application/pdf', Buffer.from(n.pdf));
    const cliente = repo.clientes.obter(n.cliente_id);
    const cert = sync.abrirCertificado(repo, cliente);
    if (!cert) throw erro(409, 'Sem certificado para buscar o PDF.');
    let pdf = null;
    try { pdf = await criarClienteAdn({ baseUrl: config.adnUrl, pfx: cert.pfx, passphrase: cert.senha }).baixarPdf(n.chave_acesso); } catch { /* melhor esforço */ }
    if (!pdf) throw erro(404, 'O PDF (DANFSe) não está disponível no portal agora. O XML continua disponível.');
    repo.notas.guardarPdf(n.id, pdf);
    return baixar(null, `DANFSe-${n.chave_acesso}.pdf`, 'application/pdf', pdf);
  });

  // ZIP do mês: <cnpj-cliente>/<AAAA-MM>/<emitidas|recebidas>/<numero>-<chave>.xml + resumo.csv
  r('GET', '/api/clientes/:id/zip', ({ repo, params, query }) => {
    const c = clienteOu404(repo, params.id);
    const comp = query.get('competencia');
    if (!competenciaValida(comp)) throw erro(400, 'Informe a competência (AAAA-MM).');
    const notas = repo.notas.doMes(c.id, comp);
    if (!notas.length) throw erro(404, 'Nenhuma nota nesta competência.');
    const base = `${nomePasta(c)}/${comp}`;
    const entradas = notas.map((n) => ({ nome: `${base}/${n.direcao === 'emitida' ? 'emitidas' : 'recebidas'}/${String(n.numero || 's-n').replace(/\W/g, '')}-${n.chave_acesso}${n.status === 'cancelada' ? '-CANCELADA' : ''}.xml`, dados: n.xml }));
    entradas.push({ nome: `${base}/resumo.csv`, dados: '﻿' + csv([
      ['direcao', 'numero', 'data_emissao', 'prestador_cnpj', 'prestador', 'tomador_doc', 'tomador', 'valor', 'status', 'chave_acesso'],
      ...notas.map((n) => [n.direcao, n.numero, n.data_emissao, n.prestador_cnpj, n.prestador_nome, n.tomador_doc, n.tomador_nome, (n.valor_centavos / 100).toFixed(2).replace('.', ','), n.status, n.chave_acesso]),
    ]) });
    return baixar(null, `${nomePasta(c)}_${comp}.zip`, 'application/zip', criarZip(entradas));
  });

  // Sincronização
  r('POST', '/api/clientes/:id/sincronizar', async ({ repo, params }) => sync.sincronizarCliente(repo.tid, clienteOu404(repo, params.id).id));
  r('POST', '/api/sincronizar', ({ repo }) => {
    sync.sincronizarEscritorio(repo.tid).catch((e) => console.error('[sync]', e.message));
    return { iniciado: true };
  });

  // Alertas
  r('GET', '/api/alertas', ({ repo, query }) => ({ itens: repo.alertas.listar({ resolvido: query.get('resolvido') === '1' }) }));
  r('POST', '/api/alertas/:id/resolver', ({ repo, params }) => { if (!repo.alertas.resolver(comoId(params.id))) throw erro(404, 'Alerta não encontrado.'); return { ok: true }; });

  // Equipe
  r('GET', '/api/usuarios', ({ repo, user }) => { exigeAdmin(user); return { itens: repo.usuarios.listar() }; });
  r('POST', '/api/usuarios', ({ repo, user, corpo }) => {
    exigeAdmin(user);
    const email = str(corpo.email, 254, 'E-mail').toLowerCase();
    if (!emailValido(email)) throw erro(400, 'E-mail inválido.');
    if (plat.usuarioPorEmail(email)) throw erro(409, 'Este e-mail já está em uso.');
    const papel = corpo.papel === 'admin' ? 'admin' : 'membro';
    if (papel === 'admin' && user.papel !== 'dono') throw erro(403, 'Só o dono cria administradores.');
    return { id: repo.usuarios.criar({ email, nome: str(corpo.nome, 120, 'Nome'), senha_hash: hashSenha(checaSenha(corpo.senha)), papel }) };
  });
  r('PATCH', '/api/usuarios/:id', ({ repo, user, params, corpo }) => {
    exigeAdmin(user);
    const alvo = repo.usuarios.obter(comoId(params.id));
    if (!alvo) throw erro(404, 'Usuário não encontrado.');
    if (alvo.papel === 'dono' && user.papel !== 'dono') throw erro(403, 'Só o dono altera o dono.');
    const mudanca = {};
    if (corpo.papel !== undefined) {
      if (!['admin', 'membro'].includes(corpo.papel)) throw erro(400, 'Papel inválido.');
      if (alvo.papel === 'dono') throw erro(400, 'O papel do dono não muda.');
      if (corpo.papel === 'admin' && user.papel !== 'dono') throw erro(403, 'Só o dono cria administradores.');
      mudanca.papel = corpo.papel;
    }
    if (corpo.ativo !== undefined) {
      if (alvo.papel === 'dono' || alvo.id === user.uid) throw erro(400, 'Esta conta não pode ser desativada aqui.');
      mudanca.ativo = corpo.ativo ? 1 : 0;
    }
    if (corpo.senha !== undefined) mudanca.senha_hash = hashSenha(checaSenha(corpo.senha));
    repo.usuarios.atualizar(alvo.id, mudanca);
    if (mudanca.ativo === 0 || mudanca.senha_hash) repo.usuarios.revogarSessoes(alvo.id);
    return { ok: true };
  });

  // ---- despacho --------------------------------------------------------------------------
  async function tratar(req, res, url, lerCorpo) {
    const rota = rotas.find((x) => x.metodo === req.method && x.re.test(url.pathname));
    if (!rota) {
      if (rotas.some((x) => x.re.test(url.pathname))) throw erro(405, 'Método não permitido.');
      throw erro(404, 'Rota não encontrada.');
    }
    if (req.method !== 'GET' && req.headers['x-nfse'] !== '1') throw erro(403, 'Requisição não permitida.');
    const m = rota.re.exec(url.pathname);
    const params = Object.fromEntries(rota.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const ctx = { req, res, params, query: url.searchParams, ip: req.socket.remoteAddress, corpo: req.method === 'GET' ? {} : await lerCorpo() };
    if (!rota.publica) { ctx.user = autenticar(req); ctx.repo = escopo(db, ctx.user.tid); }
    return rota.handler(ctx);
  }

  return { tratar, Http, limparSessoes: () => plat.limparSessoes() };
}

module.exports = { criarApi, Http };
