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
      // ORIGEM DOS DADOS (25/out/2026) — o histórico migrado do Omie (55.436 títulos,
      // emissões de 28/jan/2020 a 18/jun/2026) convive com o que o INTEGRA 2.0 gerou
      // (7.100 títulos, a partir de 31/mar/2026). O histórico tem defeitos conhecidos:
      // 7.298 títulos marcados "recebida" SEM baixa lançada (R$ 2.381.043,93), baixas
      // sem data de pagamento lançadas no vencimento, e 56 NFs que existem NAS DUAS
      // origens. Quem quiser números limpos usa ?origem=integra.
      // Padrão = integra (decisão do Flavio, 25/out/2026): o número financeiro sai
      // limpo por padrão. O RELACIONAMENTO (primeira/última compra) continua olhando
      // TODAS as origens — é o que o vendedor usa para falar com o cliente, e a data
      // de 2020 só existe no acervo migrado. Ver `relacionamento` mais abaixo.
      const origem = String(req.query.origem || "integra").toLowerCase();
      const filtroOrigem =
        origem === "integra" ? sql` AND COALESCE(r.import_origin, '') <> 'omie_historico'`
        : origem === "omie" ? sql` AND COALESCE(r.import_origin, '') = 'omie_historico'`
        : sql``;
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
               r.cancel_reason, r.import_origin,
               r.omie_instance_id, r.created_at
        FROM receivables r
        WHERE r.deleted_at IS NULL
          AND (r.customer_id = ${customerId} ${docCond})${filtroOrigem}
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
      // ESPELHO DO CONTAS A RECEBER (21/out/2026, decisão do Flavio): o Extrato é o
      // histórico de OCORRÊNCIAS financeiras do cliente — nota faturada, paga,
      // vencida, troca, devolução. Nada mais é escondido: todo título que a tela de
      // Contas a Receber mostra aparece aqui. O que muda é a LEITURA de cada linha,
      // não a sua existência.
      //
      // O título fantasma (duplicata de reparo de órfãos) continua visível, mas em
      // LINHA PRÓPRIA e com débito ZERO: se entrasse na mesma NF da nota verdadeira,
      // a linha somaria o valor duas vezes. Fica marcado como "Duplicado".
      const fantasmasIgnorados: any[] = [];
      const duplicadasComBaixa: any[] = [];
      const idsFantasma = new Set<string>();
      for (const r of receivables) {
        if (!ehDuplicata(r)) continue;
        if (temDinheiro(r)) { duplicadasComBaixa.push(r); continue; }
        fantasmasIgnorados.push(r);
        idsFantasma.add(String(r.id));
      }
      const receivablesUteis = receivables;
      if (fantasmasIgnorados.length) {
        console.log(
          `[extrato-cliente] ${fantasmasIgnorados.length} titulo(s) duplicado(s) marcado(s) p/ cliente ${customerId}: ` +
            fantasmasIgnorados.map((r) => `${r.title_number}=${r.amount}`).join(", ")
        );
      }

      // NATUREZA DA OCORRÊNCIA pelo TEXTO — último recurso, só para o histórico
      // migrado, que não tem card de venda. Casar por texto é frágil: existem vendas
      // normais cuja descrição cita um DESCONTO ("DESC. DE R$193,00 REF A TROCAS") e
      // que o regex classificava como troca, tirando-as do saldo devedor. Por isso a
      // regra de verdade é `sales_cards.operation_type` (ver tipoMovimentoDa), e este
      // texto só decide quando NÃO há card.
      const naturezaPorTexto = (desc: any): string | null => {
        const t = String(desc || "");
        if (/\[GYN\]|\[BSB\]|\[IND\]|\[SERV\]/i.test(t)) return "Outra praça";
        if (/TRANSFER/i.test(t)) return "Transferência";
        if (/DEVOLU/i.test(t)) return "Devolução";
        if (/TROCA/i.test(t)) return "Troca";
        if (/AMOSTRA/i.test(t)) return "Amostra";
        if (/OUTRAS?\s+SA[IÍ]DAS?/i.test(t)) return "Outra saída";
        return null;
      };

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
        /** description + category de TODAS as parcelas: é onde mora o marcador. */
        marcadores: string;
        /** true se QUALQUER parcela foi cancelada por devolução de venda. */
        devolucao: boolean;
        /** Justificativa da devolução. Vem da parcela CANCELADA, que não entra em `titulos`. */
        motivoDevolucao: string | null;
        /** true enquanto TODAS as parcelas vierem do histórico migrado do Omie. */
        historico: boolean;
        /** Ocorrência que NÃO gerou conta a receber: aparece, mas sem débito. */
        semCobranca?: boolean;
        /** Rótulo fixo quando a linha não vem de título (troca/amostra/transferência). */
        movimentoFixo?: string;
        /** sales_card_id de qualquer parcela — é por ele que se acha a operação e o motivo. */
        cardIds: string[];
        fantasma?: boolean;
        titulos: any[];
        bpId?: string | null;
        scId?: string | null;
        fiId?: string | null;
      };
      const notas = new Map<string, NotaAgg>();
      const nfSeen = new Set<string>();
      /** Motivo gravado pela rotina de devolução: "... Devolução de venda: <motivo>". */
      const motivoDoTexto = (notas_: any): string | null => {
        const txt = String(notas_ || "");
        const m = txt.match(/Devolu[çc][ãa]o de venda:\s*([^|\n]+)/i) || txt.match(/Motivo:\s*([^|\n]+)/i);
        return m ? m[1].trim().slice(0, 120) || null : null;
      };

      for (const r of receivablesUteis) {
        const nfFromNotes = noteVal(r.notes, "nf");
        const nf = nfKeyOf(nfFromNotes) || nfKeyOf(r.title_number);
        const pedido = noteVal(r.notes, "pedido");
        const fatRaw = noteVal(r.notes, "faturamento");
        const dataNota = toISO(fatRaw || r.issue_date);
        // A chave inclui a instância Omie: duas empresas do grupo podem emitir
        // NFs com o mesmo número, e elas não podem ser fundidas na mesma linha.
        const inst = String(r.omie_instance_id || "");
        const fantasma = idsFantasma.has(String(r.id));
        // Duplicata fica em linha própria: fundida na NF verdadeira ela dobraria o valor.
        const key = fantasma ? `FANT:${r.id}` : nf ? `NF:${inst}:${nf}` : `TIT:${r.id}`;
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
            marcadores: `${r.description || ""} ${r.category || ""}`,
            devolucao: String(r.cancel_reason || "") === "devolucao",
            motivoDevolucao: String(r.cancel_reason || "") === "devolucao" ? motivoDoTexto(r.notes) : null,
            historico: String(r.import_origin || "") === "omie_historico",
            cardIds: r.sales_card_id ? [String(r.sales_card_id)] : [],
            fantasma,
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
          cur.marcadores += ` ${r.description || ""} ${r.category || ""}`;
          if (String(r.cancel_reason || "") === "devolucao") {
            cur.devolucao = true;
            if (!cur.motivoDevolucao) cur.motivoDevolucao = motivoDoTexto(r.notes);
          }
          if (r.sales_card_id && !cur.cardIds.includes(String(r.sales_card_id))) cur.cardIds.push(String(r.sales_card_id));
          if (String(r.import_origin || "") !== "omie_historico") cur.historico = false;
          if (!cur.pedido && pedido) cur.pedido = pedido;
          if (!cur.bpId && r.billing_pipeline_id) cur.bpId = r.billing_pipeline_id;
          if (!cur.scId && r.sales_card_id) cur.scId = r.sales_card_id;
          if (!cur.fiId && r.fiscal_invoice_id) cur.fiId = r.fiscal_invoice_id;
        }
        if (nf) nfSeen.add(nf);
      }

      // ── TIPO DE MOVIMENTO pela FONTE ESTRUTURADA ───────────────────────────
      // `sales_cards.operation_type` diz o que a operação É (venda / troca / amostra /
      // transferência) e `receivables.cancel_reason = 'devolucao'` diz que o título caiu
      // por devolução de venda. Isso substitui o casamento por texto, que confundia
      // venda-com-desconto-de-troca com troca. O motivo da troca vem de `troca_registros`,
      // preenchido no modal de venda (Motivo da troca: fermentado/lacre/tampa/vencido).
      const todosCardIds = Array.from(new Set(Array.from(notas.values()).flatMap((n) => n.cardIds)));
      const opPorCard = new Map<string, string>();
      const trocaPorCard = new Map<string, { motivo: string; observacao: string | null }>();
      if (todosCardIds.length) {
        const emLotes = (arr: string[]) => sql.join(arr.map((x) => sql`${x}`), sql`, `);
        try {
          for (let i = 0; i < todosCardIds.length; i += 500) {
            const lote = todosCardIds.slice(i, i + 500);
            const r: any = await db.execute(sql`SELECT id, operation_type FROM sales_cards WHERE id IN (${emLotes(lote)})`);
            for (const row of (r.rows || r) as any[]) if (row.operation_type) opPorCard.set(String(row.id), String(row.operation_type));
          }
        } catch (_e) {}
        try {
          for (let i = 0; i < todosCardIds.length; i += 500) {
            const lote = todosCardIds.slice(i, i + 500);
            const r: any = await db.execute(sql`
              SELECT DISTINCT ON (sales_card_id) sales_card_id, motivo, observacao
              FROM troca_registros WHERE sales_card_id IN (${emLotes(lote)})
              ORDER BY sales_card_id, created_at DESC`);
            for (const row of (r.rows || r) as any[]) {
              trocaPorCard.set(String(row.sales_card_id), { motivo: String(row.motivo || ""), observacao: row.observacao || null });
            }
          }
        } catch (_e) { /* a tabela de trocas pode ainda nao existir no ambiente */ }
      }
      const OP_ROTULO: Record<string, string> = { troca: "Troca", amostra: "Amostra", transferencia: "Transferência", venda: "Venda" };
      const MOTIVO_TROCA: Record<string, string> = { fermentado: "Fermentado", lacre: "Lacre", tampa: "Tampa", vencido: "Vencido" };

      /** O que esta nota É. Fonte estruturada primeiro; texto só no histórico sem card. */
      const tipoMovimentoDa = (n: NotaAgg): string => {
        if (n.movimentoFixo) return n.movimentoFixo;
        if (n.fantasma) return "Duplicado";
        if (n.devolucao) return "Devolução";
        for (const id of n.cardIds) {
          const op = opPorCard.get(id);
          if (op && op !== "venda") return OP_ROTULO[op] || "Venda";
        }
        if (/\[GYN\]|\[BSB\]|\[IND\]|\[SERV\]/i.test(n.marcadores)) return "Outra praça";
        if (n.cardIds.length) return "Venda"; // tem card e é venda: texto não desclassifica
        return naturezaPorTexto(n.marcadores) || "Venda";
      };

      /** Motivo da troca (registro próprio) ou da devolução (justificativa no texto). */
      const motivoDa = (n: NotaAgg, tipo: string): string | null => {
        if (tipo === "Troca") {
          for (const id of n.cardIds) {
            const t = trocaPorCard.get(id);
            if (t) return MOTIVO_TROCA[t.motivo] || t.motivo || null;
          }
          return null;
        }
        if (tipo === "Devolução") {
          if (n.motivoDevolucao) return n.motivoDevolucao;
          for (const t of n.titulos) {
            const m = motivoDoTexto(t.notes);
            if (m) return m;
          }
          return null;
        }
        return null;
      };

      // ── OCORRÊNCIAS SEM CONTA A RECEBER (25/out/2026) ──────────────────────
      // Troca, amostra e transferência muitas vezes NÃO geram título: na base são 289
      // trocas, 194 amostras e 6 transferências sem nenhum recebível. Como o Extrato
      // passou a ler só o financeiro, essas ocorrências sumiram do histórico do cliente.
      // Decisão do Flavio: resgatar e mostrar. Entram com DÉBITO ZERO — não houve
      // cobrança —, ficam fora do faturado e do saldo devedor, e somam nos cards de
      // Trocas / Devoluções. Pedido cancelado ou sem venda não entra: não ocorreu.
      //
      // A NF-e de devolução NÃO é resgatada de propósito: ela é a contrapartida fiscal
      // da mesma nota que já aparece marcada "Devolução" (conferido no PANIFICADORA
      // MOREIRA: 5 títulos de R$ 301,30 e 5 NF-e de R$ 301,30, a mesma ocorrência).
      // Trazer as duas dobraria o valor devolvido.
      try {
        const opRes: any = await db.execute(sql`
          SELECT sc.id, sc.operation_type, sc.sale_value, sc.status, sc.invoice_number,
                 sc.created_at, sc.updated_at
          FROM sales_cards sc
          WHERE sc.customer_id = ${customerId}
            AND sc.operation_type IN ('troca', 'amostra', 'transferencia')
            AND COALESCE(sc.status, '') NOT IN ('cancelled', 'no_sale')
            AND COALESCE(sc.sale_value, 0) > 0
            AND NOT EXISTS (
              SELECT 1 FROM receivables r
              WHERE r.sales_card_id = sc.id AND r.deleted_at IS NULL
            )
          ORDER BY sc.created_at ASC
        `);
        for (const c of (opRes?.rows || opRes || []) as any[]) {
          const rotulo = OP_ROTULO[String(c.operation_type)] || "Venda";
          const quando = toISO(c.updated_at || c.created_at);
          const nf = nfKeyOf(c.invoice_number);
          notas.set(`OP:${c.id}`, {
            key: `OP:${c.id}`,
            nf: nf || "—",
            pedido: "",
            data: quando,
            vencimento: quando,
            valor: num(c.sale_value),
            valorCancelado: 0,
            pago: 0,
            parcelas: 1,
            origem: "pedido",
            descricao: `${rotulo} sem conta a receber`,
            marcadores: "",
            devolucao: false,
            motivoDevolucao: null,
            cardIds: [String(c.id)],
            historico: false,
            semCobranca: true,
            movimentoFixo: rotulo,
            titulos: [],
            scId: String(c.id),
          });
        }
      } catch (_e) { /* nunca derruba o extrato */ }

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
      // ── QUEM IMPLANTOU O PEDIDO que gerou a NF (21/set/2026) ────────────────
      // O implantador mora em `billing_pipeline.created_by`, quase sempre no formato
      // "auto (<quem>)". O miolo pode ser: e-mail de uma PESSOA, ou o nome de uma
      // ROTINA ("system", "system-liberacao-manual", "hotsite", "balcao (maquininha)",
      // "reconcile-nf"...). Medido em produção: dos 5.973 pedidos com NF, só 1.146
      // têm pessoa identificável — nos demais o pedido nasceu de rotina.
      // Por isso a tela mostra DUAS informações: quem implantou (pessoa ou rotina) e
      // o VENDEDOR da carteira, que o pipeline tem em praticamente todos. Assim nunca
      // se atribui a uma pessoa um pedido que a rotina criou sozinha.
      const bpAutorMap = new Map<string, { criadoPor: string | null; sellerId: string | null; sellerNome: string | null }>();
      const scSellerMap = new Map<string, string | null>();
      const userPorEmail = new Map<string, string>();
      const userPorId = new Map<string, string>();
      try {
        const u: any = await db.execute(sql`
          SELECT id, LOWER(email) AS email,
                 NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '') AS nome
          FROM users`);
        for (const row of (u.rows || u) as any[]) {
          const nome = row.nome || row.email || null;
          if (row.email && nome) userPorEmail.set(String(row.email), String(nome));
          if (row.id && nome) userPorId.set(String(row.id), String(nome));
        }
      } catch (_e) {}
      try {
        for (let i = 0; i < bpIds.length; i += 500) {
          const lote = bpIds.slice(i, i + 500);
          const r: any = await db.execute(sql`SELECT id, created_by, seller_id, seller_name FROM billing_pipeline WHERE id IN (${idsIn(lote)})`);
          for (const row of (r.rows || r) as any[]) {
            bpAutorMap.set(String(row.id), { criadoPor: row.created_by || null, sellerId: row.seller_id || null, sellerNome: row.seller_name || null });
          }
        }
      } catch (_e) {}
      try {
        for (let i = 0; i < scIds.length; i += 500) {
          const lote = scIds.slice(i, i + 500);
          const r: any = await db.execute(sql`SELECT id, seller_id FROM sales_cards WHERE id IN (${idsIn(lote)})`);
          for (const row of (r.rows || r) as any[]) scSellerMap.set(String(row.id), row.seller_id || null);
        }
      } catch (_e) {}

      /** Rótulo amigável para quando o pedido não foi implantado por uma pessoa. */
      const ROTULO_ROTINA: Array<[RegExp, string]> = [
        [/^balcao/i, "Balcão (maquininha)"],
        [/hotsite/i, "Hotsite"],
        [/^reconcile/i, "Reconciliação automática"],
        [/^recuperacao/i, "Recuperação de Faturamento"],
        [/liberacao-manual/i, "Liberação manual de bloqueio"],
        [/debito-regularizado/i, "Liberação por débito regularizado"],
        [/^system|^auto$/i, "Automático (sistema)"],
      ];
      const implantadorDaNota = (n: NotaAgg): { nome: string | null; tipo: "pessoa" | "rotina" | null } => {
        const bp = n.bpId ? bpAutorMap.get(String(n.bpId)) : null;
        const cru = String(bp?.criadoPor || "").trim();
        if (!cru) return { nome: null, tipo: null };
        const m = cru.match(/^auto\s*\((.*)\)$/i);
        const quem = (m ? m[1] : cru).trim();
        const chave = quem.toLowerCase();
        const porEmail = userPorEmail.get(chave);
        if (porEmail) return { nome: porEmail, tipo: "pessoa" };
        // E-mail que não está (mais) no cadastro: mostra o e-mail, é melhor que nada.
        if (/@/.test(quem)) return { nome: quem, tipo: "pessoa" };
        for (const [rx, rotulo] of ROTULO_ROTINA) if (rx.test(chave)) return { nome: rotulo, tipo: "rotina" };
        return { nome: quem, tipo: "rotina" };
      };
      const vendedorDaNota = (n: NotaAgg): string | null => {
        const bp = n.bpId ? bpAutorMap.get(String(n.bpId)) : null;
        if (bp?.sellerId && userPorId.get(String(bp.sellerId))) return userPorId.get(String(bp.sellerId)) || null;
        if (bp?.sellerNome) return String(bp.sellerNome);
        const scSeller = n.scId ? scSellerMap.get(String(n.scId)) : null;
        if (scSeller && userPorId.get(String(scSeller))) return userPorId.get(String(scSeller)) || null;
        return null;
      };

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

      // Operações informativas (não são dívida): DEVOLUÇÃO, outra praça
      // ([GYN]/[BSB]/[IND]/[SERV]), TRANSFERÊNCIA, TROCA, AMOSTRA e CFOP 5949/6949.
      // A regra mora em divida-viva.ts e vale também no badge da rota, no bloqueio
      // de crédito e no alerta. Desde 21/out/2026 elas APARECEM no extrato (é um
      // histórico de ocorrências), levando o nome da ocorrência no lugar da tag de
      // situação; o valor continua FORA do saldo devedor / vencido / a vencer.

      for (const n of Array.from(notas.values())) {
        const cancelada = n.valor <= 0.009 && n.valorCancelado > 0.009;
        const saldoTitulo = Math.max(0, n.valor - n.pago);
        const vencido = !cancelada && saldoTitulo > 0.009 && estaVencido(n.vencimento, hojeDia);
        const tipoMov = tipoMovimentoDa(n);
        const natureza = tipoMov === "Venda" ? null : tipoMov;
        const motivo = motivoDa(n, tipoMov);
        // TIPO DE MOVIMENTO (25/out/2026): a natureza da ocorrência saiu da coluna
        // Situação e virou coluna própria. Assim a Situação volta a ser o status real
        // do título — igual ao Contas a Receber — e a devolução/troca/transferência
        // deixa de perder a informação de "em aberto / quitada / vencida".
        const tipoMovimento = tipoMov;
        const situacao = cancelada
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
          debito: cancelada || n.fantasma || n.semCobranca ? 0 : n.valor,
          credito: 0,
          valorNota: n.valor,
          pagoNota: n.pago,
          saldoNota: saldoTitulo,
          situacao,
          origem: n.origem,
          tipoMovimento,
          motivo,
          historico: n.historico,
          semCobranca: !!n.semCobranca,
          natureza,
          informativa: natureza !== null,
          duplicado: !!n.fantasma,
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
            tipoMovimento,
            motivo,
            natureza,
            duplicado: !!n.fantasma,
            cancelada,
            parcelas: detParcelas,
            pagamentos: detPagsNota,
            produtos: produtosDaNota(n),
            implantadoPor: implantadorDaNota(n).nome,
            implantadoPorTipo: implantadorDaNota(n).tipo,
            vendedor: vendedorDaNota(n),
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
                natureza,
                // O pagamento herda o movimento da sua nota para acompanhar o filtro:
                // filtrar "Venda" tem de trazer as vendas E as baixas delas. A coluna
                // Tipo de movimento continua em branco na linha de pagamento.
                tipoMovimento: tipoMov,
                informativa: natureza !== null,
                historico: n.historico,
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
      // A LISTA é espelho do Contas a Receber; os KPIs continuam sendo de VENDA.
      // Ficam fora das somas de venda: a nota cancelada, o título duplicado (marcado
      // na lista com débito zero) e a operação informativa — devolução, CFOP 5949,
      // transferência entre estabelecimentos e faturamento de outra praça.
      //
      // TROCA e AMOSTRA ficam DENTRO (25/out/2026): na base são 145 e 25 títulos, com
      // R$ 14.642,52 ainda em aberto. Elas geram cobrança de verdade, então esconder
      // do saldo devedor era deixar de cobrar. O que elas ganham é rótulo próprio na
      // coluna Tipo de movimento e KPI próprio.
      const notasVivas = Array.from(notas.values()).filter(
        (n) => !n.fantasma && !n.semCobranca && !(n.valor <= 0.009 && n.valorCancelado > 0.009)
      );
      const INFORMATIVAS = new Set(["Outra praça", "Transferência", "Devolução", "Outra saída"]);
      const ehInformativa = (n: NotaAgg) => INFORMATIVAS.has(tipoMovimentoDa(n));
      const notasArr = notasVivas.filter((n) => !ehInformativa(n));
      const informativas = notasVivas.filter(ehInformativa);
      const totalFaturado = notasArr.reduce((s, n) => s + n.valor, 0);
      const totalPago = linhas
        .filter((l) => l.tipo === "PAGAMENTO" && !l.informativa)
        .reduce((s, l) => s + l.credito, 0);
      const abertos = notasArr.filter((n) => n.valor - n.pago > 0.009);
      const vencidos = abertos.filter((n) => estaVencido(n.vencimento, hojeDia));
      const datas = notasArr.map((n) => n.data).filter(Boolean).sort() as string[];
      // RELACIONAMENTO — primeira e última compra olham SEMPRE todas as origens, mesmo
      // com o extrato filtrado por INTEGRA 2.0. O acervo migrado é ruim de número, mas é
      // nele que mora o começo da relação (há clientes desde 2020) e é disso que o
      // vendedor precisa. Só títulos não cancelados contam como compra.
      let primeiraCompra: string | null = datas[0] || null;
      let ultimaCompra: string | null = datas[datas.length - 1] || null;
      try {
        const relRes: any = await db.execute(sql`
          SELECT MIN(r.issue_date) AS primeira, MAX(r.issue_date) AS ultima
          FROM receivables r
          WHERE r.deleted_at IS NULL
            AND COALESCE(r.status, '') <> 'cancelada'
            AND (r.customer_id = ${customerId} ${docCond})
        `);
        const rel: any = (relRes?.rows || relRes || [])[0];
        const pri = toISO(rel?.primeira);
        const ult = toISO(rel?.ultima);
        if (pri && (!primeiraCompra || pri < primeiraCompra)) primeiraCompra = pri;
        if (ult && (!ultimaCompra || ult > ultimaCompra)) ultimaCompra = ult;
      } catch (_e) { /* mantém as datas do recorte atual */ }
      const atrasos = linhas
        .filter((l) => l.tipo === "PAGAMENTO" && !l.estimado && l.diasAtraso !== null)
        .map((l) => l.diasAtraso as number);
      // KPIs de ocorrência: quanto este cliente já devolveu e quanto já trocou.
      // A devolução cancela o título, então o valor mora em `valorCancelado`.
      const porTipo = (tipo: string) =>
        Array.from(notas.values())
          .filter((n) => !n.fantasma && tipoMovimentoDa(n) === tipo)
          .reduce((s, n) => s + n.valor + n.valorCancelado, 0);
      const historicas = notasVivas.filter((n) => n.historico);
      const semCobranca = Array.from(notas.values()).filter((n) => n.semCobranca);
      const totalDevolucoes = porTipo("Devolução");
      const totalTrocas = porTipo("Troca");

      const resumo = {
        totalFaturado: Math.round(totalFaturado * 100) / 100,
        totalPago: Math.round(totalPago * 100) / 100,
        saldoDevedor: Math.round((totalFaturado - totalPago) * 100) / 100,
        totalVencido: Math.round(vencidos.reduce((s, n) => s + (n.valor - n.pago), 0) * 100) / 100,
        totalDevolucoes: Math.round(totalDevolucoes * 100) / 100,
        totalTrocas: Math.round(totalTrocas * 100) / 100,
        qtdDevolucoes: Array.from(notas.values()).filter((n) => !n.fantasma && tipoMovimentoDa(n) === "Devolução").length,
        qtdTrocas: Array.from(notas.values()).filter((n) => !n.fantasma && tipoMovimentoDa(n) === "Troca").length,
        totalAVencer:
          Math.round(
            abertos.filter((n) => !estaVencido(n.vencimento, hojeDia)).reduce((s, n) => s + (n.valor - n.pago), 0) * 100
          ) / 100,
        qtdNotas: notasArr.length,
        qtdNotasAbertas: abertos.length,
        qtdPagamentos: linhas.filter((l) => l.tipo === "PAGAMENTO").length,
        ticketMedio: notasArr.length ? Math.round((totalFaturado / notasArr.length) * 100) / 100 : 0,
        primeiraCompra,
        ultimaCompra,
        diasSemComprar: ultimaCompra ? diffDays(hoje.toISOString(), ultimaCompra) : null,
        atrasoMedioDias: atrasos.length ? Math.round(atrasos.reduce((s, d) => s + d, 0) / atrasos.length) : null,
        notasCanceladas: Array.from(notas.values()).filter(
          (n) => !n.fantasma && n.valor <= 0.009 && n.valorCancelado > 0.009
        ).length,
        baixasEstimadas: linhas.filter((l) => l.estimado).length,
        // Operações informativas: VISÍVEIS na lista, fora dos KPIs de venda.
        origem,
        notasHistorico: historicas.length,
        valorHistorico: Math.round(historicas.reduce((s2, n) => s2 + n.valor, 0) * 100) / 100,
        ocorrenciasSemCobranca: semCobranca.length,
        valorSemCobranca: Math.round(semCobranca.reduce((s2, n) => s2 + n.valor, 0) * 100) / 100,
        notasInformativas: informativas.length,
        valorInformativas: Math.round(informativas.reduce((s2, n) => s2 + n.valor, 0) * 100) / 100,
        // Duplicatas de reparo de órfãos: visíveis, marcadas e com débito zero.
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
