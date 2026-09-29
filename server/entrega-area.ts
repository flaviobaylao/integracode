// ─────────────────────────────────────────────────────────────────────────────
// ÁREA DE ENTREGA DA LOJA — trava no SERVIDOR (29/set/2026)
//
// A loja já bloqueia o CEP fora de área no formulário (hotsite/src/utils/entrega.ts),
// mas regra só no navegador é contornável: página em cache com a lista antiga, POST
// direto no endpoint, app desatualizado. E, no PIX/cartão, o dinheiro entra ANTES do
// pedido nascer — um pedido aceito fora de área vira cobrança que não temos como
// entregar. Por isso a mesma regra roda aqui.
//
// COBERTURA PROVISÓRIA: Goiânia e Aparecida de Goiânia (GO).
// 👉 PARA AMPLIAR: acrescente na lista abaixo E na lista gêmea de
//    hotsite/src/utils/entrega.ts. As duas precisam bater.
//
// FALHA ABERTA de propósito: se o endereço não disser a cidade (formato antigo,
// pedido do vendedor, texto livre), NÃO bloqueia. Barrar por dúvida derrubaria
// venda boa — o custo de um falso positivo aqui é maior que o de um falso negativo.
// ─────────────────────────────────────────────────────────────────────────────

export const CIDADES_ATENDIDAS: string[] = [
  'Goiânia',
  'Aparecida de Goiânia',
];

export const TEXTO_AREA_ATENDIDA = 'Goiânia e Aparecida de Goiânia';

export const MENSAGEM_FORA_DA_AREA =
  `No momento entregamos apenas em ${TEXTO_AREA_ATENDIDA}. ` +
  'Estamos ampliando a área de entrega aos poucos — fale com a gente pelo WhatsApp ' +
  '(62) 99578-2812 para saber quando chegaremos à sua região.';

const normalizar = (valor: string): string =>
  (valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const ATENDIDAS_NORM = CIDADES_ATENDIDAS.map(normalizar);

/**
 * Extrai "cidade/UF" do endereço montado pela loja. O montarEnderecoCompleto() do
 * hotsite grava sempre um trecho próprio no formato `Cidade/UF`, entre hífens:
 *   "Rua X, 100 - Apto 2 - Setor Bueno - Goiânia/GO - CEP 74000-000"
 * Devolve null quando não dá para identificar (aí não se bloqueia nada).
 */
export function cidadeDoEndereco(endereco: any): { cidade: string; uf: string } | null {
  const texto = String(endereco || '');
  if (!texto.trim()) return null;
  // Percorre os trechos separados por " - " e pega o que for exatamente Cidade/UF.
  const partes = texto.split(/\s+-\s+/);
  for (const parte of partes) {
    const m = parte.trim().match(/^([^/]{2,60})\/([A-Za-z]{2})$/);
    if (m) return { cidade: m[1].trim(), uf: m[2].toUpperCase() };
  }
  return null;
}

/**
 * Regra única da área de entrega. `null` = pode seguir (atendido OU indeterminado).
 * Quando bloqueia, devolve o corpo pronto para o res.status(400).json(...).
 */
export function barrarSeForaDaAreaDeEntrega(endereco: any):
  | null
  | { message: string; code: string; cidade: string; uf: string; areaAtendida: string } {
  const local = cidadeDoEndereco(endereco);
  if (!local) return null; // endereço sem cidade legível — não barra

  const atendido = local.uf === 'GO' && ATENDIDAS_NORM.includes(normalizar(local.cidade));
  if (atendido) return null;

  return {
    message: MENSAGEM_FORA_DA_AREA,
    code: 'FORA_DA_AREA_DE_ENTREGA',
    cidade: local.cidade,
    uf: local.uf,
    areaAtendida: TEXTO_AREA_ATENDIDA,
  };
}
