// ============================================================================
// SINCRONIZAÇÃO ENTREGA → PIPELINE DE FATURAMENTO  (INTEGRA 2.0 / Honest Sucos)
// ----------------------------------------------------------------------------
// Regras pedidas pelo Flavio (26/jul/2026):
//   1. Pedido incluído numa rota confirmada  → card vai para "Em Rota" (já feito
//      no POST /api/delivery-routes/save; aqui só passamos a registrar o
//      stage_history, que aquele UPDATE não gravava).
//   2. Entregador efetua a entrega           → card vai para "Entregue".
//   3. Entregador devolve o pedido           → card VOLTA para "Aguardando Rota"
//      ou "Ag. Rota BSB", conforme a origem.
//   4. O comprovante (foto do check-in) é ANEXADO à conta a receber daquela NF,
//      ficando visível na aba Contas a Receber ao pesquisar pelo número da nota.
//
// Tudo aqui é best-effort: nenhuma falha derruba a ação do entregador. O que
// falhar vira log, não erro HTTP.
// ============================================================================

import { sql } from 'drizzle-orm';
import { db } from './db';

// Etapas de onde um card pode sair para entrar em rota
export const STAGES_ORIGEM_ROTA = ['impresso', 'aguardando_rota', 'aguardando_rota_bsb', 'bsb'] as const;
// Etapas em que o card está enquanto a rota corre
export const STAGES_EM_ROTA = ['em_rota', 'em_rota_bsb'] as const;

/** Acrescenta um evento ao stage_history do card (jsonb array, formato do projeto). */
export async function appendStageHistory(
  billingPipelineId: string,
  stage: string,
  changedBy: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE billing_pipeline
    SET stage_history = COALESCE(stage_history, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'stage', ${stage}::text,
        'changedAt', to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS'),
        'changedBy', ${changedBy}::text
      )
    )
    WHERE id = ${billingPipelineId}
  `);
}

/**
 * Descobre para qual etapa de espera o card deve VOLTAR numa devolução.
 * Preferência: a etapa atual (em_rota_bsb ⇒ BSB). Se o card já saiu de rota,
 * cai no histórico e, por último, no tipo de veículo da rota (baruc ⇒ BSB).
 */
export async function resolverEtapaDeRetorno(
  billingPipelineId: string,
  vehicleType?: string | null,
): Promise<{ stage: 'aguardando_rota' | 'aguardando_rota_bsb'; motivo: string } | null> {
  const q: any = await db.execute(sql`
    SELECT stage, stage_history FROM billing_pipeline WHERE id = ${billingPipelineId} LIMIT 1
  `);
  const row = (q?.rows || [])[0];
  if (!row) return null;

  const atual = String(row.stage || '');
  if (atual === 'em_rota_bsb') return { stage: 'aguardando_rota_bsb', motivo: 'card estava em Em Rota BSB' };
  if (atual === 'em_rota') {
    // Um card pode ter entrado em rota vindo de "Ag. Rota BSB" e mesmo assim estar
    // em "em_rota" (rota montada sem veículo BARUC). O histórico desempata.
    try {
      const hist: any[] = Array.isArray(row.stage_history)
        ? row.stage_history
        : JSON.parse(String(row.stage_history || '[]'));
      for (let i = hist.length - 1; i >= 0; i--) {
        const s = String(hist[i]?.stage || '');
        if (s === 'aguardando_rota_bsb' || s === 'bsb') {
          return { stage: 'aguardando_rota_bsb', motivo: 'origem BSB no histórico do card' };
        }
        if (s === 'aguardando_rota' || s === 'impresso') {
          return { stage: 'aguardando_rota', motivo: 'origem Goiânia no histórico do card' };
        }
      }
    } catch { /* histórico ilegível: cai no default abaixo */ }
    return { stage: 'aguardando_rota', motivo: 'card estava em Em Rota' };
  }

  // Card já não está mais em rota (movido manualmente): usa o veículo como pista.
  if (String(vehicleType || '').toLowerCase() === 'baruc') {
    return { stage: 'aguardando_rota_bsb', motivo: 'rota do veículo BARUC (Brasília)' };
  }
  return { stage: 'aguardando_rota', motivo: 'fallback' };
}

/** ENTREGA EFETUADA → card para "Entregue". */
export async function marcarCardEntregue(
  billingPipelineId: string | null | undefined,
  actor: string,
): Promise<{ ok: boolean; moved: number; detalhe: string }> {
  if (!billingPipelineId) return { ok: false, moved: 0, detalhe: 'parada sem billingId' };
  try {
    const r: any = await db.execute(sql`
      UPDATE billing_pipeline
      SET stage = 'entregue', updated_at = NOW()
      WHERE id = ${billingPipelineId}
        AND stage IN ('em_rota', 'em_rota_bsb', 'impresso', 'aguardando_rota', 'aguardando_rota_bsb')
    `);
    const moved = r?.rowCount ?? r?.rows?.length ?? 0;
    if (moved > 0) {
      await appendStageHistory(billingPipelineId, 'entregue', `entrega-motorista (${actor})`);
      console.log(`📦 [PIPELINE-SYNC] Card ${billingPipelineId} → "entregue" (entrega confirmada por ${actor})`);
    } else {
      console.log(`ℹ️ [PIPELINE-SYNC] Card ${billingPipelineId} não estava em etapa de rota — nada movido`);
    }
    return { ok: true, moved, detalhe: moved > 0 ? 'movido para entregue' : 'sem movimento' };
  } catch (e: any) {
    console.error('[PIPELINE-SYNC] Falha ao mover card para entregue:', e?.message);
    return { ok: false, moved: 0, detalhe: e?.message || 'erro' };
  }
}

/** DEVOLUÇÃO → card volta para "Aguardando Rota" / "Ag. Rota BSB" conforme a origem. */
export async function marcarCardDevolvido(
  billingPipelineId: string | null | undefined,
  actor: string,
  opts?: { vehicleType?: string | null; motivo?: string },
): Promise<{ ok: boolean; moved: number; stage?: string; detalhe: string }> {
  if (!billingPipelineId) return { ok: false, moved: 0, detalhe: 'parada sem billingId' };
  try {
    const destino = await resolverEtapaDeRetorno(billingPipelineId, opts?.vehicleType);
    if (!destino) return { ok: false, moved: 0, detalhe: 'card não encontrado' };

    const r: any = await db.execute(sql`
      UPDATE billing_pipeline
      SET stage = ${destino.stage}::billing_pipeline_stage, updated_at = NOW()
      WHERE id = ${billingPipelineId}
        AND stage IN ('em_rota', 'em_rota_bsb')
    `);
    const moved = r?.rowCount ?? r?.rows?.length ?? 0;
    if (moved > 0) {
      const nota = opts?.motivo ? ` — ${String(opts.motivo).slice(0, 120)}` : '';
      await appendStageHistory(billingPipelineId, destino.stage, `devolucao-motorista (${actor})${nota}`);
      console.log(`↩️ [PIPELINE-SYNC] Card ${billingPipelineId} → "${destino.stage}" (${destino.motivo})`);
    }
    return { ok: true, moved, stage: destino.stage, detalhe: destino.motivo };
  } catch (e: any) {
    console.error('[PIPELINE-SYNC] Falha ao devolver card para aguardando rota:', e?.message);
    return { ok: false, moved: 0, detalhe: e?.message || 'erro' };
  }
}

// ============================================================================
// EDIÇÃO DE ROTA JÁ EXISTENTE (21/ago/2026)
// ----------------------------------------------------------------------------
// Pedido do Flavio: adicionar/excluir uma entrega numa rota que JÁ existe tem
// de mexer no pipeline de faturamento igual acontece quando a rota é criada —
// para "Em Rota" ao adicionar, de volta para "Aguardando Rota" ao remover.
// Best-effort: falha aqui não derruba a edição da rota.
// ============================================================================

/** Descobre se o card deve ir para "em_rota" ou "em_rota_bsb". */
async function resolverEtapaEmRota(
  billingPipelineId: string,
  vehicleType?: string | null,
): Promise<'em_rota' | 'em_rota_bsb'> {
  if (String(vehicleType || '').toLowerCase() === 'baruc') return 'em_rota_bsb';
  try {
    const q: any = await db.execute(sql`
      SELECT stage FROM billing_pipeline WHERE id = ${billingPipelineId} LIMIT 1
    `);
    const atual = String((q?.rows || [])[0]?.stage || '');
    if (atual === 'aguardando_rota_bsb' || atual === 'bsb' || atual === 'em_rota_bsb') return 'em_rota_bsb';
  } catch { /* ignora: cai no padrão Goiânia */ }
  return 'em_rota';
}

/** PEDIDO ADICIONADO a uma rota existente → card vai para "Em Rota". */
export async function moverCardParaEmRota(
  billingPipelineId: string | null | undefined,
  actor: string,
  opts?: { vehicleType?: string | null; motivo?: string },
): Promise<{ ok: boolean; moved: number; stage?: string; detalhe: string }> {
  if (!billingPipelineId) return { ok: false, moved: 0, detalhe: 'parada sem billingId' };
  try {
    const destino = await resolverEtapaEmRota(billingPipelineId, opts?.vehicleType);
    const r: any = await db.execute(sql`
      UPDATE billing_pipeline
      SET stage = ${destino}::billing_pipeline_stage, updated_at = NOW()
      WHERE id = ${billingPipelineId}
        AND stage IN ('impresso', 'aguardando_rota', 'aguardando_rota_bsb', 'bsb')
    `);
    const moved = r?.rowCount ?? r?.rows?.length ?? 0;
    if (moved > 0) {
      const nota = opts?.motivo ? ` — ${String(opts.motivo).slice(0, 120)}` : '';
      await appendStageHistory(billingPipelineId, destino, `${actor}${nota}`);
      console.log(`🚚 [PIPELINE-SYNC] Card ${billingPipelineId} → "${destino}" (${actor})`);
    } else {
      console.log(`ℹ️ [PIPELINE-SYNC] Card ${billingPipelineId} não estava em etapa de espera — nada movido`);
    }
    return { ok: true, moved, stage: destino, detalhe: moved > 0 ? 'movido para em rota' : 'sem movimento' };
  } catch (e: any) {
    console.error('[PIPELINE-SYNC] Falha ao mover card para em rota:', e?.message);
    return { ok: false, moved: 0, detalhe: e?.message || 'erro' };
  }
}

/** PEDIDO RETIRADO da rota (parada excluída / rota excluída ou cancelada) → volta para "Aguardando Rota". */
export async function moverCardParaAguardandoRota(
  billingPipelineId: string | null | undefined,
  actor: string,
  opts?: { vehicleType?: string | null; motivo?: string },
): Promise<{ ok: boolean; moved: number; stage?: string; detalhe: string }> {
  if (!billingPipelineId) return { ok: false, moved: 0, detalhe: 'parada sem billingId' };
  try {
    const destino = await resolverEtapaDeRetorno(billingPipelineId, opts?.vehicleType);
    if (!destino) return { ok: false, moved: 0, detalhe: 'card não encontrado' };

    const r: any = await db.execute(sql`
      UPDATE billing_pipeline
      SET stage = ${destino.stage}::billing_pipeline_stage, updated_at = NOW()
      WHERE id = ${billingPipelineId}
        AND stage IN ('em_rota', 'em_rota_bsb')
    `);
    const moved = r?.rowCount ?? r?.rows?.length ?? 0;
    if (moved > 0) {
      const nota = opts?.motivo ? ` — ${String(opts.motivo).slice(0, 120)}` : '';
      await appendStageHistory(billingPipelineId, destino.stage, `${actor}${nota}`);
      console.log(`↩️ [PIPELINE-SYNC] Card ${billingPipelineId} → "${destino.stage}" (${actor}: ${destino.motivo})`);
    } else {
      console.log(`ℹ️ [PIPELINE-SYNC] Card ${billingPipelineId} não estava em rota — nada movido`);
    }
    return { ok: true, moved, stage: destino.stage, detalhe: destino.motivo };
  } catch (e: any) {
    console.error('[PIPELINE-SYNC] Falha ao devolver card para aguardando rota:', e?.message);
    return { ok: false, moved: 0, detalhe: e?.message || 'erro' };
  }
}

// ============================================================================
// COMPROVANTE DE ENTREGA → ANEXO DA CONTA A RECEBER
// ============================================================================

let __ensuredAttachments = false;

/**
 * Tabela de anexos de contas a receber. Espelha `payable_attachments` (contas a
 * pagar), mas guarda a URL da foto (`/api/photo-media/...`) em vez de duplicar o
 * base64 — a imagem já é durável no Postgres via `photo_media`. O campo
 * `content_base64` fica disponível para anexos enviados manualmente.
 */
export async function ensureReceivableAttachmentsTable(): Promise<void> {
  if (__ensuredAttachments) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS receivable_attachments (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      receivable_id varchar NOT NULL,
      kind varchar NOT NULL DEFAULT 'outro',
      file_name varchar NOT NULL,
      mime_type varchar,
      size_bytes integer,
      url text,
      content_base64 text,
      source varchar,
      stop_id varchar,
      route_id varchar,
      invoice_number varchar,
      created_by varchar,
      created_at timestamptz DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_receivable_attachments_receivable ON receivable_attachments (receivable_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_receivable_attachments_invoice ON receivable_attachments (invoice_number)`);
  // Idempotência: um mesmo comprovante (parada + url) não pode duplicar no título.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS ux_receivable_attachments_stop_url ON receivable_attachments (receivable_id, stop_id, url) WHERE stop_id IS NOT NULL AND url IS NOT NULL`);
  __ensuredAttachments = true;
}

/**
 * Anexa o comprovante de entrega (foto do entregador) a TODAS as contas a
 * receber daquela nota fiscal / card do pipeline. Idempotente.
 */
export async function anexarComprovanteEntrega(params: {
  billingPipelineId?: string | null;
  salesCardId?: string | null;
  stopId?: string | null;
  routeId?: string | null;
  photoUrls: string[];
  actor: string;
  kind?: 'comprovante_entrega' | 'comprovante_devolucao';
}): Promise<{ ok: boolean; anexados: number; titulos: number; detalhe: string }> {
  const urls = (params.photoUrls || []).filter((u) => typeof u === 'string' && u.startsWith('/'));
  if (!urls.length) return { ok: true, anexados: 0, titulos: 0, detalhe: 'sem foto para anexar' };
  if (!params.billingPipelineId && !params.salesCardId) {
    return { ok: false, anexados: 0, titulos: 0, detalhe: 'parada sem vínculo com o pipeline' };
  }

  try {
    await ensureReceivableAttachmentsTable();

    const conds: any[] = [];
    if (params.billingPipelineId) conds.push(sql`r.billing_pipeline_id = ${params.billingPipelineId}`);
    if (params.salesCardId) conds.push(sql`r.sales_card_id = ${params.salesCardId}`);

    // Títulos vivos daquele card/pedido + o número da NF (do card ou da NF-e).
    const q: any = await db.execute(sql`
      SELECT r.id,
             r.title_number,
             COALESCE(bp.invoice_number, fi.invoice_number, r.title_number) AS nf
      FROM receivables r
      LEFT JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
      LEFT JOIN fiscal_invoices fi ON fi.id = r.fiscal_invoice_id
      WHERE r.deleted_at IS NULL AND (${sql.join(conds, sql` OR `)})
    `);
    const titulos: any[] = q?.rows || [];
    if (!titulos.length) {
      return { ok: true, anexados: 0, titulos: 0, detalhe: 'nenhuma conta a receber encontrada para este pedido' };
    }

    const kind = params.kind || 'comprovante_entrega';
    let anexados = 0;
    for (const t of titulos) {
      for (let i = 0; i < urls.length; i++) {
        const nome = kind === 'comprovante_devolucao'
          ? `devolucao-${t.nf || t.title_number || 'pedido'}-${i + 1}.jpg`
          : `comprovante-entrega-${t.nf || t.title_number || 'pedido'}-${i + 1}.jpg`;
        const ins: any = await db.execute(sql`
          INSERT INTO receivable_attachments
            (receivable_id, kind, file_name, mime_type, url, source, stop_id, route_id, invoice_number, created_by)
          VALUES
            (${t.id}, ${kind}, ${nome}, 'image/jpeg', ${urls[i]}, 'entregador',
             ${params.stopId || null}, ${params.routeId || null}, ${String(t.nf || '')}, ${params.actor})
          ON CONFLICT DO NOTHING
        `);
        anexados += ins?.rowCount ?? 0;
      }
    }
    console.log(`📎 [COMPROVANTE] ${anexados} anexo(s) em ${titulos.length} título(s) — NF ${titulos[0]?.nf || '?'} (${params.actor})`);
    return { ok: true, anexados, titulos: titulos.length, detalhe: 'ok' };
  } catch (e: any) {
    console.error('[COMPROVANTE] Falha ao anexar comprovante à conta a receber:', e?.message);
    return { ok: false, anexados: 0, titulos: 0, detalhe: e?.message || 'erro' };
  }
}

/**
 * Gancho único chamado pelos endpoints do entregador.
 * Move o card e anexa o comprovante, sem nunca lançar exceção.
 */
export async function processarEntregaNoPipeline(params: {
  evento: 'entregue' | 'devolvida';
  stop: any;
  routeVehicleType?: string | null;
  photoUrls: string[];
  actor: string;
  motivo?: string;
}): Promise<any> {
  const billingId = params.stop?.billingId || null;
  const out: any = { evento: params.evento };
  try {
    if (params.evento === 'entregue') {
      out.pipeline = await marcarCardEntregue(billingId, params.actor);
    } else {
      out.pipeline = await marcarCardDevolvido(billingId, params.actor, {
        vehicleType: params.routeVehicleType,
        motivo: params.motivo,
      });
    }
  } catch (e: any) {
    out.pipeline = { ok: false, detalhe: e?.message };
  }
  try {
    out.comprovante = await anexarComprovanteEntrega({
      billingPipelineId: billingId,
      salesCardId: params.stop?.salesCardId || null,
      stopId: params.stop?.id || null,
      routeId: params.stop?.routeId || null,
      photoUrls: params.photoUrls,
      actor: params.actor,
      kind: params.evento === 'entregue' ? 'comprovante_entrega' : 'comprovante_devolucao',
    });
  } catch (e: any) {
    out.comprovante = { ok: false, detalhe: e?.message };
  }
  return out;
}
