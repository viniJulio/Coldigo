'use strict';
const { escopo, plataforma } = require('./repo');
const { transacao } = require('./db');
const { chaveDoEscritorio, decifrar } = require('./seguranca');
const { criarClienteAdn } = require('./adn');
const { lerNfse, lerEvento } = require('./xml');
const { competenciaAnterior, fmtCnpj } = require('./util');

const MAX_PAGINAS = 200;
const ehCancelamento = (d) => /101101|cancel/i.test(`${d.tipoEvento ?? ''}`) || /<tpEvento>101101</.test(d.xml);

function criarServicoSync({ db, config, fabricaAdn = criarClienteAdn, agora = () => new Date() }) {
  const emExecucao = new Set(); // `${tid}:${clienteId}` — uma sincronização por cliente por vez

  function abrirCertificado(repo, cliente) {
    const cert = repo.certificados.obter(cliente.modo_cert === 'escritorio' ? null : cliente.id);
    if (!cert) return null;
    const chave = chaveDoEscritorio(config.masterKey, repo.tid);
    const ctx = (fim) => `cert:${repo.tid}:${cert.cliente_id ?? 'escritorio'}:${fim}`;
    return {
      meta: cert,
      pfx: decifrar(chave, cert.pfx_cifrado, ctx('pfx')),
      senha: decifrar(chave, cert.senha_cifrada, ctx('senha')).toString('utf8'),
    };
  }

  // Classifica a nota pela ótica do cliente. Retorna null se o CNPJ do cliente não consta.
  function direcaoPara(cliente, nota) {
    if (nota.prestador_cnpj === cliente.cnpj) return 'emitida';
    if (nota.tomador_doc === cliente.cnpj) return 'recebida';
    const raiz = cliente.cnpj.slice(0, 8);
    if (nota.prestador_cnpj?.startsWith(raiz)) return 'emitida';
    if (nota.tomador_doc?.startsWith(raiz)) return 'recebida';
    return null;
  }

  function processarDocumentos(repo, cliente, docs, primeiraCarga) {
    const r = { novas: 0, canceladas: 0, ignoradas: 0 };
    transacao(db, () => {
      for (const d of docs) {
        if (d.tipoDocumento.toUpperCase().includes('EVENTO')) {
          if (!ehCancelamento(d)) continue;
          const chave = d.chave || lerEvento(d.xml).chave_acesso;
          if (chave && repo.notas.marcarCancelada(cliente.id, chave)) {
            r.canceladas++;
            repo.alertas.criar(cliente.id, 'nota_cancelada', chave, `Nota ${chave} foi cancelada. Reveja a apuração do mês.`);
          }
          continue;
        }
        const n = lerNfse(d.xml);
        n.chave_acesso = n.chave_acesso || d.chave;
        const direcao = direcaoPara(cliente, n);
        if (!n.chave_acesso || !n.competencia || !direcao) { r.ignoradas++; continue; }
        const fornecedorNovo = direcao === 'recebida' && n.prestador_cnpj && !repo.notas.fornecedorConhecido(cliente.id, n.prestador_cnpj);
        if (repo.notas.inserir(cliente.id, { ...n, direcao, nsu: d.nsu, xml: d.xml })) {
          r.novas++;
          if (fornecedorNovo && !primeiraCarga) {
            repo.alertas.criar(cliente.id, 'fornecedor_novo', n.prestador_cnpj, `Fornecedor novo: ${n.prestador_nome || ''} (${fmtCnpj(n.prestador_cnpj)}), nota ${n.numero}.`);
          }
        }
      }
    });
    return r;
  }

  async function sincronizarCliente(tenantId, clienteId) {
    const repo = escopo(db, tenantId);
    const cliente = repo.clientes.obter(clienteId);
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado.' };
    const trava = `${tenantId}:${clienteId}`;
    if (emExecucao.has(trava)) return { ok: false, erro: 'Já existe uma sincronização em andamento para este cliente.' };
    emExecucao.add(trava);
    const estado = repo.sync.estado(clienteId);
    let nsu = estado?.ultimo_nsu ?? 0;
    const primeiraCarga = nsu === 0;
    const total = { novas: 0, canceladas: 0, ignoradas: 0 };
    try {
      const cert = abrirCertificado(repo, cliente);
      if (!cert) {
        repo.alertas.criar(clienteId, 'sem_certificado', 'atual', 'Sem certificado digital cadastrado: não é possível buscar as notas.');
        throw new Error('Sem certificado digital cadastrado.');
      }
      if (cert.meta.validade < agora().toISOString().slice(0, 10)) {
        repo.alertas.criar(clienteId, 'certificado_vencido', cert.meta.validade, `Certificado vencido em ${cert.meta.validade}. Envie um novo.`);
        throw new Error('Certificado vencido.');
      }
      repo.alertas.resolverPorTipo(clienteId, 'sem_certificado');

      const adn = fabricaAdn({ baseUrl: config.adnUrl, pfx: cert.pfx, passphrase: cert.senha });
      for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
        const lote = await adn.buscarLote(nsu, cliente.cnpj);
        if (lote.vazio) break;
        const maior = Math.max(...lote.docs.map((d) => d.nsu));
        const r = processarDocumentos(repo, cliente, lote.docs, primeiraCarga);
        total.novas += r.novas; total.canceladas += r.canceladas; total.ignoradas += r.ignoradas;
        if (maior <= nsu) break; // sem avanço: evita laço infinito
        nsu = maior;
        repo.sync.salvar(clienteId, { ultimo_nsu: nsu });
      }
      verificarMesSemNota(repo, cliente);
      repo.sync.salvar(clienteId, { ultimo_nsu: nsu, erro: null });
      return { ok: true, ...total, ultimo_nsu: nsu };
    } catch (e) {
      repo.sync.salvar(clienteId, { ultimo_nsu: nsu, erro: e.message });
      return { ok: false, erro: e.message, transitorio: !!e.transitorio, ...total };
    } finally {
      emExecucao.delete(trava);
    }
  }

  // Cliente sem nenhuma nota no mês anterior (depois do dia 5) merece atenção.
  function verificarMesSemNota(repo, cliente) {
    const hoje = agora();
    if (hoje.getDate() < 5) return;
    const mes = competenciaAnterior(hoje);
    if (repo.notas.contarMes(cliente.id, mes) === 0) {
      repo.alertas.criar(cliente.id, 'sem_nota_no_mes', mes, `Nenhuma nota (emitida ou recebida) em ${mes}.`);
    }
  }

  async function sincronizarEscritorio(tenantId) {
    const repo = escopo(db, tenantId);
    const resultados = [];
    for (const c of repo.clientes.ativos()) resultados.push({ cliente_id: c.id, ...(await sincronizarCliente(tenantId, c.id)) });
    return resultados;
  }

  // Executa o que estiver pendente (última execução há mais de `horas`). Chamado pelo agendador.
  async function rodarPendentes({ horas = 24 } = {}) {
    const limite = agora().getTime() - horas * 3600_000;
    const p = plataforma(db);
    let feitos = 0;
    for (const tid of p.escritoriosAtivos()) {
      const repo = escopo(db, tid);
      for (const c of repo.clientes.ativos()) {
        const ult = repo.sync.estado(c.id)?.ultima_execucao;
        const quando = ult ? Date.parse(`${ult.replace(' ', 'T')}Z`) : 0;
        if (quando < limite) { await sincronizarCliente(tid, c.id); feitos++; }
      }
    }
    return feitos;
  }

  function iniciarAgendador({ cadaMs = 3600_000 } = {}) {
    const t = setInterval(() => { rodarPendentes().catch((e) => console.error('[agendador]', e.message)); }, cadaMs);
    t.unref();
    return () => clearInterval(t);
  }

  return { sincronizarCliente, sincronizarEscritorio, rodarPendentes, iniciarAgendador, abrirCertificado, estaEmExecucao: (t, c) => emExecucao.has(`${t}:${c}`) };
}

module.exports = { criarServicoSync };
