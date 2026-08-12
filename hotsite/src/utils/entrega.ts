// ──────────────────────────────────────────────────────────────────────────────
// ÁREA DE ENTREGA / FRETE GRÁTIS — Honest Sucos (loja.bebahonest.com.br)
//
// O frete grátis vale SOMENTE para:
//   • Grande Goiânia (Goiânia + Região Metropolitana)
//   • Brasília / Distrito Federal e circunvizinhança do Plano Piloto (Entorno)
//
// Fora dessas cidades o checkout BLOQUEIA a finalização e mostra um popup
// orientando o cliente a falar com a equipe pelo WhatsApp.
//
// 👉 PARA MUDAR A COBERTURA: edite apenas as duas listas abaixo. Nada mais
//    precisa ser alterado — o formulário e o popup leem daqui.
// ─────────────────────────────────────────────────────────────────────────────

export type RegiaoAtendida = 'grande_goiania' | 'df_entorno';

export interface ResultadoCobertura {
  atendido: boolean;
  regiao: RegiaoAtendida | null;
  cidade: string;
  uf: string;
}

/** Goiânia + Região Metropolitana (Grande Goiânia). */
export const CIDADES_GRANDE_GOIANIA: string[] = [
  'Goiânia',
  'Aparecida de Goiânia',
  'Senador Canedo',
  'Trindade',
  'Goianira',
  'Nerópolis',
  'Santo Antônio de Goiás',
  'Abadia de Goiás',
  'Aragoiânia',
  'Bela Vista de Goiás',
  'Bonfinópolis',
  'Brazabrantes',
  'Caldazinha',
  'Caturaí',
  'Goianápolis',
  'Guapó',
  'Hidrolândia',
  'Inhumas',
  'Nova Veneza',
  'Terezópolis de Goiás',
];

/**
 * Cidades de GOIÁS na circunvizinhança do Plano Piloto (Entorno do DF).
 * Todo o Distrito Federal já é atendido pela regra de UF = DF — esta lista é
 * só para os municípios goianos vizinhos.
 */
export const CIDADES_ENTORNO_DF: string[] = [
  'Águas Lindas de Goiás',
  'Cidade Ocidental',
  'Cristalina',
  'Formosa',
  'Luziânia',
  'Novo Gama',
  'Padre Bernardo',
  'Planaltina',
  'Santo Antônio do Descoberto',
  'Valparaíso de Goiás',
];

/** WhatsApp da equipe, usado no popup de fora de área. */
export const WHATSAPP_HONEST = '5562995782812';

/** Texto curto da área atendida — usado no carrinho e no checkout. */
export const TEXTO_AREA_ATENDIDA =
  'Grande Goiânia, Brasília/DF e entorno do Plano Piloto';

const normalizar = (valor: string): string =>
  (valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const GRANDE_GOIANIA_NORM = CIDADES_GRANDE_GOIANIA.map(normalizar);
const ENTORNO_DF_NORM = CIDADES_ENTORNO_DF.map(normalizar);

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
 * Todo o Distrito Federal é atendido (o ViaCEP devolve "Brasília" para o DF
 * inteiro, incluindo Taguatinga, Ceilândia, Gama e demais regiões).
 */
export function avaliarCobertura(cidade: string, uf: string): ResultadoCobertura {
  const ufNorm = (uf || '').trim().toUpperCase();
  const cidadeNorm = normalizar(cidade);

  if (ufNorm === 'DF') {
    return { atendido: true, regiao: 'df_entorno', cidade, uf: ufNorm };
  }

  if (ufNorm === 'GO') {
    if (GRANDE_GOIANIA_NORM.includes(cidadeNorm)) {
      return { atendido: true, regiao: 'grande_goiania', cidade, uf: ufNorm };
    }
    if (ENTORNO_DF_NORM.includes(cidadeNorm)) {
      return { atendido: true, regiao: 'df_entorno', cidade, uf: ufNorm };
    }
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
