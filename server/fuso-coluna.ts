// =============================================================================
// O DIA BRASILEIRO DE UMA COLUNA DE DATA — sem chutar o tipo dela
// -----------------------------------------------------------------------------
// Este projeto tem os dois tipos convivendo na mesma consulta:
//
//   timestamp SEM fuso guardando UTC  → precisa de conversao DUPLA
//                                       (AT TIME ZONE 'UTC' AT TIME ZONE 'BRT')
//   timestamptz                       → precisa de conversao SIMPLES
//                                       (AT TIME ZONE 'BRT')
//
// Aplicar a dupla num timestamptz nao da erro: da o DIA ERRADO, e so depois das
// 21h UTC (18h BRT), quando o deslocamento de 3 horas empurra o registro para o
// dia seguinte. Ou seja: o painel fecha certo a tarde inteira e passa a mentir
// a noite — o tipo de defeito que ninguem encontra olhando o codigo.
//
// Ja aconteceu duas vezes aqui, nos dois sentidos. A causa e sempre a mesma:
// alguem (inclusive eu) LEMBRA de que tipo a coluna e, em vez de perguntar.
// Entao aqui a gente pergunta ao catalogo do Postgres, uma vez por processo, e
// monta a expressao certa. Coluna que nao existe cai na conversao simples, que
// e o padrao das tabelas novas.
// =============================================================================
import { db } from "./db";
import { sql } from "drizzle-orm";

const TZ = "America/Sao_Paulo";
const cache = new Map<string, boolean>(); // "tabela.coluna" -> tem fuso?

/** true = timestamptz (conversao simples). false = timestamp naive (dupla). */
export async function colunaTemFuso(tabela: string, coluna: string): Promise<boolean> {
  const chave = `${tabela}.${coluna}`;
  const posto = cache.get(chave);
  if (posto !== undefined) return posto;
  let comFuso = true;
  try {
    const r: any = await db.execute(sql`
      SELECT data_type FROM information_schema.columns
       WHERE table_name = ${tabela} AND column_name = ${coluna}
       LIMIT 1`);
    const t = String(r.rows?.[0]?.data_type || "");
    if (t) comFuso = /with time zone/i.test(t);
  } catch { /* sem catalogo legivel, fica no padrao */ }
  cache.set(chave, comFuso);
  return comFuso;
}

/**
 * Expressao SQL (texto) que devolve o DIA no fuso de Brasília para `expr`.
 * `tabela`/`coluna` servem só para descobrir o tipo; `expr` é o que entra na
 * consulta (pode vir com alias, ex.: "m.created_at").
 */
export async function diaBR(tabela: string, coluna: string, expr?: string): Promise<string> {
  const e = expr || coluna;
  return (await colunaTemFuso(tabela, coluna))
    ? `((${e}) AT TIME ZONE '${TZ}')::date`
    : `((${e}) AT TIME ZONE 'UTC' AT TIME ZONE '${TZ}')::date`;
}

/** Só para teste: esquece o que já perguntou. */
export function limparCacheDeFuso() { cache.clear(); }
