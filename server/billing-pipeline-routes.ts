import { Express } from 'express';
import { randomUUID } from 'crypto';
import { storage } from './storage';
import { nowBrazil } from './brazilTimezone';
import { authenticateUser } from './authMiddleware';
import { INSTANCE_COMPANY_DATA } from './nfe-routes';
import { registrarBoleto, cancelarBoleto } from './bb-boleto-service';
import { createImmediateCharge } from './bb-pix-service';
import { db } from './db';
import { sql, eq, and, gte, isNull } from 'drizzle-orm';
import { fiscalInvoices, salesCards, blockedOrders } from '@shared/schema';
import { resolveDestinationUf } from './cep-uf';

// Faturamento exige UF resolvível do destinatário (estado cadastrado OU CEP). Sem isso a NF-e
// sai com CFOP incorreto e é REJEITADA pela SEFAZ. Barramos ANTES da trava/baixa de estoque/criação
// da nota (evita nota rejeitada órfã e deixa o card acionável após corrigir o cadastro).
async function validateCustomerFiscalData(item: any): Promise<{ valid: boolean; message?: string }> {
  try {
    const customer = item.customerId ? await storage.getCustomer(item.customerId) : null;
    const destUf = resolveDestinationUf({ state: (customer as any)?.state, cep: (customer as any)?.zipCode });
    if (!destUf) {
      const nome = item.customerName || (customer as any)?.name || 'cliente';
      return { valid: false, message: `Cadastro incompleto: informe a UF (estado) ou o CEP de "${nome}" antes de faturar. Sem a UF a NF-e é rejeitada pela SEFAZ (CFOP incorreto).` };
    }
    return { valid: true };
  } catch {
    // Falha ao checar o cadastro não bloqueia (a própria emissão ainda valida a UF).
    return { valid: true };
  }
}

// Etapas VÁLIDAS do funil de faturamento (billing_pipeline.stage). NÃO inclui 'bloqueado':
// bloquear é feito pela tabela blocked_orders via POST /:id/block, não por mudança de stage.
const BILLING_STAGES = ['agendado', 'pedido', 'a_faturar', 'faturado', 'impresso', 'bsb', 'aguardando_rota_bsb', 'em_rota_bsb', 'outras_cidades', 'aguardando_rota', 'em_rota', 'entregue', 'lixeira'] as const;

// Garante (idempotente, 1x por processo) o valor 'lixeira' no enum do Postgres.
let __lixeiraStageReady = false;
async function ensureLixeiraStage() {
  if (__lixeiraStageReady) return;
  try { await db.execute(sql`ALTER TYPE billing_pipeline_stage ADD VALUE IF NOT EXISTS 'lixeira'`); } catch {}
  __lixeiraStageReady = true;
}

// Faturamento interno e a UNICA via (Omie descontinuado). O motor ja forca isso via
// isInternalBillingModeActive()===true; aqui o default do indicador tambem fica ON para
// nao exibir "desativado" apos restart (o toggle da tela e apenas informativo).
let internalBillingModeActive = true;
let internalBillingActivatedBy: string | null = 'sistema (interno e a unica via)';

export function isInternalBillingModeActive() {
  // Faturamento e SEMPRE pelo pipeline interno (Omie descontinuado para faturamento).
  // Todo pedido com venda registrada entra no pipeline, independente de toggle/Omie.
  return true;
}

// ============ Rede de seguranca: NENHUM pedido pode desaparecer ============
// Registra TODA tentativa de envio ao pipeline (created/skipped/failed) numa tabela imutavel
// (order_pipeline_audit, criada no boot do index.ts). Garante trilha mesmo se a insercao falhar.
async function logOrderAudit(salesCardId: string, outcome: string, error?: string) {
  try {
    await db.execute(sql`INSERT INTO order_pipeline_audit (id, sales_card_id, outcome, error, created_at)
      VALUES (gen_random_uuid(), ${salesCardId}, ${outcome}, ${error || null}, now())`);
  } catch (e) { /* nunca bloqueia o fluxo */ }
}

// Reconciliacao: garante que TODO sales_card com venda registrada (recente) tenha item no pipeline.
// Idempotente. E a rede de seguranca caso o envio ao vivo tenha falhado.
export async function reconcileOrphanOrders(days: number = 7): Promise<{ scanned: number; createdFromNf: number; createdFromCard: number; failed: number }> {
  // REDE DE SEGURANCA (08/jul): NENHUM pedido pode sumir do pipeline.
  // Regra do Flavio: um pedido so pode desaparecer do pipeline se foi CANCELADO antes do faturamento.
  // Portanto reconciliamos tudo que NAO esta cancelado e ficou sem card:
  //   (A) toda NF AUTORIZADA sem card -> cria card 'faturado' (com o numero da NF);
  //   (B) toda venda COMPLETADA (nao cancelada) sem NF e sem card -> cria card 'pedido'.
  // Idempotente: dedup por numero de NF, por sales_card_id e por cliente+valor recente.
  // NAO dispara automacoes (evita WhatsApp em massa retroativo). Cards marcados createdBy 'reconcile-*' (reversivel via remove-reconciled).
  const since = new Date(Date.now() - days * 86400000);
  let scanned = 0, createdFromNf = 0, createdFromCard = 0, failed = 0;

  const existing = await storage.getBillingPipelineItems();
  const haveInv = new Set(existing.map((i: any) => String(i.invoiceNumber || '').replace(/\D/g, '')).filter(Boolean));
  const haveCard = new Set(existing.map((i: any) => i.salesCardId).filter(Boolean));
  const recent = existing.filter((i: any) => i.createdAt && new Date(i.createdAt) >= since);
  const haveCustVal = new Set(recent.map((i: any) => `${i.customerId}|${Math.round(Number(i.saleValue || 0))}`));

  // (A) NFs autorizadas sem card -> 'faturado'
  try {
    const nfs = await db.select().from(fiscalInvoices)
      .where(and(gte(fiscalInvoices.createdAt, since), sql`${fiscalInvoices.status} IN ('authorized','rejected')`));
    for (const nf of nfs as any[]) {
      const num = String(nf.invoiceNumber || '').replace(/\D/g, '');
      if (!num || haveInv.has(num)) continue;
      const cv = `${nf.customerId}|${Math.round(Number(nf.totalInvoice || 0))}`;
      if (haveCustVal.has(cv)) continue; // ja existe card recente do mesmo cliente/valor
      scanned++;
      try {
        const customer = nf.customerId ? await storage.getCustomer(nf.customerId) : null;
        const seller = customer?.sellerId ? await storage.getUser(customer.sellerId) : null;
        await storage.createBillingPipelineItem({
          salesCardId: null,
          customerId: nf.customerId || null,
          customerName: nf.customerName || (customer as any)?.fantasyName || customer?.name || 'Cliente',
          customerDocument: nf.customerCnpjCpf || (customer as any)?.cnpj || (customer as any)?.cpf || null,
          sellerId: customer?.sellerId || null,
          sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
          stage: 'faturado',
          orderNumber: `NF-${nf.invoiceNumber}`,
          saleValue: nf.totalInvoice || null,
          invoiceNumber: `NF-${nf.invoiceNumber}`,
          omieInstanceId: nf.omieInstanceId || null,
          stageHistory: [{ stage: 'faturado', changedAt: (nf.emissionDate ? new Date(nf.emissionDate) : nowBrazil()).toISOString(), changedBy: 'reconcile-nf' }],
          notes: nf.status === 'rejected' ? 'NF REJEITADA na SEFAZ - preencher UF do cliente e re-transmitir (nao re-faturar, evita NF duplicada)' : null,
          createdBy: nf.status === 'rejected' ? 'reconcile-nf-rej' : 'reconcile-nf',
          ...(nf.emissionDate ? { createdAt: new Date(nf.emissionDate) } : {}),
        } as any);
        haveInv.add(num); haveCustVal.add(cv);
        createdFromNf++;
      } catch (e) { failed++; }
    }
  } catch (e) { console.error('[reconcile] parte A (NFs) erro:', (e as any)?.message); }

  // (B) vendas completadas (nao canceladas) sem NF e sem card -> 'pedido'
  try {
    const cards = await db.select().from(salesCards).where(and(
      gte(salesCards.createdAt, since),
      eq(salesCards.status, 'completed'),
      isNull(salesCards.invoiceNumber),
      sql`${salesCards.saleValue} IS NOT NULL AND ${salesCards.saleValue}::numeric > 0`,
    ));
    for (const sc of cards as any[]) {
      if (sc.isPermanent) continue;
      if (haveCard.has(sc.id)) continue;
      const cv = `${sc.customerId}|${Math.round(Number(sc.saleValue || 0))}`;
      if (haveCustVal.has(cv)) continue;
      scanned++;
      try {
        const customer = sc.customerId ? await storage.getCustomer(sc.customerId) : null;
        // NAO RESSUSCITAR bloqueados: se ja existe bloqueio ativo p/ este card, pula
        // (antes a rede de seguranca recriava o pedido como "Pedido", furando o bloqueio).
        const existingBlock = await db.select().from(blockedOrders)
          .where(and(eq(blockedOrders.salesCardId, sc.id), eq(blockedOrders.status, 'blocked'))).limit(1);
        if (existingBlock.length > 0) { continue; }
        // Aplica a MESMA regra de bloqueio dos demais caminhos (debito / amostra / troca /
        // bonificacao): se se enquadra, bloqueia em vez de criar como "Pedido".
        const blk = await evaluateOrderBlock(sc, customer);
        if (blk) {
          try { await insertBlockedOrderIdempotent(sc, blk); await logOrderAudit(sc.id, blk.reason === 'overdue_debt' ? 'blocked_overdue_debt' : 'blocked_operation_type'); } catch {}
          console.log(`🚫 [reconcile] Card ${sc.id} bloqueado (${blk.reason}) em vez de virar "Pedido".`);
          continue;
        }
        const seller = sc.sellerId ? await storage.getUser(sc.sellerId) : null;
        let omieInstanceName = '';
        if ((customer as any)?.omieInstanceId) { const inst = await storage.getOmieInstance((customer as any).omieInstanceId); omieInstanceName = (inst as any)?.displayName || ''; }
        await storage.createBillingPipelineItem({
          salesCardId: sc.id,
          customerId: sc.customerId,
          customerName: (customer as any)?.fantasyName || customer?.name || 'Cliente desconhecido',
          customerDocument: (customer as any)?.cnpj || (customer as any)?.cpf || null,
          sellerId: sc.sellerId || null,
          sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
          stage: 'pedido',
          orderNumber: `INT-${String(sc.id).substring(0, 8)}`,
          saleValue: sc.saleValue || null,
          paymentMethod: sc.paymentMethod || null,
          operationType: sc.operationType || null,
          products: (sc.products as any) || null,
          notes: sc.notes || null,
          omieInstanceId: (customer as any)?.omieInstanceId || null,
          omieInstanceName: omieInstanceName || null,
          stageHistory: [{ stage: 'pedido', changedAt: (sc.completedDate ? new Date(sc.completedDate) : (sc.createdAt ? new Date(sc.createdAt) : nowBrazil())).toISOString(), changedBy: 'reconcile-card' }],
          createdBy: 'reconcile-card',
          // Data da venda = completedDate (conclusao); fallback createdAt do card (aproxima a venda, nao a hora da reconciliacao).
          ...(sc.completedDate ? { createdAt: new Date(sc.completedDate) } : (sc.createdAt ? { createdAt: new Date(sc.createdAt) } : {})),
        } as any);
        haveCard.add(sc.id); haveCustVal.add(cv);
        await logOrderAudit(sc.id, 'created');
        createdFromCard++;
      } catch (e) { await logOrderAudit(sc.id, 'failed', String((e as any)?.message || e)); failed++; }
    }
  } catch (e) { console.error('[reconcile] parte B (cards) erro:', (e as any)?.message); }

  return { scanned, createdFromNf, createdFromCard, failed };
}

import { fireAutomation } from './automation-engine';

// Throttle para a promoção oportunista no GET /api/billing-pipeline (evita rodar o UPDATE a cada request).
let _lastScheduledPromoteAt = 0;

// Promove pedidos AGENDADOS cuja data de agendamento já chegou (etapa 'agendado' -> 'pedido').
// Comparação por dia-calendário no fuso de São Paulo. Idempotente e seguro para rodar em cron/boot/GET.
export async function promoteDueScheduledOrders(): Promise<number> {
  try {
    const res: any = await db.execute(sql`
      UPDATE billing_pipeline
      SET stage = 'pedido',
          updated_at = now(),
          stage_history = COALESCE(stage_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'stage', 'pedido',
            'changedAt', to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS'),
            'changedBy', 'auto-agendado'
          ))
      WHERE stage = 'agendado'
        AND scheduled_billing_date IS NOT NULL
        AND scheduled_billing_date::date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
      RETURNING id
    `);
    const n = res?.rowCount ?? (res?.rows?.length ?? 0);
    if (n) console.log(`📅 [AGENDADO→PEDIDO] ${n} pedido(s) agendado(s) promovido(s) para 'Pedido'.`);
    return n;
  } catch (e: any) {
    console.error('❌ [AGENDADO→PEDIDO] erro ao promover pedidos agendados:', e?.message || e);
    return 0;
  }
}

// Retorna a data (YYYY-MM-DD) de HOJE no fuso de São Paulo.
function todayBrazilISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// Tipos de operação que NÃO são venda e devem entrar BLOQUEADOS (aprovação manual
// do admin): amostra, troca e bonificação. Devolução/transferência/remessa NÃO
// entram nesta regra (decisão do Flavio — só estes três).
const NON_SALE_BLOCK_OPS = new Set(['amostra', 'troca', 'bonificacao']);

// Decisão CENTRAL de bloqueio: usada em TODOS os caminhos de entrada no pipeline
// (auto-envio, rede de segurança/reconcile). Retorna o motivo do bloqueio ou null.
// Ordem: (1) tipo de operação (amostra/troca/bonificação) → sempre manual;
//        (2) débito vencido → libera automático quando regularizado.
export async function evaluateOrderBlock(
  salesCard: any,
  customer: any,
): Promise<{ reason: 'operation_type' | 'overdue_debt'; details: string } | null> {
  const op = String(salesCard?.operationType || 'venda').toLowerCase().trim();
  if (NON_SALE_BLOCK_OPS.has(op)) {
    const label = op === 'troca' ? 'troca' : op === 'bonificacao' ? 'bonificação' : 'amostra';
    return {
      reason: 'operation_type',
      details: `Pedido de ${label} requer aprovação manual de um administrador antes do faturamento.`,
    };
  }
  try {
    const doc = (customer as any)?.cnpj || (customer as any)?.cpf || '';
    if (doc) {
      const overdueDebt = await storage.getOverdueDebtByDocument(doc);
      if (overdueDebt) {
        return {
          reason: 'overdue_debt',
          details: `Cliente possui debito vencido de R$ ${parseFloat(String(overdueDebt.totalAmount || '0')).toFixed(2)} com ${overdueDebt.maxDaysOverdue || 0} dias de atraso. Liberacao automatica quando o debito for regularizado.`,
        };
      }
    }
  } catch (e: any) {
    console.warn('⚠️ [BILLING-PIPELINE] evaluateOrderBlock: erro ao checar debito (segue sem bloquear por debito):', e?.message);
  }
  return null;
}

// Insere o pedido em blocked_orders de forma IDEMPOTENTE (não duplica um bloqueio
// ativo do mesmo card). Fonte única para todos os caminhos de bloqueio.
export async function insertBlockedOrderIdempotent(
  salesCard: any,
  blk: { reason: string; details: string },
): Promise<boolean> {
  // Retorna true SOMENTE quando o bloqueio foi inserido agora (novo); false se já existia.
  // Usado para notificar o vendedor 1x só (pedido bloqueado não entra no pipeline e não tem o
  // dedup normal; sem isso a mensagem repetiria a cada reprocessamento do autoSend).
  if (!salesCard?.id) return false;
  const already = await db.select().from(blockedOrders)
    .where(and(eq(blockedOrders.salesCardId, salesCard.id), eq(blockedOrders.status, 'blocked'))).limit(1);
  if (already.length > 0) return false;
  await db.insert(blockedOrders).values({
    salesCardId: salesCard.id,
    customerId: salesCard.customerId,
    sellerId: salesCard.sellerId || 'system',
    blockReason: blk.reason,
    blockDetails: blk.details,
    operationType: salesCard.operationType || 'venda',
    paymentMethod: salesCard.paymentMethod || 'a_vista',
    boletoDays: salesCard.boletoDays || null,
    totalAmount: String(parseFloat(String(salesCard.saleValue)) || 0),
    products: (salesCard.products as any) || [],
  } as any);
  return true;
}

export async function autoSendToBillingPipeline(salesCard: any, createdByEmail: string, opts?: { skipDebtCheck?: boolean; scheduledBillingDate?: string | Date | null }) {
  if (!isInternalBillingModeActive()) return null;
  // So cria item no pipeline para pedidos com venda registrada (evita cards vazios)
  if (!salesCard.saleValue || parseFloat(String(salesCard.saleValue)) === 0) { await logOrderAudit(salesCard.id, 'skipped_no_sale'); return null; }

  // TRAVA ANTI-REIMPORTACAO DO HISTORICO (Omie): pedidos cuja VENDA foi concluida ha mais de
  // N dias (default 2) NAO entram no pipeline interno. A migracao do historico do Omie
  // reintroduz pedidos antigos (muitos ja faturados), que sem esta trava reaparecem na etapa
  // 'pedido' como duplicatas. Pedido REAL entra no pipeline no MESMO dia da conclusao
  // (completedDate ~ agora), entao passa normalmente. Liberacoes manuais (skipDebtCheck) sao
  // isentas para nao quebrar o release de bloqueados legitimos. Ajustavel: BILLING_HISTORY_MAX_AGE_DAYS.
  if (!opts?.skipDebtCheck && salesCard.completedDate) {
    const _cd = new Date(salesCard.completedDate).getTime();
    const _maxAgeMs = (parseInt(process.env.BILLING_HISTORY_MAX_AGE_DAYS || '2', 10) || 2) * 86400000;
    if (!isNaN(_cd) && (Date.now() - _cd) > _maxAgeMs) {
      await logOrderAudit(salesCard.id, 'skipped_historical_import');
      return null;
    }
  }

  try {
    const existing = await storage.getBillingPipelineItems();
    if (existing.find(i => i.salesCardId === salesCard.id)) { await logOrderAudit(salesCard.id, 'skipped_duplicate'); return null; }

    const customer = salesCard.customerId ? await storage.getCustomer(salesCard.customerId) : null;

    // BLOQUEIO (funil unico): cliente com DEBITO VENCIDO ou pedido de AMOSTRA/TROCA/
    // BONIFICACAO nao entra no pipeline — vai para blocked_orders (coluna "Bloqueados").
    // A liberacao manual (release) e a liberacao automatica (debito regularizado)
    // chamam com opts.skipDebtCheck=true, pulando esta checagem.
    if (!opts?.skipDebtCheck) {
      const blk = await evaluateOrderBlock(salesCard, customer);
      if (blk) {
        let blkIsNew = false;
        try { blkIsNew = await insertBlockedOrderIdempotent(salesCard, blk); }
        catch (e: any) { console.warn('⚠️ [BILLING-PIPELINE] Erro ao registrar bloqueio (segue):', e?.message); }
        await logOrderAudit(salesCard.id, blk.reason === 'overdue_debt' ? 'blocked_overdue_debt' : 'blocked_operation_type');
        console.log(`🚫 [BILLING-PIPELINE] Pedido ${salesCard.id} BLOQUEADO (${blk.reason}: ${(customer as any)?.fantasyName || (customer as any)?.name || salesCard.customerId}) - coluna Bloqueados`);

        // NOTIFICAÇÃO (mesma automação 'pedido.criado' da implantação), agora TAMBÉM quando o
        // pedido nasce BLOQUEADO — com um aviso de bloqueio em CAIXA ALTA anexado à mesma mensagem.
        // Dispara só quando o bloqueio é NOVO (blkIsNew), para não repetir a cada reprocessamento.
        if (blkIsNew) {
          try {
            const _cbeB = String(createdByEmail || '').trim();
            let regUserB: any = null;
            if (_cbeB && !/^(system|auto|reconcile)/i.test(_cbeB)) { try { regUserB = await storage.getUserByEmail(_cbeB); } catch {} }
            const sellerB = regUserB || (salesCard.sellerId ? await storage.getUser(salesCard.sellerId) : null);
            const motivoUp = blk.reason === 'overdue_debt'
              ? 'DÉBITO VENCIDO DO CLIENTE'
              : 'OPERAÇÃO REQUER LIBERAÇÃO MANUAL (AMOSTRA / TROCA / BONIFICAÇÃO)';
            const blockNotice = `🚫 *PEDIDO BLOQUEADO — ${motivoUp}.*\n${String(blk.details || '').toUpperCase()}\nESTE PEDIDO NÃO SERÁ FATURADO ATÉ A LIBERAÇÃO.`;
            void fireAutomation('pedido.criado', {
              customer: { name: customer?.fantasyName || customer?.name || 'Cliente' },
              order: {
                id: `INT-${String(salesCard.id).substring(0, 8)}`,
                value: (Number(salesCard.saleValue) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
              },
              seller: { name: sellerB ? `${sellerB.firstName || ''} ${sellerB.lastName || ''}`.trim() : '' },
              sellerPhone: (sellerB as any)?.phone || null,
              blocked: true,
              blockReason: blk.reason,
              blockNotice,
            });
          } catch (e: any) { console.warn('⚠️ [BILLING-PIPELINE] Falha ao notificar bloqueio (segue):', e?.message); }
        }
        return null;
      }
    }

    // Vendedor do pedido = quem REGISTROU (createdByEmail); fallback = vendedor do cadastro do cliente (system/auto/reconcile)
    let registeringUser: any = null;
    const _cbe = String(createdByEmail || '').trim();
    if (_cbe && !/^(system|auto|reconcile)/i.test(_cbe)) { try { registeringUser = await storage.getUserByEmail(_cbe); } catch {} }
    const effectiveSellerId = registeringUser ? registeringUser.id : (salesCard.sellerId || null);
    const seller = registeringUser || (salesCard.sellerId ? await storage.getUser(salesCard.sellerId) : null);

    let omieInstanceName = '';
    if (customer?.omieInstanceId) {
      const instance = await storage.getOmieInstance(customer.omieInstanceId);
      omieInstanceName = instance?.displayName || '';
    }

    // AGENDAMENTO: se veio uma data de agendamento no FUTURO (dia-calendário BRT), o item entra na
    // etapa 'agendado' e migra automaticamente para 'pedido' na data (via promoteDueScheduledOrders).
    let stage: 'pedido' | 'agendado' = 'pedido';
    let schedDate: Date | null = null;
    if (opts?.scheduledBillingDate) {
      const s = String(opts.scheduledBillingDate).slice(0, 10); // 'YYYY-MM-DD'
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && s > todayBrazilISO()) {
        stage = 'agendado';
        schedDate = new Date(`${s}T12:00:00-03:00`); // meio-dia BRT evita virada de dia
      }
    }

    const item = await storage.createBillingPipelineItem({
      salesCardId: salesCard.id,
      customerId: salesCard.customerId,
      customerName: customer?.fantasyName || customer?.name || 'Cliente desconhecido',
      customerDocument: customer?.cnpj || customer?.cpf || null,
      sellerId: effectiveSellerId,
      sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
      stage: stage,
      scheduledBillingDate: schedDate,
      orderNumber: `INT-${salesCard.id.substring(0, 8)}`,
      saleValue: salesCard.saleValue || null,
      paymentMethod: salesCard.paymentMethod || null,
      operationType: salesCard.operationType || null,
      products: salesCard.products as any || null,
      notes: salesCard.notes || null,
      omieInstanceId: customer?.omieInstanceId || null,
      omieInstanceName: omieInstanceName || null,
      stageHistory: [{
        stage: stage,
        changedAt: (salesCard.completedDate ? new Date(salesCard.completedDate) : nowBrazil()).toISOString(),
        changedBy: `auto (${_cbe || internalBillingActivatedBy || 'system'})`
      }],
      createdBy: `auto (${_cbe || internalBillingActivatedBy || 'system'})`,
      // DATA DE REGISTRO do pedido = quando a VENDA foi registrada (completedDate do sales_card).
      // NAO usar createdAt do card: em clientes AGENDADOS/RECORRENTES o card e criado semanas
      // antes (data da agenda) e a venda so e registrada na conclusao. Sem completedDate
      // (ex.: pedido 'agendado' para o futuro), fica o defaultNow() = momento do registro.
      ...(salesCard.completedDate ? { createdAt: new Date(salesCard.completedDate) } : {}),
    });

    await logOrderAudit(salesCard.id, stage === 'agendado' ? 'created_scheduled' : 'created');
    if (stage === 'agendado') {
      console.log(`📅 [BILLING-PIPELINE] Pedido ${salesCard.id} AGENDADO para ${schedDate ? schedDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?'} (etapa 'agendado')`);
    } else {
      console.log(`✅ [BILLING-PIPELINE] Pedido ${salesCard.id} auto-enviado para faturamento interno (modo ativo)`);
      // Automacao: pedido.criado (fire-and-forget) — apenas para pedidos NÃO agendados (dispara na promoção depois)
      void fireAutomation('pedido.criado', {
        customer: { name: customer?.fantasyName || customer?.name || 'Cliente' },
        order: { id: item.orderNumber, value: (Number(salesCard.saleValue) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) },
        seller: { name: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : '' },
        sellerPhone: (seller as any)?.phone || null,
      });
    }
    return item;
  } catch (error) {
    await logOrderAudit(salesCard.id, 'failed', String((error as any)?.message || error));
    console.error(`❌ [BILLING-PIPELINE] Erro ao auto-enviar pedido:`, error);
    return null;
  }
}

// ============ Rede de seguranca #2: pedidos presos em 'pending' ============
// Um pedido pode ficar preso em sales_cards.status='pending' com a venda ja registrada
// (produtos + valor) quando a FINALIZACAO nao completa (ex.: o app do vendedor perdeu conexao
// ao confirmar). Nesse estado o card NUNCA gera item no pipeline (autoSend so roda na conclusao)
// e o pedido "some" do funil. Esta rede promove os presos: marca o card 'completed' preservando
// a DATA DE REGISTRO original e envia ao pipeline via autoSendToBillingPipeline (que aplica
// bloqueio de debito/tipo de operacao + dedup + auditoria). Idempotente.
//  - sem cardIds: varre automaticamente (parados ha >= minAgeMinutes, com produtos, sem item no pipeline).
//  - com cardIds: processa exatamente esses ids (recuperacao pontual).
//  - apply=false: dryRun (so relata o que faria).
export async function reconcilePendingOrders(opts?: { minAgeMinutes?: number; cardIds?: string[]; apply?: boolean }): Promise<{ scanned: number; recovered: number; blockedOrSkipped: number; notEligible: number; details: any[] }> {
  const apply = opts?.apply !== false; // default: aplica
  const minAge = Number(opts?.minAgeMinutes ?? 60);
  const details: any[] = [];
  let recovered = 0, blockedOrSkipped = 0, notEligible = 0;
  let ids: string[] = [];
  try {
    if (opts?.cardIds?.length) {
      ids = opts.cardIds.filter(Boolean);
    } else {
      const q: any = await db.execute(sql`
        SELECT sc.id FROM sales_cards sc
        WHERE sc.status = 'pending'
          AND sc.sale_value IS NOT NULL AND sc.sale_value::numeric > 0
          AND sc.products IS NOT NULL AND jsonb_array_length(sc.products) > 0
          AND sc.parent_card_id IS NULL
          AND sc.updated_at < (now() - (${minAge} * interval '1 minute'))
          AND NOT EXISTS (SELECT 1 FROM billing_pipeline bp WHERE bp.sales_card_id = sc.id)`);
      ids = (q.rows || []).map((r: any) => r.id);
    }
  } catch (e: any) {
    return { scanned: 0, recovered: 0, blockedOrSkipped: 0, notEligible: 0, details: [{ error: e?.message || String(e) }] };
  }
  const scanned = ids.length;
  for (const id of ids) {
    try {
      const card: any = await storage.getSalesCard(id);
      if (!card) { notEligible++; details.push({ id, result: 'not_found' }); continue; }
      if (!card.saleValue || parseFloat(String(card.saleValue)) === 0) { notEligible++; details.push({ id, result: 'no_value' }); continue; }
      if (['no_sale', 'cancelled', 'canceled', 'transferred'].includes(String(card.status))) { notEligible++; details.push({ id, result: 'status_' + card.status }); continue; }
      if (!apply) { details.push({ id, val: card.saleValue, status: card.status, result: 'would_recover' }); continue; }
      // Preserva a data de registro do pedido (senao o item entraria no pipeline como "hoje").
      const completedDate = card.completedDate || card.createdAt || new Date();
      if (card.status === 'pending') {
        await db.execute(sql`UPDATE sales_cards SET status = 'completed', completed_date = ${completedDate}, updated_at = now() WHERE id = ${id} AND status = 'pending'`);
      }
      let email = 'reconcile-pending';
      try { if (card.sellerId) { const u = await storage.getUser(card.sellerId); if (u?.email) email = u.email; } } catch {}
      const item = await autoSendToBillingPipeline({ ...card, status: 'completed', completedDate } as any, email);
      if (item) { recovered++; details.push({ id, val: card.saleValue, result: 'recovered', pipelineId: item.id, stage: item.stage }); }
      else { blockedOrSkipped++; details.push({ id, val: card.saleValue, result: 'blocked_or_dup' }); }
    } catch (e: any) {
      blockedOrSkipped++; details.push({ id, result: 'error', error: e?.message || String(e) });
    }
  }
  console.log(`🛟 [RECONCILE-PENDING] scanned=${scanned} recovered=${recovered} blocked/dup=${blockedOrSkipped} notEligible=${notEligible} apply=${apply}`);
  return { scanned, recovered, blockedOrSkipped, notEligible, details };
}

function isAdminOnly(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user || !['admin', 'coordinator', 'administrative'].includes(user.role)) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
}

// Leitura do pipeline (consulta + filtros): admins + telemarketing (interno).
// Telemarketing tem acesso SOMENTE de leitura — as mutações seguem em isAdminOnly.
function isPipelineViewer(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user || !['admin', 'coordinator', 'administrative', 'telemarketing', 'vendedor'].includes(user.role)) {
    return res.status(403).json({ message: 'Access denied' });
  }
  next();
}

function isFlavioOnly(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user || user.email !== 'flavio@bebahonest.com.br') {
    return res.status(403).json({ message: 'Apenas FLAVIO pode realizar esta ação' });
  }
  next();
}

// Bloqueio manual de pedido: apenas os 3 admins (mesma lista da Rota do Dia).
const THREE_ADMINS = ['cinthiamarque90@gmail.com', 'flaviobaylao@gmail.com', 'flavio@bebahonest.com.br'];
function isThreeAdmins(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user || !THREE_ADMINS.includes(String(user.email || '').toLowerCase())) {
    return res.status(403).json({ message: 'Apenas administradores podem bloquear pedidos.' });
  }
  next();
}

// REGRA (Flavio): trocar o VENDEDOR de um pedido no pipeline so pode admin (role) + os 3 admins + Lanucy.
const SELLER_EDIT_EMAILS = ['cinthiamarque90@gmail.com', 'flaviobaylao@gmail.com', 'flavio@bebahonest.com.br', 'lanucy@bebahonest.com.br'];
function canEditPedidoSeller(user: any): boolean {
  if (!user) return false;
  if (String(user.role || '') === 'admin') return true;
  return SELLER_EDIT_EMAILS.includes(String(user.email || '').toLowerCase());
}

export function registerBillingPipelineRoutes(app: Express) {
  // Regenera PIX EXPIRADOS para recebiveis AINDA EM ABERTO. A cob imediata do a-vista vencia
  // em 1h -> o cliente nao conseguia pagar depois. Cria um QR NOVO (validade 3 dias) e marca o
  // antigo como removido. PULA recebiveis cancelados, ja pagos (amount_paid >= amount) ou que ja
  // tem boleto ativo (boleto tem PIX proprio). dryRun=true so conta; processa no maximo `limit`
  // por chamada (default 25, max 100) -> chame em loop ate remaining=0.
  app.post('/api/admin/pix/regenerate-expired', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun === true;
      const limit = Math.min(Number(req.body?.limit) || 25, 100);
      const EXP = 259200; // 3 dias
      const cand: any = await db.execute(sql`
        SELECT pc.id AS pix_id, pc.receivable_id, pc.amount, pc.customer_id, pc.omie_instance_id, pc.description,
               r.customer_name, r.customer_document
        FROM pix_charges pc
        JOIN receivables r ON r.id = pc.receivable_id AND r.deleted_at IS NULL
        WHERE pc.status = 'ATIVA' AND pc.expires_at < now()
          AND r.status::text NOT IN ('cancelada','cancelado','recebida','paga','pago')
          AND COALESCE(NULLIF(r.amount_paid,'')::numeric, 0) < COALESCE(NULLIF(r.amount,'')::numeric, 0)
          AND NOT EXISTS (SELECT 1 FROM boleto_charges bc WHERE bc.receivable_id = r.id AND bc.status NOT IN ('cancelado','cancelada'))
        ORDER BY pc.created_at DESC`);
      const rows = (cand?.rows ?? cand ?? []) as any[];
      const eligible = rows.length;
      if (dryRun) return res.json({ ok: true, dryRun: true, eligible });
      const batch = rows.slice(0, limit);
      let regenerated = 0, failed = 0; const errors: string[] = [];
      for (const row of batch) {
        try {
          let accounts = await storage.getFinancialAccounts(row.omie_instance_id || undefined);
          let account = (accounts || []).find((a: any) => a.bbPixEnabled && a.pixKey);
          if (!account) { const all = await storage.getFinancialAccounts(); account = (all || []).find((a: any) => a.bbPixEnabled && a.pixKey); }
          if (!account) { failed++; if (errors.length < 10) errors.push('sem conta PIX p/ rec ' + row.receivable_id); continue; }
          const fresh: any = await createImmediateCharge(account.id, {
            amount: parseFloat(row.amount),
            debtorName: row.customer_name || undefined,
            debtorDocument: row.customer_document || undefined,
            description: row.description || undefined,
            expirationSeconds: EXP,
            receivableId: row.receivable_id,
            customerId: row.customer_id || undefined,
            createdBy: 'regenerate-expired',
          });
          if (fresh?.id) {
            await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR' WHERE id = ${row.pix_id} AND status = 'ATIVA'`);
            regenerated++;
          } else { failed++; }
        } catch (e: any) { failed++; if (errors.length < 10) errors.push(String(e?.message || e).slice(0, 90)); }
      }
      res.json({ ok: true, eligible, processed: batch.length, regenerated, failed, remaining: eligible - batch.length, errors });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Corrige o NUMERO DO TITULO das contas a receber que ficaram com "TIT-<pedido>"
  // (prefixo do salesCardId) em vez do numero da NF-e. Usa a NF-e vinculada
  // (fiscal_invoice_id). Idempotente: so mexe em titulos 'TIT-%' cuja NF-e tem numero.
  // Padrao: executa. Enviar {"dryRun":true} para apenas contar os elegiveis.
  app.post('/api/admin/pipeline/backfill-receivable-nf-titles', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun === true;
      const countQ: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM receivables r JOIN fiscal_invoices fi ON fi.id = r.fiscal_invoice_id WHERE r.title_number LIKE 'TIT-%' AND fi.invoice_number IS NOT NULL`);
      const eligible = (countQ?.rows?.[0]?.n ?? 0) as number;
      if (dryRun) return res.json({ ok: true, dryRun: true, eligible });
      const upd: any = await db.execute(sql`UPDATE receivables r SET title_number = 'NF-' || fi.invoice_number, updated_at = now() FROM fiscal_invoices fi WHERE fi.id = r.fiscal_invoice_id AND r.title_number LIKE 'TIT-%' AND fi.invoice_number IS NOT NULL`);
      res.json({ ok: true, eligible, updated: upd?.rowCount ?? upd?.rowsAffected ?? null });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Corrige a DATA DE REGISTRO de pedidos criados com a data errada: usa a data real da
  // venda (sales_cards.completed_date) no lugar da data de CRIACAO DO CARD. Afeta clientes
  // agendados/recorrentes (card criado semanas antes da venda). Atualiza created_at E a 1a
  // entrada do stage_history. So mexe onde a diferenca e > 1 dia. {"dryRun":true} so conta.
  app.post('/api/admin/pipeline/backfill-order-dates', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun === true;
      const countQ: any = await db.execute(sql`
        SELECT COUNT(*)::int AS n
        FROM billing_pipeline bp JOIN sales_cards sc ON sc.id = bp.sales_card_id
        WHERE sc.completed_date IS NOT NULL AND bp.created_at IS NOT NULL
          AND ABS(EXTRACT(EPOCH FROM (bp.created_at - sc.completed_date))) > 86400`);
      const eligible = (countQ?.rows?.[0]?.n ?? 0) as number;
      if (dryRun) return res.json({ ok: true, dryRun: true, eligible });
      const upd: any = await db.execute(sql`
        UPDATE billing_pipeline bp
        SET created_at = sc.completed_date,
            stage_history = CASE
              WHEN jsonb_typeof(bp.stage_history) = 'array' AND jsonb_array_length(bp.stage_history) > 0
              THEN jsonb_set(bp.stage_history, '{0,changedAt}', to_jsonb(to_char(sc.completed_date, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
              ELSE bp.stage_history END,
            updated_at = now()
        FROM sales_cards sc
        WHERE bp.sales_card_id = sc.id AND sc.completed_date IS NOT NULL AND bp.created_at IS NOT NULL
          AND ABS(EXTRACT(EPOCH FROM (bp.created_at - sc.completed_date))) > 86400`);
      res.json({ ok: true, eligible, updated: upd?.rowCount ?? upd?.rowsAffected ?? null });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // REPARO: pedidos FATURADOS (NF emitida) que NAO geraram conta a receber. Causa: no
  // fluxo de faturamento a criacao do titulo roda em try/catch que ENGOLE o erro (a NF ja
  // saiu, o pedido vira 'faturado', mas o receivable nao e criado e ninguem e avisado).
  // Este endpoint acha esses orfaos (venda, com invoice_number, valor > 0, SEM nenhum
  // receivable pelo billing_pipeline_id nem pelo sales_card_id) e cria a conta a receber +
  // EMITE a cobranca (boleto/PIX) via createReceivableFromPipelineItem. dryRun por padrao.
  // Body: { dryRun?: boolean=true, id?: string (um pedido so), limit?: number }.
  app.post('/api/admin/pipeline/backfill-missing-receivables', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun !== false; // default TRUE (so conta)
      const onlyId = req.body?.id ? String(req.body.id) : null;
      const limit = Number(req.body?.limit) > 0 ? Number(req.body.limit) : 0;
      const user = req.currentUser || req.user;
      const cand: any = await db.execute(sql`
        SELECT bp.id, bp.customer_name, bp.invoice_number, bp.sale_value, bp.omie_instance_name, bp.updated_at, bp.created_at
        FROM billing_pipeline bp
        WHERE COALESCE(bp.operation_type, 'venda') = 'venda'
          AND bp.invoice_number IS NOT NULL
          AND COALESCE(bp.sale_value, 0) > 0
          AND NOT EXISTS (SELECT 1 FROM receivables r WHERE r.billing_pipeline_id = bp.id)
          AND NOT EXISTS (SELECT 1 FROM receivables r WHERE bp.sales_card_id IS NOT NULL AND r.sales_card_id = bp.sales_card_id)
          ${onlyId ? sql`AND bp.id = ${onlyId}` : sql``}
        ORDER BY bp.updated_at DESC NULLS LAST
        ${limit ? sql`LIMIT ${limit}` : sql``}`);
      const rows0: any[] = (cand?.rows ?? cand ?? []);
      const ids: string[] = rows0.map((r: any) => String(r.id));
      if (dryRun) return res.json({ ok: true, dryRun: true, candidatos: ids.length, detalhes: rows0.slice(0, 300).map((r: any) => ({ id: String(r.id), cliente: String(r.customer_name || ''), nf: r.invoice_number, valor: r.sale_value, instancia: r.omie_instance_name, faturadoEm: r.updated_at || r.created_at })) });
      let criados = 0; const erros: any[] = []; const exemplos: any[] = [];
      for (const id of ids) {
        try {
          const item = await storage.getBillingPipelineItem(id);
          if (!item) { erros.push({ id, err: 'item nao encontrado' }); continue; }
          // Resolve a NF-e do item A PROVA DE COLISAO (mesmo criterio do retry-invoice):
          // por sales_card_id COMPLETO, preferindo a autorizada; NUNCA so por numero.
          let fiscalInvoiceId: string | null = null;
          if (item.salesCardId) {
            const nfq: any = await db.execute(sql`SELECT id FROM fiscal_invoices WHERE sales_card_id = ${item.salesCardId} AND status NOT IN ('cancelled', 'cancelada') ORDER BY (status = 'authorized') DESC, created_at DESC LIMIT 1`);
            fiscalInvoiceId = (nfq?.rows ?? nfq ?? [])[0]?.id || null;
          }
          const rcv: any = await createReceivableFromPipelineItem(item, fiscalInvoiceId, user);
          if (rcv) { criados++; if (exemplos.length < 10) exemplos.push({ nf: rcv.titleNumber, valor: rcv.amount, cliente: String(item.customerName || '').slice(0, 28) }); }
          else erros.push({ id, err: 'nao gerou titulo (operationType != venda ou valor <= 0)' });
        } catch (e: any) { erros.push({ id, err: String(e?.message || e).slice(0, 140) }); }
      }
      res.json({ ok: true, dryRun: false, candidatos: ids.length, criados, erros: erros.slice(0, 20), exemplos });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // BLOQUEIO MANUAL de um pedido do pipeline (somente os 3 admins). Move o item para
  // blocked_orders (motivo 'manual') e o remove do funil. So sai de la por liberacao manual.
  app.post('/api/billing-pipeline/:id/block', authenticateUser, isThreeAdmins, async (req: any, res) => {
    try {
      const id = req.params.id;
      const reason = String(req.body?.reason || '').trim();
      const items = await storage.getBillingPipelineItems();
      const item = items.find((i: any) => i.id === id);
      if (!item) return res.status(404).json({ message: 'Pedido nao encontrado no pipeline.' });
      if (!item.salesCardId) return res.status(400).json({ message: 'Este pedido nao tem card de venda vinculado e nao pode ser bloqueado por aqui.' });
      const details = `${reason || 'Bloqueio manual pelo administrador.'} (bloqueado por ${req.currentUser.email})`;
      const already = await db.select().from(blockedOrders)
        .where(and(eq(blockedOrders.salesCardId, item.salesCardId), eq(blockedOrders.status, 'blocked'))).limit(1);
      if (already.length === 0) {
        await db.insert(blockedOrders).values({
          salesCardId: item.salesCardId,
          customerId: item.customerId,
          sellerId: item.sellerId || 'system',
          blockReason: 'manual',
          blockDetails: details,
          operationType: item.operationType || 'venda',
          paymentMethod: item.paymentMethod || 'a_vista',
          totalAmount: String(parseFloat(String(item.saleValue)) || 0),
          products: (item.products as any) || [],
        } as any);
      }
      await storage.deleteBillingPipelineItem(id);
      try { await logOrderAudit(item.salesCardId, 'blocked_manual', details); } catch {}
      console.log(`🚫 [BILLING-PIPELINE] Pedido ${id} BLOQUEADO MANUALMENTE por ${req.currentUser.email}`);
      res.json({ ok: true });
    } catch (e: any) {
      console.error('❌ [BILLING-PIPELINE] Erro no bloqueio manual:', e?.message);
      res.status(500).json({ message: e?.message || 'Erro ao bloquear pedido' });
    }
  });


  // Move para a LIXEIRA os itens criados pela reconciliacao (pedidos fantasmas).
  // NAO apaga: um card nunca some do pipeline. Vao para 'lixeira' (restauravel) —
  // assim, se um desses cards foi de fato faturado depois (ex.: Figueira Branca /
  // NF105209), ele nao e perdido; fica na Lixeira e pode ser restaurado.
  app.post('/api/admin/pipeline/remove-reconciled', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      await ensureLixeiraStage();
      const r: any = await db.execute(sql`
        UPDATE billing_pipeline
        SET stage = 'lixeira', updated_at = now(),
            stage_history = COALESCE(stage_history, '[]'::jsonb) || jsonb_build_object(
              'stage', 'lixeira',
              'changedAt', to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS'),
              'changedBy', 'remove-reconciled'
            )::jsonb
        WHERE created_by ILIKE '%reconcile%' AND stage <> 'lixeira'`);
      res.json({ ok: true, movedToLixeira: r?.rowCount ?? null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // FASE 2 - Limpeza: cancela contas a receber criadas indevidamente por operacoes que
  // NAO sao venda (amostra, troca, bonificacao, transferencia, remessa, devolucao).
  // So atinge titulos SEM pagamento e ainda nao cancelados. Cancela tambem a cobranca:
  // boleto e baixado no BB via API; PIX e marcado cancelado (a cob expira no BB).
  // Padrao: dryRun=true (so lista). Enviar {"dryRun":false} para executar.
  app.post('/api/admin/pipeline/cleanup-non-venda', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = req.currentUser?.email || 'cleanup-non-venda';
      const q: any = await db.execute(sql`
        SELECT r.id, r.title_number, r.customer_name, r.amount, r.status, bp.operation_type AS op
        FROM receivables r JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
        WHERE COALESCE(bp.operation_type, 'venda') <> 'venda'
          AND r.deleted_at IS NULL AND r.status <> 'cancelada'
          AND COALESCE(r.amount_paid, '0')::numeric = 0
        ORDER BY bp.operation_type, r.issue_date`);
      const titles: any[] = (q as any).rows || [];
      if (dryRun) return res.json({ ok: true, dryRun: true, count: titles.length, titles });
      const results: any[] = [];
      for (const t of titles) {
        const r: any = { id: t.id, title: t.title_number, op: t.op, boletosCancelados: 0, pixCancelados: 0, erros: [] as string[] };
        try {
          const bq: any = await db.execute(sql`SELECT * FROM boleto_charges WHERE receivable_id = ${t.id} AND status NOT IN ('cancelado','cancelada','liquidado','pago','recebido') ORDER BY created_at DESC`);
          for (const boleto of ((bq as any).rows || [])) {
            const accq: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_boleto_enabled = true AND bb_convenio IS NOT NULL LIMIT 1`);
            const accId = (accq as any).rows?.[0]?.id;
            if (accId) {
              const cancel = await cancelarBoleto(accId, boleto);
              if (!cancel.ok && !cancel.alreadyBaixado) { r.erros.push('boleto ' + (boleto.nosso_numero || boleto.id) + ': ' + (cancel.error || 'falha')); continue; }
            }
            await db.execute(sql`UPDATE boleto_charges SET status = 'cancelado' WHERE id = ${boleto.id}`);
            r.boletosCancelados++;
          }
          const pu: any = await db.execute(sql`UPDATE pix_charges SET status = 'REMOVIDA_PELO_USUARIO_RECEBEDOR' WHERE receivable_id = ${t.id} AND status = 'ATIVA'`);
          r.pixCancelados = ((pu as any)?.rowCount ?? 0) as number;
          if (!r.erros.length) {
            await db.execute(sql`UPDATE receivables SET status = 'cancelada', updated_at = now(), updated_by = ${by}, notes = COALESCE(notes || ' | ', '') || ${'Cancelada automaticamente - operacao ' + String(t.op) + ' nao gera conta a receber'} WHERE id = ${t.id}`);
            r.cancelada = true;
          }
        } catch (e: any) { r.erros.push(String(e?.message || e)); }
        results.push(r);
      }
      res.json({ ok: true, dryRun: false, count: titles.length, results });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // FASE 2 - Classificacao DRE: aplica a conta de Receita Bruta (filha) nas contas a
  // receber de VENDA do pipeline ainda sem classificacao. dryRun=true (padrao) so conta.
  app.post('/api/admin/pipeline/classify-dre', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      // FASE 3.1 - escopo: 'pipeline' (vendas do pipeline), 'legados' (era Omie/conciliacao) ou 'todos'.
      const scope = String(req.body?.scope || 'pipeline');
      const scopeCond = scope === 'legados' ? sql`AND billing_pipeline_id IS NULL` : (scope === 'todos' ? sql`` : sql`AND billing_pipeline_id IS NOT NULL`);
      const accId = await resolveRevenueChartAccountId();
      if (!accId) return res.status(422).json({ error: 'nenhuma conta-filha de receita_bruta (code com ponto) ativa no plano de contas' });
      const cq: any = await db.execute(sql`
        SELECT count(*)::int AS n FROM receivables r
        WHERE r.chart_account_id IS NULL AND r.deleted_at IS NULL
          AND r.status <> 'cancelada' ${scopeCond}`);
      const n = (cq as any).rows?.[0]?.n ?? 0;
      if (dryRun) return res.json({ ok: true, dryRun: true, scope, chartAccountId: accId, candidatos: n });
      const u: any = await db.execute(sql`
        UPDATE receivables SET chart_account_id = ${accId}, updated_at = now(), updated_by = ${req.currentUser?.email || 'classify-dre'}
        WHERE chart_account_id IS NULL AND deleted_at IS NULL
          AND status <> 'cancelada' ${scopeCond}`);
      res.json({ ok: true, dryRun: false, scope, chartAccountId: accId, atualizados: ((u as any)?.rowCount ?? 0) as number });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Corrige a DATA DE CRIACAO dos itens ja reconciliados: usar a data de registro do pedido (sales_card.created_at)
  app.post('/api/admin/pipeline/fix-registration-dates', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const r: any = await db.execute(sql`
        UPDATE billing_pipeline bp
        SET created_at = sc.created_at
        FROM sales_cards sc
        WHERE bp.sales_card_id = sc.id
          AND sc.created_at IS NOT NULL
          AND bp.created_by ILIKE '%reconcile%'`);
      res.json({ ok: true, updated: r?.rowCount ?? null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Rede de seguranca: reconciliar pedidos orfaos (com venda, sem item no pipeline)
  app.post('/api/admin/pipeline/reconcile-orphans', authenticateUser, isAdminOnly, async (req: any, res) => {
    try { const days = Number(req.body?.days) || 7; const r = await reconcileOrphanOrders(days); res.json({ ok: true, ...r }); }
    catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Rede de seguranca #2: recuperar pedidos presos em 'pending' (venda registrada, nunca finalizada,
  // sem item no pipeline). ?apply=1 aplica; sem apply = dryRun (so relata). Body opcional:
  // { cardIds: string[] } p/ recuperacao pontual; { minAge } minutos (default 60) p/ a varredura.
  app.post('/api/admin/pipeline/reconcile-pending', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const apply = req.query.apply === '1' || req.body?.apply === true;
      const minAgeMinutes = Number(req.query.minAge ?? req.body?.minAge) || 60;
      const cardIds = Array.isArray(req.body?.cardIds) ? req.body.cardIds.map((x: any) => String(x)) : undefined;
      const r = await reconcilePendingOrders({ apply, minAgeMinutes, cardIds });
      res.json({ ok: true, apply, ...r });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // DIAGNOSTICO + RECUPERACAO de pedidos PAGOS na loja (PIX/cartao/GooglePay) que NAO viraram
  // sales_card — ex.: pagamento aprovado mas o POST /api/public/orders falhou (status
  // 'paid_order_error'), ou o card foi criado e depois sumiu. dryRun por padrao (so relata);
  // {apply:true} recria o pedido a partir do PAYLOAD salvo na linha de pagamento e o envia ao
  // pipeline. Idempotente por linha (so age em linhas SEM card valido).
  app.post('/api/admin/hotsite/recover-paid-orders', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const apply = req.body?.apply === true;
      const hoursRaw = Number(req.body?.hours);
      const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 && hoursRaw <= 2160 ? Math.floor(hoursRaw) : 72;
      const INTERNAL_BASE = 'http://127.0.0.1:' + (process.env.PORT || '8080');
      const report: any = { apply, hours, pix: [], card: [], orphansPix: 0, orphansCard: 0 };

      const cardExists = async (id: string | null): Promise<boolean> => {
        if (!id) return false;
        try { const c: any = await db.execute(sql`SELECT 1 FROM sales_cards WHERE id = ${id} LIMIT 1`); return ((c.rows || c) as any[]).length > 0; } catch { return false; }
      };

      const scan = async (table: 'pix' | 'card') => {
        const tbl = table === 'pix' ? 'hotsite_pending_pix' : 'hotsite_card_payments';
        let rows: any[] = [];
        try {
          const r: any = await db.execute(sql.raw(
            `SELECT id, status, order_id, order_number, amount, created_at, payload, error FROM ${tbl} ` +
            `WHERE created_at > now() - interval '${hours} hours' AND status IN ('paid','paid_order_error','error','finalizing') ` +
            `ORDER BY created_at DESC LIMIT 200`));
          rows = (r.rows || r) as any[];
        } catch (e: any) { report[table + 'Err'] = e?.message || String(e); return; }

        for (const row of rows) {
          const hasCard = await cardExists(row.order_id);
          const entry: any = { id: row.id, status: row.status, order_id: row.order_id || null, order_number: row.order_number || null, amount: row.amount, created_at: row.created_at, hasCard, error: row.error || null };
          if (!hasCard) {
            report[table === 'pix' ? 'orphansPix' : 'orphansCard']++;
            if (apply) {
              try {
                const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
                if (!payload || !payload.items) throw new Error('payload ausente/invalido');
                const resp = await fetch(`${INTERNAL_BASE}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const data: any = await resp.json();
                if (!resp.ok || !data?.orderId) throw new Error(data?.message || `HTTP ${resp.status}`);
                if (table === 'pix') await db.execute(sql`UPDATE hotsite_pending_pix SET status='paid', order_id=${data.orderId}, order_number=${data.orderNumber || null}, updated_at=now() WHERE id=${row.id}`);
                else await db.execute(sql`UPDATE hotsite_card_payments SET status='paid', order_id=${data.orderId}, order_number=${data.orderNumber || null}, updated_at=now() WHERE id=${row.id}`);
                try { await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${'\n[RECUPERADO] pedido pago na loja recriado por admin (pagamento ' + String(row.id) + ').'} WHERE id = ${data.orderId}`); } catch {}
                try { const rr = await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [data.orderId] }); entry.pipeline = rr; } catch (e2: any) { entry.pipelineError = e2?.message || String(e2); }
                entry.recovered = { newOrderId: data.orderId, newOrderNumber: data.orderNumber };
                console.log(`♻️ [RECOVER] Pedido pago recriado: ${data.orderNumber} (pagamento ${table} ${row.id})`);
              } catch (e: any) { entry.recoverError = e?.message || String(e); }
            } else { entry.wouldRecover = true; }
          }
          report[table].push(entry);
        }
      };

      await scan('pix');
      await scan('card');
      res.json({ ok: true, ...report });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Busca o PAYLOAD de um pedido da loja pelo TELEFONE do cliente nas tabelas de pagamento
  // (PIX/cartao), em QUALQUER status (inclusive awaiting_payment/expired) — util quando o card
  // nao foi criado e precisamos recuperar o carrinho. {apply:true} recria o pedido a partir do
  // payload e envia ao pipeline (so nas linhas SEM card valido). Match por ultimos 8 digitos.
  app.post('/api/admin/hotsite/find-order-by-phone', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const phoneDigits = String(req.body?.phone || '').replace(/\D/g, '');
      if (phoneDigits.length < 8) return res.status(400).json({ message: 'telefone invalido (min 8 digitos)' });
      const last8 = phoneDigits.slice(-8);
      const apply = req.body?.apply === true;
      const daysRaw = Number(req.body?.days);
      const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? Math.floor(daysRaw) : 45;
      const INTERNAL_BASE = 'http://127.0.0.1:' + (process.env.PORT || '8080');
      const out: any = { phone: phoneDigits, last8, apply, days, matches: [] };

      const cardExists = async (id: string | null): Promise<boolean> => {
        if (!id) return false;
        try { const c: any = await db.execute(sql`SELECT 1 FROM sales_cards WHERE id = ${id} LIMIT 1`); return ((c.rows || c) as any[]).length > 0; } catch { return false; }
      };

      for (const tbl of ['hotsite_pending_pix', 'hotsite_card_payments'] as const) {
        let rows: any[] = [];
        try {
          const r: any = await db.execute(sql.raw(`SELECT id, status, order_id, order_number, amount, created_at, payload, error FROM ${tbl} WHERE created_at > now() - interval '${days} days' ORDER BY created_at DESC LIMIT 500`));
          rows = (r.rows || r) as any[];
        } catch (e: any) { out[tbl + '_err'] = e?.message || String(e); continue; }

        for (const row of rows) {
          let pl: any = null;
          try { pl = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch {}
          const plPhone = String(pl?.customer?.phone || '').replace(/\D/g, '');
          if (!plPhone || plPhone.slice(-8) !== last8) continue;
          const hasCard = await cardExists(row.order_id);
          const m: any = {
            table: tbl, id: row.id, status: row.status, order_id: row.order_id || null, order_number: row.order_number || null,
            amount: row.amount, created_at: row.created_at, hasCard, error: row.error || null,
            customer: pl?.customer ? { name: pl.customer.name, phone: pl.customer.phone, cpfCnpj: pl.customer.cpfCnpj, address: pl.customer.address } : null,
            items: (pl?.items || []).map((i: any) => `${i.productName} x${i.quantity}`), paymentMethod: pl?.paymentMethod, total: pl?.totalAmount,
          };
          if (apply && !hasCard && pl?.items) {
            try {
              const resp = await fetch(`${INTERNAL_BASE}/api/public/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pl) });
              const data: any = await resp.json();
              if (!resp.ok || !data?.orderId) throw new Error(data?.message || `HTTP ${resp.status}`);
              if (tbl === 'hotsite_pending_pix') await db.execute(sql`UPDATE hotsite_pending_pix SET status='paid', order_id=${data.orderId}, order_number=${data.orderNumber || null}, updated_at=now() WHERE id=${row.id}`);
              else await db.execute(sql`UPDATE hotsite_card_payments SET status='paid', order_id=${data.orderId}, order_number=${data.orderNumber || null}, updated_at=now() WHERE id=${row.id}`);
              try { await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${'\n[RECUPERADO] pedido da loja recriado por admin via telefone (pagamento ' + String(row.id) + ').'} WHERE id = ${data.orderId}`); } catch {}
              try { const rr = await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [data.orderId] }); m.pipeline = rr; } catch (e2: any) { m.pipelineError = e2?.message || String(e2); }
              m.recovered = { newOrderId: data.orderId, newOrderNumber: data.orderNumber };
            } catch (e: any) { m.recoverError = e?.message || String(e); }
          } else if (!hasCard) { m.wouldRecover = true; }
          out.matches.push(m);
        }
      }
      res.json({ ok: true, ...out });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Envia UM card especifico (por id) para o pipeline de faturamento. Idempotente
  // (dedup por sales_card_id) e respeita as regras de bloqueio (debito/tipo de operacao).
  // Util para reconciliar pontualmente um pedido orfao (ex.: pedido do hotsite finalizado
  // antes do fix) sem rodar o reconcile em lote.
  app.post('/api/admin/pipeline/send-card/:id', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const card = await storage.getSalesCard(req.params.id);
      if (!card) return res.status(404).json({ error: 'Card nao encontrado' });
      const item = await autoSendToBillingPipeline(card as any, req.currentUser?.email || 'system');
      res.json({ ok: true, created: !!item, item: item || null });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // RECUPERACAO: recoloca no funil um pedido que foi LIBERADO mas nao entrou (ex.: o card
  // recorrente ja tinha virado para o proximo ciclo e estava VAZIO no momento da liberacao,
  // entao autoSend pulou por 'sem venda' e o pedido sumiu). Le o SNAPSHOT imutavel do bloqueio
  // (valor + produtos, gravados em blocked_orders no momento do bloqueio) e reconstroi o item
  // do funil via autoSend (dedup por sales_card_id, skipDebtCheck). Body: { salesCardId }.
  app.post('/api/admin/pipeline/restore-from-blocked', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const salesCardId = String(req.body?.salesCardId || '');
      if (!salesCardId) return res.status(400).json({ ok: false, error: 'salesCardId obrigatorio' });
      const existing = await storage.getBillingPipelineItems();
      if (existing.find((i: any) => i.salesCardId === salesCardId)) return res.json({ ok: true, created: false, reason: 'ja_no_pipeline' });
      const bq: any = await db.execute(sql`SELECT total_amount, products, operation_type, payment_method FROM blocked_orders WHERE sales_card_id = ${salesCardId} ORDER BY created_at DESC LIMIT 1`);
      const b = (bq?.rows ?? bq ?? [])[0];
      if (!b) return res.status(404).json({ ok: false, error: 'sem registro de bloqueio para este card' });
      const val = parseFloat(String(b.total_amount ?? '0')) || 0;
      if (val <= 0) return res.status(422).json({ ok: false, error: 'snapshot do bloqueio sem valor (nada a restaurar)' });
      const card: any = await storage.getSalesCard(salesCardId);
      if (!card) return res.status(404).json({ ok: false, error: 'sales card nao encontrado' });
      const cardProds = (Array.isArray(card.products) && card.products.length) ? card.products : (b.products || null);
      const synthetic: any = { ...card, saleValue: String(val), products: cardProds, operationType: card.operationType || b.operation_type || 'venda', paymentMethod: card.paymentMethod || b.payment_method || null };
      const item: any = await autoSendToBillingPipeline(synthetic, req.currentUser?.email || 'restore', { skipDebtCheck: true });
      if (!item) return res.status(422).json({ ok: false, error: 'autoSend nao criou item (verifique regras/valor)' });
      res.json({ ok: true, created: true, orderNumber: item.orderNumber, saleValue: item.saleValue, cliente: String(item.customerName || '').slice(0, 30) });
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || String(e) }); }
  });

  // Forcar criacao de card 'faturado' p/ NFs ESPECIFICAS (sem dedup cliente+valor).
  // Recupera NF rejeitada/orfa que a rede de seguranca pulou por dedup. So evita duplicar pelo NUMERO exato da NF.
  app.post('/api/admin/pipeline/create-cards-for-nfs', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const numbers = (req.body?.numbers || []).map((n: any) => String(n).replace(/\D/g, '')).filter(Boolean);
      if (!numbers.length) return res.status(400).json({ error: 'informe numbers[]' });
      const existing = await storage.getBillingPipelineItems();
      const haveInv = new Set(existing.map((i: any) => String(i.invoiceNumber || '').replace(/\D/g, '')).filter(Boolean));
      let created = 0, skipped = 0; const errs: string[] = [];
      for (const num of numbers) {
        if (haveInv.has(num)) { skipped++; continue; }
        try {
          const rows: any = await db.select().from(fiscalInvoices).where(sql`${fiscalInvoices.invoiceNumber}::text = ${num}`).limit(1);
          const nf = rows?.[0];
          if (!nf) { errs.push(`NF ${num} nao encontrada`); continue; }
          const customer = nf.customerId ? await storage.getCustomer(nf.customerId) : null;
          const seller = (customer as any)?.sellerId ? await storage.getUser((customer as any).sellerId) : null;
          await storage.createBillingPipelineItem({
            salesCardId: null,
            customerId: nf.customerId || null,
            customerName: nf.customerName || (customer as any)?.fantasyName || (customer as any)?.name || 'Cliente',
            customerDocument: nf.customerCnpjCpf || (customer as any)?.cnpj || (customer as any)?.cpf || null,
            sellerId: (customer as any)?.sellerId || null,
            sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
            stage: 'faturado',
            orderNumber: `NF-${nf.invoiceNumber}`,
            saleValue: nf.totalInvoice || null,
            invoiceNumber: `NF-${nf.invoiceNumber}`,
            omieInstanceId: nf.omieInstanceId || null,
            notes: nf.status === 'rejected' ? 'NF REJEITADA na SEFAZ - preencher UF do cliente e re-transmitir (nao re-faturar, evita NF duplicada)' : null,
            stageHistory: [{ stage: 'faturado', changedAt: (nf.emissionDate ? new Date(nf.emissionDate) : nowBrazil()).toISOString(), changedBy: 'create-card-manual' }],
            createdBy: nf.status === 'rejected' ? 'reconcile-nf-rej' : 'reconcile-nf',
            ...(nf.emissionDate ? { createdAt: new Date(nf.emissionDate) } : {}),
          } as any);
          haveInv.add(num); created++;
        } catch (e: any) { errs.push(`${num}: ${e?.message || e}`); }
      }
      res.json({ ok: true, created, skipped, errs });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  // Religa cards do pipeline cujo customer_id NAO resolve (id sintetico 'billing-') casando por DOCUMENTO
  // com um cliente real do cadastro. Corrige rota (as coordenadas do cliente passam a ser encontradas).
  app.post('/api/admin/pipeline/heal-customer-links', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const items = await storage.getBillingPipelineItems();
      const custs = await storage.getCustomers();
      const custIds = new Set((custs as any[]).map((c: any) => c.id));
      const byDoc = new Map<string, string>();
      for (const c of custs as any[]) { const d = String((c as any).cnpj || (c as any).cpf || (c as any).document || '').replace(/\D/g, ''); if (d.length >= 11 && !byDoc.has(d)) byDoc.set(d, c.id); }
      let healed = 0, jaOk = 0, semMatch = 0; const amostra: any[] = [];
      for (const it of items as any[]) {
        if (it.stage === 'entregue') continue;
        if (it.customerId && custIds.has(it.customerId)) { jaOk++; continue; }
        const doc = String(it.customerDocument || '').replace(/\D/g, '');
        const real = doc.length >= 11 ? byDoc.get(doc) : null;
        if (real) {
          try { await db.execute(sql`UPDATE billing_pipeline SET customer_id = ${real} WHERE id = ${it.id}`); healed++; if (amostra.length < 15) amostra.push({ card: it.id, cliente: it.customerName, de: it.customerId, para: real }); }
          catch (e: any) { /* ignora */ }
        } else { semMatch++; }
      }
      res.json({ ok: true, healed, jaOk, semMatch, amostra });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Monitor: quantos orfaos nos ultimos N dias + resumo da auditoria
  app.get('/api/admin/pipeline/orphans-status', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const days = Number(req.query?.days) || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const o: any = await db.execute(sql`SELECT COUNT(*)::int AS n FROM sales_cards sc LEFT JOIN billing_pipeline bp ON bp.sales_card_id = sc.id WHERE bp.id IS NULL AND sc.sale_value IS NOT NULL AND sc.sale_value::numeric > 0 AND sc.created_at >= ${since}`);
      const a: any = await db.execute(sql`SELECT outcome, COUNT(*)::int AS n FROM order_pipeline_audit WHERE created_at >= ${since} GROUP BY outcome ORDER BY n DESC`);
      res.json({ days, orphans: o.rows?.[0]?.n ?? null, audit: a.rows });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Get internal billing mode status
  app.get('/api/billing-pipeline/mode', authenticateUser, isPipelineViewer, async (req: any, res) => {
    res.json({ active: internalBillingModeActive, activatedBy: internalBillingActivatedBy });
  });

  // FLAVIO-ONLY: Toggle internal billing mode ON/OFF
  app.post('/api/billing-pipeline/mode', authenticateUser, isFlavioOnly, async (req: any, res) => {
    const { active } = req.body;
    const user = req.currentUser || req.user;
    internalBillingModeActive = !!active;
    internalBillingActivatedBy = active ? user.email : null;
    console.log(`🔄 [BILLING-PIPELINE] Modo faturamento interno ${internalBillingModeActive ? 'ATIVADO' : 'DESATIVADO'} por ${user.email}`);
    res.json({ active: internalBillingModeActive, activatedBy: internalBillingActivatedBy });
  });

  // Get all billing pipeline items (optionally filter by stage)
  app.get('/api/billing-pipeline', authenticateUser, isPipelineViewer, async (req: any, res) => {
    try {
      // Promove pedidos agendados vencidos antes de listar (throttle 60s para não custar a cada request).
      if (Date.now() - _lastScheduledPromoteAt > 60_000) {
        _lastScheduledPromoteAt = Date.now();
        await promoteDueScheduledOrders();
      }
      const stage = req.query.stage as string | undefined;
      const items = await storage.getBillingPipelineItems(stage ? { stage } : undefined);
      res.json(items);
    } catch (error: any) {
      console.error('❌ [BILLING-PIPELINE] Error fetching items:', error);
      res.status(500).json({ message: error.message });
    }
  });

  // Get single billing pipeline item
  app.get('/api/billing-pipeline/:id', authenticateUser, isPipelineViewer, async (req: any, res) => {
    try {
      const item = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: 'Item não encontrado' });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // FLAVIO-ONLY: Bypass order from Omie to internal billing pipeline
  app.post('/api/billing-pipeline/bypass', authenticateUser, isFlavioOnly, async (req: any, res) => {
    try {
      const { salesCardId } = req.body;
      if (!salesCardId) {
        return res.status(400).json({ message: 'salesCardId é obrigatório' });
      }

      const card = await storage.getSalesCard(salesCardId);
      if (!card) {
        return res.status(404).json({ message: 'Pedido não encontrado' });
      }

      const existing = await storage.getBillingPipelineItems();
      const alreadyExists = existing.find(i => i.salesCardId === salesCardId);
      if (alreadyExists) {
        return res.status(409).json({ message: 'Pedido já está no pipeline de faturamento', item: alreadyExists });
      }

      const user = req.currentUser || req.user;
      const customer = card.customerId ? await storage.getCustomer(card.customerId) : null;
      const seller = card.sellerId ? await storage.getUser(card.sellerId) : null;

      let omieInstanceName = '';
      if (customer?.omieInstanceId) {
        const instance = await storage.getOmieInstance(customer.omieInstanceId);
        omieInstanceName = instance?.displayName || '';
      }

      const item = await storage.createBillingPipelineItem({
        salesCardId,
        customerId: card.customerId,
        customerName: customer?.fantasyName || customer?.name || 'Cliente desconhecido',
        customerDocument: customer?.cnpj || customer?.cpf || null,
        sellerId: card.sellerId || null,
        sellerName: seller ? `${seller.firstName || ''} ${seller.lastName || ''}`.trim() : null,
        stage: 'pedido',
        orderNumber: card.omieOrderId ? `WEB-${card.id.substring(0, 8)}` : null,
        saleValue: card.saleValue || null,
        paymentMethod: card.paymentMethod || null,
        operationType: card.operationType || null,
        products: card.products as any || null,
        notes: card.notes || null,
        omieInstanceId: customer?.omieInstanceId || null,
        omieInstanceName: omieInstanceName || null,
        stageHistory: [{
          stage: 'pedido',
          changedAt: nowBrazil().toISOString(),
          changedBy: user.email
        }],
        createdBy: user.email,
      });

      console.log(`✅ [BILLING-PIPELINE] Pedido ${salesCardId} bypassed para faturamento interno por ${user.email}`);

      res.json({ success: true, item });
    } catch (error: any) {
      console.error('❌ [BILLING-PIPELINE] Bypass error:', error);
      res.status(500).json({ message: error.message });
    }
  });

  // DUPLICAR PEDIDO: cria um NOVO item do pipeline (etapa 'pedido') copiando os dados do original.
  // ⚠️ Gera salesCardId e orderNumber NOVOS e ÚNICOS para que a cópia seja faturável como NF-e
  // INDEPENDENTE. A trava de idempotência (commit a0723fe) casa por sales_card_id/orderNumber — se o
  // duplicado reusasse os do original, o faturamento devolveria a NF já existente em vez de emitir outra.
  app.post('/api/billing-pipeline/:id/duplicate', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const original = await storage.getBillingPipelineItem(req.params.id);
      if (!original) return res.status(404).json({ message: 'Pedido não encontrado' });

      const user = req.currentUser || req.user;
      const newCardId = randomUUID();

      const dup = await storage.createBillingPipelineItem({
        salesCardId: newCardId,
        customerId: original.customerId,
        customerName: original.customerName,
        customerDocument: original.customerDocument || null,
        sellerId: original.sellerId || null,
        sellerName: original.sellerName || null,
        stage: 'pedido',
        orderNumber: `INT-${newCardId.substring(0, 8)}`,
        invoiceNumber: null,
        saleValue: original.saleValue || null,
        paymentMethod: original.paymentMethod || null,
        operationType: original.operationType || null,
        products: (original.products as any) || null,
        notes: `Duplicado de ${original.orderNumber || original.salesCardId || 'pedido'}${original.notes ? ' — ' + original.notes : ''}`,
        omieInstanceId: original.omieInstanceId || null,
        omieInstanceName: original.omieInstanceName || null,
        stageHistory: [{
          stage: 'pedido',
          changedAt: nowBrazil().toISOString(),
          changedBy: user?.email || 'system',
        }],
        createdBy: user?.email || null,
      });

      console.log(`📋 [BILLING-PIPELINE] Pedido ${original.id} duplicado → ${dup.id} (novo card ${newCardId}) por ${user?.email}`);
      res.json({ success: true, item: dup });
    } catch (error: any) {
      console.error('❌ [BILLING-PIPELINE] Duplicate error:', error);
      res.status(500).json({ message: error.message });
    }
  });

  // Move item to next/specific stage
  app.patch('/api/billing-pipeline/:id/stage', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { stage, scheduledBillingDate } = req.body;
      if (!stage || !BILLING_STAGES.includes(stage)) {
        return res.status(400).json({ message: `Stage inválido. Valores aceitos: ${BILLING_STAGES.join(', ')}` });
      }

      const item = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: 'Item não encontrado' });

      const user = req.currentUser || req.user;
      const history = (item.stageHistory as any[]) || [];
      history.push({
        stage,
        changedAt: nowBrazil().toISOString(),
        changedBy: user.email
      });

      let invoiceNumber = item.invoiceNumber;
      let fiscalInvoiceId: string | null = null;

      if (stage === 'faturado' && item.stage !== 'faturado') {
        const stockCheck = await validateStockForBilling(item);
        if (!stockCheck.valid) {
          const shortageDetails = stockCheck.shortages.map(s =>
            `• ${s.productName}: necessário ${s.required}, disponível ${s.available}`
          ).join('\n');
          console.log(`🚫 [BILLING-PIPELINE] Faturamento bloqueado para item ${req.params.id} - estoque insuficiente`);
          return res.status(400).json({
            message: 'Faturamento bloqueado: estoque insuficiente',
            stockError: true,
            shortages: stockCheck.shortages,
            details: `Os seguintes produtos não possuem estoque suficiente para faturamento:\n${shortageDetails}`,
          });
        }

        // Cadastro fiscal incompleto (sem UF/CEP) → barra antes de travar/baixar estoque/criar a nota.
        const fiscalCheck = await validateCustomerFiscalData(item);
        if (!fiscalCheck.valid) {
          console.log(`🚫 [BILLING-PIPELINE] Faturamento bloqueado para item ${req.params.id} - cadastro sem UF/CEP`);
          return res.status(400).json({ message: fiscalCheck.message, fiscalDataError: true, details: fiscalCheck.message });
        }

        // 🔒 TRAVA DE IDEMPOTÊNCIA (evita NF-e e baixa de estoque duplicadas em faturamento concorrente).
        // UPDATE atômico: só o 1º request que "reivindicar" o item (stage != faturado) prossegue; os demais param.
        const __claim: any = await db.execute(sql`UPDATE billing_pipeline SET stage = 'faturado', updated_at = now() WHERE id = ${req.params.id} AND stage <> 'faturado'`);
        if (((__claim?.rowCount ?? __claim?.rowsAffected ?? 0) as number) !== 1) {
          console.warn(`🔁 [BILLING-PIPELINE] Faturamento duplicado evitado para item ${req.params.id} (já faturado/em faturamento).`);
          return res.status(409).json({ message: 'Item já faturado ou em faturamento — NF-e duplicada evitada.', duplicatePrevented: true });
        }

        let lotMap: Record<string, string[]> = {};
        try {
          lotMap = await deductStockForBilling(item, user);
          console.log(`📦 [BILLING-PIPELINE] Baixa de estoque realizada para item ${req.params.id}`);
        } catch (stockError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao dar baixa no estoque:`, stockError.message);
        }

        try {
          const invoiceResult = await createInvoiceFromPipelineItem(item, user, lotMap);
          if (invoiceResult) {
            invoiceNumber = `NF-${invoiceResult.invoiceNumber}`;
            fiscalInvoiceId = invoiceResult.id;
            console.log(`📄 [BILLING-PIPELINE] NF-e #${invoiceResult.invoiceNumber} criada automaticamente para item ${req.params.id}`);
          }
        } catch (invoiceError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao criar NF-e automática:`, invoiceError.message);
        }

        try {
          await createReceivableFromPipelineItem(item, fiscalInvoiceId, user);
          console.log(`💰 [BILLING-PIPELINE] Conta a receber criada para item ${req.params.id}`);
        } catch (recError: any) {
          console.error(`❌ [BILLING-PIPELINE] Erro ao criar conta a receber:`, recError.message);
        }
      }

      const updateData: any = { stage, stageHistory: history };
      if (invoiceNumber) updateData.invoiceNumber = invoiceNumber;

      // "Faturar em" (scheduled_billing_date): ao mover o pedido para "Agendado" pela tela,
      // gravamos a data escolhida. Antes o /stage só gravava a etapa e a data ficava NULL
      // (card e detalhe mostravam "-"). Aceita 'YYYY-MM-DD'; vazio/invalido limpa a data.
      if (scheduledBillingDate !== undefined) {
        const __s = String(scheduledBillingDate || '').slice(0, 10);
        updateData.scheduledBillingDate = /^\d{4}-\d{2}-\d{2}$/.test(__s) ? new Date(`${__s}T12:00:00-03:00`) : null;
      }

      const updated = await storage.updateBillingPipelineItem(req.params.id, updateData);

      console.log(`📦 [BILLING-PIPELINE] Item ${req.params.id} movido para ${stage} por ${user.email}`);
      res.json({ ...updated, fiscalInvoiceId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Update item details (notes, invoice number, etc.)
  app.patch('/api/billing-pipeline/:id', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { notes, invoiceNumber, saleValue, paymentMethod, operationType, sellerId, sellerName, products, customerName, customerDocument, scheduledBillingDate } = req.body;
      const updates: any = {};
      if (notes !== undefined) updates.notes = notes;
      if (invoiceNumber !== undefined) updates.invoiceNumber = invoiceNumber;
      if (saleValue !== undefined) updates.saleValue = (saleValue === null || saleValue === '') ? null : String(saleValue);
      if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod || null;
      if (operationType !== undefined) updates.operationType = operationType || null;
      const _canSeller = canEditPedidoSeller(req.currentUser || req.user);
      if (sellerId !== undefined && _canSeller) updates.sellerId = sellerId || null;
      if (sellerName !== undefined && _canSeller) updates.sellerName = sellerName || null;
      if (products !== undefined) {
        updates.products = products;
        // Valor Total = soma dos produtos (fonte da verdade). Ao duplicar e editar um
        // pedido, o total ficava defasado (mantinha o valor do pedido original). Aqui
        // recalculamos sempre que os produtos mudam, para o total (e a NF) baterem com os itens.
        if (Array.isArray(products)) {
          const _sum = products.reduce((t: number, p: any) => {
            const line = (p && p.totalPrice != null && String(p.totalPrice) !== '')
              ? parseFloat(String(p.totalPrice))
              : (parseFloat(String(p?.quantity ?? 0)) || 0) * (parseFloat(String(p?.unitPrice ?? 0)) || 0);
            return t + (isNaN(line) ? 0 : line);
          }, 0);
          updates.saleValue = _sum.toFixed(2);
        }
      }
      if (customerName !== undefined) updates.customerName = customerName;
      if (customerDocument !== undefined) updates.customerDocument = customerDocument;

      // "Faturar em" (scheduled_billing_date): data em que o pedido deve seguir para a etapa
      // "Pedido". Editavel no pipeline. Reavalia a etapa entre 'agendado'/'pedido':
      //  - data futura           -> volta/permanece em 'agendado' (aguarda a data)
      //  - data <= hoje ou vazia  -> segue para 'pedido' agora
      // (nao mexe em pedidos ja adiante no funil: a_faturar, faturado, etc.)
      if (scheduledBillingDate !== undefined) {
        const s = String(scheduledBillingDate || '').slice(0, 10);
        const valid = /^\d{4}-\d{2}-\d{2}$/.test(s);
        const todayBR = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
        updates.scheduledBillingDate = valid ? new Date(`${s}T12:00:00-03:00`) : null;
        const current = await storage.getBillingPipelineItem(req.params.id);
        if (current && (current.stage === 'agendado' || current.stage === 'pedido')) {
          const newStage = (valid && s > todayBR) ? 'agendado' : 'pedido';
          if (newStage !== current.stage) {
            updates.stage = newStage as any;
            const hist = Array.isArray((current as any).stageHistory) ? (current as any).stageHistory : [];
            updates.stageHistory = [...hist, { stage: newStage, changedAt: new Date().toISOString(), changedBy: (req.currentUser?.email || 'pipeline-edit') }] as any;
          }
        }
      }

      const updated = await storage.updateBillingPipelineItem(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Delete item from pipeline
  app.delete('/api/billing-pipeline/:id', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      await ensureLixeiraStage();
      // Soft-delete: move para a Lixeira (nunca apaga a linha). Restauravel.
      await storage.deleteBillingPipelineItem(req.params.id);
      res.json({ success: true, movedTo: 'lixeira' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Restaurar um card da LIXEIRA de volta para a etapa que ele tinha antes de ser
  // excluido (ou 'pedido' como padrao). UPDATE direto -> NAO re-dispara faturamento/NF.
  app.post('/api/billing-pipeline/:id/restore', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      await ensureLixeiraStage();
      const item: any = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ message: 'Item não encontrado' });
      if (item.stage !== 'lixeira') return res.status(400).json({ message: 'Item não está na Lixeira' });
      const hist = (item.stageHistory as any[]) || [];
      let prev = 'pedido';
      for (let i = hist.length - 1; i >= 0; i--) {
        const s = hist[i]?.stage;
        if (s && s !== 'lixeira') { prev = s; break; }
      }
      if (!(BILLING_STAGES as readonly string[]).includes(prev) || prev === 'lixeira') prev = 'pedido';
      const user = req.currentUser || req.user;
      const newHist = [...hist, { stage: prev, changedAt: nowBrazil().toISOString(), changedBy: `${user?.email || 'sistema'} (restaurado da lixeira)` }];
      await db.execute(sql`
        UPDATE billing_pipeline
        SET stage = ${prev}::billing_pipeline_stage, updated_at = now(), stage_history = ${JSON.stringify(newHist)}::jsonb
        WHERE id = ${req.params.id}`);
      res.json({ ok: true, restoredTo: prev });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Batch move items to a stage
  app.post('/api/billing-pipeline/batch/stage', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { ids, stage } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'ids é obrigatório (array)' });
      }
      if (!stage || !BILLING_STAGES.includes(stage)) {
        return res.status(400).json({ message: `Stage inválido. Valores aceitos: ${BILLING_STAGES.join(', ')}` });
      }

      const user = req.currentUser || req.user;
      const results: Array<{ id: string; success: boolean; fiscalInvoiceId?: string; error?: string }> = [];

      for (const id of ids) {
        try {
          const item = await storage.getBillingPipelineItem(id);
          if (!item) {
            results.push({ id, success: false, error: 'Item não encontrado' });
            continue;
          }

          const history = (item.stageHistory as any[]) || [];
          history.push({
            stage,
            changedAt: nowBrazil().toISOString(),
            changedBy: user.email
          });

          let invoiceNumber = item.invoiceNumber;
          let fiscalInvoiceId: string | undefined;

          if (stage === 'faturado' && item.stage !== 'faturado') {
            // Cadastro fiscal incompleto (sem UF/CEP) → não fatura este item.
            const fiscalCheck = await validateCustomerFiscalData(item);
            if (!fiscalCheck.valid) {
              results.push({ id, success: false, error: fiscalCheck.message });
              continue;
            }
            // 🔒 TRAVA DE IDEMPOTÊNCIA (claim atômico) — evita NF-e/estoque duplicados em faturamento concorrente.
            const __claim: any = await db.execute(sql`UPDATE billing_pipeline SET stage = 'faturado', updated_at = now() WHERE id = ${id} AND stage <> 'faturado'`);
            if (((__claim?.rowCount ?? __claim?.rowsAffected ?? 0) as number) !== 1) {
              console.warn(`🔁 [BATCH] Faturamento duplicado evitado para item ${id}.`);
              results.push({ id, success: false, error: 'Já faturado — NF-e duplicada evitada' });
              continue;
            }
            let lotMap: Record<string, string[]> = {};
            try {
              lotMap = await deductStockForBilling(item, user);
            } catch (stockError: any) {
              console.error(`❌ [BATCH] Erro baixa estoque para ${id}:`, stockError.message);
            }

            try {
              const invoiceResult = await createInvoiceFromPipelineItem(item, user, lotMap);
              if (invoiceResult) {
                invoiceNumber = `NF-${invoiceResult.invoiceNumber}`;
                fiscalInvoiceId = invoiceResult.id;
              }
            } catch (invoiceError: any) {
              console.error(`❌ [BATCH] Erro NF-e para ${id}:`, invoiceError.message);
            }

            try {
              await createReceivableFromPipelineItem(item, fiscalInvoiceId || null, user);
            } catch (recError: any) {
              console.error(`❌ [BATCH] Erro conta a receber para ${id}:`, recError.message);
            }
          }

          const updateData: any = { stage, stageHistory: history };
          if (invoiceNumber) updateData.invoiceNumber = invoiceNumber;

          await storage.updateBillingPipelineItem(id, updateData);
          results.push({ id, success: true, fiscalInvoiceId });
        } catch (err: any) {
          results.push({ id, success: false, error: err.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      console.log(`📦 [BATCH] ${successCount}/${ids.length} itens movidos para ${stage} por ${user.email}`);
      res.json({ results, successCount, totalCount: ids.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Batch delete items
  // RE-TENTAR FATURAMENTO: re-transmite a MESMA NF (rascunho/rejeitada) do item — NÃO cria outra (evita duplicata).
  // Usado pelo botão do card vermelho quando a emissão falhou e o problema foi sanado.
  app.post('/api/billing-pipeline/:id/retry-invoice', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const item = await storage.getBillingPipelineItem(req.params.id);
      if (!item) return res.status(404).json({ success: false, message: 'Item não encontrado' });
      const user = req.currentUser || req.user;
      const { sefazService } = await import('./sefaz-service.js');

      // Localiza a NF do item de forma A PROVA DE COLISAO. O numero da NF-e SE REPETE entre
      // emitentes/clientes (e ate e reaproveitado apos uma emissao que falhou), entao NUNCA
      // casar so por numero: (1) sales_card_id COMPLETO; (2) numero + MESMO cliente; (3) ref por notes.
      const numRef = String(item.invoiceNumber || '').replace(/\D/g, '');
      let nf: any = null;
      if (item.salesCardId) {
        const byCard: any = await db.execute(sql`SELECT id, status FROM fiscal_invoices WHERE sales_card_id = ${item.salesCardId} AND status <> 'cancelled' AND status <> 'cancelada' ORDER BY created_at DESC LIMIT 1`);
        nf = (byCard?.rows ?? byCard ?? [])[0] || null;
      }
      if (!nf && numRef && item.customerId) {
        const byNum: any = await db.execute(sql`SELECT id, status FROM fiscal_invoices WHERE invoice_number = ${Number(numRef)} AND customer_id = ${item.customerId} AND status <> 'cancelled' AND status <> 'cancelada' ORDER BY created_at DESC LIMIT 1`);
        nf = (byNum?.rows ?? byNum ?? [])[0] || null;
      }
      if (!nf && !item.salesCardId && item.orderNumber) {
        const byRef: any = await db.execute(sql`SELECT id, status FROM fiscal_invoices WHERE notes = ${'Pedido pipeline interno - ' + item.orderNumber} AND sales_card_id IS NULL AND status <> 'cancelled' AND status <> 'cancelada' ORDER BY created_at DESC LIMIT 1`);
        nf = (byRef?.rows ?? byRef ?? [])[0] || null;
      }

      // Sem NF nenhuma → o faturamento falhou antes de criar a nota: cria + emite (dedup interno evita duplicar).
      if (!nf) {
        const created: any = await createInvoiceFromPipelineItem(item, user);
        if (created?.invoiceNumber) await storage.updateBillingPipelineItem(item.id, { invoiceNumber: `NF-${created.invoiceNumber}` });
        const chk: any = await db.execute(sql`SELECT status FROM fiscal_invoices WHERE id = ${created.id} LIMIT 1`);
        const st = (chk?.rows ?? chk ?? [])[0]?.status;
        if (st === 'authorized') return res.json({ success: true, invoiceNumber: created.invoiceNumber });
        return res.status(422).json({ success: false, message: 'NF-e criada mas ainda não autorizada — verifique o cadastro do cliente e tente de novo.' });
      }

      if (String(nf.status) === 'authorized') {
        return res.json({ success: true, already: true, message: 'NF-e já está autorizada.' });
      }

      // 🔄 REFRESH do destinatário: a NF guardou os dados no momento da emissão (IE/UF podiam estar vazios).
      // Antes de re-transmitir, atualiza IE/UF/endereço a partir do CADASTRO ATUAL do cliente
      // (casa por DOCUMENTO da nota p/ pegar a unidade certa; fallback customerId). Sem isso, corrigir o
      // cadastro não surtia efeito e a SEFAZ rejeitava de novo (ex.: "IE do destinatário não informada").
      try {
        const nfFull: any = await storage.getFiscalInvoice(nf.id);
        const digits = (v: any) => String(v || '').replace(/\D/g, '');
        let cust: any = null;
        const nfDoc = digits(nfFull?.customerCnpjCpf);
        if (nfDoc.length >= 11) cust = await storage.getCustomerByDocument(nfDoc);
        if (!cust && nfFull?.customerId) cust = await storage.getCustomer(nfFull.customerId);
        if (!cust && item.customerId) cust = await storage.getCustomer(item.customerId);
        if (cust) {
          const ie = (cust as any).stateRegistration || (cust as any).state_registration || '';
          const upd: any = {};
          if (ie) upd.customerIe = ie;
          if ((cust as any).state) upd.customerUf = (cust as any).state;
          if ((cust as any).zipCode) upd.customerCep = (cust as any).zipCode;
          if ((cust as any).address) upd.customerAddress = (cust as any).address;
          if ((cust as any).city) upd.customerCity = (cust as any).city;
          if ((cust as any).neighborhood) upd.customerBairro = (cust as any).neighborhood;
          if ((cust as any).phone) upd.customerPhone = (cust as any).phone;
          if (Object.keys(upd).length) { await storage.updateFiscalInvoice(nf.id, upd); console.log(`[RETRY-NFE] destinatário atualizado da NF ${nf.id}:`, Object.keys(upd).join(',')); }
        }
      } catch (e: any) { console.warn('[RETRY-NFE] falha ao atualizar destinatário (segue):', e?.message); }

      // Re-transmite a MESMA NF (draft/rejected).
      const emitRes: any = await sefazService.emitNfe(nf.id);
      if (emitRes?.success) return res.json({ success: true });

      // Falha na re-transmissao (ex.: numero DUPLICADO / 539 por reaproveitamento apos uma
      // emissao que falhou — o numero ja foi autorizado para OUTRA nota). Emite uma NF-e NOVA
      // com numero atomico livre. createInvoiceFromPipelineItem tem dedup por sales_card_id e
      // ja transmite a SEFAZ; so cria nova quando NAO ha NF (nao-cancelada) com este card
      // (o createdNew.id !== nf.id evita reprocessar a mesma nota).
      try {
        const createdNew: any = await createInvoiceFromPipelineItem(item, user);
        if (createdNew?.id && createdNew.id !== nf.id) {
          if (createdNew?.invoiceNumber) await storage.updateBillingPipelineItem(item.id, { invoiceNumber: `NF-${createdNew.invoiceNumber}` });
          const chk2: any = await db.execute(sql`SELECT status FROM fiscal_invoices WHERE id = ${createdNew.id} LIMIT 1`);
          const st2 = (chk2?.rows ?? chk2 ?? [])[0]?.status;
          if (st2 === 'authorized') return res.json({ success: true, invoiceNumber: createdNew.invoiceNumber, reissued: true });
        }
      } catch (e: any) { console.warn('[RETRY-NFE] falha ao reemitir NF nova:', e?.message); }
      return res.status(422).json({ success: false, message: emitRes?.errorMessage || 'Falha ao transmitir a NF-e.' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/billing-pipeline/batch/delete', authenticateUser, isAdminOnly, async (req: any, res) => {
    try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: 'ids é obrigatório (array)' });
      }

      let successCount = 0;
      for (const id of ids) {
        try {
          await storage.deleteBillingPipelineItem(id);
          successCount++;
        } catch (err: any) {
          console.error(`❌ [BATCH-DELETE] Erro ao remover ${id}:`, err.message);
        }
      }

      const user = req.currentUser || req.user;
      console.log(`🗑️ [BATCH] ${successCount}/${ids.length} itens removidos por ${user?.email}`);
      res.json({ successCount, totalCount: ids.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

async function validateStockForBilling(item: any): Promise<{ valid: boolean; shortages: Array<{ productId: string; productName: string; required: number; available: number }> }> {
  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (!products || products.length === 0) return { valid: true, shortages: [] };

  const instanceId = item.omieInstanceId;
  if (!instanceId) return { valid: true, shortages: [] };

  const shortages: Array<{ productId: string; productName: string; required: number; available: number }> = [];

  for (const product of products) {
    if (!product.id) continue;

    const lots = await storage.getInventoryLots({
      productId: product.id,
      instanceId,
      stockType: 'in_use',
      isActive: true,
    });

    let totalAvailable = 0;
    for (const lot of lots) {
      const qty = parseFloat(lot.quantity?.toString() || '0');
      if (qty > 0) totalAvailable += qty;
    }

    if (totalAvailable < product.quantity) {
      shortages.push({
        productId: product.id,
        productName: product.name,
        required: product.quantity,
        available: totalAvailable,
      });
    }
  }

  return { valid: shortages.length === 0, shortages };
}

async function deductStockForBilling(item: any, user: any): Promise<Record<string, string[]>> {
  const lotMap: Record<string, string[]> = {};
  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (!products || products.length === 0) return lotMap;

  const instanceId = item.omieInstanceId;
  if (!instanceId) {
    console.log(`⚠️ [STOCK] Item ${item.id} sem omieInstanceId, não é possível dar baixa no estoque`);
    return lotMap;
  }

  for (const product of products) {
    if (!product.id) continue;

    const lots = await storage.getInventoryLots({
      productId: product.id,
      instanceId,
      stockType: 'in_use',
      isActive: true,
    });

    if (lots.length === 0) {
      console.log(`⚠️ [STOCK] Produto ${product.name} (${product.id}) sem lotes disponíveis na instância ${instanceId}`);
      continue;
    }

    let remaining = product.quantity;
    const consumedLots: string[] = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      const currentQty = parseFloat(lot.quantity?.toString() || '0');
      if (currentQty <= 0) continue;

      const deductQty = Math.min(remaining, currentQty);
      const newQty = currentQty - deductQty;

      await storage.updateInventoryLot(lot.id, {
        quantity: newQty.toFixed(4),
      });

      await storage.createInventoryMovement({
        lotId: lot.id,
        productId: product.id,
        instanceId,
        movementType: 'consume',
        quantity: deductQty.toFixed(4),
        previousQuantity: currentQty.toFixed(4),
        newQuantity: newQty.toFixed(4),
        sourceType: 'invoice',
        sourceId: item.id,
        lotNumber: lot.lotNumber,
        notes: `Baixa automática - Faturamento ${item.orderNumber || item.salesCardId} - ${product.name}`,
        createdBy: user?.email || null,
      });

      if (lot.lotNumber) {
        consumedLots.push(lot.lotNumber);
      }

      remaining -= deductQty;
      console.log(`📦 [STOCK] Baixa: ${deductQty} un de "${product.name}" do lote ${lot.lotNumber} (${currentQty} → ${newQty})`);
    }

    if (consumedLots.length > 0) {
      lotMap[product.id] = consumedLots;
    }

    if (remaining > 0) {
      console.log(`⚠️ [STOCK] Estoque insuficiente: faltam ${remaining} un de "${product.name}" na instância ${instanceId}`);
    }
  }

  return lotMap;
}

async function createInvoiceFromPipelineItem(item: any, user: any, lotMap?: Record<string, string[]>) {
  // 🔁 IDEMPOTÊNCIA: se já existe NF-e (não cancelada) para o MESMO pedido do pipeline, não cria outra.
  // ⚠️ CHAVE À PROVA DE COLISÃO: casa pelo sales_card_id COMPLETO. O ref textual do pedido
  //    (orderNumber = 'INT-<8 hex>') TRUNCA o UUID em 8 caracteres e COLIDE entre cartões distintos
  //    → um pedido de um cliente acabava vinculado à NF de OUTRO cliente (mesmo 'INT-xxxxxxxx').
  //    Só cai no ref por notes quando o item não tem salesCardId (e restringe a NFs sem card).
  try {
    let __row: any = null;
    if (item.salesCardId) {
      const __ex: any = await db.execute(sql`SELECT id, invoice_number FROM fiscal_invoices WHERE sales_card_id = ${item.salesCardId} AND status <> 'cancelled' AND status <> 'cancelada' ORDER BY created_at DESC LIMIT 1`);
      __row = (__ex?.rows ?? __ex ?? [])[0];
    } else if (item.orderNumber) {
      const __ex: any = await db.execute(sql`SELECT id, invoice_number FROM fiscal_invoices WHERE notes = ${'Pedido pipeline interno - ' + item.orderNumber} AND sales_card_id IS NULL AND status <> 'cancelled' AND status <> 'cancelada' ORDER BY created_at DESC LIMIT 1`);
      __row = (__ex?.rows ?? __ex ?? [])[0];
    }
    if (__row && __row.id) {
      console.warn('[NFE-DEDUP] NF-e já existe p/ pedido (card ' + (item.salesCardId || item.orderNumber) + ', id ' + __row.id + ') — emissão duplicada evitada.');
      return { id: __row.id, invoiceNumber: __row.invoice_number };
    }
  } catch (e: any) { console.warn('[NFE-DEDUP] falha ao checar duplicata (segue):', e?.message); }
  const customer = item.customerId ? await storage.getCustomer(item.customerId) : null;

  let issuerName = '', issuerCnpj = '', issuerIe = '', issuerAddress = '', issuerUf = '', issuerCityCode = '', issuerCity = '', issuerPhone = '';

  if (item.omieInstanceId) {
    const instance = await storage.getOmieInstance(item.omieInstanceId);
    if (instance && INSTANCE_COMPANY_DATA[instance.name]) {
      const cd = INSTANCE_COMPANY_DATA[instance.name];
      issuerName = cd.name;
      issuerCnpj = cd.cnpj;
      issuerIe = cd.ie;
      issuerAddress = cd.address;
      issuerUf = cd.uf;
      issuerCityCode = cd.cityCode;
      issuerCity = cd.city;
      issuerPhone = cd.phone;
    }
  }

  if (!issuerName) {
    const cd = INSTANCE_COMPANY_DATA['GYN'];
    issuerName = cd.name;
    issuerCnpj = cd.cnpj;
    issuerIe = cd.ie;
    issuerAddress = cd.address;
    issuerUf = cd.uf;
    issuerCityCode = cd.cityCode;
    issuerCity = cd.city;
    issuerPhone = cd.phone;
  }

  const customerUf = customer?.state || 'GO';
  const isWithinState = issuerUf === customerUf;
  const operationType = item.operationType || 'venda';

  let cfop = isWithinState ? '5102' : '6102';
  let natureOfOperation = 'Venda de mercadoria';
  let fiscalScenarioId: string | null = null;
  if (operationType === 'bonificacao') {
    cfop = isWithinState ? '5910' : '6910';
    natureOfOperation = 'Bonificação';
  } else if (operationType === 'troca') {
    cfop = isWithinState ? '5949' : '6949';
    natureOfOperation = 'Troca de mercadoria';
  } else if (operationType === 'amostra') {
    cfop = isWithinState ? '5911' : '6911';
    natureOfOperation = 'Amostra grátis';
  } else if (operationType === 'transferencia') {
    // Transferência entre filiais: usa o CENÁRIO FISCAL de transferência
    // (CFOP/CST/natureza configurados em Cenários Fiscais), preferindo o cenário
    // da instância emitente. A NF é criada como rascunho para conferência antes de emitir.
    natureOfOperation = 'Transferência de mercadoria';
    cfop = isWithinState ? '5152' : '6152';
    try {
      const _scen = await storage.getFiscalScenarios();
      const _inst = item.omieInstanceId || null;
      const _t = (_scen || []).find((s: any) => s.operationType === 'transferencia' && _inst && s.omieInstanceId === _inst)
              || (_scen || []).find((s: any) => s.operationType === 'transferencia');
      if (_t) {
        fiscalScenarioId = _t.id;
        if (_t.cfop) cfop = _t.cfop;
        if (_t.natureOfOperation) natureOfOperation = _t.natureOfOperation;
      }
    } catch { /* mantém CFOP/natureza padrão de transferência */ }
  }

  // BSB (CNPJ 28295493000315, filial DF, Simples Nacional sob ST): a VENDA
  // onerosa sai como contribuinte SUBSTITUIDO - CFOP 5405 (interno DF) / 6404
  // (interestadual) e CSOSN 500 (ICMS-ST ja recolhido). Espelha a regra de
  // bsbStSaleOverride() do sefaz-service para o registro salvo + DANFE nascerem
  // iguais ao XML. So afeta a venda padrao (5102/6102); bonificacao/amostra/
  // troca/transferencia mantem o CFOP proprio.
  const _isBsbIssuer = String(issuerCnpj || '').replace(/\D/g, '') === '28295493000315';
  if (_isBsbIssuer && /^[56]102$/.test(cfop)) {
    cfop = isWithinState ? '5405' : '6404';
  }

  const totalValue = item.saleValue ? parseFloat(item.saleValue) : 0;

  // Ambiente de emissao POR CNPJ EMITENTE (system_settings fiscal_env_<instanceId>).
  // ANTES estava fixo 'homologacao' -> NF do pipeline saia SEM VALOR FISCAL mesmo com o CNPJ em producao.
  // Resolve a instancia pelo omieInstanceId do item ou, se vazio, pelo CNPJ do emitente
  // (quando o cliente nao tem instancia, o emitente cai no fallback GYN). Default homologacao.
  let invEnv: 'homologacao' | 'producao' = 'homologacao';
  try {
    const __settings = await storage.getSystemSettings();
    const __instances = await storage.getOmieInstances();
    const __issuerDigits = String(issuerCnpj || '').replace(/\D/g, '');
    let __inst: any = item.omieInstanceId ? __instances.find((i: any) => i.id === item.omieInstanceId) : null;
    if (!__inst) __inst = __instances.find((i: any) => String(i.cnpj || '').replace(/\D/g, '') === __issuerDigits);
    const __v = __inst ? (__settings || []).find((x: any) => x.key === 'fiscal_env_' + __inst.id)?.value : null;
    if (__v && String(__v).replace(/\"/g, '') === 'producao') invEnv = 'producao';
  } catch {}

  const invoice = await storage.createFiscalInvoiceAtomic({
    series: '1',
    status: 'draft',
    operationType: 'saida',
    issuerName,
    issuerCnpj,
    issuerIe,
    issuerAddress,
    issuerUf,
    issuerCityCode,
    issuerCity,
    issuerPhone,
    customerId: item.customerId || null,
    customerName: item.customerName || '',
    customerCnpjCpf: item.customerDocument || customer?.cnpj || customer?.cpf || '',
    customerIe: (customer as any)?.stateRegistration || (customer as any)?.state_registration || (customer as any)?.ie || '',
    customerAddress: customer?.address || '',
    customerBairro: customer?.neighborhood || '',
    customerCep: customer?.zipCode || '',
    customerCity: customer?.city || '',
    customerUf: customer?.state || '',
    customerPhone: customer?.phone || '',
    natureOfOperation,
    cfop,
    fiscalScenarioId,
    totalProducts: totalValue.toFixed(2),
    totalInvoice: totalValue.toFixed(2),
    paymentMethod: item.paymentMethod || 'a_vista',
    salesCardId: item.salesCardId || null,
    notes: `Pedido pipeline interno - ${item.orderNumber || item.salesCardId}`,
    emissionDate: nowBrazil(),
    environment: invEnv,
    omieInstanceId: item.omieInstanceId || null,
    createdBy: user?.email || null,
  }, '1', issuerCnpj);

  // CSOSN do cliente (Simples): padrao '102'; '101' se marcado no cadastro. pCredSN (p/ 101) vem de system_settings 'fiscal_pcredsn'.
  // BSB sob ST -> CSOSN 500 (ICMS cobrado anteriormente por ST); demais
  // instancias seguem o padrao Simples: '102' (ou '101' com credito).
  const custCsosn = _isBsbIssuer ? '500' : (((customer as any)?.icmsCsosn === '101') ? '101' : '102');
  let custPcred = '0';
  if (custCsosn === '101') {
    try {
      const settings = await storage.getSystemSettings();
      const v = (settings || []).find((x: any) => x.key === 'fiscal_pcredsn')?.value;
      if (v) custPcred = String(v).replace(/"/g, '');
    } catch {}
  }

  const products = item.products as Array<{ id?: string; name: string; quantity: number; unitPrice: number; totalPrice: number }> | null;
  if (products && products.length > 0) {
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      let productCode = `PROD-${i + 1}`;
      if (p.id) {
        const productData = await storage.getProduct(p.id);
        if (productData) {
          productCode = (productData as any).omieCode || (productData as any).omieCodigo || `PROD-${i + 1}`;
        }
      }
      let productName = p.name;
      if (lotMap && p.id && lotMap[p.id] && lotMap[p.id].length > 0) {
        const lotNumbers = lotMap[p.id].join(', ');
        productName = `${p.name} - Lote: ${lotNumbers}`;
      }
      await storage.createFiscalInvoiceItem({
        invoiceId: invoice.id,
        itemNumber: i + 1,
        productName,
        productCode,
        productId: p.id || null,
        ncm: '22029000',
        cfop,
        unit: 'UN',
        quantity: p.quantity.toString(),
        unitPrice: p.unitPrice.toString(),
        totalPrice: p.totalPrice.toString(),
        discount: '0',
        csosn: custCsosn,
        aliqIcms: custPcred,
      });
    }
  }

  await storage.createFiscalInvoiceEvent({
    invoiceId: invoice.id,
    eventType: 'criacao',
    status: 'success',
    description: `NF-e #${invoice.invoiceNumber} criada automaticamente via pipeline de faturamento interno`,
    createdBy: user?.email || null,
  });

  // AUTO-EMISSAO: transmite a NF-e para a SEFAZ (autoriza) logo apos criar o rascunho.
  // Sem isto a NF fica em 'draft' (Rascunho) e NAO tem valor fiscal. Robusto: falha nao bloqueia
  // o faturamento (a NF fica em rascunho e pode ser transmitida manualmente pelo botao Transmitir).
  try {
    const { sefazService } = await import('./sefaz-service.js');
    const emitRes = await sefazService.emitNfe(invoice.id);
    if (emitRes?.success) {
      console.log(`[NFE-AUTO] NF-e #${invoice.invoiceNumber} AUTORIZADA automaticamente (${invEnv})`);
    } else {
      console.warn(`[NFE-AUTO] NF-e #${invoice.invoiceNumber} nao autorizada (fica em rascunho): ${emitRes?.errorCode || ''} ${emitRes?.errorMessage || ''}`);
    }
  } catch (e: any) {
    console.warn(`[NFE-AUTO] erro ao transmitir NF-e #${invoice.invoiceNumber} (fica em rascunho):`, e?.message);
  }

  return invoice;
}


// Hook boleto BB: gera boleto p/ um recebivel de faturamento.
// Gated por bbBoletoEnabled na conta financeira; default HOMOLOGACAO (BB_BOLETO_SANDBOX).
// Fire-and-forget: nunca lanca, nunca bloqueia o faturamento.
export async function generateBoletoForReceivable(receivable: any, item: any): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  try {
    // [06/jul] SERV (PURO SERVIÇOS, CNPJ ...0105) NÃO emite boleto por decisão — não cair no fallback do IND.
    // GYN e BSB seguem no fallback do IND (intencional). Guard robusto a tag ("SERV") ou UUID da instância.
    try {
      const _ref = String(item.omieInstanceId || '');
      const _nm = String(item.omieInstanceName || '').toUpperCase();
      let _serv = _nm === 'SERV' || _ref.toUpperCase() === 'SERV';
      if (!_serv && _ref && /^[0-9a-f-]{30,}$/i.test(_ref)) {
        const _inst = await storage.getOmieInstance(_ref);
        const _c = String((_inst as any)?.cnpj || '').replace(/\D/g, '');
        if (_c === '52921727000105' || String((_inst as any)?.name || '').toUpperCase() === 'SERV') _serv = true;
      }
      if (_serv) { console.log('[BB-BOLETO] SERV nao emite boleto (decisao 06/jul) - skip'); return { ok: false, skipped: true }; }
    } catch {}
    let accounts = await storage.getFinancialAccounts(item.omieInstanceId || undefined);
    let account = (accounts || []).find((a: any) => a.bbBoletoEnabled && a.bbConvenio);
    if (!account) {
      const all = await storage.getFinancialAccounts();
      account = (all || []).find((a: any) => a.bbBoletoEnabled && a.bbConvenio);
    }
    if (!account) return { ok: false, skipped: true }; // nenhuma conta com boleto BB habilitado -> no-op silencioso
    let customer: any = null;
    try { if (item.customerId) customer = await storage.getCustomer(item.customerId); } catch {}
    // Desconto de cobranca (%) do cadastro do cliente -> desconto ate o vencimento no boleto.
    // customers.collection_discount nao esta no schema drizzle; busca via SQL cru.
    let descontoPct = 0;
    try {
      const cid = receivable.customerId || item.customerId;
      if (cid) { const dq: any = await db.execute(sql`SELECT collection_discount FROM customers WHERE id = ${cid} LIMIT 1`); descontoPct = parseFloat(String((dq?.rows ?? dq ?? [])[0]?.collection_discount ?? '0')) || 0; }
    } catch {}
    const r = await registrarBoleto(account.id, {
      amount: parseFloat(receivable.amount),
      dueDate: receivable.dueDate ? new Date(receivable.dueDate) : new Date(Date.now() + 30 * 864e5),
      debtorName: receivable.customerName || customer?.name || 'Cliente',
      debtorDocument: receivable.customerDocument || customer?.cnpj || customer?.cpf || '',
      debtorAddress: customer?.address,
      debtorCity: customer?.city,
      debtorNeighborhood: customer?.neighborhood,
      debtorState: customer?.state,
      debtorZip: customer?.zipCode,
      receivableId: receivable.id,
      fiscalInvoiceId: receivable.fiscalInvoiceId,
      customerId: receivable.customerId,
      billingPipelineId: item.id,
      descontoPct,
    });
    if (r.success) console.log(`[BB-BOLETO] hook: boleto gerado p/ receivable ${receivable.id} (${r.sandbox ? 'homolog' : 'PRODUCAO'})`);
    else console.warn(`[BB-BOLETO] hook: nao gerou boleto (${r.error})`);
    return r.success ? { ok: true } : { ok: false, error: r.error };
  } catch (e: any) {
    console.warn('[BB-BOLETO] hook erro (ignorado):', e?.message);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Hook PIX BB: gera cobranca PIX para um recebivel de faturamento (forma pix ou a vista).
// Gated por bbPixEnabled+pixKey na conta; fire-and-forget: nunca lanca, nunca bloqueia o faturamento.
export async function generatePixForReceivable(receivable: any, item: any): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  try {
    // [06/jul] SERV (PURO SERVIÇOS, CNPJ ...0105) NÃO emite PIX por decisão — não cair no fallback do IND.
    // GYN e BSB seguem no fallback do IND (intencional). Guard robusto a tag ("SERV") ou UUID da instância.
    try {
      const _ref = String(item.omieInstanceId || '');
      const _nm = String(item.omieInstanceName || '').toUpperCase();
      let _serv = _nm === 'SERV' || _ref.toUpperCase() === 'SERV';
      if (!_serv && _ref && /^[0-9a-f-]{30,}$/i.test(_ref)) {
        const _inst = await storage.getOmieInstance(_ref);
        const _c = String((_inst as any)?.cnpj || '').replace(/\D/g, '');
        if (_c === '52921727000105' || String((_inst as any)?.name || '').toUpperCase() === 'SERV') _serv = true;
      }
      if (_serv) { console.log('[BB-PIX] SERV nao emite PIX (decisao 06/jul) - skip'); return { ok: false, skipped: true }; }
    } catch {}
    let accounts = await storage.getFinancialAccounts(item.omieInstanceId || undefined);
    let account = (accounts || []).find((a: any) => a.bbPixEnabled && a.pixKey);
    if (!account) {
      const all = await storage.getFinancialAccounts();
      account = (all || []).find((a: any) => a.bbPixEnabled && a.pixKey);
    }
    if (!account) return { ok: false, skipped: true }; // nenhuma conta com PIX BB habilitado -> no-op silencioso
    let customer: any = null;
    try { if (item.customerId) customer = await storage.getCustomer(item.customerId); } catch {}
    const r = await createImmediateCharge(account.id, {
      amount: parseFloat(receivable.amount),
      debtorName: receivable.customerName || customer?.name || 'Cliente',
      debtorDocument: receivable.customerDocument || customer?.cnpj || customer?.cpf || undefined,
      description: `Pedido ${item.orderNumber || item.salesCardId || ''}`.trim(),
      expirationSeconds: Math.max(259200, Math.round((new Date(receivable.dueDate).getTime() - Date.now()) / 1000)), // min 3 DIAS (a vista vencia em 1h e o cliente nao conseguia pagar), ou ate o vencimento se for maior
      receivableId: receivable.id,
      customerId: receivable.customerId || undefined,
      createdBy: 'auto-faturamento',
    });
    if (r) console.log(`[BB-PIX] hook: cobranca PIX gerada p/ receivable ${receivable.id} (txid ${r.txid})`);
    return r ? { ok: true } : { ok: false, error: 'sem retorno do PIX' };
  } catch (e: any) {
    console.warn('[BB-PIX] hook erro (ignorado):', e?.message);
    return { ok: false, error: e?.message || String(e) };
  }
}

// FASE 2 - Classificacao DRE automatica: vendas do pipeline entram na conta-filha de
// Receita Bruta (dre_group='receita_bruta', code com ponto, ex: 1.1). Cache de 60s.
let __revAccCache: { id: string | null; at: number } = { id: null, at: 0 };
export async function resolveRevenueChartAccountId(): Promise<string | null> {
  const now = Date.now();
  if (now - __revAccCache.at < 60000 && __revAccCache.id) return __revAccCache.id;
  try {
    const q: any = await db.execute(sql`SELECT id FROM chart_of_accounts WHERE dre_group = 'receita_bruta' AND code LIKE '%.%' AND is_active = true ORDER BY code LIMIT 1`);
    const id = (q as any).rows?.[0]?.id || null;
    __revAccCache = { id, at: now };
    return id;
  } catch { return __revAccCache.id; }
}

// Cronograma de parcelas do cliente: "7/14/21" -> [7,14,21] (cada numero = dias ate o vencimento).
function parseInstallmentSchedule(raw: any): number[] {
  if (raw == null) return [];
  return String(raw).split(/[^0-9]+/).map(s => s.trim()).filter(Boolean).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0 && n <= 3650);
}
let __instSchedColReady = false;
async function ensureInstallmentScheduleColumn(): Promise<void> {
  if (__instSchedColReady) return;
  try { await db.execute(sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS installment_schedule text`); __instSchedColReady = true; } catch (e: any) { console.warn('[BILLING-PIPELINE] ensure installment_schedule:', e?.message); }
}

// Detecta se o pedido (sales_card) foi PAGO ONLINE na loja/hotsite (Cielo cartao/GooglePay
// ou PIX). Retorna o metodo p/ a baixa ('cartao'|'pix') ou null se nao houve pagamento online
// confirmado. As tabelas sao criadas sob demanda pela loja (CREATE TABLE IF NOT EXISTS), entao
// cada consulta tem try/catch proprio (tabela pode nao existir se nunca houve pagamento).
export async function getHotsitePaidMethod(salesCardId: string | null | undefined): Promise<string | null> {
  if (!salesCardId) return null;
  try {
    const c: any = await db.execute(sql`SELECT 1 FROM hotsite_card_payments WHERE order_id = ${salesCardId} AND status = 'paid' LIMIT 1`);
    if (((c.rows || c) as any[]).length) return 'cartao';
  } catch {}
  try {
    const p: any = await db.execute(sql`SELECT 1 FROM hotsite_pending_pix WHERE order_id = ${salesCardId} AND status = 'paid' LIMIT 1`);
    if (((p.rows || p) as any[]).length) return 'pix';
  } catch {}
  return null;
}

export async function createReceivableFromPipelineItem(item: any, fiscalInvoiceId: string | null, user: any) {
  // FASE 2 - Somente VENDA gera conta a receber. Amostra, troca, bonificacao,
  // transferencia, remessa e devolucao nao geram titulo nem cobranca (boleto/PIX).
  const opTypeReceivable = String(item.operationType || 'venda').toLowerCase().trim();
  if (opTypeReceivable !== 'venda') {
    console.log(`\u{1F6AB} [BILLING-PIPELINE] operationType='${opTypeReceivable}' nao gera conta a receber (item ${item.id || '-'})`);
    return null;
  }
  const totalValue = item.saleValue ? parseFloat(item.saleValue) : 0;
  if (totalValue <= 0) return null;

  const now = nowBrazil();

  // PEDIDO PAGO NA LOJA (hotsite): o dinheiro ja foi recebido (cartao/GooglePay/PIX na Cielo).
  // Nesse caso NAO emitimos boleto/PIX de cobranca e, ao faturar, o titulo ja nasce QUITADO
  // (baixa automatica -> status 'recebida'). Pagamento na loja e sempre a vista (1x) -> sem
  // cronograma de parcelas.
  const paidMethod = await getHotsitePaidMethod(item.salesCardId);
  const paidOnline = !!paidMethod;

  // Vencimento por PRAZO: se o cliente tem condicao cadastrada (forma+prazo), usa AMBOS
  // do cadastro; senao usa a forma da venda + default (pix=5, boleto=7, a vista=0).
  let custCond: any = null;
  try { if (item.customerId) custCond = await storage.getCustomer(item.customerId); } catch {}
  const hasCadastro = !!(custCond && custCond.paymentMethod);
  const effForma = hasCadastro ? String(custCond.paymentMethod) : String(item.paymentMethod || 'a_vista');
  const defaultDays = (fm: string) => (fm === 'pix' ? 5 : fm === 'boleto' ? 7 : 0);
  const prazoDaysRaw = (hasCadastro && custCond.boletoDays != null) ? Number(custCond.boletoDays) : defaultDays(effForma);
  const prazoDays = isNaN(prazoDaysRaw) ? 0 : prazoDaysRaw;

  const methodMap: Record<string, string> = { 'a_vista': 'dinheiro', 'dinheiro': 'dinheiro', 'boleto': 'boleto', 'pix': 'pix' };
  const paymentMethod: string | null = methodMap[effForma] || 'outros';

  // O numero do TITULO deve ser o numero da NF-e (nao o id do pedido). Busca o
  // numero real na NF-e vinculada (fiscalInvoiceId); so cai para NF do item ou
  // TIT-<pedido> quando nao ha NF-e emitida.
  let titleNumber: string;
  let nfNum: any = null;
  if (fiscalInvoiceId) {
    try { const nf = await storage.getFiscalInvoice(fiscalInvoiceId); if (nf && nf.invoiceNumber != null) nfNum = nf.invoiceNumber; } catch {}
  }
  if (nfNum != null) titleNumber = `NF-${nfNum}`;
  else if (item.invoiceNumber) titleNumber = String(item.invoiceNumber);
  else titleNumber = `TIT-${item.salesCardId?.substring(0, 8)}`;

  const chartAccountId = await resolveRevenueChartAccountId();
  const baseReceivable: any = {
    customerId: item.customerId || null,
    customerName: item.customerName || 'Cliente',
    customerDocument: item.customerDocument || null,
    amountPaid: '0',
    status: 'a_vencer',
    chartAccountId,
    paymentMethod: paymentMethod as any,
    fiscalInvoiceId: fiscalInvoiceId,
    billingPipelineId: item.id,
    salesCardId: item.salesCardId || null,
    omieInstanceId: item.omieInstanceId || null,
    createdBy: user?.email || null,
  };
  const emitCharge = (rcv: any) => {
    if (paidOnline) return; // dinheiro ja recebido na loja -> sem boleto/PIX de cobranca
    if (effForma === 'boleto') { void generateBoletoForReceivable(rcv, item); }
    else if (effForma === 'pix' || effForma === 'a_vista' || effForma === 'dinheiro') { void generatePixForReceivable(rcv, item); }
  };

  // CRONOGRAMA DE PARCELAS (cadastro do cliente): "7/14/21" => 3 titulos, um por parcela,
  // cada um vencendo em N dias e com o valor total dividido igualmente (a ultima parcela
  // absorve o arredondamento). Sem cronograma, mantem 1 titulo pelo PRAZO (comportamento atual).
  let scheduleDays: number[] = [];
  try {
    if (item.customerId) {
      await ensureInstallmentScheduleColumn();
      const rs: any = await db.execute(sql`SELECT installment_schedule FROM customers WHERE id = ${item.customerId} LIMIT 1`);
      scheduleDays = parseInstallmentSchedule(rs?.rows?.[0]?.installment_schedule);
    }
  } catch (e: any) { console.warn('[BILLING-PIPELINE] cronograma de parcelas indisponivel:', e?.message); }

  if (!paidOnline && scheduleDays.length >= 1) {
    const nParc = scheduleDays.length;
    const totalCents = Math.round(totalValue * 100);
    const baseCents = Math.floor(totalCents / nParc);
    let firstRcv: any = null;
    for (let i = 0; i < nParc; i++) {
      const cents = i < nParc - 1 ? baseCents : (totalCents - baseCents * (nParc - 1));
      const due = new Date(now);
      due.setDate(due.getDate() + (isNaN(scheduleDays[i]) ? 0 : scheduleDays[i]));
      const rcv = await storage.createReceivable({
        ...baseReceivable,
        titleNumber: `${titleNumber}/${i + 1}`,
        description: `Faturamento pipeline - ${item.orderNumber || item.salesCardId} (parcela ${i + 1}/${nParc})`,
        issueDate: now,
        dueDate: due,
        amount: (cents / 100).toFixed(2),
      });
      if (!firstRcv) firstRcv = rcv;
      emitCharge(rcv);
    }
    console.log(`\u{1F4B3} [BILLING-PIPELINE] ${nParc} parcela(s) geradas (cronograma ${scheduleDays.join('/')} dias) p/ pedido ${item.orderNumber || item.salesCardId}`);
    return firstRcv;
  }

  // Sem cronograma: 1 titulo com vencimento pelo PRAZO (comportamento padrao).
  // Pedido pago na loja (paidOnline) -> vencimento hoje (a vista, ja quitado).
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + (paidOnline ? 0 : prazoDays));
  const receivable = await storage.createReceivable({
    ...baseReceivable,
    titleNumber: titleNumber,
    description: `Faturamento pipeline - ${item.orderNumber || item.salesCardId}`,
    issueDate: now,
    dueDate: dueDate,
    amount: totalValue.toFixed(2),
    ...(paidOnline ? { paymentMethod: (paidMethod === 'pix' ? 'pix' : 'cartao') as any } : {}),
  });

  // BAIXA AUTOMATICA: pedido pago na loja nasce QUITADO ao ser faturado. Reusa o mesmo
  // mecanismo do "Registrar Pagamento" (createReceivablePayment + status 'recebida'). Se a
  // baixa falhar, o titulo fica aberto (recuperavel manualmente) e o faturamento nao quebra.
  if (paidOnline) {
    try {
      await storage.createReceivablePayment({
        receivableId: receivable.id,
        paidAt: now,
        amount: totalValue.toFixed(2),
        paymentMethod: (paidMethod === 'pix' ? 'pix' : 'cartao') as any,
        financialAccountId: null,
        reference: 'Pagamento na loja (hotsite)',
        notes: `Baixa automatica - pedido pago online (${paidMethod === 'pix' ? 'PIX' : 'cartao'}) na loja/hotsite. Faturamento gerou o titulo ja quitado.`,
        createdBy: user?.email || 'sistema (loja)',
      } as any);
      await storage.updateReceivable(receivable.id, { amountPaid: totalValue.toFixed(2), status: 'recebida' as any });
      console.log(`✅ [BILLING-PIPELINE] Recebivel ${receivable.id} BAIXADO automaticamente (pago na loja, ${paidMethod}) - pedido ${item.orderNumber || item.salesCardId}`);
    } catch (e: any) {
      console.warn('⚠️ [BILLING-PIPELINE] Falha na baixa automatica do pedido pago na loja (titulo fica aberto):', e?.message || e);
    }
  }

  emitCharge(receivable);
  return receivable;
}
