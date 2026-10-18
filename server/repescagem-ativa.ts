// server/repescagem-ativa.ts
// -----------------------------------------------------------------------------
// QUEM ESTA EM REPESCAGEM AGORA — regra unica.
//
// Esta regra nasceu embutida na rota /api/consulta-local, para a tag
// "Em Repescagem" dos cards de cliente. Quando o filtro de repescagem entrou na
// Gestao de Carteiras (Flavio, 18/10/2026), ela saiu de la para ca: duas copias
// da mesma regra divergem no primeiro ajuste, e ai a tag diz uma coisa e o
// filtro outra sobre o MESMO cliente.
//
// A REGRA (a mesma da tela de Repescagem):
//   • alocacao ATIVA — status 'pending', ou 'in_route' do sorteio de HOJE;
//   • cliente ATIVO e NAO PF (PF = tem CPF de 11 digitos e nao tem CNPJ);
//   • e o atendimento AINDA NAO ACONTECEU.
//
// O ultimo ponto e o que faz a marca sumir na hora, sem esperar o fechamento
// automatico (que roda com throttle). Vale como atendido, a partir do dia da
// alocacao: atendimento virtual, check-in de rota, ou pedido no pipeline — os
// MESMOS sinais que o closeAndExpireRepescagem usa para concluir.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { hojeBR } from "@shared/tempo";

/**
 * Ids dos clientes em repescagem AGORA.
 *
 * @param ids  restringe a esses clientes (a tela de cards ja tem a lista em mao
 *             e so' precisa do status deles). Sem o parametro, varre a base
 *             inteira — e' o que o filtro da carteira usa.
 *
 * Nunca estoura: se a consulta falhar (tabela ausente num ambiente novo, por
 * exemplo), devolve conjunto vazio e registra o aviso. Nenhuma tela deve cair
 * por causa de um enfeite de status.
 */
export async function idsEmRepescagem(ids?: string[]): Promise<Set<string>> {
  const fora = new Set<string>();
  if (ids && ids.length === 0) return fora;
  try {
    const hoje = hojeBR();
    const escopo = ids && ids.length
      ? sql`AND ra.customer_id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`
      : sql``;
    const r: any = await db.execute(sql`
      SELECT DISTINCT ra.customer_id
      FROM repescagem_assignments ra
      JOIN customers c ON c.id = ra.customer_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(NULLIF(ra.draw_date, '')::date,
                        (ra.assigned_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) AS desde
      ) j
      WHERE (ra.status = 'pending' OR (ra.status = 'in_route' AND ra.draw_date = ${hoje}))
        ${escopo}
        AND c.is_active = true
        AND NOT (COALESCE(regexp_replace(c.cnpj, '[^0-9]', '', 'g'), '') = ''
                 AND length(COALESCE(regexp_replace(c.cpf, '[^0-9]', '', 'g'), '')) = 11)
        AND NOT EXISTS (
          SELECT 1 FROM virtual_service_logs vl
          WHERE vl.customer_id = ra.customer_id
            AND (vl.attendance_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= j.desde)
        AND NOT EXISTS (
          SELECT 1 FROM route_checkpoints rc
          WHERE rc.customer_id = ra.customer_id AND rc.checkpoint_type = 'check_in'
            AND (rc.checkpoint_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= j.desde)
        AND NOT EXISTS (
          SELECT 1 FROM billing_pipeline bp
          WHERE bp.customer_id = ra.customer_id
            AND COALESCE(bp.scheduled_billing_date::date,
                         (bp.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) >= j.desde)
    `);
    for (const x of (r?.rows || []) as any[]) fora.add(String(x.customer_id));
  } catch (e: any) {
    console.warn("[repescagem-ativa] status indisponivel:", e?.message || e);
  }
  return fora;
}

export function registerRepescagemAtiva(app: Express) {
  // ---------------------------------------------------------------------------
  // GET /api/repescagem/em-repescagem
  // Os ids em repescagem agora. A Gestao de Carteiras le isto e filtra a lista
  // que ja tem na tela — mesmo caminho do filtro de quarentena, sem recarregar
  // o relatorio inteiro a cada troca de filtro.
  // ---------------------------------------------------------------------------
  app.get("/api/repescagem/em-repescagem", authenticateUser, async (_req: Request, res: Response) => {
    try {
      const ids = await idsEmRepescagem();
      res.json({ ids: Array.from(ids), total: ids.size, em: hojeBR() });
    } catch (e: any) {
      console.error("[repescagem-ativa]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
