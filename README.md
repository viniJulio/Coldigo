# Coldigo — análise gráfica para day trade

Ferramenta web (sem dependências, sem build) que carrega candles intradiários e **estima a movimentação dos próximos candles**: viés de alta/baixa, cone de projeção, alvo/stop sugeridos com probabilidades e um backtest para medir se o sinal realmente funcionou nos seus dados.

## Como usar

```bash
npm start            # serve em http://localhost:8080  (ou abra index.html direto no navegador)
npm test             # testes unitários (Node 18+)
```

1. Clique em **Carregar CSV** (ou arraste o arquivo, ou **Colar dados**). **Gerar demonstração** cria dados sintéticos para testar.
2. O gráfico mostra candles, VWAP, EMA 9/21, Bollinger (opcional), suportes/resistências, pivôs, volume e RSI. Roda do mouse ou pinça = zoom, arrastar = mover, duplo clique = reiniciar a visão. Funciona também no celular, com toque.
3. O painel lateral traz o viés, a faixa de preço esperada, probabilidades de alvo/stop, composição do score e o backtest. Todos os parâmetros são editáveis.

### Modo ao vivo (Binance)

O botão **Ao vivo** busca o histórico e acompanha o preço em tempo real pelo feed público da Binance (sem chave), com reconexão automática. Ativos: **cripto** (BTC, ETH, BNB, SOL, XRP, DOGE), **câmbio** (EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/BRL, USD/TRY) e **ouro** (XAU/USD), em 1, 3, 5, 15 e 30 minutos, 1 hora e 4 horas. Câmbio e ouro vêm de pares contra USDT da Binance (por exemplo EURUSDT), que acompanham o ativo real mas **não são o mesmo feed da sua corretora**, operam 24h (inclusive fim de semana) e têm preços cotados em passos pequenos (EURUSDT anda de 0,0001 em 0,0001, o que gera muitos empates). Ao abrir, o app confere quais desses pares a Binance ainda lista e esconde os inativos. O app mostra um aviso quando o ativo é uma referência. Carrega até 6.000 candles de histórico (configurável) para treinar e validar o modelo. A análise é refeita a cada segundo e imediatamente quando um candle fecha; o candle em formação ainda pode mudar, então o sinal oscila até ele fechar.

- A **Quotex não tem API pública**, então a ferramenta não lê preços de dentro dela. Em ativos OTC a corretora gera os próprios preços, e nenhuma análise de mercado se aplica a eles.
- O modo ao vivo precisa de uma página com acesso à internet aberta: `npm start` ou uma hospedagem estática (por exemplo o GitHub Pages, em Settings → Pages → Deploy from branch → `master`, depois de mergear). A cópia publicada como artefato do Claude bloqueia conexões externas e esconde esses controles.

### Cartão de opção binária

Compara a expiração escolhida (o horizonte, em candles) com o **ponto de empate** do seu payout: `1 / (1 + payout)`, ou 54,1% para 85%. Mostra a probabilidade do modelo, o acerto histórico do sinal naquela força de score e o **limite inferior de 95%** (intervalo de Wilson, com a amostra reduzida porque as janelas se sobrepõem). O veredito só diz que há vantagem quando esse limite inferior supera o ponto de empate.

### Modelo e validação fora da amostra

O alerta não usa mais o score por indicadores (que continua na tela só como referência). Ele usa um **modelo estatístico treinado nos dados**, e só fala quando a validação mostra vantagem:

- **Modelo:** regressão logística com regularização forte. São calculadas 16 variáveis causais (retornos normalizados, distância às médias, RSI, Bollinger, VWAP, volume, regime de volatilidade, hora do dia e, da Binance, o **fluxo de ordens**: quanto do volume foi compra a mercado), e o padrão usa as 8 que se mostraram mais bem calibradas (retornos de 3, 10 e 20 candles, diferença entre médias, volume, fluxo de ordens e regime de volatilidade). Prevê a probabilidade de o preço fechar acima daqui a `expiração` candles.
- **Validação walk-forward:** treina numa janela (padrão 2.500 candles), prevê o bloco seguinte, avança. Os rótulos que ainda dependem do futuro são descartados do treino (purga). Todas as métricas vêm de previsões feitas **sobre candles que o modelo não viu**.
- **Limiar fixado antes:** a entrada exige probabilidade ≥ ponto de empate do payout + margem (padrão 1 p.p.). As operações da estratégia não se sobrepõem, então a amostra é honesta.
- **Gate (todos os critérios):** operações independentes suficientes (padrão 30), limite inferior de confiança do acerto **acima do ponto de empate**, modelo melhor que o acaso (escore de Brier) e probabilidade atual acima do limiar.
- **Múltiplos testes:** cada combinação de par, tempo, expiração e margem que você pesquisa na semana aumenta a chance de achar sorte. O limite de confiança é corrigido (Bonferroni) e o contador fica salvo no navegador.

O cartão **Decisão e validação do modelo** mostra o que passou ou falhou, o acerto fora da amostra, AUC, ganho sobre o acaso, calibração e o que a regra teria feito. A faixa acima do gráfico resume: **NÃO OPERAR** (com o motivo) ou **SINAL VALIDADO**. Quando dispara, toca som, vibra e mantém a tela ligada no modo ao vivo. A página precisa ficar aberta.

Verificado em dados sintéticos: com um sinal real plantado o modelo o encontra (AUC ~0,58 com sinal fraco) e, em 120 passeios aleatórios, **nenhum** foi validado. **Em dados reais de cripto de 1 a 15 minutos é esperado que o resultado seja "sem vantagem comprovada" na maior parte do tempo.** Isso é a ferramenta funcionando, não falhando.

### Resultados com dados reais (22/11/2026)

Avaliação walk-forward com dados reais da Binance, protocolo fixado antes de ver resultados: 8 ativos (BTC, ETH, BNB, SOL, XRP, DOGE, EUR/USDT, PAXG) × 2 tempos (1 min com expiração de 5 candles; 5 min com 3 candles) = 16 testes, payout 85%, ~7 mil candles fora da amostra cada, limite de confiança corrigido para 16 testes (z = 2,95).

- **15 de 16 sem vantagem.** AUC médio 0,51 (0,50 = acaso), acerto de sinais fortes entre 49% e 54%, abaixo do ponto de empate (54,1%). O modelo piora o escore de Brier em 15 dos 16 (previsões superconfiantes), então o gate bloqueia.
- **1 passou, e era artefato:** EUR/USDT em 1 min (acerto 59,4%, limite inferior 54,9%). Uma regra sem modelo nenhum ("apostar contra o último movimento") acerta 59,7% nesse mesmo dado: é o "quique" entre os preços vizinhos de um ativo cotado em passos de 0,0001 (50% dos candles ficam parados). Não é vantagem que exista no feed da corretora, e o acerto foi instável (54% nos primeiros dias, 88% no último).
- **Proteção criada depois:** se 20% ou mais dos candles fecham no preço em que abriram, o app bloqueia o alerta e explica o motivo. A regra foi criada *depois* de ver esse resultado, mas por um diagnóstico com linha de base, e nenhum outro ativo é afetado (máximo medido fora o EUR: 12%).
- **Ajuste de calibração (mesmo dia):** o gráfico acima mostrou superconfiança (ganho negativo sobre o acaso em todas as séries). Num conjunto de desenvolvimento anterior, nunca usado na avaliação, comparei 12 configurações (4 regularizações × 3 conjuntos de variáveis), escolhendo só pela **calibração média**, não pelo acerto. Ficou com 8 variáveis e λ = 1000 (era 16 variáveis e λ = 10): no teste, o ganho sobre o acaso foi de −1,47% para +0,04% e o AUC de 0,510 para 0,514. **Ainda 0 de 14 séries validadas:** o modelo ficou honesto (probabilidades perto de 50%), mas não achou vantagem. Também ficou melhor com dados sintéticos (calibra melhor num passeio aleatório e detecta melhor o sinal plantado).
- **Horizontes mais longos (mesmo dia):** protocolo fixado antes, modelo padrão sem nenhum ajuste, 8 ativos × 6 combinações (5 min com 6 e 12 candles, 15 min com 2 e 4, 1 h com 1 e 3; expirações de 30 min a 3 h) = 48 testes, com correção (z = 3,28), cobrindo de 35 dias (5 min) a 417 dias (1 h). **0 de 48 validados, mesmo sem a correção.** AUC médio 0,510 (melhor 0,530). Para ser justo com os melhores, repliquei os 3 de maior acerto (todos "5 min, 30 min de expiração", em DOGE, ETH e XRP) em cinco semanas anteriores nunca usadas para medir acerto: DOGE caiu de 61,3% para 53,2%, XRP de 55,8% para 50,8% e ETH de 57,7% para 52,7%, todos abaixo do empate de 54,1%. O que aparecia de bom era sorte entre muitos testes. O ETH manteve um AUC de 0,53 nas duas amostras, o que sugere um sinal real, porém pequeno demais para pagar um payout de 85%.
- **Com taxas da Binance (24/11/2026):** 8 ativos × 4 horizontes (15 min com 4 candles; 1 h com 4; 4 h com 3 e 6, ou seja, de 1 h a 24 h) × 2 mercados (à vista 0,1%, futuros 0,05% por lado) = 64 testes, de 104 dias (15 min) a 4,5 anos (4 h). **0 de 64 validados, mesmo sem correção.** Futuros, comprando e vendendo, perderam dinheiro em quase todos os casos. À vista em 4 h com saída em 12 h, o líquido médio foi positivo nas 6 criptos, então repliquei em 2017–2022 (nunca usado): 0 de 6 validados, e 88% das operações e quase todo o lucro estavam em 2021 (euforia), com prejuízo em 2022 (queda). Acerto agregado de 50%: o modelo à vista se comporta como "comprar em tendência de alta", o que é exposição ao mercado, não vantagem.
- **Para refazer** com dados novos: `node scripts/baixar-historico.js pasta` e `npm run avaliar -- pasta`; com taxas, `node scripts/avaliar-custos.js pasta`; para repetir o ajuste, `node scripts/ajustar.js pasta-desenvolvimento pasta-teste` (o desenvolvimento precisa ser anterior ao teste).

Conclusão prática: nestes dados, de 1 minuto a 24 horas, com payout ou com taxas, o modelo não achou vantagem real. Qualquer mudança no modelo a partir daqui precisa ser validada em dados **posteriores** a esta avaliação (por exemplo, no simulador em tempo real), senão vira ajuste ao que já foi visto.

### Opção binária com câmbio real (Twelve Data)

No mercado **Opção binária**, a lista de ativos mostra **câmbio real do mercado interbancário** (EUR/USD, GBP/USD, USD/JPY, AUD/USD, EUR/JPY, GBP/JPY e outros, além de ouro) pelo [Twelve Data](https://twelvedata.com), com cripto da Binance logo abaixo. Ao escolher a binária, o app abre no EUR/USD.

- Crie uma conta grátis no Twelve Data, copie a sua chave de API e salve em **Parâmetros → Dados de câmbio real**. A chave fica só no navegador e só é enviada ao Twelve Data.
- O plano grátis permite 8 consultas por minuto e 800 por dia, sem streaming contínuo. O app faz 1 consulta para o histórico (até 5.000 candles) e depois **1 por candle fechado**; o contador aparece na tela. Em 1 minuto isso dá cerca de 13 horas por dia num par; em 5 minutos ou mais, o dia todo.
- Não há candles de 3 minutos no Twelve Data, e o câmbio não tem volume (o painel some).
- **Não são os preços da sua corretora**: nenhuma corretora de opção binária publica o próprio feed. É o mercado interbancário que ela acompanha nos ativos que não são OTC, e os valores podem diferir um pouco. **Nos fins de semana** o câmbio oficial está fechado: o Twelve Data continua entregando preços, mas eles não vêm do mercado interbancário, e a corretora usa ativos OTC próprios. O app avisa nesse período.

Avaliação com EUR/USD real (24/11/2026, protocolo fixado antes, payout 85%, 4 testes: 1 min x5, 5 min x3, 15 min x4 e 1 h x4, ~2.200 candles fora da amostra cada): **nenhum validado**, nem sem a correção. O melhor foi 1 min com saída em 5 candles (AUC 0,545, acerto de 55,7% em 253 sinais), mas com limite inferior de 47,9% e probabilidades piores que um palpite constante. Esses 1 min cobrem só 3,5 dias, pouco para concluir; vale acompanhar no simulador.

### Tempo da operação

No simulador, **Tempo da operação** escolhe quanto tempo cada operação dura (de 1 minuto a alguns dias). As opções são múltiplos do candle do gráfico aberto, porque o modelo prevê "daqui a N candles". Ao trocar o tempo gráfico, o tempo escolhido é mantido; se ele não couber (30 minutos num gráfico de 4 horas), o app usa o mais próximo e avisa. O modelo, o alerta, o simulador e as ordens da conta demo usam esse mesmo tempo.

### Binance: operar com taxas

Em **Parâmetros → Operação**, escolha o mercado: **opção binária** (payout fixo), **Binance à vista** (só compra) ou **Binance futuros** (compra e venda), e a **taxa por lado** (padrão 0,1% à vista e 0,05% em futuros; confira as da sua conta). No modo Binance:

- Você ganha ou perde o tamanho do movimento e paga a taxa na entrada e na saída. Por isso horizontes maiores (1 h, 4 h) tendem a ser os únicos viáveis: em 1 min à vista, a taxa de ida e volta (0,2%) costuma ser **maior que o movimento típico**, e o app avisa que nem acertando sempre daria lucro.
- O modelo só sugere entrada quando a probabilidade cobre a taxa, dado o movimento típico recente: p ≥ 0,5 + custo de ida e volta / (2 × movimento típico).
- A validação exige, fora da amostra: operações suficientes, **lucro líquido médio** com limite inferior acima de zero e **ganho além da tendência** do mercado também acima de zero. Esse último impede que a alta do mercado seja creditada ao modelo.
- O simulador usa a mesma conta (movimento menos taxas), com botões COMPRAR/VENDER.



Carteira fictícia (R$ 1.000 iniciais) de opções binárias, no modo ao vivo: **CALL** (acima) ou **PUT** (abaixo), valor por operação, payout e expiração configuráveis. A operação entra ao preço atual e é liquidada no vencimento (vitória paga o payout, derrota perde o valor, empate devolve). Há opção de entrar automaticamente nos alertas. Cada operação é liquidada com o preço **do próprio ativo**: ao vivo no vencimento, ou, se o app estava fechado ou em outro ativo, pela abertura do minuto do vencimento consultada na Binance (nunca com os candles de outro ativo ou da demonstração). Toque numa operação para ver os detalhes: ativo, mercado, taxa ou payout, entrada, vencimento, saída e como o preço foi obtido, variação, resultado e o que o modelo dizia na hora da entrada. Entradas aparecem como triângulos no gráfico e o saldo, as operações e as preferências ficam salvos no navegador. O acerto só significa algo com muitas operações (100 ou mais) e deve ser comparado com o ponto de empate. Operar no simulador em tempo real é o teste fora da amostra que o backtest não consegue ser.

Para o câmbio real (feed da corretora ou do MetaTrader), exporte o histórico em CSV e carregue pelo botão **Carregar CSV**: o modelo valida do mesmo jeito, só que sem o fluxo de ordens, que o CSV não traz.

### Conta demo da Binance (ponte local, Windows)

O app pode enviar as suas entradas (o botão COMPRAR e os alertas) para a **conta demo** da Binance e mostrar saldo, ordens executadas, taxas e o resultado real. Quem fala com a Binance é a **ponte**, um pequeno programa que roda no seu computador:

- guarda a chave da conta demo em `ponte/config.json`, que nunca vai para o Git nem para o app;
- só escuta no próprio PC (`127.0.0.1`), só atende quem tem o **código de acesso** e vem do seu app, e só fala com a conta **demo**;
- compra a mercado e **vende sozinha no vencimento**, mesmo com o navegador fechado (o PC e a ponte precisam estar ligados; se ela estiver desligada no vencimento, vende assim que religar);
- tem limite de valor por ordem (padrão 100 USDT, ajustável em `ponte/config.json`).

**Instalação (uma vez):**

1. Instale o **Node.js LTS** em [nodejs.org](https://nodejs.org) (avançar, avançar, concluir).
2. Baixe o projeto: no GitHub, **Code → Download ZIP**, e extraia (por exemplo em `Documentos\Coldigo`).
3. Na Binance, entre na **Demo Trading** e crie uma **chave de API** do tipo gerado pelo sistema (HMAC), com permissão de leitura e de negociação à vista. Nunca habilite saques. Copie a *API Key* e a *Secret Key*.
4. Dê dois cliques em `ponte\iniciar.bat`. Na primeira vez ele cria `ponte\config.json` e avisa que falta a chave. Feche a janela, abra `ponte\config.json` no Bloco de Notas e cole as chaves entre as aspas de `"apiKey"` e `"secretKey"`. Salve.

**Uso:**

1. Dois cliques em `ponte\iniciar.bat` e deixe a janela aberta. Ela mostra o **código de acesso**.
2. No navegador **do mesmo PC**, abra o app, vá ao cartão **Conta demo da Binance**, confira o endereço `http://127.0.0.1:8787`, cole o código e toque em **Conectar**. Se o navegador perguntar se o site pode acessar a rede local ou outros apps do dispositivo, permita.
3. Escolha **Binance à vista** em Parâmetros, ligue o **Ao vivo**, marque **Enviar minhas entradas para a conta demo** e defina o valor por ordem em USDT. A partir daí, COMPRAR e os alertas (com entrada automática) viram ordens na conta demo. Toque numa operação para ver compra, venda, taxas e resultado; "Vender agora" encerra antes do vencimento.

Limitações: só mercado à vista (compra e depois vende); a ponte só é alcançável pelo navegador do próprio PC; a Binance cobra a taxa da compra na moeda comprada e só vende em passos mínimos (no BTC, 0,00001), então quase toda operação deixa uma pequena **sobra** na conta, que o resultado conta pelo valor de mercado (em ordens pequenas ela pesa: numa ordem de 20 USDT pode chegar a ~3%). Segundo a própria Binance, os preços e o livro de ofertas da demo são parecidos com os reais, não idênticos.

### Versões e atualização

O topo do app mostra a versão aberta. A cada publicação, rode `npm run versao`: ele grava uma versão nova em `version.json` e nos endereços dos arquivos do `index.html` (`?v=`), para o cache do navegador (10 minutos no GitHub Pages) não segurar a versão antiga. O app aberto confere o `version.json` ao voltar para a aba e a cada 5 minutos, e mostra **"Há uma versão nova do app · Atualizar agora"** quando ela existe.

### Formato dos dados

CSV com data/hora, abertura, máxima, mínima, fechamento e volume. Aceita `,` `;` ou tab, cabeçalho em português ou inglês, `dd/mm/aaaa` ou ISO, decimal com vírgula, epoch, e exportações do MetaTrader (`<DATE> <TIME>` separados). Sem cabeçalho: 6 colunas = `datetime,o,h,l,c,v`; 7 colunas = `data,hora,o,h,l,c,v`.

## Como a estimativa é calculada

| Etapa | O que faz |
|---|---|
| **Score de viés** (−1…+1) | Soma ponderada de tendência (EMA 9 vs 21), posição vs VWAP, momentum de 5 candles, RSI e Bollinger (os dois últimos como reversão nos extremos). Acima de +0,25 = alta; abaixo de −0,25 = baixa. |
| **Monte Carlo** | 2.000 trajetórias por bootstrap de candles recentes (retorno + máxima + mínima), com um pequeno deslocamento proporcional ao score. Gera bandas 50%/80%, máxima/mínima esperadas e P(fechar acima). |
| **Alvo × stop** | Alvo e stop em múltiplos do ATR(14); mede quantas trajetórias tocam o alvo, o stop ou nenhum dentro do horizonte (empate no mesmo candle conta como stop). |
| **Backtest walk-forward** | Para cada candle do histórico compara o score com o retorno `horizonte` candles depois, sem atravessar pregões. Mostra taxa de acerto e retorno médio por faixa de score. |

Indicadores são causais (nenhum usa candles futuros). Os arquivos estão em `js/`: `indicators.js`, `forecast.js`, `data.js`, `live.js`, `model.js`, `sim.js`, `ponte.js`, `chart.js`, `app.js`; a ponte local fica em `ponte/`.

## Limites que você deve conhecer

- É uma estimativa estatística, não previsão nem recomendação. Desempenho passado não garante o futuro.
- O backtest usa janelas sobrepostas e é *in-sample*; os pesos do score são heurísticos, não otimizados. Valide com vários pregões antes de confiar.
- Não inclui custos, corretagem, slippage nem liquidez.
- Os dados de demonstração são sintéticos (com regimes de tendência embutidos), então o backtest neles parece melhor do que seria no mercado real.
