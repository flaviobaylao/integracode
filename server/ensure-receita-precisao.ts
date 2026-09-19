// ═══════════════════════════════════════════════════════════════════════════
// PRECISÃO DA QUANTIDADE NA FICHA TÉCNICA (Flavio, 18/set/2026)
//
// recipe_items.quantity nasceu com 3 casas decimais. Isso basta para polpa
// (0,225 kg) e para embalagem contada por unidade (1,000), mas trunca qualquer
// insumo que entre em fração de grama por garrafa.
//
// Pego em produção: o plástico de enfardamento do 900 ml é 2,33 g = 0,00233 kg,
// e o banco gravou 0,002 — 14% a menos. O consumo anual saiu 656 kg em vez de
// 667 kg. Erro silencioso: nenhuma mensagem, só um número menor.
//
// Aqui a coluna passa a NUMERIC(14,6), que segura até miligrama por unidade
// (0,000001 kg). É alargamento puro: nenhum valor existente perde precisão, e o
// tipo antigo cabe inteiro no novo. Idempotente — roda no boot e não faz nada
// se já estiver aplicado.
//
// A mesma coluna existe em production_order_items (o consumo efetivo da ordem),
// e pelo mesmo motivo é alargada junto: de nada adianta a ficha ter 6 casas se
// a baixa da produção volta a truncar em 3.
// ═══════════════════════════════════════════════════════════════════════════
import { db } from "./db";
import { sql } from "drizzle-orm";

type Alvo = { tabela: string; coluna: string };

const ALVOS: Alvo[] = [
  { tabela: "recipe_items", coluna: "quantity" },
  { tabela: "production_order_items", coluna: "quantity" },
  { tabela: "raw_material_movements", coluna: "quantity" },
];

export async function ensureReceitaPrecisao(): Promise<{ ok: boolean; alterados: string[]; error?: string }> {
  const alterados: string[] = [];
  try {
    for (const a of ALVOS) {
      try {
        // Só mexe se a coluna existir e tiver menos de 6 casas decimais.
        const r: any = await db.execute(sql`
          SELECT numeric_scale
            FROM information_schema.columns
           WHERE table_name = ${a.tabela} AND column_name = ${a.coluna}
           LIMIT 1`);
        const linha = (r.rows || r)[0];
        if (!linha) continue;                          // tabela/coluna não existe aqui
        const casas = Number(linha.numeric_scale);
        if (!Number.isFinite(casas) || casas >= 6) continue;

        await db.execute(sql.raw(
          `ALTER TABLE ${a.tabela} ALTER COLUMN ${a.coluna} TYPE NUMERIC(14,6)`));
        alterados.push(`${a.tabela}.${a.coluna} (${casas} -> 6 casas)`);
      } catch (e: any) {
        console.warn(`⚠️ [PRECISAO] ${a.tabela}.${a.coluna}:`, e?.message || e);
      }
    }
    if (alterados.length) console.log("✅ [PRECISAO] colunas alargadas:", alterados.join(", "));
    return { ok: true, alterados };
  } catch (e: any) {
    console.warn("⚠️ [PRECISAO] ensureReceitaPrecisao falhou:", e?.message || e);
    return { ok: false, alterados, error: String(e?.message || e) };
  }
}
