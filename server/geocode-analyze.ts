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
            if (util(a)) { linha.veredito = "ja_resolvido"; jaOk++; linhas.push(linha); await esperar(); continue; }

            // B — endereco limpo (so faz sentido se a limpeza mudou algo)
            if (linha.mudouNaLimpeza && limpo) {
              await esperar();
              const b = await geocodeOne([limpo, sufixo].filter(Boolean).join(", "));
              linha.B = b ? { precisao: b.precisao, resultado: String(b.display_name).slice(0, 90) } : null;
              if (util(b)) { linha.veredito = "resolvido_pela_limpeza"; ganhoLimpeza++; linhas.push(linha); await esperar(); continue; }
            }

            // C — Places: nome FANTASIA primeiro, razao social como segunda tentativa.
            if (incluirPlaces && c.cnpj) {
              await esperar();
              const p = await buscarPlacesComFallback(fantasia, String(c.name || ""), cidade, uf);
              linha.C = p.ok
                ? {
                    origemDoTermo: p.origemDoTermo, termoUsado: p.termoUsado,
                    nomeEncontrado: p.nomeEncontrado, endereco: p.endereco.slice(0, 90),
                    lat: p.lat, lon: p.lon,
                  }
                : { falhou: p.motivo };
              if (p.ok) {
                linha.veredito = "resolvido_pelo_places";
                ganhoPlaces++;
                if (p.origemDoTermo === "fantasia") placesPorFantasia++; else placesPorRazaoSocial++;
                linhas.push(linha); await esperar(); continue;
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
