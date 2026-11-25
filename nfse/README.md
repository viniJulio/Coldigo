# NFS-e Contadores

Portal multi-escritório que busca todo dia, no Portal Nacional da NFS-e, as notas de serviço (emitidas e recebidas) de todos os clientes de um escritório de contabilidade, organiza por cliente e mês, entrega em ZIP e avisa o que merece atenção. Veja o documento de validação da ideia (roteiro de conversas com contadores) fora deste repositório.

Sem dependências npm. Precisa de **Node 22.13+** (usa `node:sqlite`) e do **openssl** no servidor (para ler o certificado A1).

```bash
npm run nfse        # http://localhost:8090  (ADN simulado, dados fictícios)
npm run nfse:test   # 23 testes (isolamento entre escritórios, sincronização, acesso, ZIP)
```

## Como o acesso é separado

- **Escritório** (quem contrata) é o tenant. Quem se cadastra vira `dono`; ele convida `admin` e `membro`.
- **Clientes** (as empresas do escritório) ficam dentro do escritório: cada nota, certificado, alerta e posição de sincronização pertence a um cliente de um escritório.
- O `tenant_id` vem **sempre da sessão**, nunca da requisição. Toda consulta passa por `src/repo.js`, que o inclui; um ID de outro escritório responde 404, como se não existisse.
- No banco, chaves estrangeiras compostas `(tenant_id, cliente_id)` impedem gravar uma nota, certificado ou alerta ligado a cliente de outro escritório, mesmo com bug no código.
- O mesmo CNPJ pode ser cliente de dois escritórios; os dados ficam separados.
- Certificados (.pfx e senha) são cifrados com AES-256-GCM, com chave derivada **por escritório** da chave mestra, e o contexto amarra o blob ao escritório. A API nunca os devolve.
- Papéis: `membro` consulta, baixa e sincroniza; `admin` também cadastra clientes, certificados e membros; só o `dono` cria admins.
- Sessão por cookie `HttpOnly` + `SameSite=Strict`, cabeçalho `X-NFSE` obrigatório em escrita, CSP sem script/estilo inline, senha com scrypt, limite de tentativas de login.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Para quê |
|---|---|---|
| `NFSE_ADN` | `simulador` | `simulador`, `homologacao` ou `producao` |
| `NFSE_MASTER_KEY` | gerada em `nfse/data/master.key` | 64 hex. **Obrigatória em produção** (`NODE_ENV=production`); guarde em cofre e faça backup: sem ela os certificados não abrem |
| `NFSE_DATA` | `nfse/data` | onde ficam banco e chave local |
| `NFSE_CADASTRO_ABERTO` | `1` | `0` fecha o auto-cadastro de escritórios |
| `NFSE_COOKIE_SECURE` | `0` | `1` atrás de HTTPS |
| `NFSE_AGENDADOR` | `1` | sincroniza o que estiver há mais de 24 h sem rodar (checa a cada hora) |
| `PORT` | `8090` | porta HTTP |

## O que já faz

Cadastro de escritório e equipe · clientes por CNPJ · certificado A1 por cliente **ou** do escritório (consulta pelo CNPJ do cliente) · sincronização diária e manual por NSU, idempotente · classificação emitida/recebida · alertas (nota cancelada, fornecedor novo, cliente sem nota no mês anterior, sem certificado, certificado vencido) · ZIP por cliente/mês (`CNPJ-Razao/AAAA-MM/emitidas|recebidas/*.xml` + `resumo.csv`) · XML e PDF por nota.

## Pendências antes de usar com clientes reais

1. **Conferir o contrato do ADN** (`src/adn.js`). Rota, parâmetros e formato do JSON foram escritos a partir de documentação secundária, não do manual oficial (o `gov.br` não estava acessível ao construir). Validar em produção restrita com um certificado de teste e ajustar só esse arquivo e, se o XML diferir, `src/xml.js`.
2. **Procuração × certificado do contador.** O manual do ADN v1.1 (nov/2026) cita consulta com CNPJ diferente do certificado, validando a raiz do CNPJ, e "alternância de perfis e procurações". O modo "certificado do escritório" já existe para testar isso; confirme nas conversas e na homologação o que o portal aceita para clientes com CNPJ raiz diferente.
3. **PDF (DANFSe).** Há indício de que o gerador nacional saiu do ar; o sistema tenta o portal e, se falhar, o XML segue disponível. O caminho é gerar o PDF localmente a partir do XML.
4. **Produção:** trocar SQLite por Postgres se passar de algumas dezenas de escritórios, HTTPS, backup do banco e da chave mestra, e-mail de alertas, recuperação de senha, cobrança por cliente/mês.
5. **Entrega:** Google Drive e integração com sistemas contábeis (Domínio, Alterdata, Questor, SCI) ainda não existem; hoje a entrega é o ZIP.

## Estrutura

`server.js` (HTTP + estáticos) · `src/api.js` (rotas e permissões) · `src/repo.js` (dados com escopo de escritório) · `src/sync.js` (sincronização e alertas) · `src/adn.js` (cliente do ADN) · `src/simulador.js` (ADN falso para desenvolver e testar) · `src/cert.js`, `seguranca.js`, `zip.js`, `xml.js` · `public/` (interface) · `test/`.
