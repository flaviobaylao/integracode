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

/**
 * Reduz o endereco a "logradouro, numero".
 *
 * O endereco vindo da Receita e montado como `logradouro, numero complemento`
 * (ver cadastro-receita-sync). Por isso a regra primaria e estrutural — corta na
 * primeira virgula e fica com o primeiro token numerico — em vez de caçar
 * palavras. Isso preserva vias cujo NOME contem "QUADRA" (comuns no DF), que um
 * corte por palavra-chave destruiria.
 *
 * Só cai no corte por palavra-chave quando o endereco foge desse formato
 * (cadastro digitado a mao, cliente PF).
 */
export function limparEndereco(addr: any): string {
  let s = String(addr || "").replace(/\s*;\s*/g, ", ").replace(/\s+/g, " ").trim();
  if (!s) return "";

  const i = s.indexOf(",");
  if (i > 0) {
    const via = s.slice(0, i).trim();
    const resto = s.slice(i + 1).trim();
    const m = resto.match(/^(\d+[A-Za-z]?)\b/);
    if (m) return `${via}, ${m[1]}`;
    if (COMPLEMENTO.test((resto.split(" ")[0] || ""))) return via;
  }

  const mc = s.match(COMPLEMENTO);
  if (mc && (mc.index || 0) > 0) s = s.slice(0, mc.index).trim();
  return s.replace(/[\s,;-]+$/, "").trim();
}

/** Coordenada util = resolve o endereco, nao a regiao. */
const util = (hit: any) => !!hit && !hit.aproximado;

async function buscarPlaces(nome: string, cidade: string, uf: string) {
  if (!PLACES_KEY()) return { ok: false as const, motivo: "GOOGLE_PLACES_API_KEY ausente" };
  const query = [nome, cidade, uf, "Brasil"].filter(Boolean).join(", ");
  const url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}&language=pt-BR&region=br&key=${encodeURIComponent(PLACES_KEY())}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return { ok: false as const, motivo: `Places HTTP ${resp.status}` };
  const j: any = await resp.json();
  if (j?.status === "ZERO_RESULTS") return { ok: false as const, motivo: "sem resultado" };
  if (j?.status !== "OK") return { ok: false as const, motivo: `Places: ${j?.status || "erro"}` };
  const r = j?.results?.[0];
  if (!r?.geometry?.location) return { ok: false as const, motivo: "sem geometria" };
  return {
    ok: true as const,
    lat: String(r.geometry.location.lat),
    lon: String(r.geometry.location.lng),
    nomeEncontrado: String(r.name || ""),
    endereco: String(r.formatted_address || ""),
    // Places nao devolve location_type; o endereco formatado indica a qualidade.
    status: String(r.business_status || ""),
  };
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

        const sel: any = await db.execute(sql`
          SELECT c.id, c.name, c.cnpj, c.address, c.neighborhood, c.city, c.state, c.zip_code
          FROM customers c
          WHERE (c.is_supplier IS NOT TRUE)
            AND (c.coordinates_locked IS NOT TRUE)
            AND COALESCE(TRIM(c.address), '') <> ''
          ORDER BY c.is_active DESC, c.name
          LIMIT ${limit}
        `);
        const cands = (sel.rows || sel) as any[];

        const linhas: any[] = [];
        let jaOk = 0, ganhoLimpeza = 0, ganhoPlaces = 0, semSolucao = 0, erros = 0;

        for (const c of cands) {
          const cidade = String(c.city || "");
          const uf = String(c.state || "");
          const sufixo = [c.neighborhood, cidade, uf, "Brasil"].filter(Boolean).join(", ");
          const original = String(c.address || "");
          const limpo = limparEndereco(original);
          const linha: any = {
            id: String(c.id), nome: c.name, tipo: c.cnpj ? "PJ" : "PF",
            enderecoOriginal: original, enderecoLimpo: limpo, mudouNaLimpeza: limpo !== original.trim(),
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

            // C — Places por nome (estabelecimento comercial costuma estar no Maps)
            if (incluirPlaces && c.cnpj) {
              await esperar();
              const p = await buscarPlaces(String(c.name || ""), cidade, uf);
              linha.C = p.ok
                ? { nomeEncontrado: p.nomeEncontrado, endereco: p.endereco.slice(0, 90), lat: p.lat, lon: p.lon }
                : { falhou: p.motivo };
              if (p.ok) { linha.veredito = "resolvido_pelo_places"; ganhoPlaces++; linhas.push(linha); await esperar(); continue; }
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
          amostra: cands.length,
          resumo: {
            jaResolvidoHoje: jaOk,
            recuperadosPelaLimpeza: ganhoLimpeza,
            recuperadosPeloPlaces: ganhoPlaces,
            semSolucaoAutomatica: semSolucao,
            erros,
          },
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
