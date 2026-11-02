// ============================================================================
// GESTÃO DE TROCAS — recebimento e tratamento no CD Goiânia (01/nov/2026)
// ---------------------------------------------------------------------------
// Protótipo aprovado por Flavio ("Protótipo Gestão de Trocas", 25/10) e decisões de 01/11:
//
//   1. Lista de todas as NF-e de TROCA emitidas (natureza "Troca de mercadoria",
//      CFOP 5949/6949), com a situação do tratamento.
//   2. Conferência no CD (flavio, lanucy, robson + admin — os mesmos do recebimento de
//      lote): por produto, qtd recebida, sabor confere, Recebido, Conferido; por garrafa,
//      lote, validade, como chegou e destino. "Copiar para as de baixo" repete lote/validade.
//   3. Fechamento:
//        - Problema de qualidade → "Enviar para Indústria" (chamado para naiara e flavio).
//        - Somente comercial     → registrado; a Indústria só RECEBE O AVISO (chamado
//          informativo), sem validação.
//   4. Validação da Indústria (Naiara e Flavio + admin): parecer por defeito (origem) e
//      destino final; análise da causa; plano de ação.
//   5. Destinos: volta ao estoque · quarentena no CD · enviar à Indústria · devolver ao
//      fornecedor · descarte.
//        - "Volta ao estoque" = entrada no estoque EM USO da GYN no lote informado
//          (lote de mesmo número: soma; não existe: cria). Só garrafa sem defeito.
//        - Descarte: o CD descarta e informa COMO foi feito (texto obrigatório).
//
// Tabela gt_conferencias criada sob demanda (o build não roda db:push). Itens e garrafas
// ficam em JSONB na própria conferência.
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { normalizarNumeroLote } from "./estoque-em-uso";

const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const n = (v: any) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const nomeDe = (u: any) => [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.email || "Usuário";
const dataBr = (d: any) => (d ? new Date(d).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null);

export const CONDICOES: Record<string, string> = {
  ok: "Sem defeito",
  lacre: "Lacre rompido",
  tampa: "Tampa solta / vazando",
  amassada: "Amassada / deformada",
  rotulo: "Rótulo danificado",
  fermentada: "Fermentada (estufada, gás, odor)",
  avaria: "Outra avaria",
  vencida: "Vencida (sem defeito)",
};
export const DESTINOS: Record<string, string> = {
  estoque: "Volta ao estoque",
  quarentena: "Quarentena no CD",
  industria: "Enviar à Indústria",
  fornecedor: "Devolver ao fornecedor",
  descarte: "Descarte",
};
const ORIGENS: Record<string, string> = {
  fabricacao: "Defeito de fabricação (processo)",
  envase: "Defeito de envase / fechamento",
  embalagem: "Embalagem do fornecedor (garrafa, tampa, rótulo)",
  transporte: "Transporte / manuseio",
  cliente: "Armazenamento no cliente",
  nao: "Defeito não confirmado",
};
const ehDefeito = (c: string) => c !== "ok" && c !== "vencida";
const STATUS_LABEL: Record<string, string> = {
  aguardando: "Aguardando chegada",
  em_conferencia: "Em conferência",
  na_industria: "Na Indústria",
  validada: "Validada pela Indústria",
  comercial: "Comercial · Indústria avisada",
};
const DESTINOS_INDUSTRIA = ["naiara", "flavio"];
const NF_TROCA_WHERE = `fi.status = 'authorized' AND COALESCE(fi.operation_type,'saida') <> 'entrada'
  AND UPPER(COALESCE(fi.nature_of_operation,'')) LIKE '%TROCA%'`;

let ensured: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS gt_conferencias (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        invoice_id varchar NOT NULL UNIQUE,
        status varchar NOT NULL DEFAULT 'em_conferencia',
        tipo varchar,
        itens jsonb NOT NULL DEFAULT '[]'::jsonb,
        observacao_cd text,
        descarte_como text,
        conferido_por varchar, conferido_por_nome varchar, enviado_em timestamptz,
        parecer jsonb,
        analise text,
        plano_acao boolean,
        descarte_como_industria text,
        validado_por varchar, validado_por_nome varchar, validado_em timestamptz,
        estoque_lancado jsonb,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`));
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

async function podeConferir(user: any): Promise<boolean> {
  try { const { podeReceberLote } = await import("./recebimento-lote"); return await podeReceberLote(user); } catch { return user?.role === "admin"; }
}
async function podeValidar(user: any): Promise<boolean> {
  if (!user) return false;
  if (user.role === "admin") return true;
  try {
    const { getDestinos } = await import("./chamados-routes");
    const ds = await getDestinos();
    return ds.some((d: any) => DESTINOS_INDUSTRIA.includes(d.key) && (d.userIds || []).map(String).includes(String(user.id)));
  } catch { return false; }
}

async function chamado(keys: string[], assunto: string, descricao: string, prioridade: string, user: any) {
  try {
    const { abrirChamadoSistema } = await import("./chamados-routes");
    await abrirChamadoSistema({ destinoKeys: keys, assunto, descricao, prioridade, autor: user?.id ? { id: String(user.id), nome: nomeDe(user), role: String(user.role || "") } : null });
  } catch (e: any) { console.error("[GESTAO-TROCAS] chamado:", e?.message || e); }
}

async function instanciaGyn(): Promise<string | null> {
  const r = rows(await db.execute(sql`SELECT id, name FROM omie_instances`));
  const g = r.find((i: any) => String(i.name || "").toUpperCase().trim() === "GYN");
  return g ? String(g.id) : null;
}

/** Entrada no estoque EM USO da GYN no lote informado (garrafa de troca que volta ao estoque). */
async function entradaEstoque(itens: Array<{ productId: string; produto: string; lote: string; qtd: number }>, conferenciaId: string, nf: string, user: any) {
  const gyn = await instanciaGyn();
  const out: any[] = [];
  if (!gyn) { console.warn("[GESTAO-TROCAS] instância GYN não encontrada — entrada no estoque ignorada"); return out; }
  for (const it of itens) {
    if (!it.productId || !(it.qtd > 0)) { out.push({ ...it, ok: false, motivo: "produto sem cadastro" }); continue; }
    const lote = normalizarNumeroLote(it.lote) || "SEM-LOTE";
    await db.transaction(async (tx: any) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"estoque-mover-tipo:" + it.productId + ":" + gyn + ":" + lote}))`);
      const ex = rows(await tx.execute(sql`
        SELECT * FROM inventory_lots WHERE product_id = ${it.productId} AND instance_id = ${gyn} AND stock_type = 'in_use'
          AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${lote}
        ORDER BY is_active DESC, created_at ASC LIMIT 1 FOR UPDATE`))[0];
      const nota = `Retorno de troca (NF ${nf}) — volta ao estoque após conferência no CD`;
      let lotId: string; let prev = 0;
      if (ex) {
        lotId = ex.id; prev = n(ex.quantity);
        await tx.execute(sql`UPDATE inventory_lots SET quantity = ${(prev + it.qtd).toFixed(4)}, is_active = true,
          total_cost = CASE WHEN unit_cost IS NOT NULL THEN unit_cost::numeric * ${(prev + it.qtd).toFixed(4)}::numeric ELSE total_cost END,
          updated_at = now() WHERE id = ${lotId}`);
      } else {
        // CMV do lote de mesmo número em outra instância (o custo não muda na transferência).
        const ref = rows(await tx.execute(sql`SELECT unit_cost FROM inventory_lots WHERE product_id = ${it.productId}
          AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${lote} AND unit_cost IS NOT NULL ORDER BY created_at ASC LIMIT 1`))[0];
        const unit = ref ? n(ref.unit_cost) : null;
        const ins = rows(await tx.execute(sql`
          INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, min_quantity, unit_cost, total_cost, notes, is_active, created_at, updated_at)
          VALUES (gen_random_uuid()::varchar, ${it.productId}, ${gyn}, 'in_use', ${lote}, ${it.qtd.toFixed(4)}, '0',
                  ${unit != null ? unit.toFixed(4) : null}, ${unit != null ? (unit * it.qtd).toFixed(2) : null}, ${nota}, true, now(), now())
          RETURNING id`));
        lotId = ins[0].id;
      }
      await tx.execute(sql`
        INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
        VALUES (gen_random_uuid()::varchar, ${lotId}, ${it.productId}, ${gyn}, 'replenish', ${it.qtd.toFixed(4)}, ${prev.toFixed(4)}, ${(prev + it.qtd).toFixed(4)},
                'manual', ${conferenciaId}, ${lote}, ${nota}, ${user?.email || user?.id || null}, now())`);
      out.push({ ...it, lote, lotId, ok: true });
    });
  }
  return out;
}

/** Agrupa garrafas por produto + lote (para lançar estoque e montar os defeitos). */
function agrupar(itens: any[], filtro: (g: any) => boolean) {
  const m = new Map<string, { productId: string; produto: string; lote: string; validade: string; cond: string; destino: string; qtd: number }>();
  for (const it of itens || []) {
    for (const g of it.garrafas || []) {
      if (!filtro(g)) continue;
      const k = `${it.productId}|${normalizarNumeroLote(g.lote)}|${g.cond}|${g.destino}`;
      const e = m.get(k) || { productId: it.productId, produto: it.produto, lote: normalizarNumeroLote(g.lote), validade: g.validade || "", cond: g.cond, destino: g.destino, qtd: 0 };
      e.qtd += 1;
      m.set(k, e);
    }
  }
  return Array.from(m.values());
}

/** Itens normalizados vindos da tela. */
function limparItens(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((it: any) => ({
    invoiceItemId: String(it.invoiceItemId || ""),
    productId: String(it.productId || ""),
    produto: String(it.produto || ""),
    qtdNF: n(it.qtdNF),
    valorUnit: n(it.valorUnit),
    qtdRecebida: Math.max(0, Math.floor(n(it.qtdRecebida))),
    saborOk: !!it.saborOk,
    recebido: !!it.recebido,
    conferido: !!it.conferido,
    garrafas: (Array.isArray(it.garrafas) ? it.garrafas : []).slice(0, 500).map((g: any, i: number) => ({
      n: i + 1,
      lote: String(g.lote || "").trim().slice(0, 40),
      validade: String(g.validade || "").slice(0, 10),
      cond: CONDICOES[g.cond] ? String(g.cond) : "ok",
      destino: DESTINOS[g.destino] ? String(g.destino) : "estoque",
    })),
  }));
}

async function carregarNf(invoiceId: string) {
  const r = rows(await db.execute(sql.raw(`
    SELECT fi.id, fi.invoice_number, fi.total_invoice, fi.customer_id, fi.customer_name, fi.sales_card_id, fi.omie_instance_id,
           to_char(COALESCE(fi.emission_date, fi.authorization_date, fi.created_at), 'DD/MM/YYYY') AS emissao,
           sc.seller_id, sc.parent_card_id,
           TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS vendedor
    FROM fiscal_invoices fi
    LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id
    LEFT JOIN users u ON u.id = sc.seller_id
    WHERE fi.id = '${String(invoiceId).replace(/'/g, "''")}' AND ${NF_TROCA_WHERE} LIMIT 1`)))[0];
  return r || null;
}

export function registerGestaoTrocasRoutes(app: Express) {
  // Lista das NF-e de troca com a situação do tratamento.
  app.get("/api/gestao-trocas", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      try { const { ensureTrocaSchema } = await import("./troca-registros-routes"); await ensureTrocaSchema(); } catch { /* segue */ }
      const dias = Math.min(365, Math.max(7, parseInt(String(req.query?.dias || "60"), 10) || 60));
      const r = rows(await db.execute(sql.raw(`
        SELECT fi.id, fi.invoice_number, fi.total_invoice, fi.customer_name, fi.sales_card_id,
               to_char(COALESCE(fi.emission_date, fi.authorization_date, fi.created_at), 'DD/MM/YYYY') AS emissao,
               COALESCE(fi.emission_date, fi.authorization_date, fi.created_at) AS dt,
               TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS vendedor,
               (SELECT COALESCE(SUM(fii.quantity),0) FROM fiscal_invoice_items fii WHERE fii.invoice_id = fi.id) AS garrafas,
               (SELECT t.motivo FROM troca_registros t
                 WHERE t.sales_card_id IN (fi.sales_card_id, sc.parent_card_id) ORDER BY t.created_at DESC LIMIT 1) AS motivo,
               g.status, g.tipo
        FROM fiscal_invoices fi
        LEFT JOIN sales_cards sc ON sc.id = fi.sales_card_id
        LEFT JOIN users u ON u.id = sc.seller_id
        LEFT JOIN gt_conferencias g ON g.invoice_id = fi.id
        WHERE ${NF_TROCA_WHERE}
          AND COALESCE(fi.emission_date, fi.authorization_date, fi.created_at) >= now() - interval '${dias} days'
        ORDER BY dt DESC LIMIT 500`)));
      const MOT: Record<string, string> = { fermentado: "Fermentado", lacre: "Lacre", tampa: "Tampa", avaria: "Avaria / deformação / rótulo", vencido: "Vencido" };
      res.json({
        dias,
        podeConferir: await podeConferir(req.currentUser),
        podeValidar: await podeValidar(req.currentUser),
        notas: r.map((x: any) => {
          const st = x.status || "aguardando";
          return {
            invoiceId: x.id, nf: x.invoice_number != null ? String(x.invoice_number) : "—", emissao: x.emissao,
            cliente: x.customer_name, vendedor: x.vendedor || null, motivo: x.motivo ? MOT[x.motivo] || x.motivo : null,
            garrafas: n(x.garrafas), valor: n(x.total_invoice), status: st, statusLabel: STATUS_LABEL[st] || st, tipo: x.tipo || null,
          };
        }),
      });
    } catch (e: any) {
      console.error("[GESTAO-TROCAS] lista:", e?.message || e);
      res.status(500).json({ message: "Falha ao listar as notas de troca" });
    }
  });

  // Detalhe de uma NF de troca: cabeçalho, itens da NF, conferência, fotos e histórico dos lotes.
  app.get("/api/gestao-trocas/:invoiceId", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const nf = await carregarNf(req.params.invoiceId);
      if (!nf) return res.status(404).json({ message: "NF de troca não encontrada" });
      const itensNf = rows(await db.execute(sql`
        SELECT id, product_id, product_name, quantity, unit_price FROM fiscal_invoice_items WHERE invoice_id = ${nf.id} ORDER BY item_number`));
      const conf = rows(await db.execute(sql`SELECT * FROM gt_conferencias WHERE invoice_id = ${nf.id} LIMIT 1`))[0] || null;
      const cardIds = [nf.sales_card_id, nf.parent_card_id].filter(Boolean).map(String);
      let fotos: string[] = []; let motivo: string | null = null; let observacaoVendedor: string | null = null;
      if (cardIds.length) {
        const lst = sql.join(cardIds.map((x) => sql`${x}`), sql`, `);
        fotos = rows(await db.execute(sql`SELECT error AS url FROM order_pipeline_audit WHERE outcome = 'troca_photo' AND sales_card_id IN (${lst}) ORDER BY created_at DESC LIMIT 6`)).map((x: any) => String(x.url)).filter(Boolean);
        try {
          const t = rows(await db.execute(sql`SELECT motivo, observacao FROM troca_registros WHERE sales_card_id IN (${lst}) ORDER BY created_at DESC LIMIT 1`))[0];
          motivo = t?.motivo || null; observacaoVendedor = t?.observacao || null;
        } catch { /* sem registro */ }
      }
      const itens = conf?.itens?.length ? conf.itens : itensNf.map((i: any) => ({
        invoiceItemId: i.id, productId: i.product_id || "", produto: i.product_name, qtdNF: n(i.quantity), valorUnit: n(i.unit_price),
        qtdRecebida: Math.round(n(i.quantity)), saborOk: false, recebido: false, conferido: false,
        garrafas: Array.from({ length: Math.round(n(i.quantity)) }, (_, k) => ({ n: k + 1, lote: "", validade: "", cond: "ok", destino: "estoque" })),
      }));
      // Histórico dos lotes com defeito desta nota em outras trocas (para a Indústria).
      const lotesDefeito = new Set<string>(agrupar(itens, (g) => ehDefeito(g.cond)).map((g) => g.lote).filter(Boolean));
      const historico: any[] = [];
      if (lotesDefeito.size) {
        const outras = rows(await db.execute(sql`
          SELECT g.invoice_id, g.itens, g.enviado_em, fi.customer_name, fi.invoice_number
          FROM gt_conferencias g JOIN fiscal_invoices fi ON fi.id = g.invoice_id
          WHERE g.invoice_id <> ${nf.id} AND g.enviado_em IS NOT NULL ORDER BY g.enviado_em DESC LIMIT 300`));
        for (const o of outras) {
          for (const d of agrupar(o.itens || [], (g) => ehDefeito(g.cond))) {
            if (lotesDefeito.has(d.lote)) historico.push({ data: dataBr(o.enviado_em), cliente: o.customer_name, nf: o.invoice_number, produto: d.produto, lote: d.lote, cond: CONDICOES[d.cond], qtd: d.qtd });
          }
        }
      }
      res.json({
        nf: { invoiceId: nf.id, nf: nf.invoice_number, emissao: nf.emissao, cliente: nf.customer_name, vendedor: nf.vendedor || null, valor: n(nf.total_invoice), motivo, observacaoVendedor, fotos },
        conferencia: conf ? {
          status: conf.status, statusLabel: STATUS_LABEL[conf.status] || conf.status, tipo: conf.tipo, observacaoCd: conf.observacao_cd, descarteComo: conf.descarte_como,
          conferidoPor: conf.conferido_por_nome, enviadoEm: dataBr(conf.enviado_em), parecer: conf.parecer || [], analise: conf.analise,
          planoAcao: conf.plano_acao, descarteComoIndustria: conf.descarte_como_industria, validadoPor: conf.validado_por_nome, validadoEm: dataBr(conf.validado_em),
        } : { status: "aguardando", statusLabel: STATUS_LABEL.aguardando },
        itens,
        defeitos: agrupar(itens, (g) => ehDefeito(g.cond)).map((d) => ({ ...d, condLabel: CONDICOES[d.cond], destinoLabel: DESTINOS[d.destino], chave: `${d.productId}|${d.lote}|${d.cond}` })),
        historicoLotes: historico,
        condicoes: CONDICOES, destinos: DESTINOS, origens: ORIGENS,
        podeConferir: await podeConferir(req.currentUser),
        podeValidar: await podeValidar(req.currentUser),
      });
    } catch (e: any) {
      console.error("[GESTAO-TROCAS] detalhe:", e?.message || e);
      res.status(500).json({ message: "Falha ao abrir a nota de troca" });
    }
  });

  // Salvar a conferência sem fechar (continuar depois).
  app.post("/api/gestao-trocas/:invoiceId/salvar", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      if (!(await podeConferir(req.currentUser))) return res.status(403).json({ message: "Sem permissão para conferir trocas no CD" });
      const nf = await carregarNf(req.params.invoiceId);
      if (!nf) return res.status(404).json({ message: "NF de troca não encontrada" });
      const atual = rows(await db.execute(sql`SELECT status FROM gt_conferencias WHERE invoice_id = ${nf.id}`))[0];
      if (atual && atual.status !== "em_conferencia") return res.status(409).json({ message: "Esta troca já foi fechada pelo CD" });
      const itens = limparItens(req.body?.itens);
      await db.execute(sql`
        INSERT INTO gt_conferencias (invoice_id, status, itens, observacao_cd, descarte_como, conferido_por, conferido_por_nome)
        VALUES (${nf.id}, 'em_conferencia', ${JSON.stringify(itens)}::jsonb, ${req.body?.observacao || null}, ${req.body?.descarteComo || null}, ${req.currentUser?.id || null}, ${nomeDe(req.currentUser)})
        ON CONFLICT (invoice_id) DO UPDATE SET itens = EXCLUDED.itens, observacao_cd = EXCLUDED.observacao_cd, descarte_como = EXCLUDED.descarte_como,
          conferido_por = EXCLUDED.conferido_por, conferido_por_nome = EXCLUDED.conferido_por_nome, updated_at = now()`);
      res.json({ ok: true });
    } catch (e: any) {
      console.error("[GESTAO-TROCAS] salvar:", e?.message || e);
      res.status(500).json({ message: "Falha ao salvar a conferência" });
    }
  });

  // Fechar a conferência: qualidade → Indústria; comercial → registra e avisa a Indústria.
  app.post("/api/gestao-trocas/:invoiceId/fechar", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const user = req.currentUser;
      if (!(await podeConferir(user))) return res.status(403).json({ message: "Sem permissão para conferir trocas no CD" });
      const nf = await carregarNf(req.params.invoiceId);
      if (!nf) return res.status(404).json({ message: "NF de troca não encontrada" });
      const atual = rows(await db.execute(sql`SELECT status FROM gt_conferencias WHERE invoice_id = ${nf.id}`))[0];
      if (atual && atual.status !== "em_conferencia") return res.status(409).json({ message: "Esta troca já foi fechada pelo CD" });
      const tipo = req.body?.tipo === "comercial" ? "comercial" : "qualidade";
      const itens = limparItens(req.body?.itens);
      const observacao = String(req.body?.observacao || "").trim() || null;
      const descarteComo = String(req.body?.descarteComo || "").trim() || null;
      if (!itens.length) return res.status(400).json({ message: "Nenhum produto na conferência" });
      for (const it of itens) {
        if (!it.recebido || !it.conferido) return res.status(400).json({ message: `Marque Recebido e Conferido em ${it.produto}` });
        for (const g of it.garrafas) {
          if (!g.lote || !g.validade) return res.status(400).json({ message: `Informe lote e validade de todas as garrafas de ${it.produto}` });
        }
      }
      const todas = itens.flatMap((i) => i.garrafas);
      const defeitos = todas.filter((g) => ehDefeito(g.cond)).length;
      if (tipo === "comercial" && defeitos) return res.status(400).json({ message: `Há ${defeitos} garrafa(s) com defeito: troca de qualidade, envie para a Indústria` });
      if (todas.some((g) => g.destino === "estoque" && g.cond !== "ok")) return res.status(400).json({ message: "Só volta ao estoque garrafa sem defeito e dentro da validade" });
      if (todas.some((g) => g.destino === "descarte") && (!descarteComo || descarteComo.length < 5)) return res.status(400).json({ message: "Informe como foi feito o descarte" });

      const status = tipo === "comercial" ? "comercial" : "na_industria";
      const ins = rows(await db.execute(sql`
        INSERT INTO gt_conferencias (invoice_id, status, tipo, itens, observacao_cd, descarte_como, conferido_por, conferido_por_nome, enviado_em)
        VALUES (${nf.id}, ${status}, ${tipo}, ${JSON.stringify(itens)}::jsonb, ${observacao}, ${descarteComo}, ${user?.id || null}, ${nomeDe(user)}, now())
        ON CONFLICT (invoice_id) DO UPDATE SET status = EXCLUDED.status, tipo = EXCLUDED.tipo, itens = EXCLUDED.itens, observacao_cd = EXCLUDED.observacao_cd,
          descarte_como = EXCLUDED.descarte_como, conferido_por = EXCLUDED.conferido_por, conferido_por_nome = EXCLUDED.conferido_por_nome,
          enviado_em = now(), updated_at = now()
        RETURNING id`))[0];

      // Garrafas sem defeito com destino "volta ao estoque": entram já no estoque da GYN.
      const paraEstoque = agrupar(itens, (g) => g.destino === "estoque" && g.cond === "ok").map((g) => ({ productId: g.productId, produto: g.produto, lote: g.lote, qtd: g.qtd }));
      const lancado = paraEstoque.length ? await entradaEstoque(paraEstoque, ins.id, String(nf.invoice_number || ""), user) : [];
      await db.execute(sql`UPDATE gt_conferencias SET estoque_lancado = ${JSON.stringify(lancado)}::jsonb WHERE id = ${ins.id}`);

      const resumo = agrupar(itens, () => true).map((g) => `${g.qtd} × ${g.produto} · lote ${g.lote} · ${CONDICOES[g.cond]} → ${DESTINOS[g.destino]}`).join("\n");
      const cab = `NF de troca ${nf.invoice_number} · ${nf.customer_name || ""} · vendedor ${nf.vendedor || "—"} · conferida por ${nomeDe(user)}`;
      if (tipo === "comercial") {
        await chamado(DESTINOS_INDUSTRIA, `AVISO - TROCA COMERCIAL - NF ${nf.invoice_number} - ${String(nf.customer_name || "").toUpperCase()}`,
          `${cab}\nSem defeito de fabricação, envase ou industrialização: apenas pleito comercial.\n\n${resumo}${descarteComo ? `\n\nDescarte: ${descarteComo}` : ""}`, "Baixa", user);
      } else {
        await chamado(DESTINOS_INDUSTRIA, `TROCA PARA VALIDACAO DA INDUSTRIA - NF ${nf.invoice_number} - ${String(nf.customer_name || "").toUpperCase()}`,
          `${cab}\n${defeitos} garrafa(s) com defeito.\n\n${resumo}${observacao ? `\n\nObservação do CD: ${observacao}` : ""}\n\nValide em Produtos e Estoque › Gestão de Trocas.`, "Normal", user);
      }
      res.json({ ok: true, status, estoque: lancado });
    } catch (e: any) {
      console.error("[GESTAO-TROCAS] fechar:", e?.message || e);
      res.status(500).json({ message: "Falha ao fechar a conferência" });
    }
  });

  // Indústria devolve ao CD para correção.
  app.post("/api/gestao-trocas/:invoiceId/devolver", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      if (!(await podeValidar(req.currentUser))) return res.status(403).json({ message: "Sem permissão para validar trocas" });
      const motivo = String(req.body?.motivo || "").trim();
      if (motivo.length < 3) return res.status(400).json({ message: "Informe o que o CD deve corrigir" });
      const r = rows(await db.execute(sql`UPDATE gt_conferencias SET status = 'em_conferencia', observacao_cd = COALESCE(observacao_cd,'') || ${`\n[Devolvido pela Indústria] ${motivo}`}, updated_at = now()
        WHERE invoice_id = ${req.params.invoiceId} AND status = 'na_industria' RETURNING id`));
      if (!r.length) return res.status(409).json({ message: "A troca não está aguardando a Indústria" });
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: "Falha ao devolver ao CD" });
    }
  });

  // Validação da Indústria: parecer por defeito, destino final, análise e plano de ação.
  app.post("/api/gestao-trocas/:invoiceId/validar", authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const user = req.currentUser;
      if (!(await podeValidar(user))) return res.status(403).json({ message: "Sem permissão para validar trocas" });
      const conf = rows(await db.execute(sql`SELECT * FROM gt_conferencias WHERE invoice_id = ${req.params.invoiceId} LIMIT 1`))[0];
      if (!conf || conf.status !== "na_industria") return res.status(409).json({ message: "A troca não está aguardando a Indústria" });
      const defeitos = agrupar(conf.itens || [], (g) => ehDefeito(g.cond));
      const parecerIn: any[] = Array.isArray(req.body?.parecer) ? req.body.parecer : [];
      const parecer = defeitos.map((d) => {
        const chave = `${d.productId}|${d.lote}|${d.cond}`;
        const p = parecerIn.find((x: any) => x?.chave === chave) || {};
        return { chave, produto: d.produto, lote: d.lote, cond: d.cond, qtd: d.qtd, destinoCd: d.destino,
          origem: ORIGENS[p.origem] ? String(p.origem) : "", destinoFinal: DESTINOS[p.destinoFinal] ? String(p.destinoFinal) : d.destino };
      });
      if (parecer.some((p) => !p.origem)) return res.status(400).json({ message: "Dê o parecer de todas as linhas" });
      const analise = String(req.body?.analise || "").trim();
      if (analise.length < 5) return res.status(400).json({ message: "Escreva a análise e a causa provável" });
      const descarteInd = String(req.body?.descarteComo || "").trim() || null;
      if (parecer.some((p) => p.destinoFinal === "descarte" && p.destinoCd !== "descarte") && (!descarteInd || descarteInd.length < 5)) {
        return res.status(400).json({ message: "Informe como será/foi feito o descarte" });
      }
      // Liberado para o estoque pela Indústria: entra no estoque da GYN.
      const liberar = parecer.filter((p) => p.destinoFinal === "estoque" && p.destinoCd !== "estoque");
      const nfNum = rows(await db.execute(sql`SELECT invoice_number FROM fiscal_invoices WHERE id = ${conf.invoice_id}`))[0]?.invoice_number;
      const lancado = liberar.length ? await entradaEstoque(liberar.map((p) => {
        const d = defeitos.find((x) => `${x.productId}|${x.lote}|${x.cond}` === p.chave)!;
        return { productId: d.productId, produto: d.produto, lote: d.lote, qtd: d.qtd };
      }), conf.id, String(nfNum || ""), user) : [];
      await db.execute(sql`UPDATE gt_conferencias SET status = 'validada', parecer = ${JSON.stringify(parecer)}::jsonb, analise = ${analise},
          plano_acao = ${!!req.body?.planoAcao}, descarte_como_industria = ${descarteInd},
          validado_por = ${user?.id || null}, validado_por_nome = ${nomeDe(user)}, validado_em = now(),
          estoque_lancado = COALESCE(estoque_lancado, '[]'::jsonb) || ${JSON.stringify(lancado)}::jsonb, updated_at = now()
        WHERE id = ${conf.id}`);
      res.json({ ok: true, estoque: lancado });
    } catch (e: any) {
      console.error("[GESTAO-TROCAS] validar:", e?.message || e);
      res.status(500).json({ message: "Falha ao validar a troca" });
    }
  });
}
