// ============================================================================
// EXTRATO DO CLIENTE — "vida" do cliente com a Honest
// ----------------------------------------------------------------------------
// Uma linha para CADA nota faturada (débito) e uma linha para CADA pagamento
// por data (crédito), com saldo corrente acumulado.
//
// Fontes (nesta ordem de prioridade, deduplicadas por número de NF):
//   1. receivables            -> títulos do financeiro (Omie + internos)
//   2. receivable_payments    -> baixas com data real
//   3. fiscal_invoices        -> NF-e emitidas no próprio sistema (autorizadas)
//   4. billing_pipeline       -> pedidos faturados sem contrapartida financeira
//
// Observação importante: títulos importados do histórico do Omie chegam com
// `amount_paid` preenchido mas SEM linhas em receivable_payments (a baixa não
// veio na carga). Nesses casos geramos uma linha de pagamento "estimada",
// datada no vencimento e sinalizada com `estimado: true` na resposta.
// ============================================================================

import { type Express } from "express";
import { authenticateUser } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";

// Decisão do Flavio (04/ago/2026): o Extrato é uma tela de CONSULTA (só GET, nada
// editável) e fica liberada para TODOS os perfis, sem filtro de carteira —
// qualquer usuário logado consulta o extrato de qualquer cliente.
const ROLES_EXTRATO = [
  "admin",
  "coordinator",
  "administrative",
  "vendedor",
  "telemarketing",
  "motorista",
  "industria",
];

function isExtratoAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: "Não autenticado" });
  if (!ROLES_EXTRATO.includes(user.role)) {
    return res.status(403).json({ message: "Sem permissão para ver o extrato do cliente" });
  }
  next();
}

const onlyDigits = (v: any) => String(v ?? "").replace(/\D/g, "");

/** Lê um campo do padrão "faturamento=... | parcela=1 | nf=123 | pedido=99" */
function noteVal(notes: any, key: string): string {
  const s = String(notes ?? "");
  const m = new RegExp(`(?:^|\\|)\\s*${key}=([^|]*)`).exec(s);
  return m ? m[1].trim() : "";
}

/** Normaliza número de NF: só dígitos, sem zeros à esquerda. */
function nfKeyOf(v: any): string {
  const d = onlyDigits(v).replace(/^0+/, "");
  return d || "";
}

function toISO(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function num(v: any): number {
  const n = parseFloat(String(v ?? "0").replace(",", "."));
  return isNaN(n) ? 0 : n;
}

function diffDays(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
  return isNaN(d) ? null : d;
}

// ── Régua oficial de vencimento (ver Correcao_Vencimento_Hoje_Nao_E_Vencida.md,
// 27/jul/2026): o vencimento é uma DATA DE CALENDÁRIO gravada como meia-noite UTC,
// e é lido em UTC — exatamente o dia que a tela mostra. HOJE é lido em
// America/Sao_Paulo. Título que vence HOJE, a qualquer hora, NÃO é vencido:
// só atrasa depois que o dia do vencimento passa.
function diaUTC(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "UTC" });
}

function diaBR(v: any): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function hojeBR(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function estaVencido(vencimento: any, hoje: string): boolean {
  const dia = diaUTC(vencimento);
  return !!dia && dia < hoje;
}

// Diferença em DIAS DE CALENDÁRIO entre dois dias no formato YYYY-MM-DD.
function diffDias(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);
  return isNaN(d) ? null : d;
}

const ORIGEM_LABEL: Record<string, string> = {
  financeiro: "Financeiro",
  nfe: "NF-e emitida",
  pedido: "Pedido faturado",
  baixa: "Baixa",
  baixa_importada: "Baixa importada",
};

const PM_LABEL: Record<string, string> = {
  dinheiro: "Dinheiro",
  boleto: "Boleto",
  cartao: "Cartão",
  cartao_credito: "Cartão de crédito",
  cartao_debito: "Cartão de débito",
  pix: "PIX",
  transferencia: "Transferência",
  cheque: "Cheque",
  outros: "Outros",
};

export function registerCustomerStatementRoutes(app: Express): void {
  // ── Busca de clientes para o seletor do extrato ────────────────────────────
  app.get("/api/customer-statement/search", authenticateUser, isExtratoAuthorized, async (req: any, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json([]);
      const like = `%${q.toLowerCase()}%`;
      const dig = onlyDigits(q);

      // Consulta liberada: nenhum perfil é limitado à própria carteira.
      const sellerFilter = sql``;

      const docFilter =
        dig.length >= 3
          ? sql` OR REGEXP_REPLACE(COALESCE(c.cnpj,''), '\\D', '', 'g') LIKE ${"%" + dig + "%"}
                 OR REGEXP_REPLACE(COALESCE(c.cpf,''), '\\D', '', 'g') LIKE ${"%" + dig + "%"}`
          : sql``;

      const r: any = await db.execute(sql`
        SELECT c.id, c.name, c.fantasy_name, c.company_name, c.cnpj, c.cpf,
               c.city, c.state, c.is_active, c.phone, c.seller_id,
               TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS seller_name
        FROM customers c
        LEFT JOIN users u ON u.id = c.seller_id
        WHERE (
          LOWER(c.name) LIKE ${like}
          OR LOWER(COALESCE(c.fantasy_name,'')) LIKE ${like}
          OR LOWER(COALESCE(c.company_name,'')) LIKE ${like}
          ${docFilter}
        )
        ${sellerFilter}
        ORDER BY c.is_active DESC, c.name ASC
        LIMIT 40
      `);
      const rows: any[] = r?.rows || r || [];
      res.json(
        rows.map((c) => ({
          id: c.id,
          name: c.name,
          fantasyName: c.fantasy_name,
          document: c.cnpj || c.cpf || null,
          city: c.city,
          state: c.state,
          phone: c.phone,
          isActive: c.is_active,
          sellerName: (c.seller_name || "").trim() || null,
        }))
      );
    } catch (error: any) {
      console.error("[extrato-cliente] search:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // ── Extrato completo de um cliente ────────────────────────────────────────
  app.get("/api/customer-statement/:customerId", authenticateUser, isExtratoAuthorized, async (req: any, res) => {
    try {
      const customerId = String(req.params.customerId);
      const start = req.query.start ? new Date(String(req.query.start)) : null;
      const end = req.query.end ? new Date(String(req.query.end)) : null;
      if (end) end.setHours(23, 59, 59, 999);

      const cRes: any = await db.execute(sql`
        SELECT c.*, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS seller_name
        FROM customers c LEFT JOIN users u ON u.id = c.seller_id
        WHERE c.id = ${customerId} LIMIT 1
      `);
      const cust: any = (cRes?.rows || cRes || [])[0];
      if (!cust) return res.status(404).json({ message: "Cliente não encontrado" });

      const doc = onlyDigits(cust.cnpj || cust.cpf);
      const docCond = doc.length >= 11
        ? sql` OR REGEXP_REPLACE(COALESCE(r.customer_document,''), '\\D', '', 'g') = ${doc}`
        : sql``;

      // 1) Títulos do financeiro
      const recRes: any = await db.execute(sql`
        SELECT r.id, r.title_number, r.customer_name, r.description, r.category,
               r.issue_date, r.due_date, r.amount, r.amount_paid, r.status,
               r.payment_method, r.notes, r.fiscal_invoice_id, r.billing_pipeline_id, r.sales_card_id,
               r.omie_instance_id, r.created_at
        FROM receivables r
        WHERE r.deleted_at IS NULL
          AND (r.customer_id = ${customerId} ${docCond})
        ORDER BY r.issue_date ASC, r.due_date ASC
      `);
      const receivables: any[] = recRes?.rows || recRes || [];
      const recIds = receivables.map((r) => r.id);

      // 2) Baixas com data real
      let payments: any[] = [];
      if (recIds.length) {
        for (let i = 0; i < recIds.length; i += 500) {
          const lote = recIds.slice(i, i + 500);
          const pRes: any = await db.execute(sql`
            SELECT p.id, p.receivable_id, p.paid_at, p.amount, p.payment_method, p.reference, p.notes,
                   a.name AS account_name
            FROM receivable_payments p
            LEFT JOIN financial_accounts a ON a.id = p.financial_account_id
            WHERE p.deleted_at IS NULL
              AND p.receivable_id IN (${sql.join(lote.map((id: string) => sql`${id}`), sql`, `)})
            ORDER BY p.paid_at ASC
          `);
          payments = payments.concat(pRes?.rows || pRes || []);
        }
      }
      const payByRec = new Map<string, any[]>();
      for (const p of payments) {
        const arr = payByRec.get(p.receivable_id) || [];
        arr.push(p);
        payByRec.set(p.receivable_id, arr);
      }

      // ── TÍTULOS FANTASMAS ──────────────────────────────────────────────────
      // Ver Titulo_Fantasma_NF102004_CausaRaiz_2026-08-04.md. Rotinas de reparo de
      // órfãos (ex.: backfill-missing-receivables) criam um SEGUNDO título para uma
      // NF que JÁ tem título: o card duplicado — vindo da Recuperação de Faturamento —
      // não tem sales_card_id, então a rotina não acha a NF-e e o título nasce sem
      // vínculo nenhum, com o número cru da NF e um vencimento novo.
      //
      // Regra: se a NF já tem título ANCORADO (fiscal_invoice_id preenchido), qualquer
      // outro título da MESMA NF (mesma instância Omie) SEM NF-e, SEM card de venda e
      // criado mais de 1 dia DEPOIS do ancorado é duplicata.
      //
      // Decisão do Flavio (04/ago/2026): só some da tela o fantasma SEM nenhum centavo
      // recebido. Fantasma com baixa continua visível e é contado em
      // `duplicadasComBaixa` — o Extrato nunca esconde dinheiro que de fato entrou.
      const chaveNfDe = (r: any): string | null => {
        const nf = nfKeyOf(noteVal(r.notes, "nf")) || nfKeyOf(r.title_number);
        return nf ? `${String(r.omie_instance_id || "")}:${nf}` : null;
      };
      const ancoradoPorNf = new Map<string, any>();
      for (const r of receivables) {
        if (!r.fiscal_invoice_id) continue;
        const k = chaveNfDe(r);
        if (!k) continue;
        const atual = ancoradoPorNf.get(k);
        if (!atual || new Date(r.created_at || 0) < new Date(atual.created_at || 0)) ancoradoPorNf.set(k, r);
      }
      const temDinheiro = (r: any) => num(r.amount_paid) > 0.009 || (payByRec.get(r.id) || []).length > 0;
      const ehDuplicata = (r: any): boolean => {
        if (r.fiscal_invoice_id || r.sales_card_id) return false;
        const k = chaveNfDe(r);
        if (!k) return false;
        const anc = ancoradoPorNf.get(k);
        if (!anc || anc.id === r.id) return false;
        const nasceu = new Date(r.created_at || 0).getTime();
        const ancNasceu = new Date(anc.created_at || 0).getTime();
        if (!isFinite(nasceu) || !isFinite(ancNasceu)) return false;
        return nasceu - ancNasceu > 86400000; // mais de 1 dia depois
      };
      const fantasmasIgnorados: any[] = [];
      const duplicadasComBaixa: any[] = [];
      const receivablesUteis = receivables.filter((r) => {
        if (!ehDuplicata(r)) return true;
        if (temDinheiro(r)) { duplicadasComBaixa.push(r); return true; }
        fantasmasIgnorados.push(r);
        return false;
      });
      if (fantasmasIgnorados.length) {
        console.log(
          `[extrato-cliente] ${fantasmasIgnorados.length} titulo(s) fantasma ignorado(s) p/ cliente ${customerId}: ` +
            fantasmasIgnorados.map((r) => `${r.title_number}=${r.amount}`).join(", ")
        );
      }

      // ── Monta as notas (agrupando parcelas do mesmo número de NF) ───────────
      type NotaAgg = {
        key: string;
        nf: string;
        pedido: string;
        data: string | null;
        vencimento: string | null;
        valor: number;
        valorCancelado: number;
        pago: number;
        parcelas: number;
        origem: string;
        descricao: string;
        titulos: any[];
        bpId?: string | null;
        scId?: string | null;
        fiId?: string | null;
      };
      const notas = new Map<string, NotaAgg>();
      const nfSeen = new Set<string>();

      for (const r of receivablesUteis) {
        const nfFromNotes = noteVal(r.notes, "nf");
        const nf = nfKeyOf(nfFromNotes) || nfKeyOf(r.title_number);
        const pedido = noteVal(r.notes, "pedido");
        const fatRaw = noteVal(r.notes, "faturamento");
        const dataNota = toISO(fatRaw || r.issue_date);
        // A chave inclui a instância Omie: duas empresas do grupo podem emitir
        // NFs com o mesmo número, e elas não podem ser fundidas na mesma linha.
        const inst = String(r.omie_instance_id || "");
        const key = nf ? `NF:${inst}:${nf}` : `TIT:${r.id}`;
        const cancelado = String(r.status || "") === "cancelada";
        const pago = cancelado ? 0 : num(r.amount_paid);

        const cur = notas.get(key);
        if (!cur) {
          notas.set(key, {
            key,
            nf: nf || String(r.title_number || "").trim() || "—",
            pedido,
            data: dataNota,
            vencimento: toISO(r.due_date),
            valor: cancelado ? 0 : num(r.amount),
            valorCancelado: cancelado ? num(r.amount) : 0,
            pago,
            parcelas: 1,
            origem: "financeiro",
            descricao: r.description || r.category || "",
            titulos: cancelado ? [] : [r],
            bpId: r.billing_pipeline_id || null,
            scId: r.sales_card_id || null,
            fiId: r.fiscal_invoice_id || null,
          });
        } else {
          if (cancelado) cur.valorCancelado += num(r.amount);
          else { cur.valor += num(r.amount); cur.titulos.push(r); }
          cur.pago += pago;
          cur.parcelas += 1;
          if (dataNota && (!cur.data || dataNota < cur.data)) cur.data = dataNota;
          const venc = toISO(r.due_date);
          if (venc && (!cur.vencimento || venc > cur.vencimento)) cur.vencimento = venc;
          if (!cur.pedido && pedido) cur.pedido = pedido;
          if (!cur.bpId && r.billing_pipeline_id) cur.bpId = r.billing_pipeline_id;
          if (!cur.scId && r.sales_card_id) cur.scId = r.sales_card_id;
          if (!cur.fiId && r.fiscal_invoice_id) cur.fiId = r.fiscal_invoice_id;
        }
        if (nf) nfSeen.add(nf);
      }

      // 3) NF-e emitidas no sistema que não apareceram no financeiro
      const nfeRes: any = await db.execute(sql`
        SELECT f.id, f.invoice_number, f.series, f.status, f.total_invoice,
               f.emission_date, f.authorization_date, f.cancellation_date,
               f.nature_of_operation, f.payment_method
        FROM fiscal_invoices f
        WHERE (f.customer_id = ${customerId}
               ${doc.length >= 11 ? sql` OR REGEXP_REPLACE(COALESCE(f.customer_cnpj_cpf,''), '\\D', '', 'g') = ${doc}` : sql``})
          AND f.status IN ('authorized','cancelled','cancelada')
        ORDER BY f.emission_date ASC
      `);
      const nfeRows: any[] = nfeRes?.rows || nfeRes || [];
      const canceladas: any[] = [];
      for (const f of nfeRows) {
        const nf = nfKeyOf(f.invoice_number);
        if (f.status === "cancelled" || f.status === "cancelada") {
          if (nf) canceladas.push({ nf, data: toISO(f.cancellation_date || f.emission_date), valor: num(f.total_invoice) });
          continue;
        }
        if (nf && nfSeen.has(nf)) continue; // já veio pelo financeiro
        const key = nf ? `NF:${nf}` : `NFE:${f.id}`;
        if (notas.has(key)) continue;
        notas.set(key, {
          key,
          nf: nf || "—",
          pedido: "",
          data: toISO(f.authorization_date || f.emission_date),
          vencimento: toISO(f.emission_date),
          valor: num(f.total_invoice),
          valorCancelado: 0,
          pago: 0,
          parcelas: 1,
          origem: "nfe",
          descricao: f.nature_of_operation || "NF-e emitida",
          titulos: [],
          fiId: f.id,
        });
        if (nf) nfSeen.add(nf);
      }
      const canceladasSet = new Set(canceladas.map((c) => c.nf));

      // 4) Pedidos faturados sem contrapartida (fecha buracos do histórico)
      const bpRes: any = await db.execute(sql`
        SELECT b.id, b.order_number, b.invoice_number, b.sale_value, b.stage,
               b.payment_method, b.created_at, b.updated_at, b.seller_name
        FROM billing_pipeline b
        WHERE b.customer_id = ${customerId}
          AND b.invoice_number IS NOT NULL AND b.invoice_number <> ''
        ORDER BY b.created_at ASC
      `);
      const bpRows: any[] = bpRes?.rows || bpRes || [];
      for (const b of bpRows) {
        const nf = nfKeyOf(b.invoice_number);
        if (!nf || nfSeen.has(nf)) continue;
        const key = `NF:${nf}`;
        if (notas.has(key)) continue;
        notas.set(key, {
          key,
          nf,
          pedido: String(b.order_number || ""),
          data: toISO(b.updated_at || b.created_at),
          vencimento: toISO(b.updated_at || b.created_at),
          valor: num(b.sale_value),
          valorCancelado: 0,
          pago: 0,
          parcelas: 1,
          origem: "pedido",
          descricao: `Pedido ${b.order_number || ""}`.trim(),
          titulos: [],
          bpId: b.id,
        });
        nfSeen.add(nf);
      }

      // ── Produtos faturados por nota ─────────────────────────────────────────
      // Resolve a lista de itens de cada nota na ordem: billing_pipeline ->
      // sales_cards -> fiscal_invoice_items. Busca em lote para evitar N+1.
      const notasArrAll = Array.from(notas.values());
      const idsIn = (arr: string[]) => sql.join(arr.map((x) => sql`${x}`), sql`, `);
      const bpProdMap = new Map<string, any[]>();
      const scProdMap = new Map<string, any[]>();
      const fiProdMap = new Map<string, any[]>();
      const bpIds = Array.from(new Set(notasArrAll.map((n) => n.bpId).filter(Boolean) as string[]));
      const scIds = Array.from(new Set(notasArrAll.map((n) => n.scId).filter(Boolean) as string[]));
      const fiIds = Array.from(new Set(notasArrAll.map((n) => n.fiId).filter(Boolean) as string[]));
      try {
        for (let i = 0; i < bpIds.length; i += 500) {
          const lote = bpIds.slice(i, i + 500);
          const r: any = await db.execute(sql`SELECT id, products FROM billing_pipeline WHERE id IN (${idsIn(lote)})`);
          for (const row of (r.rows || r) as any[]) bpProdMap.set(String(row.id), Array.isArray(row.products) ? row.products : []);
        }
      } catch (_e) {}
      try {
        for (let i = 0; i < scIds.length; i += 500) {
          const lote = scIds.slice(i, i + 500);
          const r: any = await db.execute(sql`SELECT id, products FROM sales_cards WHERE id IN (${idsIn(lote)})`);
          for (const row of (r.rows || r) as any[]) scProdMap.set(String(row.id), Array.isArray(row.products) ? row.products : []);
        }
      } catch (_e) {}
      try {
        for (let i = 0; i < fiIds.length; i += 500) {
          const lote = fiIds.slice(i, i + 500);
          const r: any = await db.execute(sql`
            SELECT invoice_id, product_name, quantity, unit, unit_price, total_price, item_number
            FROM fiscal_invoice_items WHERE invoice_id IN (${idsIn(lote)})
            ORDER BY item_number ASC`);
          for (const row of (r.rows || r) as any[]) {
            const arr = fiProdMap.get(String(row.invoice_id)) || [];
            arr.push(row);
            fiProdMap.set(String(row.invoice_id), arr);
          }
        }
      } catch (_e) {}
      const produtosDaNota = (n: NotaAgg): any[] => {
        const bp = n.bpId ? bpProdMap.get(String(n.bpId)) : null;
        if (bp && bp.length) return bp.map((p: any) => ({ nome: p.name || "—", quantidade: num(p.quantity), unidade: null, unitPrice: num(p.unitPrice), totalPrice: num(p.totalPrice) }));
        const sc = n.scId ? scProdMap.get(String(n.scId)) : null;
        if (sc && sc.length) return sc.map((p: any) => ({ nome: p.name || "—", quantidade: num(p.quantity), unidade: null, unitPrice: num(p.unitPrice), totalPrice: num(p.totalPrice) }));
        const fi = n.fiId ? fiProdMap.get(String(n.fiId)) : null;
        if (fi && fi.length) return fi.map((p: any) => ({ nome: p.product_name || "—", quantidade: num(p.quantity), unidade: p.unit || null, unitPrice: num(p.unit_price), totalPrice: num(p.total_price) }));
        return [];
      };

      // ── Constrói as linhas do extrato ──────────────────────────────────────
      const hoje = new Date();
      const hojeDia = hojeBR(); // dia de hoje em America/Sao_Paulo (YYYY-MM-DD)
      const linhas: any[] = [];

      // Operações informativas (não são dívida): DEVOLUÇÃO DE VENDA, faturamento de
      // outra praça ([GYN]), TROCA DE MERCADORIA, REMESSA DE AMOSTRA GRÁTIS e
      // "Outra saída de mercadoria ou prestação de serviço não especificado"
      // (CFOP 5949/6949 — bonificação, brinde, remessa: não gera cobrança).
      // Não ganham tag de situação e o seu valor NÃO entra no saldo devedor /
      // vencido / a vencer.
      const foraDaDivida = (d: any) =>
        /DEVOLU|\[GYN\]|\[IND\]|TROCA|AMOSTRA|OUTRAS?\s+SA[IÍ]DAS?/i.test(String(d || ""));

      for (const n of Array.from(notas.values())) {
        const cancelada = canceladasSet.has(n.nf) || (n.valor <= 0.009 && n.valorCancelado > 0.009);
        const saldoTitulo = Math.max(0, n.valor - n.pago);
        const vencido = !cancelada && saldoTitulo > 0.009 && estaVencido(n.vencimento, hojeDia);
        const semTag = foraDaDivida(n.descricao);
        const situacao = semTag
          ? null
          : cancelada
          ? "Cancelada"
          : saldoTitulo <= 0.009
          ? "Quitada"
          : vencido
          ? "Vencida"
          : n.pago > 0
          ? "Parcial"
          : "Em aberto";

        // Pormenores da nota: parcelas (títulos) e pagamentos aplicados a ela.
        const detParcelas = n.titulos.map((t: any) => ({
          titulo: String(t.title_number || "").trim() || null,
          vencimento: toISO(t.due_date),
          valor: num(t.amount),
          pago: num(t.amount_paid),
          status: t.status || null,
          formaPagamento: PM_LABEL[t.payment_method] || t.payment_method || null,
          categoria: t.category || null,
          descricao: t.description || null,
        }));
        const detPagsNota: any[] = [];
        for (const t of n.titulos) {
          for (const p of (payByRec.get(t.id) || [])) {
            detPagsNota.push({
              data: toISO(p.paid_at),
              valor: num(p.amount),
              formaPagamento: PM_LABEL[p.payment_method] || p.payment_method || null,
              conta: p.account_name || null,
              referencia: p.reference || p.notes || null,
              titulo: String(t.title_number || "").trim() || null,
            });
          }
        }

        linhas.push({
          key: `${n.key}|nf`,
          data: n.data,
          tipo: "NF",
          documento: n.nf !== "—" ? `NF ${n.nf}` : "Título",
          nf: n.nf,
          pedido: n.pedido || null,
          descricao: n.descricao || null,
          vencimento: n.vencimento,
          parcelas: n.parcelas,
          debito: cancelada ? 0 : n.valor,
          credito: 0,
          valorNota: n.valor,
          pagoNota: n.pago,
          saldoNota: saldoTitulo,
          situacao,
          origem: n.origem,
          cancelada,
          diasAtraso: vencido ? diffDias(hojeDia, diaUTC(n.vencimento)) : null,
          formaPagamento: null,
          estimado: false,
          detalhe: {
            tipo: "NF",
            nf: n.nf,
            pedido: n.pedido || null,
            emissao: n.data,
            vencimento: n.vencimento,
            valorTotal: n.valor,
            pago: n.pago,
            saldo: saldoTitulo,
            parcelasQtd: n.parcelas,
            origem: ORIGEM_LABEL[n.origem] || n.origem,
            situacao,
            cancelada,
            parcelas: detParcelas,
            pagamentos: detPagsNota,
            produtos: produtosDaNota(n),
          },
        });

        // Pagamentos de cada título da nota
        for (const t of n.titulos) {
          const reais = payByRec.get(t.id) || [];
          if (reais.length) {
            for (const p of reais) {
              linhas.push({
                key: `pg:${p.id}`,
                data: toISO(p.paid_at),
                tipo: "PAGAMENTO",
                documento: n.nf !== "—" ? `NF ${n.nf}` : `Título ${t.title_number || ""}`.trim(),
                nf: n.nf,
                pedido: n.pedido || null,
                descricao: p.reference || p.notes || p.account_name || "Baixa",
                vencimento: toISO(t.due_date),
                parcelas: null,
                debito: 0,
                credito: num(p.amount),
                situacao: "Recebido",
                origem: "baixa",
                formaPagamento: PM_LABEL[p.payment_method] || p.payment_method || null,
                conta: p.account_name || null,
                estimado: false,
                diasAtraso: diffDias(diaBR(p.paid_at), diaUTC(t.due_date)),
                detalhe: {
                  tipo: "PAGAMENTO",
                  pagoEm: toISO(p.paid_at),
                  valor: num(p.amount),
                  formaPagamento: PM_LABEL[p.payment_method] || p.payment_method || null,
                  conta: p.account_name || null,
                  referencia: p.reference || null,
                  obs: p.notes || null,
                  nf: n.nf,
                  pedido: n.pedido || null,
                  tituloNumero: String(t.title_number || "").trim() || null,
                  tituloVencimento: toISO(t.due_date),
                  diasAtraso: diffDias(diaBR(p.paid_at), diaUTC(t.due_date)),
                  estimado: false,
                },
              });
            }
          } else if (num(t.amount_paid) > 0.009) {
            // Baixa importada do histórico sem data — estimamos no vencimento.
            linhas.push({
              key: `pgest:${t.id}`,
              data: toISO(t.due_date),
              tipo: "PAGAMENTO",
              documento: n.nf !== "—" ? `NF ${n.nf}` : `Título ${t.title_number || ""}`.trim(),
              nf: n.nf,
              pedido: n.pedido || null,
              descricao: "Baixa importada (data estimada no vencimento)",
              vencimento: toISO(t.due_date),
              parcelas: null,
              debito: 0,
              credito: num(t.amount_paid),
              situacao: "Recebido",
              origem: "baixa_importada",
              formaPagamento: PM_LABEL[t.payment_method] || t.payment_method || null,
              estimado: true,
              diasAtraso: 0,
              detalhe: {
                tipo: "PAGAMENTO",
                pagoEm: toISO(t.due_date),
                valor: num(t.amount_paid),
                formaPagamento: PM_LABEL[t.payment_method] || t.payment_method || null,
                conta: null,
                referencia: null,
                obs: "Baixa importada do histórico sem data — estimada no vencimento.",
                nf: n.nf,
                pedido: n.pedido || null,
                tituloNumero: String(t.title_number || "").trim() || null,
                tituloVencimento: toISO(t.due_date),
                diasAtraso: 0,
                estimado: true,
              },
            });
          }
        }
      }

      // Ordena por data (NF antes do pagamento no mesmo dia) e acumula saldo
      linhas.sort((a, b) => {
        const da = a.data || "";
        const db_ = b.data || "";
        if (da !== db_) return da < db_ ? -1 : 1;
        if (a.tipo !== b.tipo) return a.tipo === "NF" ? -1 : 1;
        return String(a.documento).localeCompare(String(b.documento));
      });
      let acc = 0;
      for (const l of linhas) {
        acc += (l.debito || 0) - (l.credito || 0);
        l.saldo = Math.round(acc * 100) / 100;
      }

      // Recorte por período (o saldo acumulado permanece o da vida inteira)
      const linhasPeriodo = linhas.filter((l) => {
        if (!l.data) return !start && !end;
        const d = new Date(l.data);
        if (start && d < start) return false;
        if (end && d > end) return false;
        return true;
      });

      // ── Resumo (vida inteira, independente do filtro de período) ───────────
      const notasArr = Array.from(notas.values()).filter(
        (n) => !canceladasSet.has(n.nf) && !(n.valor <= 0.009 && n.valorCancelado > 0.009)
      );
      const totalFaturado = notasArr.reduce((s, n) => s + n.valor, 0);
      const totalPago = linhas.filter((l) => l.tipo === "PAGAMENTO").reduce((s, l) => s + l.credito, 0);
      // DEVOLUÇÃO / [GYN] / TROCA / AMOSTRA / OUTRA SAÍDA não entram na dívida:
      // ficam fora do saldo devedor, do vencido e do a vencer.
      const notasDivida = notasArr.filter((n) => !foraDaDivida(n.descricao));
      const saldoDevGyn = notasArr
        .filter((n) => foraDaDivida(n.descricao))
        .reduce((s, n) => s + (n.valor - n.pago), 0);
      const abertos = notasDivida.filter((n) => n.valor - n.pago > 0.009);
      const vencidos = abertos.filter((n) => estaVencido(n.vencimento, hojeDia));
      const datas = notasArr.map((n) => n.data).filter(Boolean).sort() as string[];
      const atrasos = linhas
        .filter((l) => l.tipo === "PAGAMENTO" && !l.estimado && l.diasAtraso !== null)
        .map((l) => l.diasAtraso as number);

      const resumo = {
        totalFaturado: Math.round(totalFaturado * 100) / 100,
        totalPago: Math.round(totalPago * 100) / 100,
        saldoDevedor: Math.round((totalFaturado - totalPago - saldoDevGyn) * 100) / 100,
        totalVencido: Math.round(vencidos.reduce((s, n) => s + (n.valor - n.pago), 0) * 100) / 100,
        totalAVencer:
          Math.round(
            abertos.filter((n) => !estaVencido(n.vencimento, hojeDia)).reduce((s, n) => s + (n.valor - n.pago), 0) * 100
          ) / 100,
        qtdNotas: notasArr.length,
        qtdNotasAbertas: abertos.length,
        qtdPagamentos: linhas.filter((l) => l.tipo === "PAGAMENTO").length,
        ticketMedio: notasArr.length ? Math.round((totalFaturado / notasArr.length) * 100) / 100 : 0,
        primeiraCompra: datas[0] || null,
        ultimaCompra: datas[datas.length - 1] || null,
        diasSemComprar: datas.length ? diffDays(hoje.toISOString(), datas[datas.length - 1]) : null,
        atrasoMedioDias: atrasos.length ? Math.round(atrasos.reduce((s, d) => s + d, 0) / atrasos.length) : null,
        notasCanceladas:
          canceladas.length +
          Array.from(notas.values()).filter((n) => !canceladasSet.has(n.nf) && n.valor <= 0.009 && n.valorCancelado > 0.009).length,
        baixasEstimadas: linhas.filter((l) => l.estimado).length,
        // Duplicatas de reparo de órfãos: as sem baixa foram REMOVIDAS do extrato;
        // as com baixa continuam visíveis e só são sinalizadas.
        titulosFantasma: fantasmasIgnorados.length,
        valorFantasma:
          Math.round(fantasmasIgnorados.reduce((s2, r) => s2 + num(r.amount), 0) * 100) / 100,
        duplicadasComBaixa: duplicadasComBaixa.length,
        valorDuplicadasComBaixa:
          Math.round(duplicadasComBaixa.reduce((s2, r) => s2 + num(r.amount_paid), 0) * 100) / 100,
      };

      res.json({
        customer: {
          id: cust.id,
          name: cust.name,
          fantasyName: cust.fantasy_name,
          companyName: cust.company_name,
          document: cust.cnpj || cust.cpf || null,
          phone: cust.phone,
          city: cust.city,
          state: cust.state,
          address: cust.address,
          isActive: cust.is_active,
          sellerName: (cust.seller_name || "").trim() || null,
        },
        resumo,
        linhas: linhasPeriodo,
        totalLinhas: linhas.length,
        periodo: { start: start ? start.toISOString() : null, end: end ? end.toISOString() : null },
      });
    } catch (error: any) {
      console.error("[extrato-cliente] statement:", error);
      res.status(500).json({ message: error.message });
    }
  });
}
