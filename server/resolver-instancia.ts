// ═══════════════════════════════════════════════════════════════════════════
// RESOLVER DE INSTÂNCIA (set/2026)
//
// O problema: a tela do Financeiro manda o APELIDO da instância ("BSB", "GYN",
// "IND", "SERV") em campos que o backend compara com omie_instances.id, que é
// um UUID. A comparação nunca casa, e o SPED saía vazio sem nenhum erro — o
// pior tipo de bug, porque o arquivo é gerado e parece bom.
//
// Aqui a entrada é normalizada uma vez: aceita o id, o name ou o display_name.
// `equivalentesInstancia` devolve os três valores, porque nem toda tabela grava a
// instância do mesmo jeito; `resolverInstanciaId` devolve só o id canônico, para
// quem precisa gravar a referência.
//
// O cache existe porque omie_instances muda raramente e essa resolução entra em
// rota de listagem; 5 minutos é curto o bastante para uma instância nova
// aparecer sem reiniciar o servidor.
// ═══════════════════════════════════════════════════════════════════════════
import { db } from "./db";
import { sql } from "drizzle-orm";

type Linha = { id: string; name: string; display_name: string };

let cache: { em: number; linhas: Linha[] } | null = null;
const TTL = 5 * 60 * 1000;

async function instancias(): Promise<Linha[]> {
  if (cache && Date.now() - cache.em < TTL) return cache.linhas;
  const r: any = await db.execute(sql`SELECT id, name, display_name FROM omie_instances`);
  const linhas = (r.rows || r) as Linha[];
  cache = { em: Date.now(), linhas };
  return linhas;
}

const norm = (v: any) => String(v ?? "").trim().toLowerCase();

/**
 * Aceita id, name ou display_name e devolve TODOS os valores equivalentes
 * daquela instância (id, name, display_name).
 *
 * Devolve a lista em vez de só o id de propósito: nem toda tabela guarda a
 * instância do mesmo jeito — fiscal_invoices guarda o UUID, e há tabelas
 * antigas que guardam o apelido. Filtrando por "qualquer um dos equivalentes",
 * a consulta acerta nos dois casos, sem depender de uma convenção que eu não
 * consigo verificar em todas as tabelas.
 *
 * Lista vazia = sem filtro (entrada vazia). `null` = a instância pedida não
 * existe, e aí o chamador deve recusar em vez de devolver tudo.
 */
export async function equivalentesInstancia(valor: any): Promise<string[] | null> {
  const v = norm(valor);
  if (!v) return [];
  try {
    const lista = await instancias();
    const achou =
      lista.find((i) => norm(i.id) === v) ||
      lista.find((i) => norm(i.name) === v) ||
      lista.find((i) => norm(i.display_name) === v);
    if (!achou) return null;
    return Array.from(new Set([achou.id, achou.name, achou.display_name].filter(Boolean)));
  } catch (e: any) {
    console.warn("[INSTANCIA] falha ao resolver:", e?.message);
    // Sem conseguir resolver, o valor original ainda é a melhor aposta.
    return [String(valor)];
  }
}

/** Só o id canônico, para quem precisa gravar a referência. */
export async function resolverInstanciaId(valor: any): Promise<string | null> {
  const v = norm(valor);
  if (!v) return null;
  try {
    const lista = await instancias();
    const achou =
      lista.find((i) => norm(i.id) === v) ||
      lista.find((i) => norm(i.name) === v) ||
      lista.find((i) => norm(i.display_name) === v);
    return achou ? achou.id : null;
  } catch {
    return null;
  }
}

/** Limpa o cache — usar depois de criar ou renomear uma instância. */
export function limparCacheInstancias() {
  cache = null;
}
