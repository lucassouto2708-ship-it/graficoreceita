# Apuração de Arrecadação Contábil

Ferramenta web (roda 100% no navegador, sem backend) para processar a "Minuta de Arrecadação Contábil" da Prefeitura Municipal — extrai o texto do PDF (usa o texto embutido quando existe, ou OCR local via Tesseract.js quando o PDF é escaneado), discrimina o total arrecadado por tipo de tributo (incluindo o detalhamento da Dívida Ativa por imposto de origem), gera gráficos de pizza e de arrecadação diária, permite salvar e comparar vários anos, e exporta tudo em Excel.

O PDF nunca sai da sua máquina — todo o processamento (OCR, cálculo, gráficos) acontece no próprio navegador.

## Como usar

Como o navegador bloqueia certas funcionalidades (como abrir o worker do PDF.js) quando o `index.html` é aberto diretamente como arquivo, é preciso servir a pasta por um servidor local simples. Com Python instalado:

```bash
python -m http.server 8767
```

Depois abra `http://localhost:8767` no navegador.

## Funcionalidades

- Upload de PDF (com ou sem texto embutido — faz OCR automático se necessário)
- Discriminação por tributo (ISSQN, IPTU, ITBI, Arrecadação Diversas, Taxas, COSIP, Multa de Trânsito, IRRF, Simples, ITR, CFEM etc.) com detalhamento de sub-itens (ex.: Principal x Multas e Juros)
- Dívida Ativa detalhada por tributo de origem
- Gráfico de pizza (por tributo) e gráfico de arrecadação diária com média e desvio padrão
- Cache local (localStorage) — não precisa reprocessar o PDF ao recarregar a página
- Histórico de anos: salve vários relatórios e compare a arrecadação entre anos, com destaque de crescimento/queda por tributo
- Lançamento manual de movimentação diária (fechamento de caixa) dentro de um ano já salvo
- Exportação para Excel (.xlsx)

## Estrutura

- `index.html` — página principal
- `app.js` — toda a lógica (extração de texto, OCR, parsing, gráficos, cache, comparativo)
- `pdf.min.js` / `pdf.worker.min.js` — PDF.js (renderização do PDF)
- `tesseract.min.js` — Tesseract.js (OCR)
- `chart.umd.min.js` — Chart.js (gráficos)
- `xlsx.full.min.js` — SheetJS (exportação Excel)
