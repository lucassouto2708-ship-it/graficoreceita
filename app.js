// Apuração de Arrecadação Contábil — parsing da "Minuta de Arrecadação Contábil" (PJe/contábil municipal)
// Tudo roda no navegador: OCR via Tesseract.js (pdf.js renderiza cada página em canvas).

const fileInput = document.getElementById('fileInput');
const drop = document.getElementById('drop');
const dropLabel = document.getElementById('dropLabel');
const btnProcess = document.getElementById('btnProcess');
const btnExport = document.getElementById('btnExport');
const progressBar = document.getElementById('progressBar');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const chartsEl = document.getElementById('charts');
const cachedBar = document.getElementById('cachedBar');
const anoInput = document.getElementById('anoInput');
const btnSalvarAno = document.getElementById('btnSalvarAno');
const salvarAnoStatus = document.getElementById('salvarAnoStatus');
const comparativoEl = document.getElementById('comparativo');
const anosSalvosLista = document.getElementById('anosSalvosLista');
const periodoComparadoEl = document.getElementById('periodoComparado');
const destaquesVariacaoEl = document.getElementById('destaquesVariacao');
const tabVariacaoEl = document.getElementById('tabVariacao');
const btnExportarComparativoPDF = document.getElementById('btnExportarComparativoPDF');

pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

let currentFile = null;
let lastResult = null;
const graficosPorSufixo = {};
let chartComparativo = null;
const movDiariaAbertos = new Set(); // anos com a seção "Movimentação diária" expandida (sobrevive a re-renders)
const CORES_GRAFICO = ['#2f5d8a', '#4f8fc0', '#7fb069', '#e0a458', '#c15b4a', '#8e6bab', '#4a9d8f', '#c98686', '#9aa5b1'];
const anosCarregadosEl = document.getElementById('anosCarregados');

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('hover');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

function setFile(file) {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    alert('Selecione um arquivo PDF.');
    return;
  }
  currentFile = file;
  dropLabel.innerHTML = `<span class="filename">${escapeHTML(file.name)}</span> — ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  btnProcess.disabled = false;
  btnExport.disabled = true;
  resultsEl.style.display = 'none';
  chartsEl.style.display = 'none';
}

// ── Cache local (localStorage): evita ter que reprocessar o PDF (OCR) de novo a
// cada vez que a página é recarregada — guarda só o resultado já calculado. ──────
const CACHE_KEY = 'arrecadacao_ultimo_resultado_v1';

function mapParaObj(m) {
  const o = {};
  for (const [k, v] of m.entries()) o[k] = (v instanceof Map) ? mapParaObj(v) : v;
  return o;
}
function objParaMap(o, profundidade = 1) {
  const m = new Map();
  for (const k of Object.keys(o || {})) {
    m.set(k, profundidade > 1 ? objParaMap(o[k], profundidade - 1) : o[k]);
  }
  return m;
}

function salvarResultadoNoCache(r) {
  try {
    const serializado = {
      nomeArquivo: r.nomeArquivo,
      salvoEm: new Date().toISOString(),
      totalGeral: r.totalGeral,
      porTributo: mapParaObj(r.porTributo),
      porSub: mapParaObj(r.porSub),
      porData: mapParaObj(r.porData),
      porDataTributo: mapParaObj(r.porDataTributo),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(serializado));
  } catch (e) {
    console.warn('Não foi possível salvar cache local:', e);
  }
}

function carregarResultadoDoCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return {
      nomeArquivo: o.nomeArquivo,
      salvoEm: o.salvoEm,
      totalGeral: o.totalGeral,
      porTributo: objParaMap(o.porTributo, 1),
      porSub: objParaMap(o.porSub, 2),
      porData: objParaMap(o.porData, 1),
      porDataTributo: objParaMap(o.porDataTributo, 2),
    };
  } catch (e) {
    console.warn('Não foi possível ler cache local:', e);
    return null;
  }
}

function limparCache() {
  localStorage.removeItem(CACHE_KEY);
  lastResult = null;
  resultsEl.style.display = 'none';
  chartsEl.style.display = 'none';
  cachedBar.style.display = 'none';
  btnExport.disabled = true;
}

// Restaura automaticamente o último resultado processado, se existir, ao abrir a página.
window.addEventListener('DOMContentLoaded', () => {
  const cache = carregarResultadoDoCache();
  if (cache) {
    lastResult = cache;
    renderizarResultado(cache);
    btnExport.disabled = false;
    const dataFmt = cache.salvoEm ? new Date(cache.salvoEm).toLocaleString('pt-BR') : '';
    cachedBar.innerHTML = `Mostrando resultado salvo de <strong>${escapeHTML(cache.nomeArquivo || 'um PDF anterior')}</strong> (processado em ${escapeHTML(dataFmt)}) — não precisou reprocessar. <button id="btnLimparCache" class="secondary" style="padding:4px 10px;font-size:.8rem;">Limpar e processar outro</button>`;
    cachedBar.style.display = 'block';
    document.getElementById('btnLimparCache').addEventListener('click', limparCache);
  }
  renderizarCardsAnos();
  renderizarListaAnos();
});

// ── Histórico por ano e comparativo ─────────────────────────────────────────
// Guarda vários relatórios (um por ano, marcado manualmente por você) pra poder
// comparar quanto foi arrecadado em cada ano, no mesmo período do calendário.
const ANOS_KEY = 'arrecadacao_anos_v1';

function carregarAnosSalvos() {
  try {
    const raw = localStorage.getItem(ANOS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn('Não foi possível ler o histórico de anos:', e);
    return {};
  }
}

function salvarAnoNoHistorico(ano, r) {
  const todos = carregarAnosSalvos();
  todos[ano] = {
    nomeArquivo: r.nomeArquivo,
    salvoEm: new Date().toISOString(),
    totalGeral: r.totalGeral,
    porTributo: mapParaObj(r.porTributo),
    porSub: mapParaObj(r.porSub),
    porData: mapParaObj(r.porData),
    porDataTributo: mapParaObj(r.porDataTributo),
  };
  localStorage.setItem(ANOS_KEY, JSON.stringify(todos));
}

function excluirAnoDoHistorico(ano) {
  const todos = carregarAnosSalvos();
  delete todos[ano];
  localStorage.setItem(ANOS_KEY, JSON.stringify(todos));
}

// Soma o resultado de um PDF recém-processado a um ano JÁ salvo, em vez de substituir — é o
// "lançamento em massa": em vez de digitar dia a dia na Movimentação diária, sobe um PDF (ex.: só o
// período que faltava) e todos os tributos/datas dele entram somados ao que já tinha. Se o ano ainda
// não existir no histórico, comporta-se como salvar pela primeira vez.
function mesclarResultadoNoAno(ano, r) {
  const todos = carregarAnosSalvos();
  const existente = todos[ano];
  if (!existente) {
    salvarAnoNoHistorico(ano, r);
    return;
  }

  existente.porTributo = existente.porTributo || {};
  existente.porData = existente.porData || {};
  existente.porDataTributo = existente.porDataTributo || {};
  existente.porSub = existente.porSub || {};

  for (const [nome, v] of r.porTributo.entries()) {
    existente.porTributo[nome] = (existente.porTributo[nome] || 0) + v;
  }
  for (const [data, v] of r.porData.entries()) {
    existente.porData[data] = (existente.porData[data] || 0) + v;
  }
  for (const [data, mapaTrib] of r.porDataTributo.entries()) {
    existente.porDataTributo[data] = existente.porDataTributo[data] || {};
    for (const [nome, v] of mapaTrib.entries()) {
      existente.porDataTributo[data][nome] = (existente.porDataTributo[data][nome] || 0) + v;
    }
  }
  for (const [nome, mapaSub] of r.porSub.entries()) {
    existente.porSub[nome] = existente.porSub[nome] || {};
    for (const [sub, v] of mapaSub.entries()) {
      existente.porSub[nome][sub] = (existente.porSub[nome][sub] || 0) + v;
    }
  }

  existente.totalGeral = Object.values(existente.porTributo).reduce((s, v) => s + v, 0);
  existente.nomeArquivo = existente.nomeArquivo ? `${existente.nomeArquivo} + ${r.nomeArquivo}` : r.nomeArquivo;
  existente.salvoEm = new Date().toISOString();

  todos[ano] = existente;
  localStorage.setItem(ANOS_KEY, JSON.stringify(todos));
}

function parseValorInput(s) {
  if (!s) return NaN;
  return parseValorBR(String(s).replace(/R\$/gi, '').trim());
}

// Lança manualmente a arrecadação de um dia (ex.: fechamento de caixa) dentro de um ano já salvo —
// soma nos mesmos totais que vieram do PDF (porTributo/porData/porDataTributo/porSub), marcado como
// "Lançamento manual" no detalhamento, pra ficar claro o que veio do relatório e o que foi digitado.
function adicionarMovimentoDiario(ano, dataStr, tributoNomeRaw, valor) {
  const todos = carregarAnosSalvos();
  const info = todos[ano];
  if (!info) return false;

  const nome = normalizarTributo(tributoNomeRaw);
  info.porTributo = info.porTributo || {};
  info.porData = info.porData || {};
  info.porDataTributo = info.porDataTributo || {};
  info.porSub = info.porSub || {};

  info.porTributo[nome] = (info.porTributo[nome] || 0) + valor;
  info.porData[dataStr] = (info.porData[dataStr] || 0) + valor;
  info.porDataTributo[dataStr] = info.porDataTributo[dataStr] || {};
  info.porDataTributo[dataStr][nome] = (info.porDataTributo[dataStr][nome] || 0) + valor;
  info.porSub[nome] = info.porSub[nome] || {};
  const subLabel = 'Lançamento manual (fechamento diário)';
  info.porSub[nome][subLabel] = (info.porSub[nome][subLabel] || 0) + valor;

  info.totalGeral = Object.values(info.porTributo).reduce((s, v) => s + v, 0);

  todos[ano] = info;
  localStorage.setItem(ANOS_KEY, JSON.stringify(todos));
  return true;
}

// Trata o clique em "Adicionar lançamento" dentro do card de um ano: valida os campos, grava o
// lançamento e re-renderiza só o necessário (cards dos anos + comparativo) sem perder a seleção
// de checkboxes já marcada no painel de comparativo.
function handleAdicionarMovimento(ano) {
  const card = document.getElementById(`ano-card-${ano}`);
  if (!card) return;
  const dataInput = card.querySelector('.mov-data');
  const tributoInput = card.querySelector('.mov-tributo');
  const valorInput = card.querySelector('.mov-valor');
  const statusEl2 = card.querySelector('.mov-status');
  const setStatus = (msg, ok) => { statusEl2.textContent = msg; statusEl2.style.color = ok ? 'var(--good)' : 'var(--warn)'; };

  if (!dataInput.value) return setStatus('Escolha uma data.', false);
  const tributoNome = tributoInput.value.trim();
  if (!tributoNome) return setStatus('Informe o tipo de tributo.', false);
  const valor = parseValorInput(valorInput.value);
  if (!valor || isNaN(valor) || valor <= 0) return setStatus('Informe um valor válido (ex.: 1234,56).', false);

  const [y, m, d] = dataInput.value.split('-');
  const dataBR = `${d}/${m}/${y}`;
  const dataAnteriorInput = dataInput.value;

  adicionarMovimentoDiario(ano, dataBR, tributoNome, valor);
  movDiariaAbertos.add(String(ano));
  renderizarCardsAnos();
  atualizarComparativo();

  // Restaura a data no formulário recriado (facilita lançar vários tributos do mesmo dia em seguida).
  const novoCard = document.getElementById(`ano-card-${ano}`);
  if (novoCard) {
    const novoStatus = novoCard.querySelector('.mov-status');
    novoStatus.textContent = `Lançamento de R$ ${fmtBRL(valor)} em ${dataBR} adicionado.`;
    novoStatus.style.color = 'var(--good)';
    const novaData = novoCard.querySelector('.mov-data');
    novaData.value = dataAnteriorInput;
    novoCard.querySelector('.mov-tributo').focus();
  }
}

// Processa um PDF escolhido dentro do card de um ano e soma o resultado ao que já existe (mesmo
// pipeline de extração/OCR/parsing do upload principal, só que o destino é `mesclarResultadoNoAno`
// em vez de `renderizarResultado` — não mexe no card do "processamento atual" lá em cima).
async function handleAlimentarAnoComPDF(ano, file) {
  const card = document.getElementById(`ano-card-${ano}`);
  if (!card) return;
  const statusEl2 = card.querySelector('.mov-pdf-status');
  const btn = card.querySelector('.btn-mov-pdf');
  const setStatus = (msg, ok) => { statusEl2.textContent = msg; statusEl2.style.color = ok === undefined ? 'var(--muted)' : (ok ? 'var(--good)' : 'var(--warn)'); };

  btn.disabled = true;
  try {
    const texto = await extrairTexto(file, (frac, msg) => setStatus(msg));
    const resultado = parseMinuta(texto);
    resultado.nomeArquivo = file.name;
    mesclarResultadoNoAno(ano, resultado);
    movDiariaAbertos.add(String(ano));
    renderizarCardsAnos();
    atualizarComparativo();

    const novoCard = document.getElementById(`ano-card-${ano}`);
    if (novoCard) {
      const novoStatus = novoCard.querySelector('.mov-pdf-status');
      novoStatus.textContent = `"${file.name}" somado ao ano ${ano} (Total Geral do PDF: R$ ${fmtBRL(resultado.totalGeral)}).`;
      novoStatus.style.color = 'var(--good)';
    }
  } catch (err) {
    console.error(err);
    setStatus('Erro ao processar: ' + err.message, false);
    btn.disabled = false;
  }
}

// Abre uma janela de impressão com o resumo (tabela + gráficos) daquele ano — o usuário usa o
// "Salvar como PDF" do próprio diálogo de impressão do navegador, sem precisar de nenhuma
// biblioteca extra de geração de PDF.
// Gera, num canvas temporário (fora da tela, sem afetar os gráficos já visíveis na página), um
// gráfico de barras empilhadas com a movimentação de cada dia discriminada por tributo — mesmas
// cores do gráfico de pizza — e devolve como imagem (data URL) pra embutir no PDF exportado.
function gerarImagemGraficoDiario(r) {
  const linhasData = [...r.porData.entries()].sort((a, b) => {
    const [da, ma, ya] = a[0].split('/'); const [db, mb, yb] = b[0].split('/');
    return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
  });
  if (!linhasData.length) return '';

  const linhasPizza = [...r.porTributo.entries()].sort((a, b) => b[1] - a[1]);
  const corPorTributo = new Map(linhasPizza.map(([nome], i) => [nome, CORES_GRAFICO[i % CORES_GRAFICO.length]]));

  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 320;
  canvas.style.position = 'fixed';
  canvas.style.left = '-9999px';
  document.body.appendChild(canvas);

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: linhasData.map(([data]) => data),
      datasets: linhasPizza.map(([nome]) => ({
        label: nome,
        data: linhasData.map(([data]) => r.porDataTributo.get(data)?.get(nome) || 0),
        backgroundColor: corPorTributo.get(nome),
      })),
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 9 } } },
      },
      scales: {
        x: { stacked: true, ticks: { font: { size: 8 }, maxRotation: 70, minRotation: 45 } },
        y: { stacked: true, ticks: { font: { size: 9 }, callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') } },
      },
    },
  });

  const imagem = canvas.toDataURL('image/png');
  chart.destroy();
  canvas.remove();
  return imagem;
}

function exportarAnoPDF(ano) {
  const todos = carregarAnosSalvos();
  const info = todos[ano];
  if (!info) return;
  const r = {
    porTributo: objParaMap(info.porTributo, 1),
    porSub: objParaMap(info.porSub, 2),
    porData: objParaMap(info.porData, 1),
    porDataTributo: objParaMap(info.porDataTributo, 2),
    totalGeral: info.totalGeral,
  };
  const tabelaHTML = construirTabelaResumoHTML(r, `pdf${ano}`);
  const tabelaDiariaHTML = construirTabelaDiariaHTML(r, `pdfdia${ano}`);
  const canvasPizza = document.getElementById(`chartPizza-${ano}`);
  const canvasLinha = document.getElementById(`chartLinha-${ano}`);
  const imgPizza = canvasPizza ? canvasPizza.toDataURL('image/png') : '';
  const imgLinha = canvasLinha ? canvasLinha.toDataURL('image/png') : '';
  const imgDiario = gerarImagemGraficoDiario(r);

  const janela = window.open('', '_blank');
  if (!janela) {
    alert('O navegador bloqueou a janela de impressão. Permita pop-ups pra exportar o PDF deste ano.');
    return;
  }
  janela.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Apuração ${escapeHTML(String(ano))}</title>
<style>
  body{font-family:Segoe UI,Arial,sans-serif;color:#1f2430;margin:28px;}
  h1{font-size:1.25rem;margin:0 0 2px;}
  .sub{color:#667085;font-size:.85rem;margin-bottom:20px;}
  .charts{display:flex;gap:16px;margin-bottom:22px;flex-wrap:wrap;}
  .charts img{max-width:47%;border:1px solid #dde1e6;border-radius:8px;}
  table{width:100%;border-collapse:collapse;font-size:.82rem;}
  th,td{padding:6px 8px;border-bottom:1px solid #dde1e6;text-align:left;}
  th{color:#667085;font-size:.75rem;text-transform:uppercase;}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
  tr.total td{font-weight:700;border-top:2px solid #1f2430;border-bottom:none;}
  tr.sub td{color:#667085;}
  tr.sub td:first-child{padding-left:22px;}
  tr.detail-row{display:table-row !important;}
  tr.detail-row td{padding:0;}
  tr.detail-row table{margin:2px 0 8px;}
  .caret{display:none;}
  h2.secao{font-size:.95rem;margin:26px 0 8px;padding-top:14px;border-top:1px solid #dde1e6;}
  img.grafico-diario{max-width:100%;border:1px solid #dde1e6;border-radius:8px;margin-bottom:16px;}
  @media print{ body{margin:10mm;} h2.secao{break-before:auto;} }
</style>
</head><body>
<h1>Apuração de Arrecadação Contábil — Ano ${escapeHTML(String(ano))}</h1>
<div class="sub">${escapeHTML(info.nomeArquivo || '')} — gerado em ${escapeHTML(new Date().toLocaleString('pt-BR'))}</div>
<div class="charts">
  ${imgPizza ? `<img src="${imgPizza}" alt="Arrecadado por tributo">` : ''}
  ${imgLinha ? `<img src="${imgLinha}" alt="Arrecadação diária">` : ''}
</div>
<table>${tabelaHTML}</table>
<h2 class="secao">Movimentação diária</h2>
${imgDiario ? `<img class="grafico-diario" src="${imgDiario}" alt="Movimentação diária por tributo">` : ''}
<table>${tabelaDiariaHTML}</table>
</body></html>`);
  janela.document.close();
  janela.focus();
  setTimeout(() => { try { janela.print(); } catch (e) { /* usuário pode imprimir manualmente */ } }, 400);
}

// Tabela de "Movimentação diária": uma linha por data (mais recente primeiro), clicável pra abrir
// o detalhamento por tributo daquele dia — reaproveita o mesmo acordeão (classes/IDs) do resumo geral.
function construirTabelaDiariaHTML(r, idPrefix) {
  const linhas = [...r.porData.entries()].sort((a, b) => {
    const [da, ma, ya] = a[0].split('/'); const [db, mb, yb] = b[0].split('/');
    return new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da);
  });
  if (!linhas.length) return `<tr><td class="hint" style="padding:8px 0;">Nenhuma data registrada ainda.</td></tr>`;
  let html = `<tr><th></th><th>Data</th><th class="num">Arrecadado no dia (R$)</th></tr>`;
  linhas.forEach(([data, v], i) => {
    const porTrib = r.porDataTributo.get(data);
    const temDetalhe = porTrib && porTrib.size;
    html += `<tr class="tributo-row" data-idx="${i}"><td><span class="caret">${temDetalhe ? '▶' : ''}</span></td><td>${escapeHTML(data)}</td><td class="num">${fmtBRL(v)}</td></tr>`;
    if (temDetalhe) {
      const subLinhas = [...porTrib.entries()].sort((a, b) => b[1] - a[1]);
      html += `<tr class="detail-row" id="detail-${idPrefix}-${i}" style="display:none;"><td></td><td colspan="2">
        <table>
          ${subLinhas.map(([t, tv]) => `<tr class="sub"><td>${escapeHTML(t)}</td><td class="num">${fmtBRL(tv)}</td></tr>`).join('')}
        </table>
      </td></tr>`;
    }
  });
  return html;
}

btnSalvarAno.addEventListener('click', () => {
  const ano = parseInt(anoInput.value, 10);
  if (!ano || ano < 2000 || ano > 2100) {
    salvarAnoStatus.textContent = 'Digite um ano válido (ex.: 2026).';
    salvarAnoStatus.style.color = 'var(--warn)';
    return;
  }
  if (!lastResult) return;
  salvarAnoNoHistorico(ano, lastResult);
  salvarAnoStatus.textContent = `Salvo como ${ano}.`;
  salvarAnoStatus.style.color = 'var(--good)';
  renderizarCardsAnos();
  renderizarListaAnos();
});

// Um card fixo por ano salvo (resumo + pizza + linha), empilhados — subir um ano novo NÃO
// apaga os anteriores, cada um fica visível e separado, na ordem do mais recente pro mais antigo.
function renderizarCardsAnos() {
  const todos = carregarAnosSalvos();
  const anos = Object.keys(todos).map(Number).sort((a, b) => b - a);

  // Libera os gráficos dos anos que não existem mais (removidos do histórico).
  for (const sufixo of Object.keys(graficosPorSufixo)) {
    if (!sufixo.startsWith('-')) continue;
    if (!anos.includes(Number(sufixo.slice(1)))) {
      const refs = graficosPorSufixo[sufixo];
      if (refs.pizza) refs.pizza.destroy();
      if (refs.linha) refs.linha.destroy();
      delete graficosPorSufixo[sufixo];
    }
  }

  anosCarregadosEl.innerHTML = anos.map(ano => `
    <div class="panel" id="ano-card-${ano}">
      <div class="ano-card-header">
        <h2>Ano ${ano} <span class="hint" style="margin:0;">— ${escapeHTML(todos[ano].nomeArquivo || '')}</span></h2>
        <div class="ano-card-actions">
          <button class="secondary btn-exportar-pdf-ano" data-ano="${ano}" type="button">Exportar PDF</button>
          <button class="btn-remover-ano" data-ano="${ano}">Remover ano</button>
        </div>
      </div>
      <div class="charts-grid" style="margin-bottom:18px;">
        <div class="chart-box">
          <h2 style="font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.02em;">Arrecadado por tributo</h2>
          <div class="chart-canvas-wrap" style="height:220px;"><canvas id="chartPizza-${ano}"></canvas></div>
        </div>
        <div class="chart-box">
          <h2 style="font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.02em;">Arrecadação diária</h2>
          <div class="chart-canvas-wrap" style="height:220px;"><canvas id="chartLinha-${ano}"></canvas></div>
        </div>
      </div>
      <table id="tabGeral-${ano}"></table>

      <div class="mov-diaria-section" style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);">
        <button type="button" class="mov-diaria-toggle" data-ano="${ano}">
          <span class="caret">▶</span>
          <h2 style="font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.02em;margin:0;">Movimentação diária</h2>
        </button>
        <div class="mov-diaria-body" id="mov-diaria-body-${ano}" style="display:none;">
          <div class="mov-pdf-bulk">
            <label class="hint" style="display:block;margin-bottom:6px;">Lançamento em massa: suba um PDF (ex.: só o período que faltava) e todos os tributos dele são somados ao que este ano já tem — sem substituir nada.</label>
            <input type="file" accept="application/pdf" class="mov-pdf-input" id="mov-pdf-input-${ano}" style="display:none;">
            <button class="secondary btn-mov-pdf" data-ano="${ano}" type="button">Escolher PDF e somar a este ano</button>
            <span class="mov-pdf-status hint" style="display:block;margin-top:6px;"></span>
          </div>
          <p class="hint" style="margin-top:8px;">Clique numa data pra ver o detalhamento por tributo. Lance aqui a arrecadação do fechamento do dia.</p>
          <table id="tabDiaria-${ano}"></table>
          <div class="row mov-form" style="margin-top:12px;">
            <input type="date" class="mov-data" aria-label="Data do lançamento">
            <input type="text" class="mov-tributo" list="dl-tributos-${ano}" placeholder="Tipo de tributo (ex.: ISSQN)">
            <datalist id="dl-tributos-${ano}"></datalist>
            <input type="text" class="mov-valor" placeholder="Valor (ex.: 1234,56)">
            <button class="secondary btn-add-mov" data-ano="${ano}">Adicionar lançamento</button>
            <span class="mov-status hint" style="margin-top:0;"></span>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  anos.forEach(ano => {
    const info = todos[ano];
    const r = {
      porTributo: objParaMap(info.porTributo, 1),
      porSub: objParaMap(info.porSub, 2),
      porData: objParaMap(info.porData, 1),
      porDataTributo: objParaMap(info.porDataTributo, 2),
      totalGeral: info.totalGeral,
    };
    const tabEl = document.getElementById(`tabGeral-${ano}`);
    tabEl.innerHTML = construirTabelaResumoHTML(r, `ano${ano}`);
    vincularCliquesTabela(tabEl, `ano${ano}`);
    renderizarGraficos(r, `-${ano}`, document.getElementById(`chartPizza-${ano}`), document.getElementById(`chartLinha-${ano}`));

    const tabDiariaEl = document.getElementById(`tabDiaria-${ano}`);
    tabDiariaEl.innerHTML = construirTabelaDiariaHTML(r, `dia${ano}`);
    vincularCliquesTabela(tabDiariaEl, `dia${ano}`);

    const dl = document.getElementById(`dl-tributos-${ano}`);
    dl.innerHTML = [...r.porTributo.keys()].sort().map(t => `<option value="${escapeHTML(t)}">`).join('');
  });

  anosCarregadosEl.querySelectorAll('.btn-remover-ano').forEach(btn => btn.addEventListener('click', () => {
    const ano = btn.getAttribute('data-ano');
    if (!confirm(`Remover o ano ${ano} do histórico? (o PDF original não é afetado, só precisa reprocessar se quiser de volta)`)) return;
    excluirAnoDoHistorico(ano);
    renderizarCardsAnos();
    renderizarListaAnos();
  }));

  anosCarregadosEl.querySelectorAll('.btn-exportar-pdf-ano').forEach(btn => btn.addEventListener('click', () => {
    exportarAnoPDF(btn.getAttribute('data-ano'));
  }));

  anosCarregadosEl.querySelectorAll('.btn-mov-pdf').forEach(btn => btn.addEventListener('click', () => {
    document.getElementById(`mov-pdf-input-${btn.getAttribute('data-ano')}`).click();
  }));
  anosCarregadosEl.querySelectorAll('.mov-pdf-input').forEach(inp => inp.addEventListener('change', () => {
    if (!inp.files.length) return;
    const ano = inp.id.replace('mov-pdf-input-', '');
    handleAlimentarAnoComPDF(ano, inp.files[0]);
  }));

  anosCarregadosEl.querySelectorAll('.btn-add-mov').forEach(btn => btn.addEventListener('click', () => {
    handleAdicionarMovimento(btn.getAttribute('data-ano'));
  }));
  anosCarregadosEl.querySelectorAll('.mov-form .mov-valor').forEach(inp => inp.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const ano = inp.closest('.panel').id.replace('ano-card-', '');
    handleAdicionarMovimento(ano);
  }));

  // Seção "Movimentação diária": fechada por padrão, alterna ao clicar no cabeçalho — o estado
  // (aberto/fechado) fica em `movDiariaAbertos` pra sobreviver aos re-renders do card inteiro.
  anosCarregadosEl.querySelectorAll('.mov-diaria-toggle').forEach(btn => {
    const ano = btn.getAttribute('data-ano');
    const body = document.getElementById(`mov-diaria-body-${ano}`);
    const caret = btn.querySelector('.caret');
    const aberto = movDiariaAbertos.has(ano);
    body.style.display = aberto ? '' : 'none';
    caret.classList.toggle('open', aberto);
    btn.addEventListener('click', () => {
      const abrirAgora = body.style.display === 'none';
      body.style.display = abrirAgora ? '' : 'none';
      caret.classList.toggle('open', abrirAgora);
      if (abrirAgora) movDiariaAbertos.add(ano); else movDiariaAbertos.delete(ano);
    });
  });
}

function renderizarListaAnos() {
  const todos = carregarAnosSalvos();
  const anos = Object.keys(todos).map(Number).sort((a, b) => a - b);

  if (!anos.length) {
    comparativoEl.style.display = 'none';
    return;
  }
  comparativoEl.style.display = 'block';

  anosSalvosLista.innerHTML = anos.map((ano, i) => `
    <label class="ano-chip">
      <input type="checkbox" class="chk-ano" value="${ano}" checked>
      <input type="color" class="chk-ano-cor" data-ano="${ano}" value="${corDoAno(todos, ano, i)}" title="Cor deste ano no gráfico comparativo">
      ${ano} <span class="hint" style="margin:0;">(${escapeHTML(todos[ano].nomeArquivo || '')})</span>
      <span class="del" data-ano="${ano}" title="Remover este ano do histórico">✕</span>
    </label>
  `).join('');

  anosSalvosLista.querySelectorAll('.chk-ano').forEach(chk => chk.addEventListener('change', atualizarComparativo));
  anosSalvosLista.querySelectorAll('.chk-ano-cor').forEach(inp => inp.addEventListener('input', () => {
    definirCorAno(inp.getAttribute('data-ano'), inp.value);
  }));
  anosSalvosLista.querySelectorAll('.del').forEach(el => el.addEventListener('click', (ev) => {
    ev.preventDefault();
    excluirAnoDoHistorico(el.getAttribute('data-ano'));
    renderizarCardsAnos();
    renderizarListaAnos();
  }));

  atualizarComparativo();
}

// Cor de um ano no gráfico comparativo: usa a escolhida manualmente se existir, senão cai na
// paleta padrão (pela posição do ano na lista) — é só o ponto de partida, o usuário pode trocar
// livremente pra deixar anos parecidos (ex.: dois tons de azul) mais distintos entre si.
function corDoAno(todos, ano, indice) {
  return (todos[ano] && todos[ano].corComparativo) || CORES_GRAFICO[indice % CORES_GRAFICO.length];
}

function definirCorAno(ano, cor) {
  const todos = carregarAnosSalvos();
  if (!todos[ano]) return;
  todos[ano].corComparativo = cor;
  localStorage.setItem(ANOS_KEY, JSON.stringify(todos));
  atualizarComparativo();
}

// "dd/mm/aaaa" -> número mmdd (ignora o ano), pra alinhar o mesmo período entre anos diferentes.
function mesDia(dataStr) {
  const [dd, mm] = dataStr.split('/').map(Number);
  return mm * 100 + dd;
}
function fmtMesDia(num) {
  const dd = String(num % 100).padStart(2, '0');
  const mm = String(Math.floor(num / 100)).padStart(2, '0');
  return `${dd}/${mm}`;
}

function atualizarComparativo() {
  const todos = carregarAnosSalvos();
  const anosMarcados = [...anosSalvosLista.querySelectorAll('.chk-ano:checked')].map(el => el.value);

  if (!anosMarcados.length) {
    periodoComparadoEl.textContent = 'Marque pelo menos um ano para ver o comparativo.';
    if (chartComparativo) { chartComparativo.destroy(); chartComparativo = null; }
    destaquesVariacaoEl.innerHTML = '';
    tabVariacaoEl.innerHTML = '';
    return;
  }

  // Janela comum (dia/mês) entre todos os anos marcados.
  let janelaMin = -Infinity, janelaMax = Infinity;
  const dadosPorAno = {};
  for (const ano of anosMarcados) {
    const info = todos[ano];
    if (!info) continue;
    const datas = Object.keys(info.porData || {});
    if (!datas.length) continue;
    let anoMin = Infinity, anoMax = -Infinity;
    for (const d of datas) { const v = mesDia(d); if (v < anoMin) anoMin = v; if (v > anoMax) anoMax = v; }
    janelaMin = Math.max(janelaMin, anoMin);
    janelaMax = Math.min(janelaMax, anoMax);
    dadosPorAno[ano] = info;
  }

  if (!isFinite(janelaMin) || !isFinite(janelaMax) || janelaMin > janelaMax) {
    periodoComparadoEl.textContent = 'Não há período em comum entre os anos marcados (as datas não se sobrepõem).';
    if (chartComparativo) { chartComparativo.destroy(); chartComparativo = null; }
    destaquesVariacaoEl.innerHTML = '';
    tabVariacaoEl.innerHTML = '';
    return;
  }

  periodoComparadoEl.textContent = `Comparando o período de ${fmtMesDia(janelaMin)} a ${fmtMesDia(janelaMax)} em cada ano marcado.`;

  // Soma, por ano e por tributo, só as datas dentro da janela comum.
  const somaPorAnoTributo = {}; // ano -> { tributo -> valor }
  const tributosSet = new Set();
  for (const ano of anosMarcados) {
    const info = dadosPorAno[ano];
    if (!info) continue;
    const soma = {};
    for (const [data, mapaTrib] of Object.entries(info.porDataTributo || {})) {
      const md = mesDia(data);
      if (md < janelaMin || md > janelaMax) continue;
      for (const [tributo, valor] of Object.entries(mapaTrib)) {
        soma[tributo] = (soma[tributo] || 0) + valor;
        tributosSet.add(tributo);
      }
    }
    somaPorAnoTributo[ano] = soma;
  }

  const tributos = [...tributosSet].sort((a, b) => {
    const totalA = anosMarcados.reduce((s, ano) => s + (somaPorAnoTributo[ano]?.[a] || 0), 0);
    const totalB = anosMarcados.reduce((s, ano) => s + (somaPorAnoTributo[ano]?.[b] || 0), 0);
    return totalB - totalA;
  });

  const ctx = document.getElementById('chartComparativo').getContext('2d');
  if (chartComparativo) chartComparativo.destroy();
  chartComparativo = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: tributos,
      datasets: anosMarcados.map((ano, i) => ({
        label: String(ano),
        data: tributos.map(t => somaPorAnoTributo[ano]?.[t] || 0),
        backgroundColor: corDoAno(todos, ano, i),
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: R$ ${fmtBRL(ctx.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { ticks: { callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') } },
      },
    },
  });

  renderizarVariacao(anosMarcados, somaPorAnoTributo, tributos);
}

// Mostra, entre os anos marcados (do mais antigo pro mais recente, considerando só o período em
// comum), quanto cada tributo cresceu ou caiu — e destaca a maior alta, a maior queda e o total geral.
function renderizarVariacao(anosMarcados, somaPorAnoTributo, tributos) {
  const anosOrdenados = [...anosMarcados].map(String).sort((a, b) => Number(a) - Number(b));

  if (anosOrdenados.length < 2) {
    destaquesVariacaoEl.innerHTML = '';
    tabVariacaoEl.innerHTML = '';
    return;
  }

  const totalPorAno = {};
  for (const ano of anosOrdenados) {
    totalPorAno[ano] = tributos.reduce((s, t) => s + (somaPorAnoTributo[ano]?.[t] || 0), 0);
  }

  function variacao(vAntigo, vNovo) {
    const delta = vNovo - vAntigo;
    let pct;
    if (vAntigo > 0) pct = (delta / vAntigo) * 100;
    else pct = vNovo > 0 ? Infinity : 0;
    return { delta, pct };
  }

  function fmtVariacaoHTML(vAntigo, vNovo) {
    const { delta, pct } = variacao(vAntigo, vNovo);
    if (delta === 0 && vAntigo === 0 && vNovo === 0) return `<span class="variacao-zero">—</span>`;
    const cls = delta > 0 ? 'variacao-pos' : (delta < 0 ? 'variacao-neg' : 'variacao-zero');
    const seta = delta > 0 ? '▲' : (delta < 0 ? '▼' : '—');
    const pctTxt = pct === Infinity ? 'novo' : `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    const sinalR$ = delta >= 0 ? '+' : '-';
    return `<span class="${cls}">${seta} ${sinalR$}R$ ${fmtBRL(Math.abs(delta))} (${pctTxt})</span>`;
  }

  // ── Destaques: comparando o ano mais antigo com o mais recente marcados ──
  const anoBase = anosOrdenados[0];
  const anoFinal = anosOrdenados[anosOrdenados.length - 1];
  let melhor = null, pior = null; // { tributo, pct, delta }
  for (const t of tributos) {
    const vAntigo = somaPorAnoTributo[anoBase]?.[t] || 0;
    const vNovo = somaPorAnoTributo[anoFinal]?.[t] || 0;
    if (vAntigo === 0 && vNovo === 0) continue;
    const { delta, pct } = variacao(vAntigo, vNovo);
    const pctComp = pct === Infinity ? 1e9 : pct;
    if (!melhor || pctComp > melhor.pctComp) melhor = { tributo: t, delta, pct, pctComp };
    if (!pior || pctComp < pior.pctComp) pior = { tributo: t, delta, pct, pctComp };
  }
  const totalVar = variacao(totalPorAno[anoBase], totalPorAno[anoFinal]);

  let destaquesHTML = `<div class="destaques-grid">`;
  destaquesHTML += `
    <div class="destaque-card ${totalVar.delta >= 0 ? 'subiu' : 'desceu'}">
      <div class="label">Total geral: ${escapeHTML(anoBase)} → ${escapeHTML(anoFinal)}</div>
      <div class="valor">${fmtVariacaoHTML(totalPorAno[anoBase], totalPorAno[anoFinal])}</div>
    </div>`;
  if (melhor) {
    destaquesHTML += `
    <div class="destaque-card subiu">
      <div class="label">Maior crescimento</div>
      <div class="valor">${escapeHTML(melhor.tributo)}</div>
      <div>${fmtVariacaoHTML(somaPorAnoTributo[anoBase]?.[melhor.tributo] || 0, somaPorAnoTributo[anoFinal]?.[melhor.tributo] || 0)}</div>
    </div>`;
  }
  if (pior) {
    destaquesHTML += `
    <div class="destaque-card desceu">
      <div class="label">Maior queda</div>
      <div class="valor">${escapeHTML(pior.tributo)}</div>
      <div>${fmtVariacaoHTML(somaPorAnoTributo[anoBase]?.[pior.tributo] || 0, somaPorAnoTributo[anoFinal]?.[pior.tributo] || 0)}</div>
    </div>`;
  }
  destaquesHTML += `</div>`;
  destaquesVariacaoEl.innerHTML = destaquesHTML;

  // ── Tabela: valor de cada tributo em cada ano marcado + variação ano a ano ──
  let html = `<tr><th>Tributo</th>`;
  anosOrdenados.forEach((ano, i) => {
    html += `<th class="num-var">${escapeHTML(ano)}</th>`;
    if (i > 0) html += `<th class="num-var">Var. ${escapeHTML(anosOrdenados[i - 1])} → ${escapeHTML(ano)}</th>`;
  });
  html += `</tr>`;

  tributos.forEach(t => {
    html += `<tr><td>${escapeHTML(t)}</td>`;
    anosOrdenados.forEach((ano, i) => {
      const v = somaPorAnoTributo[ano]?.[t] || 0;
      html += `<td class="num-var">R$ ${fmtBRL(v)}</td>`;
      if (i > 0) {
        const vAnt = somaPorAnoTributo[anosOrdenados[i - 1]]?.[t] || 0;
        html += `<td class="num-var">${fmtVariacaoHTML(vAnt, v)}</td>`;
      }
    });
    html += `</tr>`;
  });

  html += `<tr class="total"><td>TOTAL GERAL</td>`;
  anosOrdenados.forEach((ano, i) => {
    html += `<td class="num-var">R$ ${fmtBRL(totalPorAno[ano])}</td>`;
    if (i > 0) html += `<td class="num-var">${fmtVariacaoHTML(totalPorAno[anosOrdenados[i - 1]], totalPorAno[ano])}</td>`;
  });
  html += `</tr>`;

  tabVariacaoEl.innerHTML = html;
}

// Mesma ideia do "Exportar PDF" de cada ano, mas pro painel de comparativo inteiro: gráfico de
// barras + destaques (maior crescimento/queda) + tabela de variação ano a ano, numa janela de
// impressão pra salvar como PDF pelo navegador.
btnExportarComparativoPDF.addEventListener('click', () => {
  const anosMarcados = [...anosSalvosLista.querySelectorAll('.chk-ano:checked')].map(el => el.value);
  if (anosMarcados.length < 2) {
    alert('Marque pelo menos 2 anos pra exportar o comparativo.');
    return;
  }

  const imgComparativo = chartComparativo ? document.getElementById('chartComparativo').toDataURL('image/png') : '';

  const janela = window.open('', '_blank');
  if (!janela) {
    alert('O navegador bloqueou a janela de impressão. Permita pop-ups pra exportar o PDF do comparativo.');
    return;
  }
  janela.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><title>Comparativo entre anos</title>
<style>
  body{font-family:Segoe UI,Arial,sans-serif;color:#1f2430;margin:28px;}
  h1{font-size:1.25rem;margin:0 0 2px;}
  .sub{color:#667085;font-size:.85rem;margin-bottom:20px;}
  img.grafico{max-width:100%;border:1px solid #dde1e6;border-radius:8px;margin-bottom:20px;}
  .destaques-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:22px;}
  .destaque-card{border:1px solid #dde1e6;border-radius:8px;padding:10px 12px;}
  .destaque-card.subiu{border-left:4px solid #1e7d4d;}
  .destaque-card.desceu{border-left:4px solid #b6531c;}
  .destaque-card .label{font-size:.72rem;color:#667085;text-transform:uppercase;margin-bottom:3px;}
  .destaque-card .valor{font-weight:700;}
  .variacao-pos{color:#1e7d4d;font-weight:600;}
  .variacao-neg{color:#b6531c;font-weight:600;}
  .variacao-zero{color:#667085;}
  table{width:100%;border-collapse:collapse;font-size:.8rem;}
  th,td{padding:6px 8px;border-bottom:1px solid #dde1e6;text-align:right;white-space:nowrap;}
  th:first-child,td:first-child{text-align:left;}
  th{color:#667085;font-size:.72rem;text-transform:uppercase;}
  tr.total td{font-weight:700;border-top:2px solid #1f2430;}
  @media print{ body{margin:10mm;} }
</style>
</head><body>
<h1>Comparativo entre anos — ${escapeHTML(anosMarcados.join(', '))}</h1>
<div class="sub">${escapeHTML(periodoComparadoEl.textContent)} — gerado em ${escapeHTML(new Date().toLocaleString('pt-BR'))}</div>
${imgComparativo ? `<img class="grafico" src="${imgComparativo}" alt="Gráfico comparativo">` : ''}
${destaquesVariacaoEl.innerHTML}
<div style="margin-top:20px;">${tabVariacaoEl.outerHTML}</div>
</body></html>`);
  janela.document.close();
  janela.focus();
  setTimeout(() => { try { janela.print(); } catch (e) { /* usuário pode imprimir manualmente */ } }, 400);
});

btnProcess.addEventListener('click', async () => {
  if (!currentFile) return;
  btnProcess.disabled = true;
  progressBar.style.display = 'block';
  progressBar.value = 0;
  try {
    const texto = await extrairTexto(currentFile, (frac, msg) => {
      progressBar.value = frac;
      statusEl.textContent = msg;
    });
    const resultado = parseMinuta(texto);
    resultado.nomeArquivo = currentFile.name;
    lastResult = resultado;
    renderizarResultado(resultado);
    btnExport.disabled = false;
    statusEl.textContent = 'Concluído.';
    salvarResultadoNoCache(resultado);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Erro ao processar: ' + err.message;
  } finally {
    btnProcess.disabled = false;
    progressBar.style.display = 'none';
  }
});

// ── Extração de texto (usa texto embutido se existir; senão OCR) ──────────────
async function extrairTexto(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  // Tenta texto embutido primeiro (rápido, sem OCR)
  let textoEmbutido = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const linhas = agruparPorLinha(content.items);
    textoEmbutido += linhas.join('\n') + '\n\n';
  }
  if (textoEmbutido.replace(/\s/g, '').length > 200) {
    onProgress(1, 'Texto embutido encontrado — sem necessidade de OCR.');
    return textoEmbutido;
  }

  // Sem texto útil: OCR página a página, em paralelo (um worker por núcleo de CPU disponível).
  // Cada worker usa PSM 6 ("bloco único de texto"), em vez do modo automático padrão — o modo
  // automático tenta detectar colunas sozinho e é exatamente o que fazia o Tesseract reconhecer o
  // mesmo trecho duas vezes nesse tipo de relatório (rótulo numa "coluna", valor bem afastado em
  // outra); forçando bloco único ele lê linha por linha na ordem natural, sem duplicar.
  const numWorkers = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
  const scheduler = Tesseract.createScheduler();
  for (let i = 0; i < numWorkers; i++) {
    onProgress(0, `Preparando OCR (iniciando ${i + 1}/${numWorkers} processos em paralelo)...`);
    const w = await Tesseract.createWorker('por');
    try {
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    } catch (e) {
      console.warn('Não foi possível ajustar parâmetros do OCR, usando padrão:', e);
    }
    scheduler.addWorker(w);
  }

  const LIMIAR_BAIXA_CONFIANCA = 75;
  const resultados = new Array(pdf.numPages);
  const confiancas = new Array(pdf.numPages);
  let concluidas = 0;

  // Renderiza + reconhece uma página; devolve {texto, confianca}. Usado tanto na primeira passada
  // quanto no reprocessamento de páginas ruins.
  //
  // NÃO binariza a imagem antes do OCR (testei e tirei essa etapa de novo): esses relatórios são
  // gerados digitalmente — o texto já sai de um "imprimir para PDF" como vetor, sem ruído de scanner
  // de verdade — e a binarização (preto/branco puro via limiar de Otsu) estava fazendo mais mal que
  // bem: comparei OCR da mesma página com e sem binarização e ela trocou "TOTAL DESTE TRIBUTO:" por
  // "TOTAL DESTE TRIBUTO;" (dois-pontos virou ponto e vírgula) E um valor de R$268,73 virou R$368,73
  // (o "2" virou "3") — a binarização "endureceu" a antialiasing que o Tesseract usa pra diferenciar
  // dígitos parecidos. Como o texto de origem já é nítido, o passo que ajudaria em scan de papel real
  // aqui só introduzia erro.
  async function ocrPagina(p, scale) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale, rotation: page.rotate || 0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const { data } = await scheduler.addJob('recognize', canvas);
    canvas.width = 0; canvas.height = 0;
    return { texto: removerLinhasDuplicadas(data.text), confianca: typeof data.confidence === 'number' ? data.confidence : null };
  }

  // Processa as páginas com um número LIMITADO de renderizações simultâneas (== numWorkers) em vez
  // de disparar todas de uma vez. Relatórios reais desse tipo de minuta têm 80-170+ páginas — sem
  // esse limite, o código antigo criava um canvas cheio (renderizado + binarizado, ~18MB cada em
  // escala 3x) para TODAS as páginas de uma vez só, antes mesmo do OCR começar a consumi-las, porque
  // o "for" que disparava os jobs não esperava nenhum terminar. Num PDF de 170 páginas isso empilhava
  // ~3GB de canvas na memória ao mesmo tempo — o motivo mais provável de resultado incompleto/errado
  // em arquivos grandes (a aba trava ou o navegador mata a página por falta de memória, silenciosamente
  // perdendo páginas no meio do processo). Processar só `numWorkers` páginas por vez mantém a memória
  // proporcional ao paralelismo real, não ao tamanho do arquivo.
  async function processarComLimite(paginas, tarefa, concorrencia) {
    let proximo = 0;
    const executores = new Array(concorrencia).fill(0).map(async () => {
      while (proximo < paginas.length) {
        const i = proximo++;
        await tarefa(paginas[i], i);
      }
    });
    await Promise.all(executores);
  }

  const todasPaginas = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  await processarComLimite(todasPaginas, async (p) => {
    const idx = p - 1;
    const r = await ocrPagina(p, 3);
    resultados[idx] = r.texto;
    confiancas[idx] = r.confianca;
    concluidas++;
    onProgress(concluidas / pdf.numPages, `OCR: ${concluidas} de ${pdf.numPages} páginas concluídas (${numWorkers} em paralelo)...`);
  }, numWorkers);

  // Segunda passada automática, só nas páginas que ficaram abaixo do limiar de confiança: renderiza
  // de novo numa escala maior (mais nítido pro OCR) e fica com a leitura que tiver mais confiança.
  // Também limitada em concorrência, pelo mesmo motivo acima.
  const paginasParaRefazer = confiancas
    .map((c, i) => ({ idx: i, pagina: i + 1, confianca: c }))
    .filter(x => typeof x.confianca === 'number' && x.confianca < LIMIAR_BAIXA_CONFIANCA);

  if (paginasParaRefazer.length) {
    let refeitas = 0;
    await processarComLimite(paginasParaRefazer, async ({ idx, pagina }) => {
      const r = await ocrPagina(pagina, 4.5);
      if (r.confianca != null && (confiancas[idx] == null || r.confianca > confiancas[idx])) {
        resultados[idx] = r.texto;
        confiancas[idx] = r.confianca;
      }
      refeitas++;
      onProgress(1, `Reprocessando ${refeitas} de ${paginasParaRefazer.length} página(s) com confiança baixa (resolução maior)...`);
    }, numWorkers);
  }

  await scheduler.terminate();
  onProgress(1, 'OCR concluído.');
  return resultados.join('\n\n');
}

// O Tesseract às vezes reconhece o mesmo trecho de texto duas vezes quando a página tem colunas
// bem separadas (rótulo à esquerda, valor bem à direita) — a análise de layout interpreta como
// blocos sobrepostos e repete a linha. Remove repetições exatas (vizinhas ou próximas) por página.
function removerLinhasDuplicadas(texto) {
  const linhas = texto.split('\n');
  const saida = [];
  const normsRecentes = [];
  for (const linha of linhas) {
    const norm = linha.replace(/\s+/g, ' ').trim();
    if (norm && normsRecentes.includes(norm)) continue;
    saida.push(linha);
    normsRecentes.push(norm);
    if (normsRecentes.length > 4) normsRecentes.shift();
  }
  return saida.join('\n');
}

function agruparPorLinha(items) {
  const porY = new Map();
  for (const it of items) {
    const y = Math.round(it.transform[5]);
    if (!porY.has(y)) porY.set(y, []);
    porY.get(y).push(it);
  }
  const ys = [...porY.keys()].sort((a, b) => b - a);
  return ys.map(y => porY.get(y).sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' '));
}

// ── Parsing da minuta ──────────────────────────────────────────────────────
const MONEY_RE = /(-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;

// Palavras-chave para identificar o tributo de origem dentro do quadro de Dívida Ativa
const DA_KEYWORDS = [
  { key: 'IPTU', re: /IPTU/i },
  { key: 'ISSQN / ISS', re: /ISSQN|\bISS\b/i },
  { key: 'ITBI', re: /ITBI/i },
  { key: 'Taxa Fiscaliz. Funcionamento (TFF)', re: /\bTFF\b|Fiscalizac.{0,3}Funcion/i },
  { key: 'ITR', re: /\bITR\b/i },
  { key: 'CFEM', re: /CFEM/i },
  { key: 'Multas de Trânsito', re: /Tr[aâ]nsito/i },
  { key: 'COSIP / Ilum. Pública', re: /Ilum.{0,3}P[uú]blica|COSIP/i },
  { key: 'Taxas diversas', re: /Taxa/i },
];

function classificarOrigemDA(descricao) {
  for (const k of DA_KEYWORDS) if (k.re.test(descricao)) return k.key;
  return 'Outros / não identificado';
}

// Traduz a descrição abreviada de cada rubrica (fora da Dívida Ativa) para um rótulo legível,
// discriminando principal x multa/juros dentro de cada tributo (ex.: IPTU/TAXAS vira "IPTU - Principal",
// "IPTU - Multas e Juros", "Taxa de Segurança Preventiva", "COSIP", "Contribuição de Melhoria" etc.)
function rotuloAmigavel(descricao) {
  const d = descricao;
  const ehMultaJuros = /MJM|Mult.{0,4}Jur|Mora/i.test(d);

  if (/IPTU/i.test(d)) return ehMultaJuros ? 'IPTU - Multas e Juros de Mora' : 'IPTU - Principal';
  if (/ISSQN|\bISS\b/i.test(d)) return ehMultaJuros ? 'ISSQN - Multas e Juros de Mora' : 'ISSQN - Principal';
  if (/ITBI/i.test(d)) return 'ITBI';
  if (/\bTFF\b|Fiscalizac.{0,3}Funcion/i.test(d)) return ehMultaJuros ? 'Taxa Fiscaliz. Funcionamento (TFF) - Multas e Juros' : 'Taxa Fiscaliz. Funcionamento (TFF) - Principal';
  if (/Ilum.{0,3}P[uú]blica|COSIP/i.test(d)) return 'COSIP - Contrib. Ilum. Pública';
  if (/Melhoria/i.test(d)) return 'Contribuição de Melhoria';
  if (/Seguran[çc]a Preventiva|Taxas?\s*pela\s*Prest/i.test(d)) return ehMultaJuros ? 'Taxa de Segurança Preventiva - Multas e Juros' : 'Taxa de Segurança Preventiva';
  if (/CFEM/i.test(d)) return 'CFEM';
  if (/\bITR\b/i.test(d)) return 'ITR';
  if (/Tr[aâ]nsito/i.test(d)) return 'Multas de Trânsito';
  if (/IRRF|Imposto de Renda/i.test(d)) return 'IRRF';
  if (/Simples/i.test(d)) return 'Simples Nacional';
  return d; // não reconhecido: mantém a descrição original do relatório
}

// Remove pontuação solta que o OCR às vezes gruda no começo do nome do tributo (ex.: o ":" de "TOTAL
// DESTE TRIBUTO:" às vezes sai lido como ";" e, como não é o ":" literal esperado, a regex captura
// junto com o nome — "; ITBI" em vez de "ITBI" — e isso faz o mesmo tributo aparecer duplicado na
// tela, com e sem o símbolo). Sem essa limpeza, um único caractere de ruído do OCR quebra a agregação
// inteira daquele tributo em duas linhas separadas.
function normalizarTributo(nome) {
  const n = nome.trim().replace(/^[^\p{L}\p{N}]+/u, '').toUpperCase().replace(/\s+/g, ' ');
  return n;
}

function parseMinuta(texto) {
  const linhasBrutas = texto.split('\n').map(l => l.replace(/\s+/g, ' ').trim());

  // Fonte OFICIAL dos números mostrados (Total Geral e valor de cada tributo): as próprias
  // linhas "TOTAL DESTE TRIBUTO" / "TOTAL DESTA DATA" já impressas no relatório. É o número que
  // bateu com o total real nos testes — a soma linha a linha demonstrou duplicar texto em alguns
  // casos (artefato do OCR em página com colunas bem separadas) e por isso não é mais usada como total.
  const porTributo = new Map();   // nome do tipo de tributo -> soma OFICIAL (via "TOTAL DESTE TRIBUTO")
  const porData = new Map();      // data da arrecadação -> soma OFICIAL (via "TOTAL DESTA DATA")
  const porDataTributo = new Map(); // data -> Map(tipo de tributo -> soma), via "TOTAL DESTE TRIBUTO" na data

  // Lançamentos individuais: usados só para saber a PROPORÇÃO de cada sub-item dentro do tributo
  // (ex.: quanto do IPTU/TAXAS é "Principal" x "Multas"). O valor absoluto de cada sub-item é depois
  // escalado para que a soma bata exatamente com o total oficial do tributo.
  const porSubBruto = new Map();  // nome do tipo de tributo -> Map(sub-item -> soma bruta)

  let tributoAtual = null;
  let descricaoRubricaAtual = null;
  let dataAtual = null;

  // "[:;]?" em vez de ":?" — o OCR às vezes lê o dois-pontos depois desses rótulos como ponto-e-vírgula.
  const reData = /^DATA DA ARRECADA[ÇC][ÃA]O[:;]?\s*(\d{2}\/\d{2}\/\d{4})/i;
  const reTipoTributo = /^TIPO DE TRIBUTO[:;]?\s*(.+)$/i;
  const reTotalTributo = /^TOTAL DESTE TRIBUTO[:;]?\s*(.+?)\s+(-?[\d.]*\d,\d{2})\s*$/i;
  const reTotalData = /^TOTAL DESTA DATA[:;]?\s*(\d{2}\/\d{2}\/\d{4})\s+(-?[\d.]*\d,\d{2})\s*$/i;
  const reTotalLinha = /^TOTAL (DESTE TRIBUTO|DESTE BANCO|DESTA DATA)/i;
  // O traço depois do código de 4 dígitos às vezes sai do OCR como travessão (–/—) e às vezes como
  // hífen normal SEGUIDO de travessão ("0030 -— 1.1.2...") — testei com o relatório real e o Tesseract
  // produz as duas formas dependendo da página. "[-–—]+" aceita um ou mais desses caracteres em
  // sequência, então casa nos dois casos (antes só aceitava um único traço e perdia a rubrica inteira
  // sempre que o OCR emendava hífen + travessão, fazendo o sub-item cair no rótulo genérico).
  const reRubrica = /^\d{4}\s*[-–—]+\s*[\d.]+\s+(.+)$/; // ex: "0013 -  1.1.1.4.51.1.1  Imp. s/ Serv...."

  for (let raw of linhasBrutas) {
    if (!raw) continue;

    let m = reData.exec(raw);
    if (m) { dataAtual = m[1]; continue; }

    m = reTotalTributo.exec(raw);
    if (m) {
      const nome = normalizarTributo(m[1]);
      const valor = parseValorBR(m[2]);
      if (!isNaN(valor)) {
        porTributo.set(nome, (porTributo.get(nome) || 0) + valor);
        if (dataAtual) {
          if (!porDataTributo.has(dataAtual)) porDataTributo.set(dataAtual, new Map());
          const mapaDia = porDataTributo.get(dataAtual);
          mapaDia.set(nome, (mapaDia.get(nome) || 0) + valor);
        }
      }
      continue;
    }

    m = reTotalData.exec(raw);
    if (m) {
      const valor = parseValorBR(m[2]);
      if (!isNaN(valor)) porData.set(m[1], (porData.get(m[1]) || 0) + valor);
      continue;
    }

    if (reTotalLinha.test(raw)) continue; // "TOTAL DESTE BANCO" ou totais que o OCR não conseguiu casar com valor — ignora

    m = reTipoTributo.exec(raw);
    if (m) { tributoAtual = normalizarTributo(m[1]); descricaoRubricaAtual = null; continue; }

    m = reRubrica.exec(raw);
    if (m) { descricaoRubricaAtual = m[1].replace(MONEY_RE, '').trim(); }

    const moneyMatch = MONEY_RE.exec(raw);
    if (!moneyMatch) continue;
    if (!tributoAtual) continue;

    const valor = parseValorBR(moneyMatch[1]);
    if (isNaN(valor)) continue;

    const desc = descricaoRubricaAtual || raw;
    const ehDA = /D[IÍ]VIDA ATIVA/i.test(tributoAtual);
    const subLabel = ehDA ? ('DA – ' + classificarOrigemDA(desc)) : rotuloAmigavel(desc);
    if (!porSubBruto.has(tributoAtual)) porSubBruto.set(tributoAtual, new Map());
    const mapaSub = porSubBruto.get(tributoAtual);
    mapaSub.set(subLabel, (mapaSub.get(subLabel) || 0) + valor);
  }

  // Escala os sub-itens de cada tributo para que a soma bata exatamente com o total oficial
  // (mantém a proporção relativa entre os sub-itens, mesmo que o OCR tenha duplicado/perdido linhas).
  const porSub = new Map();
  for (const [nome, totalOficial] of porTributo.entries()) {
    const bruto = porSubBruto.get(nome);
    if (!bruto || !bruto.size) continue;
    let somaBruta = 0; for (const v of bruto.values()) somaBruta += v;
    const escala = somaBruta > 0 ? totalOficial / somaBruta : 1;
    const ajustado = new Map();
    for (const [sn, sv] of bruto.entries()) ajustado.set(sn, sv * escala);
    porSub.set(nome, ajustado);
  }

  // Total Geral = soma das linhas de tributo mostradas no resumo (garante que a tela sempre bate:
  // TOTAL GERAL = soma das linhas acima). "porData" (TOTAL DESTA DATA) é uma leitura de OCR à parte
  // e pode divergir alguns reais do "porTributo" (TOTAL DESTE TRIBUTO) — não dá pra exibir os dois
  // como se fossem a mesma soma, então a tela usa só uma fonte: a que ela própria mostra por linha.
  let totalGeral = 0;
  for (const v of porTributo.values()) totalGeral += v;

  return { porTributo, porSub, porData, porDataTributo, totalGeral };
}

function parseValorBR(s) {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

function fmtBRL(v) {
  return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Renderização ────────────────────────────────────────────────────────────
// Constrói o HTML da tabela de resumo (acordeão) para um resultado `r`. `idPrefix` garante que os
// ids das linhas de detalhe não colidam quando há vários cards (um por ano) na mesma página.
function construirTabelaResumoHTML(r, idPrefix) {
  const linhas = [...r.porTributo.entries()].sort((a, b) => b[1] - a[1]);
  let html = `<tr><th></th><th>Tipo de tributo</th><th class="num">Valor arrecadado (R$)</th></tr>`;
  linhas.forEach(([nome, v], i) => {
    const sub = r.porSub.get(nome);
    const temDetalhe = sub && sub.size;
    html += `<tr class="tributo-row" data-idx="${i}"><td><span class="caret">${temDetalhe ? '▶' : ''}</span></td><td>${escapeHTML(nome)}</td><td class="num">${fmtBRL(v)}</td></tr>`;
    if (temDetalhe) {
      const linhasSub = [...sub.entries()].sort((a, b) => b[1] - a[1]);
      html += `<tr class="detail-row" id="detail-${idPrefix}-${i}" style="display:none;"><td></td><td colspan="2">
        <table>
          ${linhasSub.map(([sn, sv]) => `<tr class="sub"><td>${escapeHTML(sn)}</td><td class="num">${fmtBRL(sv)}</td></tr>`).join('')}
        </table>
      </td></tr>`;
    }
  });
  html += `<tr class="total"><td></td><td>TOTAL GERAL</td><td class="num">${fmtBRL(r.totalGeral)}</td></tr>`;
  return html;
}

function vincularCliquesTabela(tabEl, idPrefix) {
  tabEl.querySelectorAll('tr.tributo-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const idx = tr.getAttribute('data-idx');
      const detail = document.getElementById(`detail-${idPrefix}-${idx}`);
      if (!detail) return;
      const abrir = detail.style.display === 'none';
      detail.style.display = abrir ? '' : 'none';
      tr.classList.toggle('open', abrir);
    });
  });
}

function renderizarResultado(r) {
  resultsEl.style.display = 'block';
  const tabGeral = document.getElementById('tabGeral');
  tabGeral.innerHTML = construirTabelaResumoHTML(r, 'atual');
  vincularCliquesTabela(tabGeral, 'atual');
  chartsEl.style.display = 'block';
  renderizarGraficos(r, '', document.getElementById('chartPizza'), document.getElementById('chartLinha'));
}

// ── Gráficos ────────────────────────────────────────────────────────────────
// `sufixo` identifica o conjunto de gráficos (ex.: '' pro card do PDF recém-processado, '-2026'
// pro card salvo daquele ano) — cada um guarda sua própria instância de Chart pra não conflitar.
function renderizarGraficos(r, sufixo, canvasPizza, canvasLinha) {
  if (!graficosPorSufixo[sufixo]) graficosPorSufixo[sufixo] = { pizza: null, linha: null };
  const refs = graficosPorSufixo[sufixo];

  // Pizza: total arrecadado por tipo de tributo
  const linhasPizza = [...r.porTributo.entries()].sort((a, b) => b[1] - a[1]);
  // Mapa de cor por tributo — usado no gráfico de pizza E no detalhamento do gráfico de linha,
  // pra cada tributo ter sempre a mesma cor nos dois gráficos.
  const corPorTributo = new Map(linhasPizza.map(([nome], i) => [nome, CORES_GRAFICO[i % CORES_GRAFICO.length]]));

  const ctxPizza = canvasPizza.getContext('2d');
  if (refs.pizza) refs.pizza.destroy();
  refs.pizza = new Chart(ctxPizza, {
    type: 'pie',
    data: {
      labels: linhasPizza.map(([nome]) => nome),
      datasets: [{
        data: linhasPizza.map(([, v]) => v),
        backgroundColor: linhasPizza.map(([nome]) => corPorTributo.get(nome)),
        borderColor: '#fff',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = linhasPizza.reduce((s, [, v]) => s + v, 0);
              const pct = total ? (ctx.parsed / total * 100).toFixed(1) : '0';
              return `${ctx.label}: R$ ${fmtBRL(ctx.parsed)} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  // Linha/área: arrecadação por data
  const linhasData = [...r.porData.entries()].sort((a, b) => {
    const [da, ma, ya] = a[0].split('/'); const [db, mb, yb] = b[0].split('/');
    return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
  });
  const valoresDiarios = linhasData.map(([, v]) => v);
  const n = valoresDiarios.length;
  const media = n ? valoresDiarios.reduce((s, v) => s + v, 0) / n : 0;
  const variancia = n ? valoresDiarios.reduce((s, v) => s + (v - media) ** 2, 0) / n : 0;
  const desvioPadrao = Math.sqrt(variancia);

  const ctxLinha = canvasLinha.getContext('2d');
  if (refs.linha) refs.linha.destroy();
  refs.linha = new Chart(ctxLinha, {
    type: 'line',
    data: {
      labels: linhasData.map(([data]) => data),
      datasets: [
        {
          label: 'Arrecadado no dia',
          data: valoresDiarios,
          fill: true,
          backgroundColor: 'rgba(47, 93, 138, 0.15)',
          borderColor: '#2f5d8a',
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.15,
          order: 1,
        },
        {
          label: `Média (R$ ${fmtBRL(media)})`,
          data: valoresDiarios.map(() => media),
          borderColor: '#c15b4a',
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          order: 2,
        },
        {
          label: `+1 desvio padrão`,
          data: valoresDiarios.map(() => media + desvioPadrao),
          borderColor: 'rgba(154,165,177,.9)',
          borderDash: [2, 3],
          borderWidth: 1,
          pointRadius: 0,
          fill: '+1',
          backgroundColor: 'rgba(154,165,177,.10)',
          order: 3,
        },
        {
          label: `-1 desvio padrão`,
          data: valoresDiarios.map(() => Math.max(0, media - desvioPadrao)),
          borderColor: 'rgba(154,165,177,.9)',
          borderDash: [2, 3],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
          order: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } },
        tooltip: {
          enabled: false,
          external: (ctx) => tooltipDiarioHTML(ctx, r, valoresDiarios, corPorTributo),
        },
      },
      scales: {
        x: { ticks: { maxRotation: 70, minRotation: 45, autoSkip: true, font: { size: 10 } } },
        y: { ticks: { callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') } },
      },
    },
  });
}

// Tooltip HTML customizado do gráfico de arrecadação diária: mostra o total do dia e o
// detalhamento por tributo, cada um com a mesma cor usada no gráfico de pizza.
function tooltipDiarioHTML(ctx, r, valoresDiarios, corPorTributo) {
  const { chart, tooltip } = ctx;
  const wrap = chart.canvas.parentNode;
  let el = wrap.querySelector('.chartjs-tooltip-html');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chartjs-tooltip-html';
    wrap.appendChild(el);
  }

  if (tooltip.opacity === 0) { el.style.opacity = 0; return; }

  const dp = tooltip.dataPoints && tooltip.dataPoints[0];
  if (dp) {
    const label = dp.label;
    const total = valoresDiarios[dp.dataIndex];
    let html = `<div class="tt-title">${escapeHTML(label)}</div><div class="tt-linha"><span class="tt-dot" style="background:#2f5d8a"></span>Arrecadado no dia: <strong>R$ ${fmtBRL(total)}</strong></div>`;
    const porTrib = r.porDataTributo.get(label);
    if (porTrib && porTrib.size) {
      html += `<div class="tt-sub">Discriminado por tributo:</div>`;
      for (const [nome, v] of [...porTrib.entries()].sort((a, b) => b[1] - a[1])) {
        const cor = corPorTributo.get(nome) || '#9aa5b1';
        html += `<div class="tt-linha"><span class="tt-dot" style="background:${cor}"></span>${escapeHTML(nome)}: R$ ${fmtBRL(v)}</div>`;
      }
    }
    el.innerHTML = html;
  }

  el.style.opacity = 1;
  el.style.left = tooltip.caretX + 'px';
  el.style.top = tooltip.caretY + 'px';
}

// ── Exportação para Excel ──────────────────────────────────────────────────
btnExport.addEventListener('click', () => {
  if (!lastResult) return;
  const wb = XLSX.utils.book_new();

  const rGeral = [['Tipo de tributo / sub-item', 'Valor (R$)']];
  for (const [nome, v] of [...lastResult.porTributo.entries()].sort((a, b) => b[1] - a[1])) {
    rGeral.push([nome, v]);
    const sub = lastResult.porSub.get(nome);
    if (sub && sub.size) {
      for (const [sn, sv] of [...sub.entries()].sort((a, b) => b[1] - a[1])) rGeral.push(['   ' + sn, sv]);
    }
  }
  rGeral.push(['TOTAL GERAL', lastResult.totalGeral]);
  const wsGeral = XLSX.utils.aoa_to_sheet(rGeral);
  wsGeral['!cols'] = [{ wch: 46 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsGeral, 'Resumo por Tributo');

  const rData = [['Data da arrecadação', 'Valor (R$)']];
  for (const [data, v] of [...lastResult.porData.entries()].sort((a, b) => {
    const [da, ma, ya] = a[0].split('/'); const [db, mb, yb] = b[0].split('/');
    return (ya + ma + da).localeCompare(yb + mb + db);
  })) rData.push([data, v]);
  const wsData = XLSX.utils.aoa_to_sheet(rData);
  wsData['!cols'] = [{ wch: 20 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsData, 'Por Data (conferência)');

  const nomeBase = (lastResult.nomeArquivo || 'minuta').replace(/\.pdf$/i, '');
  XLSX.writeFile(wb, `Apuracao_${nomeBase}.xlsx`);
});
