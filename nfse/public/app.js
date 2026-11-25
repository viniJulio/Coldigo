'use strict';
// Interface do portal. Todo texto vindo do servidor entra no DOM via textContent (nunca innerHTML),
// e a política CSP bloqueia scripts e estilos inline.
const raiz = document.getElementById('app');
let eu = null;

const h = (tag, attrs, ...filhos) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat()) if (f != null && f !== false) el.append(f.nodeType ? f : document.createTextNode(String(f)));
  return el;
};

async function api(metodo, caminho, corpo) {
  const r = await fetch(caminho, {
    method: metodo,
    headers: { ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(metodo !== 'GET' ? { 'X-NFSE': '1' } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const dados = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (r.status === 401 && eu) { eu = null; desenhar(); }
  if (!r.ok) throw new Error(dados?.erro || `Erro ${r.status}`);
  return dados;
}

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (d) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '—');
const mesBr = (m) => (m ? m.split('-').reverse().join('/') : '');
const cnpjFmt = (c) => String(c || '').replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const hoje = () => new Date().toISOString().slice(0, 10);
const mesAtual = () => hoje().slice(0, 7);

function caixa(tipo, msg) { return h('div', { class: `${tipo}-caixa`, role: 'alert' }, msg); }
function avisar(alvo, tipo, msg) { alvo.replaceChildren(msg ? caixa(tipo, msg) : ''); }

function etiquetaCert(validade) {
  if (!validade) return h('span', { class: 'etiqueta perigo' }, 'sem certificado');
  const dias = Math.ceil((Date.parse(validade) - Date.now()) / 86400000);
  if (dias < 0) return h('span', { class: 'etiqueta perigo' }, `vencido em ${dataBr(validade)}`);
  if (dias <= 30) return h('span', { class: 'etiqueta aviso' }, `vence em ${dias} d`);
  return h('span', { class: 'etiqueta ok' }, `válido até ${dataBr(validade)}`);
}

function lerArquivoBase64(arquivo) {
  return new Promise((ok, falha) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1] || '');
    fr.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
    fr.readAsDataURL(arquivo);
  });
}

// ---------- entrada ----------
function telaEntrada() {
  let modo = 'entrar';
  const msg = h('div');
  const corpo = h('div');
  const desenharForm = () => {
    avisar(msg);
    const campo = (id, rotulo, tipo = 'text', extra = {}) => h('div', null, h('label', { for: id }, rotulo), h('input', { id, type: tipo, required: true, ...extra }));
    const cadastro = modo === 'cadastro';
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const v = (id) => form.querySelector(`#${id}`).value;
      try {
        await api('POST', cadastro ? '/api/cadastro' : '/api/login', cadastro
          ? { escritorio: v('escritorio'), nome: v('nome'), email: v('email'), senha: v('senha') } : { email: v('email'), senha: v('senha') });
        await iniciar();
      } catch (err) { avisar(msg, 'erro', err.message); }
    } },
    cadastro && campo('escritorio', 'Nome do escritório', 'text', { maxlength: 120 }), cadastro && campo('nome', 'Seu nome', 'text', { maxlength: 120 }),
    campo('email', 'E-mail', 'email', { autocomplete: 'username' }),
    campo('senha', cadastro ? 'Senha (mínimo 10 caracteres)' : 'Senha', 'password', { autocomplete: cadastro ? 'new-password' : 'current-password', minlength: cadastro ? 10 : 1 }),
    h('button', { type: 'submit' }, cadastro ? 'Criar escritório' : 'Entrar'));
    corpo.replaceChildren(form);
  };
  const aba = (id, rotulo) => h('button', { class: 'sec', type: 'button', onclick: () => { modo = id; desenharForm(); } }, rotulo);
  desenharForm();
  return h('div', { class: 'entrada' }, h('h1', null, 'NFS-e para Contadores'),
    h('p', { class: 'suave' }, 'As notas de serviço de todos os seus clientes, baixadas e organizadas todo dia.'),
    h('div', { class: 'cartao' }, h('div', { class: 'abas' }, aba('entrar', 'Entrar'), aba('cadastro', 'Criar escritório')), msg, corpo));
}

// ---------- estrutura ----------
const ROTAS = [['painel', 'Painel'], ['clientes', 'Clientes'], ['alertas', 'Alertas'], ['equipe', 'Equipe'], ['escritorio', 'Certificado']];
const ehAdmin = () => eu && eu.papel !== 'membro';

function moldura(conteudo, ativa) {
  return h('div', null,
    h('header', { class: 'topo' }, h('span', { class: 'marca' }, 'NFS-e Contadores'), h('span', { class: 'escritorio' }, eu.escritorio),
      h('nav', null, ROTAS.filter(([r]) => ehAdmin() || !['equipe', 'escritorio'].includes(r)).map(([r, n]) => h('a', { href: `#/${r}`, class: ativa === r ? 'ativo' : '' }, n))),
      h('span', { class: 'suave' }, eu.nome), h('button', { class: 'sec', onclick: async () => { await api('POST', '/api/logout', {}); eu = null; desenhar(); } }, 'Sair')),
    eu.modo_adn === 'simulador' ? h('div', { class: 'aviso-caixa' }, 'Modo de teste: as notas vêm de um ADN simulado (dados fictícios), não do Portal Nacional.') : null,
    h('main', { class: 'conteudo' }, conteudo));
}

// ---------- painel ----------
async function paginaPainel() {
  const p = await api('GET', '/api/painel');
  const t = p.totais;
  const cartao = (n, l, cls) => h('div', { class: 'cartao' }, h('div', { class: `numero ${cls || ''}` }, n), h('div', { class: 'legenda' }, l));
  const msg = h('div'); const btn = h('button', { onclick: async () => {
    btn.disabled = true; try { await api('POST', '/api/sincronizar', {}); avisar(msg, 'ok', 'Sincronização iniciada. Atualize em alguns instantes.'); } catch (e) { avisar(msg, 'erro', e.message); } btn.disabled = false;
  } }, 'Sincronizar todos agora');
  return h('div', null, h('h1', null, `Fechamento de ${mesBr(p.competencia)}`),
    h('div', { class: 'grade' }, cartao(t.clientes, 'clientes ativos'), cartao(t.notas_mes, 'notas no mês'), cartao(t.alertas_abertos, 'alertas abertos'),
      cartao(t.sem_certificado, 'sem certificado'), cartao(t.certificados_vencendo, 'certificados vencendo (30 dias)')),
    msg, h('div', { class: 'linha-acoes' }, btn),
    h('div', { class: 'cartao rolagem' }, p.clientes.length ? h('table', null,
      h('thead', null, h('tr', null, ['Cliente', 'CNPJ', 'Certificado', 'Notas no mês', 'Última sincronização', 'Alertas'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
      h('tbody', null, p.clientes.map((c) => h('tr', null,
        h('td', null, h('a', { href: `#/cliente/${c.id}` }, c.razao_social)), h('td', null, c.cnpj_fmt), h('td', null, etiquetaCert(c.cert_validade)),
        h('td', { class: 'num' }, c.notas_mes),
        h('td', null, c.ultimo_erro ? h('span', { class: 'etiqueta perigo', title: c.ultimo_erro }, 'erro') : (c.ultima_execucao ? dataBr(c.ultima_execucao) : h('span', { class: 'suave' }, 'nunca'))),
        h('td', null, c.alertas_abertos ? h('span', { class: 'etiqueta aviso' }, c.alertas_abertos) : '—')))))
      : h('div', { class: 'vazio' }, 'Nenhum cliente ainda. ', h('a', { href: '#/clientes' }, 'Cadastre o primeiro.'))));
}

// ---------- clientes ----------
async function paginaClientes() {
  const p = await api('GET', '/api/painel');
  const msg = h('div');
  const novo = ehAdmin() ? h('form', { class: 'cartao form', onsubmit: async (e) => {
    e.preventDefault(); const f = e.target;
    try { const r = await api('POST', '/api/clientes', { cnpj: f.cnpj.value, razao_social: f.razao.value, modo_cert: f.modo.value }); location.hash = `#/cliente/${r.id}`; }
    catch (err) { avisar(msg, 'erro', err.message); }
  } },
  h('div', null, h('label', null, 'CNPJ'), h('input', { name: 'cnpj', required: true, inputmode: 'numeric', placeholder: '00.000.000/0000-00' })),
  h('div', null, h('label', null, 'Razão social'), h('input', { name: 'razao', required: true, maxlength: 200 })),
  h('div', null, h('label', null, 'Certificado'), h('select', { name: 'modo' }, h('option', { value: 'proprio' }, 'Do próprio cliente'), h('option', { value: 'escritorio' }, 'Do escritório (consulta pelo CNPJ do cliente)'))),
  h('button', { type: 'submit' }, 'Adicionar cliente')) : null;
  return h('div', null, h('h1', null, 'Clientes'), msg, novo,
    h('div', { class: 'cartao rolagem' }, p.clientes.length ? h('table', null,
      h('thead', null, h('tr', null, ['Cliente', 'CNPJ', 'Certificado', 'Notas (total)'].map((x) => h('th', null, x)))),
      h('tbody', null, p.clientes.map((c) => h('tr', null, h('td', null, h('a', { href: `#/cliente/${c.id}` }, c.razao_social)), h('td', null, c.cnpj_fmt), h('td', null, etiquetaCert(c.cert_validade)), h('td', null, c.notas_total)))))
      : h('div', { class: 'vazio' }, 'Nenhum cliente cadastrado.')));
}

// ---------- cliente ----------
async function paginaCliente(id) {
  const c = await api('GET', `/api/clientes/${id}`);
  const msg = h('div');
  const mes = h('input', { type: 'month', value: mesAtual() });
  const dir = h('select', null, h('option', { value: '' }, 'Emitidas e recebidas'), h('option', { value: 'emitida' }, 'Emitidas'), h('option', { value: 'recebida' }, 'Recebidas'));
  const tabela = h('div', { class: 'cartao rolagem' });
  const efetivo = c.modo_cert === 'escritorio' ? c.certificado_escritorio : c.certificado;

  async function carregar() {
    const q = new URLSearchParams(); if (mes.value) q.set('competencia', mes.value); if (dir.value) q.set('direcao', dir.value);
    try {
      const r = await api('GET', `/api/clientes/${id}/notas?${q}`);
      tabela.replaceChildren(r.itens.length ? h('div', null,
        h('table', null, h('thead', null, h('tr', null, ['Tipo', 'Nº', 'Emissão', 'Contraparte', 'Situação'].map((x) => h('th', null, x)), h('th', { class: 'num' }, 'Valor'), h('th', null, 'Arquivos'))),
          h('tbody', null, r.itens.map((n) => h('tr', null,
            h('td', null, n.direcao === 'emitida' ? 'Emitida' : 'Recebida'), h('td', null, n.numero), h('td', null, dataBr(n.data_emissao)),
            h('td', null, n.direcao === 'emitida' ? (n.tomador_nome || cnpjFmt(n.tomador_doc)) : `${n.prestador_nome || ''} ${cnpjFmt(n.prestador_cnpj)}`),
            h('td', null, n.status === 'cancelada' ? h('span', { class: 'etiqueta perigo' }, 'cancelada') : h('span', { class: 'etiqueta ok' }, 'normal')),
            h('td', { class: 'num' }, brl(n.valor_centavos)),
            h('td', null, h('span', null, h('a', { href: `/api/notas/${n.id}/xml` }, 'XML'), ' · ', h('a', { href: `/api/notas/${n.id}/pdf` }, 'PDF'))))))),
        h('p', { class: 'suave' }, `${r.total} nota(s)${r.total > r.itens.length ? `, mostrando as ${r.itens.length} mais recentes` : ''}.`))
        : h('div', { class: 'vazio' }, 'Nenhuma nota neste filtro.'));
      rotularTabelas(tabela);
    } catch (e) { avisar(msg, 'erro', e.message); }
  }
  mes.addEventListener('change', carregar); dir.addEventListener('change', carregar);

  const sinc = h('button', { onclick: async () => {
    sinc.disabled = true; sinc.textContent = 'Sincronizando…';
    try {
      const r = await api('POST', `/api/clientes/${id}/sincronizar`, {});
      avisar(msg, r.ok ? 'ok' : 'erro', r.ok ? `Pronto: ${r.novas} nota(s) nova(s), ${r.canceladas} cancelada(s).` : r.erro);
      await carregar();
    } catch (e) { avisar(msg, 'erro', e.message); }
    sinc.disabled = false; sinc.textContent = 'Sincronizar agora';
  } }, 'Sincronizar agora');

  const zip = h('a', { class: 'botao sec', href: '#', onclick: (e) => { e.preventDefault(); if (!mes.value) return avisar(msg, 'erro', 'Escolha o mês.'); location.href = `/api/clientes/${id}/zip?competencia=${mes.value}`; } }, 'Baixar ZIP do mês');

  let certCartao = null;
  if (ehAdmin()) {
    const arq = h('input', { type: 'file', accept: '.pfx,.p12' }); const senha = h('input', { type: 'password', autocomplete: 'off' });
    const m2 = h('div');
    certCartao = h('div', { class: 'cartao' }, h('h2', null, 'Certificado digital A1'),
      h('p', null, 'Em uso: ', c.modo_cert === 'escritorio' ? 'certificado do escritório ' : 'certificado do cliente ', etiquetaCert(efetivo?.validade),
        efetivo?.titular ? h('span', { class: 'suave' }, ` — ${efetivo.titular}`) : null),
      c.modo_cert === 'proprio' ? h('div', null, m2, h('div', { class: 'form' },
        h('div', null, h('label', null, 'Arquivo .pfx / .p12'), arq), h('div', null, h('label', null, 'Senha do certificado'), senha),
        h('button', { onclick: async () => {
          if (!arq.files[0]) return avisar(m2, 'erro', 'Escolha o arquivo do certificado.');
          try { await api('PUT', `/api/clientes/${id}/certificado`, { nome_arquivo: arq.files[0].name, pfx_base64: await lerArquivoBase64(arq.files[0]), senha: senha.value }); senha.value = ''; router(); }
          catch (e) { avisar(m2, 'erro', e.message); }
        } }, 'Enviar certificado')),
      h('p', { class: 'suave' }, 'O arquivo é guardado cifrado e nunca volta para a tela.')) : h('p', { class: 'suave' }, 'A consulta usa o certificado do escritório, informando o CNPJ deste cliente. Se o portal não aceitar, troque para certificado próprio.'),
      h('div', { class: 'linha-acoes' },
        h('select', { onchange: async (e) => { try { await api('PATCH', `/api/clientes/${id}`, { modo_cert: e.target.value }); router(); } catch (err) { avisar(msg, 'erro', err.message); } } },
          h('option', { value: 'proprio', selected: c.modo_cert === 'proprio' }, 'Usar certificado do cliente'), h('option', { value: 'escritorio', selected: c.modo_cert === 'escritorio' }, 'Usar certificado do escritório')),
        h('button', { class: 'perigo', onclick: async () => { if (confirm(`Arquivar ${c.razao_social}? As notas deixam de aparecer.`)) { await api('DELETE', `/api/clientes/${id}`); location.hash = '#/clientes'; } } }, 'Arquivar cliente')));
  }

  carregar();
  return h('div', null, h('p', null, h('a', { href: '#/clientes' }, '← Clientes')), h('h1', null, c.razao_social), h('p', { class: 'suave' }, c.cnpj_fmt),
    c.sync?.ultimo_erro ? caixa('erro', `Última sincronização falhou: ${c.sync.ultimo_erro}`) : null, msg, certCartao,
    h('div', { class: 'cartao' }, h('h2', null, 'Notas'), h('div', { class: 'form' }, h('div', null, h('label', null, 'Competência'), mes), h('div', null, h('label', null, 'Tipo'), dir)),
      h('div', { class: 'linha-acoes' }, sinc, zip)), tabela);
}

// ---------- alertas ----------
const TIPOS_ALERTA = { nota_cancelada: 'Nota cancelada', fornecedor_novo: 'Fornecedor novo', sem_nota_no_mes: 'Sem nota no mês', sem_certificado: 'Sem certificado', certificado_vencido: 'Certificado vencido' };
async function paginaAlertas() {
  const r = await api('GET', '/api/alertas');
  const msg = h('div');
  return h('div', null, h('h1', null, 'Alertas'), msg, h('div', { class: 'cartao rolagem' }, r.itens.length ? h('table', null,
    h('thead', null, h('tr', null, ['Quando', 'Cliente', 'Tipo', 'Detalhe', ''].map((x) => h('th', null, x)))),
    h('tbody', null, r.itens.map((a) => h('tr', null, h('td', null, dataBr(a.criado_em)), h('td', null, h('a', { href: `#/cliente/${a.cliente_id}` }, a.razao_social)),
      h('td', null, h('span', { class: 'etiqueta aviso' }, TIPOS_ALERTA[a.tipo] || a.tipo)), h('td', null, a.mensagem),
      h('td', null, h('button', { class: 'sec', onclick: async () => { try { await api('POST', `/api/alertas/${a.id}/resolver`, {}); router(); } catch (e) { avisar(msg, 'erro', e.message); } } }, 'Resolver'))))))
    : h('div', { class: 'vazio' }, 'Nada pendente. 🎉')));
}

// ---------- equipe ----------
async function paginaEquipe() {
  const r = await api('GET', '/api/usuarios'); const msg = h('div');
  const form = h('form', { class: 'cartao form', onsubmit: async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('POST', '/api/usuarios', { nome: f.nome.value, email: f.email.value, senha: f.senha.value, papel: f.papel.value }); router(); } catch (err) { avisar(msg, 'erro', err.message); }
  } },
  h('div', null, h('label', null, 'Nome'), h('input', { name: 'nome', required: true })), h('div', null, h('label', null, 'E-mail'), h('input', { name: 'email', type: 'email', required: true })),
  h('div', null, h('label', null, 'Senha inicial (10+ caracteres)'), h('input', { name: 'senha', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
  h('div', null, h('label', null, 'Papel'), h('select', { name: 'papel' }, h('option', { value: 'membro' }, 'Membro (consulta e baixa)'), eu.papel === 'dono' ? h('option', { value: 'admin' }, 'Administrador') : null)),
  h('button', { type: 'submit' }, 'Adicionar pessoa'));
  return h('div', null, h('h1', null, 'Equipe'), msg, form, h('div', { class: 'cartao rolagem' }, h('table', null,
    h('thead', null, h('tr', null, ['Nome', 'E-mail', 'Papel', 'Situação', ''].map((x) => h('th', null, x)))),
    h('tbody', null, r.itens.map((u) => h('tr', null, h('td', null, u.nome), h('td', null, u.email), h('td', null, u.papel), h('td', null, u.ativo ? 'ativo' : h('span', { class: 'etiqueta' }, 'desativado')),
      h('td', null, u.papel === 'dono' ? '' : h('button', { class: 'sec', onclick: async () => { try { await api('PATCH', `/api/usuarios/${u.id}`, { ativo: !u.ativo }); router(); } catch (e) { avisar(msg, 'erro', e.message); } } }, u.ativo ? 'Desativar' : 'Reativar'))))))));
}

// ---------- certificado do escritório ----------
async function paginaEscritorio() {
  const { certificado } = await api('GET', '/api/certificado-escritorio'); const msg = h('div');
  const arq = h('input', { type: 'file', accept: '.pfx,.p12' }); const senha = h('input', { type: 'password', autocomplete: 'off' });
  return h('div', null, h('h1', null, 'Certificado do escritório'),
    h('p', { class: 'suave' }, 'Opcional. Se o Portal Nacional aceitar o certificado do contador para consultar as notas dos clientes (mesma raiz de CNPJ ou procuração), cadastre-o uma vez aqui e marque os clientes como "certificado do escritório".'),
    msg, h('div', { class: 'cartao' }, h('p', null, 'Situação: ', certificado ? etiquetaCert(certificado.validade) : h('span', { class: 'etiqueta' }, 'não cadastrado'), certificado?.titular ? h('span', { class: 'suave' }, ` — ${certificado.titular}`) : null),
      h('div', { class: 'form' }, h('div', null, h('label', null, 'Arquivo .pfx / .p12'), arq), h('div', null, h('label', null, 'Senha'), senha),
        h('button', { onclick: async () => {
          if (!arq.files[0]) return avisar(msg, 'erro', 'Escolha o arquivo.');
          try { await api('PUT', '/api/certificado-escritorio', { nome_arquivo: arq.files[0].name, pfx_base64: await lerArquivoBase64(arq.files[0]), senha: senha.value }); router(); } catch (e) { avisar(msg, 'erro', e.message); }
        } }, certificado ? 'Substituir' : 'Enviar')),
      certificado ? h('div', { class: 'linha-acoes' }, h('button', { class: 'perigo', onclick: async () => { if (confirm('Remover o certificado do escritório?')) { await api('DELETE', '/api/certificado-escritorio'); router(); } } }, 'Remover')) : null));
}

// ---------- roteamento ----------
async function router() {
  if (!eu) return;
  const [, rota = 'painel', arg] = location.hash.split('/');
  const paginas = { painel: paginaPainel, clientes: paginaClientes, alertas: paginaAlertas, equipe: paginaEquipe, escritorio: paginaEscritorio };
  let conteudo; let ativa = rota === 'cliente' ? 'clientes' : rota;
  try { conteudo = rota === 'cliente' ? await paginaCliente(arg) : await (paginas[rota] || paginaPainel)(); }
  catch (e) { conteudo = caixa('erro', e.message); }
  raiz.replaceChildren(moldura(conteudo, ativa));
  rotularTabelas(raiz);
}

// No celular as tabelas viram cartões; cada célula mostra o título da sua coluna (via CSS attr()).
function rotularTabelas(el) {
  for (const t of el.querySelectorAll('table')) {
    const titulos = [...t.querySelectorAll('thead th')].map((th) => th.textContent);
    for (const tr of t.querySelectorAll('tbody tr')) [...tr.children].forEach((td, i) => { if (titulos[i]) td.setAttribute('data-label', titulos[i]); });
  }
}

function desenhar() { if (eu) router(); else raiz.replaceChildren(telaEntrada()); }
async function iniciar() { try { eu = await api('GET', '/api/eu'); } catch { eu = null; } desenhar(); }
window.addEventListener('hashchange', router);
iniciar();
