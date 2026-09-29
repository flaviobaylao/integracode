// ──────────────────────────────────────────────────────────────────────────────
// ÁREA DE ENTREGA / FRETE GRÁTIS — Honest Sucos (loja.bebahonest.com.br)
//
// 29/set/2026 — COBERTURA REDUZIDA, EM CARÁTER PROVISÓRIO, a:
//   • Goiânia/GO
//   • Aparecida de Goiânia/GO
//
// Antes a loja aceitava toda a Grande Goiânia e ainda Brasília/DF + entorno do
// Plano Piloto. A operação de entrega não alcança essas praças por ora; a
// previsão é voltar a ampliar. A vitrine avisa isso ANTES do carrinho.
//
// Fora dessas cidades o checkout BLOQUEIA a finalização e mostra um popup
// orientando o cliente a falar com a equipe pelo WhatsApp. A mesma regra vale
// no SERVIDOR (server/entrega-area.ts) — regra só no navegador é contornável.
//
// 👉 PARA AMPLIAR A COBERTURA: acrescente as cidades na lista abaixo E na lista
//    gêmea de server/entrega-area.ts. As duas precisam bater.
// ─────────────────────────────────────────────────────────────────────────────

export type RegiaoAtendida = 'grande_goiania';

export interface ResultadoCobertura {
  atendido: boolean;
  regiao: RegiaoAtendida | null;
  cidade: string;
  uf: string;
}

/** Cidades com entrega. PROVISÓRIO (29/set/2026) — só Goiânia e Aparecida. */
export const CIDADES_ATENDIDAS: string[] = [
  'Goiânia',
  'Aparecida de Goiânia',
];

/** Nome antigo mantido para não quebrar quem importa daqui. */
export const CIDADES_GRANDE_GOIANIA = CIDADES_ATENDIDAS;

/** WhatsApp da equipe, usado no popup de fora de área. */
export const WHATSAPP_HONEST = '5562995782812';

/** Texto curto da área atendida — usado no carrinho e no checkout. */
export const TEXTO_AREA_ATENDIDA = 'Goiânia e Aparecida de Goiânia';

/**
 * Aviso de cobertura provisória — vitrine, carrinho e checkout.
 * Deixa claro que a limitação é temporária e que a área vai crescer.
 */
// O título nomeia as DUAS cidades de propósito: dizer "Grande Goiânia" faria
// quem é de Senador Canedo, Trindade ou Aparecida do interior montar o carrinho
// para ser barrado no CEP lá na frente.
export const TITULO_AVISO_COBERTURA = 'Entregamos em Goiânia e Aparecida — por enquanto';
export const TEXTO_AVISO_COBERTURA =
  'No momento entregamos apenas em Goiânia e Aparecida de Goiânia. ' +
  'Estamos ampliando a área de entrega aos poucos — em breve atenderemos mais cidades.';

const normalizar = (valor: string): string =>
  (valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const ATENDIDAS_NORM = CIDADES_ATENDIDAS.map(normalizar);

/** Deixa só os dígitos do CEP (máx. 8). */
export const limparCep = (valor: string): string =>
  (valor || '').replace(/\D/g, '').slice(0, 8);

/** Formata para 00000-000 enquanto o cliente digita. */
export const formatarCep = (valor: string): string => {
  const numeros = limparCep(valor);
  if (numeros.length <= 5) return numeros;
  return `${numeros.slice(0, 5)}-${numeros.slice(5)}`;
};

export interface EnderecoCep {
  cep: string;
  logradouro: string;
  bairro: string;
  cidade: string;
  uf: string;
}

/**
 * Consulta o CEP no ViaCEP (API pública e gratuita, sem cadastro).
 * Lança Error com mensagem amigável quando o CEP não existe ou a consulta falha.
 */
export async function buscarCep(cepBruto: string): Promise<EnderecoCep> {
  const cep = limparCep(cepBruto);
  if (cep.length !== 8) throw new Error('CEP deve ter 8 dígitos');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let dados: any;
  try {
    const resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: controller.signal,
    });
    if (!resposta.ok) throw new Error('falha http');
    dados = await resposta.json();
  } catch {
    throw new Error('Não foi possível consultar o CEP agora. Tente novamente.');
  } finally {
    clearTimeout(timeout);
  }

  if (!dados || dados.erro) throw new Error('CEP não encontrado');

  return {
    cep: formatarCep(cep),
    logradouro: dados.logradouro || '',
    bairro: dados.bairro || '',
    cidade: dados.localidade || '',
    uf: (dados.uf || '').toUpperCase(),
  };
}

/**
 * Decide se a cidade/UF está na área com entrega e frete grátis.
 * 29/set/2026: só Goiânia e Aparecida de Goiânia, ambas em GO. Brasília/DF e o
 * entorno do Plano Piloto saíram — a entrega não alcança essas praças por ora.
 */
export function avaliarCobertura(cidade: string, uf: string): ResultadoCobertura {
  const ufNorm = (uf || '').trim().toUpperCase();
  const cidadeNorm = normalizar(cidade);

  if (ufNorm === 'GO' && ATENDIDAS_NORM.includes(cidadeNorm)) {
    return { atendido: true, regiao: 'grande_goiania', cidade, uf: ufNorm };
  }

  return { atendido: false, regiao: null, cidade, uf: ufNorm };
}

/** Monta o endereço final que vai para o pedido, já com bairro, cidade e CEP. */
export function montarEnderecoCompleto(params: {
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}): string {
  const { logradouro, numero, complemento, bairro, cidade, uf, cep } = params;
  const rua = [logradouro, numero].filter((p) => (p || '').trim()).join(', ');
  const partes = [
    rua,
    (complemento || '').trim(),
    (bairro || '').trim(),
    [cidade, uf].filter(Boolean).join('/'),
    cep ? `CEP ${cep}` : '',
  ].filter((p) => p && p.trim());
  return partes.join(' - ');
}
