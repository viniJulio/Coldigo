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

O botão **Ao vivo** busca o histórico e acompanha o preço em tempo real pelo feed público da Binance (sem chave), com reconexão automática. Pares: BTC, ETH, BNB, SOL, XRP e DOGE contra USDT, em 1, 3, 5 e 15 minutos. A análise é refeita a cada segundo e imediatamente quando um candle fecha; o candle em formação ainda pode mudar, então o sinal oscila até ele fechar.

- A **Quotex não tem API pública**, então a ferramenta não lê preços de dentro dela. Em ativos OTC a corretora gera os próprios preços, e nenhuma análise de mercado se aplica a eles.
- O modo ao vivo precisa de uma página com acesso à internet aberta: `npm start` ou uma hospedagem estática (por exemplo o GitHub Pages, em Settings → Pages → Deploy from branch → `master`, depois de mergear). A cópia publicada como artefato do Claude bloqueia conexões externas e esconde esses controles.

### Cartão de opção binária

Compara a expiração escolhida (o horizonte, em candles) com o **ponto de empate** do seu payout: `1 / (1 + payout)`, ou 54,1% para 85%. Mostra a probabilidade do modelo, o acerto histórico do sinal naquela força de score e o **limite inferior de 95%** (intervalo de Wilson, com a amostra reduzida porque as janelas se sobrepõem). O veredito só diz que há vantagem quando esse limite inferior supera o ponto de empate.

### Formato dos dados

CSV com data/hora, abertura, máxima, mínima, fechamento e volume. Aceita `,` `;` ou tab, cabeçalho em português ou inglês, `dd/mm/aaaa` ou ISO, decimal com vírgula, epoch, e exportações do MetaTrader (`<DATE> <TIME>` separados). Sem cabeçalho: 6 colunas = `datetime,o,h,l,c,v`; 7 colunas = `data,hora,o,h,l,c,v`.

## Como a estimativa é calculada

| Etapa | O que faz |
|---|---|
| **Score de viés** (−1…+1) | Soma ponderada de tendência (EMA 9 vs 21), posição vs VWAP, momentum de 5 candles, RSI e Bollinger (os dois últimos como reversão nos extremos). Acima de +0,25 = alta; abaixo de −0,25 = baixa. |
| **Monte Carlo** | 2.000 trajetórias por bootstrap de candles recentes (retorno + máxima + mínima), com um pequeno deslocamento proporcional ao score. Gera bandas 50%/80%, máxima/mínima esperadas e P(fechar acima). |
| **Alvo × stop** | Alvo e stop em múltiplos do ATR(14); mede quantas trajetórias tocam o alvo, o stop ou nenhum dentro do horizonte (empate no mesmo candle conta como stop). |
| **Backtest walk-forward** | Para cada candle do histórico compara o score com o retorno `horizonte` candles depois, sem atravessar pregões. Mostra taxa de acerto e retorno médio por faixa de score. |

Indicadores são causais (nenhum usa candles futuros). Os arquivos estão em `js/`: `indicators.js`, `forecast.js`, `data.js`, `live.js`, `chart.js`, `app.js`.

## Limites que você deve conhecer

- É uma estimativa estatística, não previsão nem recomendação. Desempenho passado não garante o futuro.
- O backtest usa janelas sobrepostas e é *in-sample*; os pesos do score são heurísticos, não otimizados. Valide com vários pregões antes de confiar.
- Não inclui custos, corretagem, slippage nem liquidez.
- Os dados de demonstração são sintéticos (com regimes de tendência embutidos), então o backtest neles parece melhor do que seria no mercado real.
