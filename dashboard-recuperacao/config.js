// CONFIGURAÇÃO — edite só este arquivo.
window.CONFIG = {
  // ID da planilha: é o trecho entre /d/ e /edit no link do Google Sheets
  SHEET_ID: "COLE_AQUI_O_ID_DA_PLANILHA",

  // Nome EXATO de cada aba, como aparece embaixo na planilha.
  // tipo "cobranca" = tabela com TENTATIVA 01/02 e VALOR ATUAL
  // tipo "parcelamento" = tabela com VALOR DA PARCELA e QTDE DE PARCELAS
  ABAS: [
    { nome: "Cobrança 1", tipo: "cobranca" },
    { nome: "Parcelamento", tipo: "parcelamento" }
  ],

  // Palavras na coluna SITUAÇÃO que significam "já foi pago"
  PALAVRAS_PAGO: ["pago", "paga", "quitado", "quitada", "liquidado"],
  // Palavras que NÃO contam como pago (ex.: "não pago")
  PALAVRAS_NAO_PAGO: ["não pago", "nao pago", "não paga", "nao paga", "a pagar", "pendente"]
};
