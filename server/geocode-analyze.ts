// ─── ANALISE DE ESTRATEGIAS DE GEOCODIFICACAO ────────────────────────────────
// SOMENTE LEITURA: nunca grava latitude/longitude nem qualquer campo. Serve para
// medir, antes de decidir, quanto cada estrategia recupera dos clientes que hoje
// caem em coordenada aproximada (centroide de bairro/cidade).
//
// Compara tres caminhos para o MESMO cliente:
//   A. endereco como esta no cadastro            (linha de base — o que roda hoje)
//   B. endereco limpo                            (logradouro + numero, sem quadra/lote/loja)
//   C. Google Places por nome do cliente + cidade (so PJ; usa GOOGLE_PLACES_API_KEY)
//
// O funil e sequencial: se A ja resolve, B e C nem sao chamados. Assim o custo
// por cliente e proporcional a dificuldade, e o relatorio mostra quanto CADA
// estrategia acrescenta sobre a anterior.
//
// Amostra por padrao (60 clientes) porque a Places API e cobrada por chamada e
// mais cara que a Geocoding. Para medir tendencia isso basta; a decisao de rodar
// na base inteira vem depois, com o numero na mao.

import type { Express, Request, Response } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { geocodeOne, geocodeProvider, geocodeThrottleMs } from "./geocode-provider";

const PLACES_KEY = () => String(process.env.GOOGLE_PLACES_API_KEY || "").trim();

// Palavras que iniciam COMPLEMENTO no padrao de endereco brasileiro. Em Goiania
// e no DF quase todo cadastro comercial traz quadra/lote/loja, e e justamente
// essa cauda que faz o geocodificador nao resolver o logradouro.
const COMPLEMENTO =
  /\b(QUADRA|QD|QDA|LOTE|LT|LOJA|LJ|SALA|SL|BLOCO|BL|APARTAMENTO|APTO|AP|BANCA|BOX|GALPAO|GALPÃO|KM|ANDAR|CONJUNTO|CONJ|CASA|FUNDOS|TERREO|TÉRREO|EDIFICIO|EDIFÍCIO|ED)\b/i;

// Ponto de referencia digitado a mao ("em frente a...", "ao lado da..."). Nao e
// endereco: e instrucao para o entregador. O geocodificador trata como parte do
// nome da via e erra o logradouro.
const NOTA =
  /\b(EM FRENTE|EMFRENTE|PROXIMO|PRÓXIMO|PROX|AO LADO|AOLADO|ESQUINA|ATRAS|ATRÁS|REFERENCIA|REFERÊNCIA|PONTO DE REF|DENTRO D[OA]|EM CIMA|FRENTE A|FRENTE AO)\b/i;

// "S/N" / "SEM NUMERO": marcador de ausencia de numero. Se sobrar na string, o
// geocodificador o trata como parte do endereco e piora o resultado.
const SEM_NUMERO = /[,\s]+(?:S\s*\/?\s*N[ºo°]?|SEM\s+N[UÚ]MERO|SN)\s*$/i;

// Numero explicitamente marcado, em QUALQUER posicao da string: "nº 69",
// "n. 711", "numero 546". Exige o marcador (º/°/./palavra) de proposito — um
// "\bn\b" solto destruiria vias chamadas "Rua N".
const NUM_MARCADO = /(?:n[ºo°]\.?|n\.|num\.?|n[uú]mero)\s*:?\s*(\d+[A-Za-z]?)\b/i;

/** Descarta ponto de referencia e complemento, ficando so com o nome da via. */
function soAVia(texto: string): string {
  let via = String(texto || "").trim();
  const corte = via.search(/\s[-–—]\s|,/);
  if (corte > 0) via = via.slice(0, corte);
  const mn = via.match(NOTA);
  if (mn && (mn.index || 0) > 0) via = via.slice(0, mn.index);
  const mc = via.match(COMPLEMENTO);
  if (mc && (mc.index || 0) > 0) via = via.slice(0, mc.index);
  return via.replace(SEM_NUMERO, "").replace(/[\s,;-]+$/, "").trim();
}

/**
 * Reduz o endereco a "logradouro, numero".
 *
 * Tres regras, na ordem em que resolvem mais:
 *
 * 1. Numero MARCADO em qualquer posicao ("nº 69"). Medido em producao: o cadastro
 *    manual escreve "Rua X - em frente a academia, nº 69", ou seja o numero vem
 *    DEPOIS do ponto de referencia. A regra estrutural (item 2) nao alcanca esse
 *    caso e o Google devolvia o centro da via.
 * 2. Formato da Receita, `logradouro, numero complemento`: corta na primeira
 *    virgula e fica com o primeiro token numerico. Estrutural, nao por palavra —
 *    preserva vias cujo NOME contem "QUADRA" (comuns no DF).
 * 3. Corte por palavra-chave, para o que fugir dos dois formatos.
 */
export function limparEndereco(addr: any): string {
  let s = String(addr || "").replace(/\s*;\s*/g, ", ").replace(/\s+/g, " ").trim();
  if (!s) return "";

  // 1 — numero marcado em qualquer posicao
  const mm = s.match(NUM_MARCADO);
  if (mm && (mm.index || 0) > 0) {
    const via = soAVia(s.slice(0, mm.index));
    if (via) return `${via}, ${mm[1]}`;
  }

  // 2 — formato da Receita
  const i = s.indexOf(",");
  if (i > 0) {
    const via = s.slice(0, i).trim();
    const resto = s.slice(i + 1).trim();
    const m = resto.match(/^(\d+[A-Za-z]?)\b/);
    if (m) return `${via}, ${m[1]}`;
    if (COMPLEMENTO.test((resto.split(" ")[0] || ""))) return via;
  }

  // 3 — corte por palavra-chave (inclui ponto de referencia)
  const mn = s.match(NOTA);
  if (mn && (mn.index || 0) > 0) s = s.slice(0, mn.index).trim();
  const mc = s.match(COMPLEMENTO);
  if (mc && (mc.index || 0) > 0) s = s.slice(0, mc.index).trim();
  return s.replace(SEM_NUMERO, "").replace(/[\s,;-]+$/, "").trim();
}

/** O cadastro traz numero da casa? Sem numero, nenhum geocodificador acerta o ponto. */
export function temNumeroDeCasa(addr: any): boolean {
  const s = String(addr || "");
  if (NUM_MARCADO.test(s)) return true;
  const i = s.indexOf(",");
  return i > 0 && /^\s*\d/.test(s.slice(i + 1));
}

// ─── TRAVA DE VALIDACAO DO PLACES ────────────────────────────────────────────
// Medido em producao: buscar pelo nome fantasia resolve ~28% dos empilhados, mas
// parte dos acertos e o estabelecimento ERRADO — nome parecido ("Pasticceria
// Goiana" -> "Pastel Goiano oficial") ou outra unidade da rede (Casa do Pao de
// Queijo -> a do aeroporto). Gravar sem conferir trocaria coordenada empilhada
// por coordenada errada, que e pior: a empilhada pelo menos se ve no mapa.
//
// Duas evidencias independentes, e basta uma:
//   1. a rua do resultado e a rua do cadastro;
//   2. o ponto esta perto do que o proprio endereco do cadastro geocodifica.

/** Abreviaturas de logradouro. Sem expandir, "Av. Eng. Fuad Rassi" nunca casa
 *  com "ENGENHEIRO FUAD RASSI" e a trava reprova acerto bom. */
const ABREV: Record<string, string> = {
  ENG: "ENGENHEIRO", MIN: "MINISTRO", MAL: "MARECHAL", MAR: "MARECHAL",
  DR: "DOUTOR", DRA: "DOUTORA", PROF: "PROFESSOR", PROFA: "PROFESSORA",
  PRES: "PRESIDENTE", CEL: "CORONEL", GEN: "GENERAL", SEN: "SENADOR",
  DEP: "DEPUTADO", GOV: "GOVERNADOR", PREF: "PREFEITO", DES: "DESEMBARGADOR",
  CONS: "CONSELHEIRO", BRIG: "BRIGADEIRO", VISC: "VISCONDE", MARQ: "MARQUES",
  ALM: "ALMIRANTE", VER: "VEREADOR", PE: "PADRE", STO: "SANTO", STA: "SANTA",
  JD: "JARDIM", PQ: "PARQUE", VL: "VILA",
};

/** Palavras de TIPO de logradouro: nao identificam a via, so atrapalham a comparacao. */
const TIPO_VIA =
  /\b(RUA|R|AVENIDA|AV|AVN|ALAMEDA|AL|PRACA|PC|TRAVESSA|TV|RODOVIA|ROD|ESTRADA|EST|VIA|SETOR|ST|QUADRA|QD|QDA|LOTE|LT|BLOCO|BL|LOJA|LJ|SALA|SL)\b/g;

function normVia(s: any): string {
  let t = String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ");
  t = t.split(" ").map((w) => ABREV[w] || w).join(" ");
  return t.replace(TIPO_VIA, " ").replace(/[^A-Z0-9]/g, "");
}

/** Nome da via do cadastro: o que vem antes da primeira virgula ou traco. */
function viaDoCadastro(endereco: any): string {
  const bruto = String(endereco || "").split(/[,\-–—]/)[0];
  return normVia(bruto);
}

/** Distancia em km entre dois pontos (haversine). */
function distanciaKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const soDigitos = (s: any) => String(s || "").replace(/\D/g, "");

/**
 * Raio aceito quando a distancia e a UNICA prova.
 *
 * Era 2 km e deixou passar um erro medido em producao: "CONTEINER MERCADINHO"
 * casou com "Brasil Conteiner e Guindastes" a 1,08 km. O problema e que a
 * referencia costuma ser o centro da via ou do bairro — nesse caso QUALQUER
 * estabelecimento do bairro cai dentro de 2 km, entao a proximidade nao prova
 * nada. Com 300 m o ponto do Places tem que praticamente coincidir com o que o
 * endereco do cadastro resolve, e ai a coincidencia deixa de ser barata.
 *
 * Quando a rua ou o CEP conferem, esta constante nem e consultada.
 */
const RAIO_ACEITO_KM = 0.3;

/** Palavras que nao identificam o estabelecimento (forma juridica, conectivos). */
const GENERICO = new Set([
  "LTDA", "ME", "MEI", "EIRELI", "EPP", "SA", "CIA", "DE", "DA", "DO", "DAS",
  "DOS", "E", "EM", "COM", "COMERCIO", "COMERCIAL", "INDUSTRIA", "SERVICOS",
]);

/** Tokens uteis de um nome de estabelecimento, sem acento e sem palavra generica. */
function tokensDoNome(s: any): string[] {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERICO.has(w));
}

/**
 * O nome encontrado tem alguma palavra do nome buscado?
 *
 * Guarda contra o caso em que a distancia aprovaria um vizinho qualquer: se o
 * Places devolveu um estabelecimento que nao compartilha NENHUMA palavra com o
 * que buscamos, proximidade e coincidencia geografica, nao identificacao.
 */
function nomeTemPalavraEmComum(buscado: any, encontrado: any): boolean {
  const a = tokensDoNome(buscado), b = tokensDoNome(encontrado);
  if (!a.length || !b.length) return false;
  return a.some((w) => b.some((x) => x.startsWith(w.slice(0, 4)) || w.startsWith(x.slice(0, 4))));
}

/**
 * Decide se a coordenada do Places pode ser confiada para este cliente.
 * `referencia` e o que o endereco do cadastro geocodificou (mesmo que impreciso):
 * serve de ancora geografica.
 */
function validarPlaces(
  cliente: { endereco: any; cep: any },
  places: { lat: string; lon: string; endereco: string; termoBuscado?: string; nomeEncontrado?: string },
  referencia: { lat: string; lon: string } | null,
) {
  const via = viaDoCadastro(cliente.endereco);
  // Via curta demais casa com qualquer coisa e nao serve de prova — "53" aparece
  // dentro de qualquer numero. A excecao sao as vias alfanumericas de Goiania
  // ("6A", "T7"): duas posicoes, mas com letra e digito juntos ja discriminam.
  const viaDiscrimina = via.length >= 3 || (via.length === 2 && /[A-Z]/.test(via) && /\d/.test(via));
  const ruaConfere = viaDiscrimina ? normVia(places.endereco).includes(via) : null;

  const cepCad = soDigitos(cliente.cep);
  const cepConfere = cepCad.length === 8 ? soDigitos(places.endereco).includes(cepCad) : null;

  let distanciaDaReferenciaKm: number | null = null;
  if (referencia) {
    const d = distanciaKm(
      Number(referencia.lat), Number(referencia.lon),
      Number(places.lat), Number(places.lon),
    );
    if (Number.isFinite(d)) distanciaDaReferenciaKm = Math.round(d * 100) / 100;
  }
  // Prova por proximidade: exige coincidencia apertada E nome compativel. Sao as
  // duas fraquezas que se cobrem — perto sem nome parecido e vizinho por acaso;
  // nome parecido e longe e outra unidade da rede.
  const nomeCombina = nomeTemPalavraEmComum(places.termoBuscado, places.nomeEncontrado);
  const pertoDaReferencia =
    distanciaDaReferenciaKm === null ? null : distanciaDaReferenciaKm <= RAIO_ACEITO_KM;
  const provaPorProximidade = pertoDaReferencia === true && nomeCombina;

  const aprovado = ruaConfere === true || cepConfere === true || provaPorProximidade;
  const motivo = aprovado
    ? ruaConfere === true ? "rua confere"
      : cepConfere === true ? "CEP confere"
      : `a ${distanciaDaReferenciaKm} km do endereco do cadastro, com nome compativel`
    : referencia === null
      ? "sem referencia para comparar e rua nao confere"
      : pertoDaReferencia === true
        ? `perto (${distanciaDaReferenciaKm} km) mas o nome encontrado nao bate com o buscado`
        : `rua diferente e ${distanciaDaReferenciaKm} km longe do endereco do cadastro`;

  return { aprovado, motivo, ruaConfere, cepConfere, distanciaDaReferenciaKm, nomeCombina };
}

/**
 * Coordenada util = aponta o ENDERECO, nao a via nem a regiao.
 *
 * `centro_geometrico` (GEOMETRIC_CENTER) e o centro da rua. Quando o cadastro nao
 * tem numero, TODO cliente daquela via recebe a mesma coordenada — era essa a
 * origem das coordenadas empilhadas. Aceitar centro_geometrico como resolvido
 * fazia o funil parar em A e nunca medir o ganho da limpeza nem do Places.
 */
const util = (hit: any) =>
  !!hit && !hit.aproximado && hit.precisao !== "centro_geometrico";

/**
 * Text Search da PLACES API (NEW) — places.googleapis.com/v1/places:searchText.
 *
 * Por que a API nova e nao a antiga: a chave do projeto esta restrita a
 * "Places API (New)", que e a unica ativada em honest-396719. O endpoint legado
 * (maps/api/place/textsearch/json) exige a "Places API" antiga, que o Google
 * nao habilita mais em projetos novos. Chamar o legado devolveria REQUEST_DENIED
 * mesmo com a chave correta.
 *
 * Diferencas de protocolo em relacao ao legado: e POST com JSON no corpo, a
 * chave vai no header X-Goog-Api-Key, e o FieldMask e OBRIGATORIO — sem ele a
 * API responde 400. O FieldMask tambem define o que e cobrado, entao pedimos
 * so o minimo: id, nome, endereco e coordenada.
 */
async function buscarPlaces(nome: string, cidade: string, uf: string) {
  if (!PLACES_KEY()) return { ok: false as const, motivo: "GOOGLE_PLACES_API_KEY ausente" };
  const textQuery = [nome, cidade, uf, "Brasil"].filter(Boolean).join(", ");
  const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": PLACES_KEY(),
      // Cobrado pelo que se pede: manter enxuto e proposital.
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus",
    },
    body: JSON.stringify({
      textQuery,
      languageCode: "pt-BR",
      regionCode: "BR",
      maxResultCount: 1,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j: any = await resp.json().catch(() => null);
  if (!resp.ok) {
    // A API nova devolve o motivo em error.message — util para distinguir chave
    // invalida de API nao habilitada de FieldMask errado.
    const msg = j?.error?.message || `HTTP ${resp.status}`;
    return { ok: false as const, motivo: `Places(New): ${String(msg).slice(0, 120)}` };
  }
  const r = j?.places?.[0];
  if (!r) return { ok: false as const, motivo: "sem resultado" };
  if (typeof r?.location?.latitude !== "number") return { ok: false as const, motivo: "sem geometria" };
  return {
    ok: true as const,
    lat: String(r.location.latitude),
    lon: String(r.location.longitude),
    nomeEncontrado: String(r.displayName?.text || ""),
    endereco: String(r.formattedAddress || ""),
    // Places nao devolve location_type; o endereco formatado indica a qualidade.
    status: String(r.businessStatus || ""),
  };
}

/**
 * Busca no Places tentando o NOME FANTASIA primeiro e a razao social depois.
 *
 * Motivo: o Places acha estabelecimento por como ele e conhecido na rua. Um
 * cadastro como "22.348.633 SELMA MARIA MENDES FRANCA" (razao social de MEI)
 * nao existe no Maps; o nome fantasia do ponto existe. Registrar QUAL termo
 * acertou e o dado que decide se vale padronizar a busca pelo fantasia.
 */
async function buscarPlacesComFallback(
  fantasia: string,
  razaoSocial: string,
  cidade: string,
  uf: string,
) {
  const tentativas: { termo: string; origem: "fantasia" | "razao_social" }[] = [];
  const f = String(fantasia || "").trim();
  const r = String(razaoSocial || "").trim();
  if (f) tentativas.push({ termo: f, origem: "fantasia" });
  // So tenta a razao social se for diferente do fantasia (evita chamada duplicada e cobrada).
  if (r && r.toUpperCase() !== f.toUpperCase()) tentativas.push({ termo: r, origem: "razao_social" });

  const falhas: string[] = [];
  for (const t of tentativas) {
    const res = await buscarPlaces(t.termo, cidade, uf);
    if (res.ok) return { ...res, termoUsado: t.termo, origemDoTermo: t.origem };
    falhas.push(`${t.origem}: ${res.motivo}`);
    if (tentativas.length > 1) await esperar();
  }
  return { ok: false as const, motivo: falhas.join(" | ") || "sem nome para buscar" };
}

export function registerGeocodeAnalyze(app: Express) {
  // POST /api/admin/customers/geocode-analyze  { limit?: number, incluirPlaces?: boolean }
  // NAO GRAVA NADA. Devolve o comparativo direto na resposta.
  app.post(
    "/api/admin/customers/geocode-analyze",
    authenticateUser,
    requireRole(["admin"]),
    async (req: Request, res: Response) => {
      try {
        const limit = Math.min(Math.max(Number((req.body as any)?.limit) || 60, 1), 400);
        const incluirPlaces = (req.body as any)?.incluirPlaces !== false;
        // escopo "duplicados" (padrao) = so clientes que COMPARTILHAM coordenada
        // com outro. Sao os empilhados no mesmo ponto — a populacao que este
        // trabalho quer resolver. Ordenar por nome, como era antes, sorteava
        // sobretudo quem ja resolve: 91% da amostra vinha "ja_resolvido" e cada
        // chamada paga do Places era gasta confirmando o que funciona.
        const escopo = (req.body as any)?.escopo === "todos" ? "todos" : "duplicados";
        const filtroEscopo =
          escopo === "duplicados"
            ? sql` AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM customers d
                  WHERE d.latitude = c.latitude AND d.longitude = c.longitude
                    AND d.id <> c.id AND (d.is_supplier IS NOT TRUE)
                )`
            : sql``;

        const sel: any = await db.execute(sql`
          SELECT c.id, c.name, c.fantasy_name, c.cnpj, c.address, c.neighborhood, c.city, c.state, c.zip_code
          FROM customers c
          WHERE (c.is_supplier IS NOT TRUE)
            AND (c.coordinates_locked IS NOT TRUE)
            AND COALESCE(TRIM(c.address), '') <> ''${filtroEscopo}
          ORDER BY c.is_active DESC, c.name
          LIMIT ${limit}
        `);
        const cands = (sel.rows || sel) as any[];

        // Quantos existem no escopo — mostra se a amostra representa o total.
        let totalNoEscopo = cands.length;
        try {
          const cnt: any = await db.execute(sql`
            SELECT COUNT(*)::int AS n FROM customers c
            WHERE (c.is_supplier IS NOT TRUE)
              AND (c.coordinates_locked IS NOT TRUE)
              AND COALESCE(TRIM(c.address), '') <> ''${filtroEscopo}
          `);
          totalNoEscopo = Number(((cnt.rows || cnt) as any[])[0]?.n || cands.length);
        } catch {}

        const linhas: any[] = [];
        let jaOk = 0, ganhoLimpeza = 0, ganhoPlaces = 0, semSolucao = 0, erros = 0;
        // Quebra do ganho do Places por qual termo acertou — e o dado que decide
        // se vale padronizar a busca pelo nome fantasia.
        let placesPorFantasia = 0, placesPorRazaoSocial = 0;
        // Achou no Places, mas a trava barrou: provavel estabelecimento errado.
        let placesReprovados = 0;

        for (const c of cands) {
          const cidade = String(c.city || "");
          const uf = String(c.state || "");
          const sufixo = [c.neighborhood, cidade, uf, "Brasil"].filter(Boolean).join(", ");
          const original = String(c.address || "");
          const limpo = limparEndereco(original);
          const fantasia = String(c.fantasy_name || "");
          const linha: any = {
            id: String(c.id), nome: c.name, nomeFantasia: fantasia, temFantasia: !!fantasia.trim(),
            tipo: c.cnpj ? "PJ" : "PF",
            enderecoOriginal: original, enderecoLimpo: limpo, mudouNaLimpeza: limpo !== original.trim(),
            // Sem numero de casa nenhum geocodificador acerta o ponto: o melhor que
            // a Geocoding devolve e o centro da via. Separar essa populacao mostra
            // quanto do problema e falta de informacao no cadastro, e nao estrategia.
            temNumeroNoCadastro: temNumeroDeCasa(original),
            numeroRecuperadoPelaLimpeza: !temNumeroDeCasa(original) && temNumeroDeCasa(limpo),
          };

          try {
            // A — linha de base
            const a = await geocodeOne([original, sufixo].filter(Boolean).join(", "));
            linha.A = a ? { precisao: a.precisao, resultado: String(a.display_name).slice(0, 90) } : null;
            // Ancora geografica da trava do Places: mesmo impreciso, o endereco do
            // cadastro diz em que pedaco da cidade o cliente esta.
            if (a) linha.refGeo = { lat: a.lat, lon: a.lon };
            if (util(a)) { linha.veredito = "ja_resolvido"; jaOk++; linhas.push(linha); await esperar(); continue; }

            // B — endereco limpo (so faz sentido se a limpeza mudou algo)
            if (linha.mudouNaLimpeza && limpo) {
              await esperar();
              const b = await geocodeOne([limpo, sufixo].filter(Boolean).join(", "));
              linha.B = b ? { precisao: b.precisao, resultado: String(b.display_name).slice(0, 90) } : null;
              if (b && !linha.refGeo) linha.refGeo = { lat: b.lat, lon: b.lon };
              if (util(b)) { linha.veredito = "resolvido_pela_limpeza"; ganhoLimpeza++; linhas.push(linha); await esperar(); continue; }
            }

            // C — Places: nome FANTASIA primeiro, razao social como segunda tentativa.
            // O acerto so vale se passar na trava: o Places acha por nome, e nome
            // parecido nao e o mesmo estabelecimento.
            if (incluirPlaces && c.cnpj) {
              await esperar();
              const p = await buscarPlacesComFallback(fantasia, String(c.name || ""), cidade, uf);
              if (p.ok) {
                const v = validarPlaces(
                  { endereco: original, cep: c.zip_code },
                  {
                    lat: p.lat, lon: p.lon, endereco: p.endereco,
                    termoBuscado: p.termoUsado, nomeEncontrado: p.nomeEncontrado,
                  },
                  linha.refGeo || null,
                );
                linha.C = {
                  origemDoTermo: p.origemDoTermo, termoUsado: p.termoUsado,
                  nomeEncontrado: p.nomeEncontrado, endereco: p.endereco.slice(0, 90),
                  lat: p.lat, lon: p.lon,
                  aprovado: v.aprovado, motivo: v.motivo,
                  ruaConfere: v.ruaConfere, cepConfere: v.cepConfere,
                  distanciaDaReferenciaKm: v.distanciaDaReferenciaKm,
                  nomeCombina: v.nomeCombina,
                };
                if (v.aprovado) {
                  linha.veredito = "resolvido_pelo_places";
                  ganhoPlaces++;
                  if (p.origemDoTermo === "fantasia") placesPorFantasia++; else placesPorRazaoSocial++;
                  linhas.push(linha); await esperar(); continue;
                }
                placesReprovados++;
              } else {
                linha.C = { falhou: p.motivo };
              }
            }

            linha.veredito = "sem_solucao_automatica";
            semSolucao++;
          } catch (e: any) {
            linha.veredito = "erro";
            linha.erro = String(e?.message || e).slice(0, 120);
            erros++;
          }
          linhas.push(linha);
          await esperar();
        }

        const n = cands.length || 1;
        const pct = (x: number) => `${Math.round((x / n) * 100)}%`;
        res.json({
          provider: geocodeProvider(),
          placesConfigurado: !!PLACES_KEY(),
          escopo,
          amostra: cands.length,
          totalNoEscopo,
          resumo: {
            jaResolvidoHoje: jaOk,
            recuperadosPelaLimpeza: ganhoLimpeza,
            recuperadosPeloPlaces: ganhoPlaces,
            semSolucaoAutomatica: semSolucao,
            erros,
          },
          places: {
            acertosPeloNomeFantasia: placesPorFantasia,
            acertosPelaRazaoSocial: placesPorRazaoSocial,
            // Barrados pela trava — o Places achou "um" lugar, nao "o" lugar.
            reprovadosNaTrava: placesReprovados,
            aprovadosPelaRua: linhas.filter((l) => l.C?.aprovado && l.C?.ruaConfere === true).length,
            aprovadosPeloCep: linhas.filter((l) => l.C?.aprovado && l.C?.ruaConfere !== true && l.C?.cepConfere === true).length,
            aprovadosPelaDistancia: linhas.filter((l) => l.C?.aprovado && l.C?.ruaConfere !== true && l.C?.cepConfere !== true).length,
            clientesComFantasiaPreenchido: linhas.filter((l) => l.temFantasia).length,
            clientesSemFantasia: linhas.filter((l) => l.tipo === "PJ" && !l.temFantasia).length,
          },
          // Diagnostico do cadastro: separa "estrategia errada" de "informacao que
          // nao existe". semNumeroDeCasa e o teto do que qualquer automacao alcanca
          // por endereco — para esses, so Places por nome ou correcao manual.
          cadastro: {
            semNumeroDeCasa: linhas.filter((l) => !l.temNumeroNoCadastro).length,
            comNumeroDeCasa: linhas.filter((l) => l.temNumeroNoCadastro).length,
            numeroRecuperadoPelaLimpeza: linhas.filter((l) => l.numeroRecuperadoPelaLimpeza).length,
          },
          // Precisao que a Geocoding devolveu no endereco atual (etapa A).
          // centro_geometrico = centro da via, que e o que empilha clientes.
          precisaoNoEnderecoAtual: linhas.reduce((acc: any, l: any) => {
            const p = (l.A && l.A.precisao) || "sem_resultado";
            acc[p] = (acc[p] || 0) + 1;
            return acc;
          }, {}),
          percentuais: {
            jaResolvidoHoje: pct(jaOk),
            ganhoDaLimpeza: pct(ganhoLimpeza),
            ganhoDoPlaces: pct(ganhoPlaces),
            restaCorrecaoManual: pct(semSolucao),
          },
          linhas,
        });
      } catch (e: any) {
        res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
      }
    },
  );
}

const esperar = () => new Promise((r) => setTimeout(r, geocodeThrottleMs()));
