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

O botão **Ao vivo** busca o histórico e acompanha o preço em tempo real pelo feed público da Binance (sem chave), com reconexão automática. Ativos: **cripto** (BTC, ETH, BNB, SOL, XRP, DOGE), **câmbio** (EUR/USD, GBP/USD, AUD/USD, USD/JPY, USD/BRL, USD/TRY) e **ouro** (XAU/USD), em 1, 3, 5 e 15 minutos. Câmbio e ouro vêm de pares contra USDT da Binance (por exemplo EURUSDT), que acompanham o ativo real mas **não são o mesmo feed da sua corretora**, operam 24h (inclusive fim de semana) e têm preços cotados em passos pequenos (EURUSDT anda de 0,0001 em 0,0001, o que gera muitos empates). Ao abrir, o app confere quais desses pares a Binance ainda lista e esconde os inativos. O app mostra um aviso quando o ativo é uma referência. Carrega até 6.000 candles de histórico (configurável) para treinar e validar o modelo. A análise é refeita a cada segundo e imediatamente quando um candle fecha; o candle em formação ainda pode mudar, então o sinal oscila até ele fechar.

- A **Quotex não tem API pública**, então a ferramenta não lê preços de dentro dela. Em ativos OTC a corretora gera os próprios preços, e nenhuma análise de mercado se aplica a eles.
- O modo ao vivo precisa de uma página com acesso à internet aberta: `npm start` ou uma hospedagem estática (por exemplo o GitHub Pages, em Settings → Pages → Deploy from branch → `master`, depois de mergear). A cópia publicada como artefato do Claude bloqueia conexões externas e esconde esses controles.

### Cartão de opção binária

Compara a expiração escolhida (o horizonte, em candles) com o **ponto de empate** do seu payout: `1 / (1 + payout)`, ou 54,1% para 85%. Mostra a probabilidade do modelo, o acerto histórico do sinal naquela força de score e o **limite inferior de 95%** (intervalo de Wilson, com a amostra reduzida porque as janelas se sobrepõem). O veredito só diz que há vantagem quando esse limite inferior supera o ponto de empate.

### Modelo e validação fora da amostra

O alerta não usa mais o score por indicadores (que continua na tela só como referência). Ele usa um **modelo estatístico treinado nos dados**, e só fala quando a validação mostra vantagem:

- **Modelo:** regressão logística com regularização, 16 variáveis causais (retornos normalizados, distância às médias, RSI, Bollinger, VWAP, volume, regime de volatilidade, hora do dia e, da Binance, o **fluxo de ordens**: quanto do volume foi compra a mercado). Prevê a probabilidade de o preço fechar acima daqui a `expiração` candles.
- **Validação walk-forward:** treina numa janela (padrão 2.500 candles), prevê o bloco seguinte, avança. Os rótulos que ainda dependem do futuro são descartados do treino (purga). Todas as métricas vêm de previsões feitas **sobre candles que o modelo não viu**.
- **Limiar fixado antes:** a entrada exige probabilidade ≥ ponto de empate do payout + margem (padrão 1 p.p.). As operações da estratégia não se sobrepõem, então a amostra é honesta.
- **Gate (todos os critérios):** operações independentes suficientes (padrão 30), limite inferior de confiança do acerto **acima do ponto de empate**, modelo melhor que o acaso (escore de Brier) e probabilidade atual acima do limiar.
- **Múltiplos testes:** cada combinação de par, tempo, expiração e margem que você pesquisa na semana aumenta a chance de achar sorte. O limite de confiança é corrigido (Bonferroni) e o contador fica salvo no navegador.

O cartão **Decisão e validação do modelo** mostra o que passou ou falhou, o acerto fora da amostra, AUC, ganho sobre o acaso, calibração e o que a regra teria feito. A faixa acima do gráfico resume: **NÃO OPERAR** (com o motivo) ou **SINAL VALIDADO**. Quando dispara, toca som, vibra e mantém a tela ligada no modo ao vivo. A página precisa ficar aberta.

Verificado em dados sintéticos: com um sinal real plantado o modelo o encontra (AUC ~0,58 com sinal fraco) e, em 120 passeios aleatórios, **nenhum** foi validado. **Em dados reais de cripto de 1 a 15 minutos é esperado que o resultado seja "sem vantagem comprovada" na maior parte do tempo.** Isso é a ferramenta funcionando, não falhando.

### Simulador de operações

Carteira fictícia (R$ 1.000 iniciais) de opções binárias, no modo ao vivo: **CALL** (acima) ou **PUT** (abaixo), valor por operação, payout e expiração configuráveis. A operação entra ao preço atual e é liquidada no vencimento (vitória paga o payout, derrota perde o valor, empate devolve). Há opção de entrar automaticamente nos alertas. Entradas aparecem como triângulos no gráfico e o saldo, as operações e as preferências ficam salvos no navegador. O acerto só significa algo com muitas operações (100 ou mais) e deve ser comparado com o ponto de empate. Operar no simulador em tempo real é o teste fora da amostra que o backtest não consegue ser.

Para o câmbio real (feed da corretora ou do MetaTrader), exporte o histórico em CSV e carregue pelo botão **Carregar CSV**: o modelo valida do mesmo jeito, só que sem o fluxo de ordens, que o CSV não traz.

### Formato dos dados

CSV com data/hora, abertura, máxima, mínima, fechamento e volume. Aceita `,` `;` ou tab, cabeçalho em português ou inglês, `dd/mm/aaaa` ou ISO, decimal com vírgula, epoch, e exportações do MetaTrader (`<DATE> <TIME>` separados). Sem cabeçalho: 6 colunas = `datetime,o,h,l,c,v`; 7 colunas = `data,hora,o,h,l,c,v`.

## Como a estimativa é calculada

| Etapa | O que faz |
|---|---|
| **Score de viés** (−1…+1) | Soma ponderada de tendência (EMA 9 vs 21), posição vs VWAP, momentum de 5 candles, RSI e Bollinger (os dois últimos como reversão nos extremos). Acima de +0,25 = alta; abaixo de −0,25 = baixa. |
| **Monte Carlo** | 2.000 trajetórias por bootstrap de candles recentes (retorno + máxima + mínima), com um pequeno deslocamento proporcional ao score. Gera bandas 50%/80%, máxima/mínima esperadas e P(fechar acima). |
| **Alvo × stop** | Alvo e stop em múltiplos do ATR(14); mede quantas trajetórias tocam o alvo, o stop ou nenhum dentro do horizonte (empate no mesmo candle conta como stop). |
| **Backtest walk-forward** | Para cada candle do histórico compara o score com o retorno `horizonte` candles depois, sem atravessar pregões. Mostra taxa de acerto e retorno médio por faixa de score. |

Indicadores são causais (nenhum usa candles futuros). Os arquivos estão em `js/`: `indicators.js`, `forecast.js`, `data.js`, `live.js`, `model.js`, `sim.js`, `chart.js`, `app.js`.

## Limites que você deve conhecer

- É uma estimativa estatística, não previsão nem recomendação. Desempenho passado não garante o futuro.
- O backtest usa janelas sobrepostas e é *in-sample*; os pesos do score são heurísticos, não otimizados. Valide com vários pregões antes de confiar.
- Não inclui custos, corretagem, slippage nem liquidez.
- Os dados de demonstração são sintéticos (com regimes de tendência embutidos), então o backtest neles parece melhor do que seria no mercado real.
