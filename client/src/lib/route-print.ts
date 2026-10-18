// ============================================================================
// IMPRESSÃO DA ROTEIRIZAÇÃO — folha de rosto do motorista + pacote completo
// ----------------------------------------------------------------------------
// Reúne, para um conjunto de rotas (motoristas), tudo que a impressão precisa:
//   • itens do pipeline (produtos, vendedor, valor, observação)  → folha de pedido
//   • cobranças já sincronizadas (boleto / PIX)                  → página de cobrança
//   • DANFE vinculada a cada item                                → nota fiscal
// e delega a montagem do PDF ao cobranca-generator.
//
// Usado em DOIS lugares, com o mesmo resultado:
//   1) pop-up "Roteirização com IA" (antes ou depois de salvar);
//   2) tela "Rotas de Entrega" — reimpressão de qualquer rota já salva, mesmo
//      muito depois de o pop-up ter sido fechado.
// ============================================================================

import {
  generateFolhasDeRostoPdf,
  generateRotasCompletoPdf,
  type CobrancaData,
  type RotaImpressao,
} from './cobranca-generator';
import type { DanfeInvoice } from './danfe-generator';
import { janelaTextoDoDia } from '@shared/janelas-entrega';

export type { RotaImpressao };

async function postJson(url: string, body: any): Promise<any[]> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** ids de billing_pipeline presentes nas paradas das rotas informadas. */
function idsDasRotas(rotas: RotaImpressao[]): string[] {
  const set = new Set<string>();
  for (const r of rotas || []) {
    for (const s of (r?.stops || [])) {
      const id = String(s?.billingId || '').trim();
      if (id) set.add(id);
    }
  }
  return Array.from(set);
}

/**
 * Busca no servidor os dados de cada pedido das rotas (item + cobrança + DANFE).
 * Nenhuma das três chamadas é obrigatória: o que faltar simplesmente não é
 * impresso (a folha de pedido sai com o que existir).
 */
export async function carregarPedidosDasRotas(rotas: RotaImpressao[]): Promise<CobrancaData[]> {
  const ids = idsDasRotas(rotas);
  if (ids.length === 0) return [];

  const [items, charges, danfes] = await Promise.all([
    postJson('/api/billing-pipeline/items-by-ids', { ids }),
    postJson('/api/billing-pipeline/charges', { ids }),
    postJson('/api/billing-pipeline/danfes', { ids }),
  ]);

  const itemById = new Map<string, any>();
  for (const it of items) if (it?.id) itemById.set(String(it.id), it);

  // Mesma regra do Pipeline de Faturamento: entre duas linhas do mesmo item,
  // vence a que efetivamente tem boleto ou PIX.
  const chargeById = new Map<string, any>();
  for (const r of charges) {
    const k = String(r?.item_id || '');
    if (!k) continue;
    const cur = chargeById.get(k);
    if (!cur || ((!cur.boleto && !cur.pix) && (r.boleto || r.pix))) chargeById.set(k, r);
  }

  const danfeById = new Map<string, DanfeInvoice>();
  for (const d of danfes) if (d?.itemId) danfeById.set(String(d.itemId), d as DanfeInvoice);

  return ids.map((id) => {
    const it = itemById.get(id) || {};
    const ch = chargeById.get(id) || {};
    return {
      itemId: id,
      customerName: it.customerName,
      sellerName: it.sellerName,
      invoiceNumber: it.invoiceNumber,
      saleValue: it.saleValue,
      products: it.products,
      observation: it.notes,
      boleto: ch.boleto || null,
      pix: ch.pix || null,
      danfe: danfeById.get(id) || null,
      deliveryTimeSlots: it.deliveryTimeSlots ?? null,
      deliverySaturdayTimeSlots: it.deliverySaturdayTimeSlots ?? null,
    } as CobrancaData;
  });
}

/** Completa as paradas com NF/pedido/valor do pipeline (a parada só tem o id). */
function enriquecerRotas(rotas: RotaImpressao[], pedidos: CobrancaData[]): RotaImpressao[] {
  const porId = new Map<string, CobrancaData>();
  for (const p of pedidos) if (p?.itemId) porId.set(String(p.itemId), p);
  return (rotas || []).map((r) => ({
    ...r,
    stops: (r.stops || []).map((s) => {
      const p = porId.get(String(s.billingId || ''));
      if (!p) return s;
      const temJanela = typeof s.janelaTexto === 'string';
      return {
        ...s,
        invoiceNumber: s.invoiceNumber || p.invoiceNumber || null,
        saleValue: s.saleValue ?? p.saleValue ?? null,
        products: s.products ?? p.products ?? null,
        // Horário de recebimento: o planejamento já manda pronto; rota salva
        // calcula a partir do cadastro do cliente para o dia da rota.
        janelaTexto: temJanela
          ? s.janelaTexto
          : janelaTextoDoDia(p.deliveryTimeSlots, p.deliverySaturdayTimeSlots, String(r.routeDate || '').slice(0, 10) || new Date()),
      };
    }),
  }));
}

/**
 * Todas as rotas JÁ SALVAS nas datas das rotas impressas (todos os
 * entregadores) — alimentam o mapa do dia do romaneio. Falha = sem mapa extra.
 */
async function carregarRotasDoDia(rotas: RotaImpressao[]): Promise<RotaImpressao[]> {
  const datas = Array.from(new Set((rotas || []).map((r) => String(r.routeDate || '').slice(0, 10)).filter(Boolean)));
  const out: RotaImpressao[] = [];
  for (const d of datas) {
    try {
      const r = await fetch(`/api/delivery-routes?routeDate=${encodeURIComponent(d)}`, { credentials: 'include' });
      if (!r.ok) continue;
      const lista = await r.json();
      for (const rt of (Array.isArray(lista) ? lista : [])) {
        if (['cancelled', 'cancelada'].includes(String(rt?.status))) continue;
        if (String(rt?.routeDate || '').slice(0, 10) !== d) continue;
        const rs = rotaSalva(rt, rt?.stops || []);
        if (rs.stops.length) out.push(rs);
      }
    } catch { /* sem mapa das demais rotas */ }
  }
  return out;
}

export interface OpcoesImpressao {
  /** outras rotas do mesmo dia (ex.: as demais propostas do planejamento) para o mapa */
  rotasDoDia?: RotaImpressao[];
}

/** Só o romaneio: uma folha de rosto por motorista (+ mapa do dia). */
export async function imprimirFolhasDeRosto(rotas: RotaImpressao[], opts?: OpcoesImpressao): Promise<number> {
  const [pedidos, salvas] = await Promise.all([carregarPedidosDasRotas(rotas), carregarRotasDoDia(rotas)]);
  return await generateFolhasDeRostoPdf(enriquecerRotas(rotas, pedidos), [...(opts?.rotasDoDia || []), ...salvas]);
}

/** Folha de rosto + pacote completo de cada entrega, na ordem da rota. */
export async function imprimirRotasCompleto(
  rotas: RotaImpressao[],
  opts?: OpcoesImpressao,
): Promise<{ rotas: number; pedidos: number }> {
  const [pedidos, salvas] = await Promise.all([carregarPedidosDasRotas(rotas), carregarRotasDoDia(rotas)]);
  return await generateRotasCompletoPdf(enriquecerRotas(rotas, pedidos), pedidos, [...(opts?.rotasDoDia || []), ...salvas]);
}

/** Converte uma rota vinda do PLANEJAMENTO (`/api/delivery-routes/plan`). */
export function rotaDoPlano(r: any, routeDate: string, janela?: { inicio?: string; fim?: string }): RotaImpressao {
  return {
    driverName: r?.driverName || null,
    vehicleType: r?.vehicleType || null,
    routeDate,
    startAddress: r?.startAddress || null,
    startLatitude: r?.startLatitude ?? null,
    startLongitude: r?.startLongitude ?? null,
    totalDistance: r?.totalDistance ?? null,
    totalDuration: r?.totalDuration ?? null,
    timeWindowStart: janela?.inicio || null,
    timeWindowEnd: janela?.fim || null,
    stops: (r?.stops || []).map((s: any, i: number) => ({
      stopOrder: s?.stopOrder ?? i + 1,
      billingId: s?.billingId || s?.salesCardId || null,
      customerName: s?.customerName || null,
      customerAddress: s?.customerAddress || null,
      estimatedArrival: s?.estimatedArrival || null,
      distanceFromPrevious: s?.distanceFromPrevious ?? null,
      isPriority: !!(s?.isUrgent ?? s?.isPriority),
      latitude: s?.latitude ?? s?.customerLatitude ?? null,
      longitude: s?.longitude ?? s?.customerLongitude ?? null,
      janelaTexto: typeof s?.janelaTexto === 'string' ? s.janelaTexto : undefined,
      foraDaJanela: !!s?.foraDaJanela,
      esperaMin: s?.esperaMin ?? null,
      estimatedServiceTime: s?.estimatedServiceTime ?? null,
      estimatedDeparture: s?.estimatedDeparture || null,
      customerId: s?.customerId || null,
    })),
  };
}

/** Converte uma rota JÁ SALVA (`/api/delivery-routes` ou `/:id/stops`). */
export function rotaSalva(route: any, stops: any[]): RotaImpressao {
  return {
    routeId: route?.id,
    driverName: route?.driverName || null,
    vehicleType: route?.vehicleType || null,
    routeDate: route?.routeDate ? String(route.routeDate).slice(0, 10) : null,
    startAddress: route?.startAddress || null,
    startLatitude: route?.startLatitude ?? null,
    startLongitude: route?.startLongitude ?? null,
    totalDistance: route?.totalDistance ?? null,
    totalDuration: route?.totalDuration ?? null,
    timeWindowStart: route?.timeWindowStart || null,
    timeWindowEnd: route?.timeWindowEnd || null,
    stops: (stops || []).map((s: any, i: number) => ({
      stopOrder: s?.stopOrder ?? i + 1,
      billingId: s?.billingId || s?.salesCardId || null,
      customerName: s?.customerName || null,
      customerAddress: s?.customerAddress || null,
      orderNumber: s?.orderNumber || null,
      invoiceNumber: s?.invoiceNumber || null,
      estimatedArrival: s?.estimatedArrival || null,
      distanceFromPrevious: s?.distanceFromPrevious ?? null,
      isPriority: !!s?.isPriority,
      latitude: s?.customerLatitude ?? s?.latitude ?? null,
      longitude: s?.customerLongitude ?? s?.longitude ?? null,
      estimatedServiceTime: s?.estimatedServiceTime ?? null,
      estimatedDeparture: s?.estimatedDeparture || null,
      customerId: s?.customerId || null,
    })),
  };
}
