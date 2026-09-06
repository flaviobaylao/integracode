// ============================================================================
// DÉBITOS VENCIDOS POR CLIENTE — fonte 2.0 (Contas a Receber)
// ----------------------------------------------------------------------------
// E4 (06/set/2026). Até aqui a tela "Débitos Vencidos" nasceu lendo a tabela
// `overdue_debts`, alimentada pelo sync do Omie. O Omie foi desligado e a tabela
// congelou em 26/ago — NÃO é mais fonte de débito para nada.
//
// Este módulo é o ÚNICO produtor do formato que a tela consome (agrupado por
// cliente, com os títulos dentro), lendo `receivables` com a REGRA ÚNICA de
// "débito vencido vivo" de server/divida-viva.ts (whereDebitoVivoSql) — a mesma
// do bloqueio de crédito (storage.getOverdueDebtByDocument), do badge da Rota,
// do alerta de WhatsApp e dos relatórios.
//
// Servido em três paths (mesmo handler):
//   GET /api/financial/overdue-debts               (o que a tela chama hoje)
//   GET /api/financial/overdue-debts/por-cliente   (alias novo, nome definitivo)
//   GET /api/omie/overdue-debts/cached             (path antigo, até a E5)
//
// Formato de resposta (preservado da versão Omie — ver OverdueDebtsManagement.tsx):
//   { debts: [{ cliente: { codigo_cliente_omie, nome_fantasia, cnpj_cpf, telefone },
//               debitos: [{ numero_documento, numero_documento_fiscal, codigo_lancamento_omie,
//                           receivableId, valor, data_vencimento (DD/MM/AAAA), dias_atraso,
//                           observacao, codigo_vendedor }],
//               valorTotal, diasMaximoAtraso, vendedores: [], omieInstanceId }],
//     totalAmount, totalClients, lastSyncAt }
//
// Campos que só existiam no Omie:
//   codigo_cliente_omie ....... customers.omie_client_code (0 quando não há)
//   codigo_lancamento_omie .... 0 (não existe no 2.0; o título é o receivableId)
//   codigo_vendedor ........... NOME do vendedor (o front resolve por id, código ou nome)
//   lastSyncAt ................ null (não há mais sync; é leitura ao vivo)
// ============================================================================

import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { whereDebitoVivoSql, diasAtrasoText } from './divida-viva';

export interface FiltrosDebitosVencidos {
  /** Instância (empresa) do título: receivables.omie_instance_id */
  instanceId?: string;
  /** Vendedor: users.id, users.omie_vendor_code ou nome — casa com a carteira (customers.seller_id) ou com o vendedor do pedido */
  sellerId?: string;
  /** Um cliente específico (customers.id) */
  customerId?: string;
  /** CNPJ/CPF (qualquer formatação) */
  document?: string;
  /** Conferência: inclui a dívida HISTÓRICA migrada do Omie (fora da regra por padrão) */
  incluirHistorico?: boolean;
}

export interface DebitoVencidoTitulo {
  numero_documento: string;
  numero_documento_fiscal: string;
  codigo_lancamento_omie: number;
  receivableId: string;
  valor: number;
  data_vencimento: string;
  data_vencimento_iso: string;
  dias_atraso: number;
  observacao: string;
  codigo_vendedor: string;
  vendedor_id: string | null;
  omieInstanceId: string | null;
}

export interface DebitoVencidoCliente {
  cliente: {
    codigo_cliente_omie: number;
    nome_fantasia: string;
    cnpj_cpf: string;
    telefone: string;
    customerId: string | null;
    cidade: string;
  };
  debitos: DebitoVencidoTitulo[];
  valorTotal: number;
  diasMaximoAtraso: number;
  vendedores: string[];
  omieInstanceId: string | null;
}

export interface DebitosVencidosResposta {
  debts: DebitoVencidoCliente[];
  totalAmount: number;
  totalClients: number;
  totalTitles: number;
  lastSyncAt: null;
  source: 'receivables';
}

const digits = (v: any) => String(v == null ? '' : v).replace(/\D/g, '');
const PHONE_PLACEHOLDER = /00000-0000/;
const telefoneValido = (p: any) => {
  const s = String(p || '').trim();
  return s && !PHONE_PLACEHOLDER.test(s) ? s : '';
};
/** due_date é DATA DE CALENDÁRIO (meia-noite UTC): lida em UTC, sem conversão de fuso. */
const isoUTC = (d: any) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'UTC' });
const fmtBR = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

export async function listarDebitosVencidosPorCliente(f: FiltrosDebitosVencidos = {}): Promise<DebitosVencidosResposta> {
  const conds: any[] = [whereDebitoVivoSql('r', { incluirHistoricoOmie: !!f.incluirHistorico })];
  if (f.instanceId) conds.push(sql`r.omie_instance_id = ${f.instanceId}`);
  if (f.customerId) conds.push(sql`r.customer_id = ${f.customerId}`);
  const doc = digits(f.document);
  if (doc) conds.push(sql`regexp_replace(COALESCE(r.customer_document, ''), '[^0-9]', '', 'g') = ${doc}`);

  const rows: any[] = ((await db.execute(sql`
    SELECT r.id,
           r.title_number,
           r.customer_id,
           r.customer_name,
           r.customer_document,
           r.description,
           r.category,
           r.omie_instance_id,
           (r.amount - COALESCE(r.amount_paid, 0))::float AS saldo,
           r.due_date,
           ${sql.raw(diasAtrasoText('r'))}::int AS dias_atraso,
           bp.seller_id   AS bp_seller_id,
           bp.seller_name AS bp_seller_name,
           bp.invoice_number AS bp_invoice_number,
           fi.invoice_number AS fi_invoice_number,
           c.id            AS c_id,
           c.name          AS c_name,
           c.fantasy_name  AS c_fantasy_name,
           c.phone         AS c_phone,
           c.city          AS c_city,
           c.seller_id     AS c_seller_id,
           c.omie_client_code AS c_omie_code,
           u.id            AS u_id,
           u.nome          AS u_nome,
           u.omie_vendor_code AS u_code
    FROM receivables r
    LEFT JOIN billing_pipeline bp ON bp.id = r.billing_pipeline_id
    LEFT JOIN fiscal_invoices fi ON fi.id = r.fiscal_invoice_id
    -- Cliente: pelo vínculo direto (customer_id) e, na falta dele, pelo documento.
    LEFT JOIN LATERAL (
      SELECT c.id, c.name, c.fantasy_name, c.phone, c.city, c.seller_id, c.omie_client_code
      FROM customers c
      WHERE (r.customer_id IS NOT NULL AND c.id = r.customer_id)
         OR (r.customer_id IS NULL
             AND regexp_replace(COALESCE(r.customer_document, ''), '[^0-9]', '', 'g') <> ''
             AND regexp_replace(COALESCE(c.cnpj, c.cpf, ''), '[^0-9]', '', 'g')
                 = regexp_replace(COALESCE(r.customer_document, ''), '[^0-9]', '', 'g'))
      ORDER BY (c.id = r.customer_id) DESC NULLS LAST, c.is_active DESC NULLS LAST
      LIMIT 1
    ) c ON true
    -- Vendedor da carteira: customers.seller_id guarda users.id OU código Omie ('omie-vendor-123' / '123').
    LEFT JOIN LATERAL (
      SELECT u.id, u.omie_vendor_code,
             NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS nome
      FROM users u
      WHERE c.seller_id IS NOT NULL AND (
            u.id = c.seller_id
         OR u.omie_vendor_code = c.seller_id
         OR u.omie_vendor_code = REPLACE(c.seller_id, 'omie-vendor-', ''))
      LIMIT 1
    ) u ON true
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY r.due_date ASC, r.created_at ASC
  `)) as any).rows || [];

  // Filtro por vendedor (carteira do cliente OU vendedor do pedido), aceitando id, código ou nome.
  const sellerWanted = String(f.sellerId || '').trim();
  const sellerWantedNorm = sellerWanted.replace(/^omie-vendor-/, '').toLowerCase();
  const casaVendedor = (r: any) => {
    if (!sellerWanted) return true;
    const cands = [r.u_id, r.u_code, r.u_nome, r.c_seller_id, r.bp_seller_id, r.bp_seller_name]
      .filter(Boolean).map((x: any) => String(x).replace(/^omie-vendor-/, '').toLowerCase());
    return cands.includes(sellerWantedNorm);
  };

  const groups = new Map<string, DebitoVencidoCliente>();
  let totalTitles = 0;
  for (const r of rows) {
    if (!casaVendedor(r)) continue;
    const saldo = Math.max(0, Number(r.saldo || 0));
    if (!(saldo > 0)) continue;
    const ndoc = digits(r.customer_document);
    const key = r.c_id ? `id:${r.c_id}` : (ndoc ? `doc:${ndoc}` : `nome:${String(r.customer_name || '').trim().toLowerCase() || r.id}`);
    const sellerName = String(r.bp_seller_name || r.u_nome || '').trim() || 'Sem vendedor';
    const sellerId = r.bp_seller_id || r.u_id || null;
    const iso = isoUTC(r.due_date);
    // Número da NF: NF-e vinculada > NF do pipeline (quando o título ainda é "TIT-<pedido>") > título.
    const title = String(r.title_number || '');
    const bpInv = String(r.bp_invoice_number || '');
    const nf = r.fi_invoice_number != null ? String(r.fi_invoice_number)
      : (/^NF-/i.test(bpInv) && /^TIT-/i.test(title)) ? bpInv
      : title;
    let g = groups.get(key);
    if (!g) {
      g = {
        cliente: {
          codigo_cliente_omie: Number(digits(r.c_omie_code)) || 0,
          nome_fantasia: String(r.c_fantasy_name || r.customer_name || r.c_name || '(sem nome)'),
          cnpj_cpf: String(r.customer_document || ''),
          telefone: telefoneValido(r.c_phone),
          customerId: r.c_id || r.customer_id || null,
          cidade: String(r.c_city || ''),
        },
        debitos: [],
        valorTotal: 0,
        diasMaximoAtraso: 0,
        vendedores: [],
        omieInstanceId: r.omie_instance_id || null,
      };
      groups.set(key, g);
    }
    const dias = Math.max(0, Number(r.dias_atraso || 0));
    g.debitos.push({
      numero_documento: title,
      numero_documento_fiscal: nf,
      codigo_lancamento_omie: 0,
      receivableId: String(r.id),
      valor: Math.round(saldo * 100) / 100,
      data_vencimento: fmtBR(iso),
      data_vencimento_iso: iso,
      dias_atraso: dias,
      observacao: String(r.description || r.category || ''),
      codigo_vendedor: sellerName,
      vendedor_id: sellerId ? String(sellerId) : null,
      omieInstanceId: r.omie_instance_id || null,
    });
    g.valorTotal = Math.round((g.valorTotal + saldo) * 100) / 100;
    g.diasMaximoAtraso = Math.max(g.diasMaximoAtraso, dias);
    if (!g.vendedores.includes(sellerName)) g.vendedores.push(sellerName);
    if (!g.cliente.telefone) g.cliente.telefone = telefoneValido(r.c_phone);
    totalTitles++;
  }

  const debts = Array.from(groups.values());
  debts.sort((a, b) => (b.diasMaximoAtraso - a.diasMaximoAtraso) || (b.valorTotal - a.valorTotal));
  const totalAmount = Math.round(debts.reduce((s, g) => s + g.valorTotal, 0) * 100) / 100;
  return { debts, totalAmount, totalClients: debts.length, totalTitles, lastSyncAt: null, source: 'receivables' };
}

/** Handler Express compartilhado pelos três paths. */
export async function handlerDebitosVencidosPorCliente(req: Request, res: Response): Promise<void> {
  try {
    const q: any = req.query || {};
    const first = (v: any) => (Array.isArray(v) ? v[0] : v);
    const data = await listarDebitosVencidosPorCliente({
      instanceId: first(q.instanceId || q.omieInstanceId || q.instancia) || undefined,
      sellerId: first(q.sellerId || q.vendedor || q.vendorCode) || undefined,
      customerId: first(q.customerId) || undefined,
      document: first(q.document || q.documento || q.cnpj) || undefined,
      incluirHistorico: String(first(q.incluirHistorico) || '') === '1',
    });
    res.json(data);
  } catch (error: any) {
    console.error('[OVERDUE-DEBTS] Erro ao listar débitos vencidos (receivables):', error?.message || error);
    res.status(500).json({
      message: 'Erro ao buscar débitos vencidos: ' + (error?.message || 'Erro desconhecido'),
      debts: [],
      totalAmount: 0,
      totalClients: 0,
    });
  }
}
