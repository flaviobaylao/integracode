// server/cfop-transferencia.ts
// ============================================================================
// CFOP DAS TRANSFERÊNCIAS ENTRE ESTABELECIMENTOS (Flavio, 19/out/2026)
// ----------------------------------------------------------------------------
// Regra dele:
//   • Transferência entre os estabelecimentos de GOIÁS (IND -> GYN): 5151, e a
//     entrada no destino 1151.
//   • Transferência para BSB (GO -> DF): 6409 (o cenário "TRANSFERENCIA BSB").
//     O 5409 que estava saindo nas notas IND -> GYN era ERRADO: só havia UM
//     cenário de transferência cadastrado (o do BSB, 6409) e o pipeline caía
//     nele para qualquer destino; o sefaz-service então "corrigia" a direção
//     (6409 -> 5409) e a nota saía com CFOP de ST dentro de GO.
//   • Devolução de transferência (GYN devolve à fábrica): 5208 na saída de quem
//     devolve / 1208 na entrada de quem recebe (a NF-e de devolução do Integra
//     é de ENTRADA, emitida pela IND, logo 1208; interestadual 2208).
//
// Daqui saem: (1) a escolha do cenário/CFOP de transferência no pipeline, por
// direção REAL da operação (UF emitente x UF destinatário), nunca por "qualquer
// cenário de transferência"; (2) o seed idempotente do cenário GO 5151.
// ============================================================================
import { db } from "./db";
import { sql } from "drizzle-orm";

const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
const dig = (s: any) => String(s || "").replace(/\D/g, "");

export const CFOP_TRANSFERENCIA_GO = "5151";
export const CFOP_TRANSFERENCIA_INTERESTADUAL = "6151";
export const NATUREZA_TRANSFERENCIA = "TRANSFERENCIA DE PRODUCAO DO ESTABELECIMENTO";
export const NOME_CENARIO_TRANSFERENCIA_GO = "TRANSFERENCIA GO (entre estabelecimentos em Goias)";

export interface CenarioTransferenciaEscolhido {
  cfop: string;
  natureOfOperation: string;
  fiscalScenarioId: string | null;
}

/**
 * Escolhe o cenário de transferência coerente com a direção da operação.
 * Um cenário interestadual (6xxx) NUNCA é aplicado a uma operação interna e
 * vice-versa — é exatamente o que gerava o 5409 dentro de GO.
 */
export function escolherCenarioTransferencia(
  scenarios: any[] | null | undefined,
  isWithinState: boolean,
): CenarioTransferenciaEscolhido {
  const prefixo = isWithinState ? "5" : "6";
  const padrao = isWithinState ? CFOP_TRANSFERENCIA_GO : CFOP_TRANSFERENCIA_INTERESTADUAL;
  const candidatos = (scenarios || []).filter((s: any) =>
    s && s.operationType === "transferencia" && (s.isActive ?? true) && dig(s.cfop).length === 4 && dig(s.cfop)[0] === prefixo,
  );
  // Dentro de GO o 5151 é a regra; entre os candidatos 5xxx ele tem preferência.
  const escolhido =
    candidatos.find((s: any) => dig(s.cfop) === padrao) ||
    candidatos.find((s: any) => !/^[56]4\d\d$/.test(dig(s.cfop))) || // evita ST (5409/6409) quando há outro
    candidatos[0];
  if (!escolhido) {
    return { cfop: padrao, natureOfOperation: NATUREZA_TRANSFERENCIA, fiscalScenarioId: null };
  }
  return {
    cfop: dig(escolhido.cfop),
    natureOfOperation: escolhido.natureOfOperation || NATUREZA_TRANSFERENCIA,
    fiscalScenarioId: escolhido.id,
  };
}

/**
 * Garante o cenário "TRANSFERENCIA GO" (5151) em fiscal_scenarios. Copia a
 * tributação do cenário de transferência já existente (BSB, Simples/CSOSN 400)
 * para a nota interna nascer com a mesma tributação de sempre, só com o CFOP
 * certo. Também corrige o escopo do cenário BSB (6409 é interestadual).
 */
export async function garantirCenarioTransferenciaGO(): Promise<void> {
  try {
    const ja = rowsOf(await db.execute(sql`
      SELECT id FROM fiscal_scenarios WHERE operation_type = 'transferencia' AND cfop = ${CFOP_TRANSFERENCIA_GO} LIMIT 1`));
    if (!ja.length) {
      const base = rowsOf(await db.execute(sql`
        SELECT tax_regime, csosn, cst_icms, cst_ipi, cst_pis, aliq_pis, cst_cofins, aliq_cofins
        FROM fiscal_scenarios WHERE operation_type = 'transferencia' AND is_active = true
        ORDER BY created_at ASC LIMIT 1`))[0] || {};
      await db.execute(sql`
        INSERT INTO fiscal_scenarios (id, name, operation_type, state_scope, cfop, nature_of_operation, tax_regime,
          csosn, cst_icms, cst_ipi, cst_pis, aliq_pis, cst_cofins, aliq_cofins, description, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${NOME_CENARIO_TRANSFERENCIA_GO}, 'transferencia', 'intraestadual', ${CFOP_TRANSFERENCIA_GO}, ${NATUREZA_TRANSFERENCIA},
          ${base.tax_regime || 'simples_nacional'}, ${base.csosn || '400'}, ${base.cst_icms || null}, ${base.cst_ipi || null},
          ${base.cst_pis || '49'}, ${base.aliq_pis ?? 0}, ${base.cst_cofins || '49'}, ${base.aliq_cofins ?? 0},
          'Transferência de produção entre estabelecimentos da PURO dentro de Goiás (IND -> GYN). Entrada no destino: 1151. Devolução: 5208/1208.',
          true, now(), now())`);
      console.log(`✅ [TRANSFERENCIA] cenário fiscal criado: ${CFOP_TRANSFERENCIA_GO} ${NOME_CENARIO_TRANSFERENCIA_GO}`);
    }
    // O cenário do BSB (6409) estava marcado como intraestadual.
    await db.execute(sql`
      UPDATE fiscal_scenarios SET state_scope = 'interestadual', updated_at = now()
      WHERE operation_type = 'transferencia' AND cfop LIKE '6%' AND state_scope <> 'interestadual'`);
  } catch (e: any) {
    console.warn("⚠️ [TRANSFERENCIA] cenário GO não garantido:", e?.message);
  }
}
