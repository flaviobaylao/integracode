// server/cliente-dossie.ts
// -----------------------------------------------------------------------------
// DOSSIÊ DO CLIENTE (nov/2026 — pedido do Flávio)
// Botão "Dossiê do Cliente" na caixa "Ações do Cliente" (todas as telas). Traz:
//   • DATA DE CONQUISTA — a mesma da Gestão de Carteiras: a menor entre o cadastro
//     e o 1º título de venda de todos os tempos (quem veio do 1.0 tem cadastro com
//     a data da importação, por isso o 1º título manda);
//   • OS DOIS ÚLTIMOS VENDEDORES — o atual (desde quando) e o anterior (até quando).
//     Fonte 1: a troca de carteira registrada no histórico do cadastro
//     (customer_change_history, campo sellerId). Fonte 2, quando não há troca
//     registrada (o histórico só começou em set/2026): os pedidos — o vendedor de
//     cada pedido no Omie (billings) e no Integra (billing_pipeline);
//   • UM RELATO CURTO do cliente no Integra, montado com números do próprio sistema
//     (faturamento e classe da Gestão de Carteiras, atendimentos, não vendas,
//     reportes de estoque, trocas, pagamento, inativações e repescagem).
// SOMENTE LEITURA. Mesmo escopo da Gestão de Carteiras: admin e coordenador veem
// qualquer cliente; os demais, só os da própria carteira.
// GET /api/clientes/:id/dossie
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { computeCarteiraClientes } from "./carteira-routes";
import { escopoRestrito } from "./escopo-carteira";

const TZ = "America/Sao_Paulo";
const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);
const dig = (v: any) => String(v ?? "").replace(/\D/g, "");
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dia = (v: any): string | null => {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v).slice(0, 10) || null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
};
const br = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const brl = (v: number) => `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const mesAtual = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const hojeIso = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const mesBr = (ym: string | null) => (ym ? `${MESES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(0, 4)}` : "—");

// A Gestão de Carteiras inteira é cara de calcular: guarda por 10 min e reaproveita
// (uma única conta em andamento por vez, mesmo com várias caixas abertas juntas).
let carteiraCache: { em: number; porId: Map<string, any>; porDoc: Map<string, any> } | null = null;
let carteiraEmAndamento: Promise<void> | null = null;
async function carteira() {
  if (carteiraCache && Date.now() - carteiraCache.em < 10 * 60_000) return carteiraCache;
  if (!carteiraEmAndamento) {
    carteiraEmAndamento = (async () => {
      const { clientes } = await computeCarteiraClientes({ inicio: "2025-01", fim: mesAtual(), restrito: false });
      const porId = new Map<string, any>(), porDoc = new Map<string, any>();
      for (const c of clientes || []) {
        if (c?.customerId) porId.set(String(c.customerId), c);
        if (c?.doc) porDoc.set(dig(c.doc), c);
      }
      carteiraCache = { em: Date.now(), porId, porDoc };
    })().finally(() => { carteiraEmAndamento = null; });
  }
  await carteiraEmAndamento;
  return carteiraCache!;
}

type Usuario = { id: string; nome: string; codigos: string[]; email: string };
async function usuarios(): Promise<Usuario[]> {
  const r = rows(await db.execute(sql`SELECT id, first_name, last_name, email, omie_vendor_code, omie_vendor_codes FROM users`));
  return r.map((u: any) => {
    const codigos: string[] = [];
    if (u.omie_vendor_code) codigos.push(String(u.omie_vendor_code));
    let m = u.omie_vendor_codes;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch { m = null; } }
    if (m && typeof m === "object") for (const v of Object.values(m)) if (v) codigos.push(String(v));
    const nome = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (u.email ? String(u.email).split("@")[0] : String(u.id));
    return { id: String(u.id), nome, codigos, email: String(u.email || "") };
  });
}
function resolvedor(us: Usuario[]) {
  const mapa = new Map<string, string>();
  for (const u of us) {
    mapa.set(u.id, u.nome);
    for (const c of u.codigos) { mapa.set(c, u.nome); mapa.set(`omie-vendor-${c}`, u.nome); }
    if (u.email) mapa.set(u.email.toLowerCase(), u.nome);
    mapa.set(u.nome.toLowerCase(), u.nome);
  }
  return (v: any, reserva?: any): string => {
    const s = String(v ?? "").trim();
    if (!s || s === "—") return String(reserva ?? "").trim();
    return mapa.get(s) || mapa.get(s.toLowerCase()) || mapa.get(s.replace(/^omie-vendor-/, "")) || String(reserva ?? "").trim() || s;
  };
}

const MOTIVOS_NAO_VENDA: Record<string, string> = {
  com_estoque: "com estoque", com_debito: "com débito", estab_fechado: "estabelecimento fechado",
  sem_retorno: "sem retorno", outro_motivo: "outro motivo",
};

export function registerClienteDossie(app: Express): void {
  app.get("/api/clientes/:id/dossie", authenticateUser, async (req: any, res) => {
    try {
      const id = String(req.params.id || "");
      const cad = rows(await db.execute(sql`
        SELECT id, name, fantasy_name, cnpj, cpf, city, state, created_at, seller_id, virtual_service,
               visit_periodicity, segmento_principal, is_active, inactivated_at, omie_client_code, phone, contact
          FROM customers WHERE id = ${id} LIMIT 1`))[0];
      if (!cad) return res.status(404).json({ message: "Cliente não encontrado" });

      // ── Escopo: quem não é admin/coordenador vê só a própria carteira ──────
      const u: any = req.currentUser || req.user || {};
      if (escopoRestrito(u.role)) {
        const meus = new Set<string>([String(u.id || "")]);
        const cods: any[] = [u.omieVendorCode, ...(u.omieVendorCodes && typeof u.omieVendorCodes === "object" ? Object.values(u.omieVendorCodes) : [])];
        for (const c of cods) if (c) { meus.add(String(c)); meus.add(`omie-vendor-${c}`); }
        if (!meus.has(String(cad.seller_id || ""))) {
          return res.status(403).json({ message: "Este cliente não é da sua carteira." });
        }
      }

      const doc = dig(cad.cnpj) || dig(cad.cpf);
      const us = await usuarios();
      const nomeDe = resolvedor(us);
      const hoje = hojeIso();
      const vendedorAtual = nomeDe(cad.seller_id) || "Sem vendedor";

      // ── Gestão de Carteiras (faturamento, classe, conquista, pagamento) ────
      let cart: any = null;
      try {
        const c = await carteira();
        cart = c.porId.get(id) || (doc ? c.porDoc.get(doc) : null) || null;
      } catch (e: any) { console.warn("[cliente-dossie] carteira indisponível:", e?.message); }

      // ── Vendas por vendedor (Omie + Integra) ──────────────────────────────
      const omieCode = cad.omie_client_code ? String(cad.omie_client_code) : "";
      const vendasOmie = rows(await db.execute(sql`
        SELECT seller_id, MAX(seller_name) AS seller_name, MIN(invoice_date) AS primeira, MAX(invoice_date) AS ultima, COUNT(*)::int AS n
          FROM billings
         WHERE invoice_date IS NOT NULL AND COALESCE(is_cancelled,false) = false
           AND COALESCE(NULLIF(total_value::text,'')::numeric,0) > 0
           AND COALESCE(billing_type,'venda') = 'venda'
           AND ( (${omieCode}::text <> '' AND omie_customer_code = ${omieCode})
              OR (${doc}::text <> '' AND regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g') = ${doc}) )
         GROUP BY seller_id`));
      const vendasIntegra = rows(await db.execute(sql`
        SELECT COALESCE(NULLIF(seller_id,''), created_by) AS uid, MIN(created_at) AS primeira, MAX(created_at) AS ultima, COUNT(*)::int AS n
          FROM billing_pipeline
         WHERE customer_id = ${id} AND stage::text <> 'lixeira'
           AND COALESCE(operation_type,'venda') = 'venda'
         GROUP BY 1`));
      const porVendedor = new Map<string, { nome: string; primeira: string | null; ultima: string | null; pedidos: number }>();
      const soma = (nome: string, primeira: any, ultima: any, n: number) => {
        if (!nome) return;
        const k = nome.toLowerCase();
        const a = porVendedor.get(k) || { nome, primeira: null, ultima: null, pedidos: 0 };
        const p = dia(primeira), l = dia(ultima);
        if (p && (!a.primeira || p < a.primeira)) a.primeira = p;
        if (l && (!a.ultima || l > a.ultima)) a.ultima = l;
        a.pedidos += n;
        porVendedor.set(k, a);
      };
      for (const v of vendasOmie) soma(nomeDe(v.seller_id, v.seller_name), v.primeira, v.ultima, num(v.n));
      for (const v of vendasIntegra) soma(nomeDe(v.uid), v.primeira, v.ultima, num(v.n));
      const linhaDoTempo = Array.from(porVendedor.values()).sort((a, b) => String(a.ultima).localeCompare(String(b.ultima)));

      // ── Trocas de carteira registradas no cadastro ────────────────────────
      const trocas = rows(await db.execute(sql`
        SELECT old_value, new_value, created_at, changed_by_name, source
          FROM customer_change_history
         WHERE customer_id = ${id} AND field = 'sellerId'
         ORDER BY created_at`))
        .map((t: any) => ({ de: nomeDe(t.old_value), para: nomeDe(t.new_value), data: dia(t.created_at), quem: t.changed_by_name || null }))
        .filter((t) => t.de !== t.para);

      let atual: any = { nome: vendedorAtual, desde: null as string | null, fonte: "" };
      let anterior: any = null;
      const ultTroca = trocas.length ? trocas[trocas.length - 1] : null;
      if (ultTroca && ultTroca.para.toLowerCase() === vendedorAtual.toLowerCase()) {
        atual = { nome: vendedorAtual, desde: ultTroca.data, fonte: "troca de carteira registrada no cadastro" };
        if (ultTroca.de && ultTroca.de !== "—") {
          anterior = { nome: ultTroca.de, ate: ultTroca.data, fonte: `troca de carteira registrada${ultTroca.quem ? ` por ${ultTroca.quem}` : ""}`, pedidos: porVendedor.get(ultTroca.de.toLowerCase())?.pedidos ?? null, ultimoPedido: porVendedor.get(ultTroca.de.toLowerCase())?.ultima ?? null };
        }
      }
      if (!anterior) {
        // Sem troca registrada: o anterior é quem vendeu por último antes do atual.
        const outros = linhaDoTempo.filter((v) => v.nome.toLowerCase() !== vendedorAtual.toLowerCase());
        const ult = outros.length ? outros[outros.length - 1] : null;
        if (ult) anterior = { nome: ult.nome, ate: ult.ultima, fonte: "pelos pedidos (último pedido dele)", pedidos: ult.pedidos, ultimoPedido: ult.ultima };
      }
      if (!atual.desde) {
        const meu = porVendedor.get(vendedorAtual.toLowerCase());
        if (anterior?.ate && meu?.primeira) {
          const depois = (meu.primeira > anterior.ate) ? meu.primeira : null;
          atual = { nome: vendedorAtual, desde: depois, fonte: depois ? "pelos pedidos (1º pedido depois do anterior)" : "" };
        } else if (meu?.primeira) {
          atual = { nome: vendedorAtual, desde: meu.primeira, fonte: "pelos pedidos (1º pedido dele)" };
        } else {
          atual = { nome: vendedorAtual, desde: dia(cad.created_at), fonte: "data do cadastro" };
        }
      }
      const meuAtual = porVendedor.get(vendedorAtual.toLowerCase());
      atual.pedidos = meuAtual?.pedidos ?? 0;
      atual.ultimoPedido = meuAtual?.ultima ?? null;

      // ── Atendimentos e ocorrências ────────────────────────────────────────
      const at = rows(await db.execute(sql`
        SELECT
          (SELECT COUNT(*)::int FROM virtual_service_logs v WHERE v.entity_type='customer' AND v.customer_id=${id}
              AND NOT (COALESCE(v.attendant_id,'')='ia' AND COALESCE(v.service_type,'')='repescagem_ia')
              AND v.attendance_date >= now() - interval '90 days') AS virt90,
          (SELECT COUNT(*)::int FROM virtual_service_logs v WHERE v.entity_type='customer' AND v.customer_id=${id}
              AND NOT (COALESCE(v.attendant_id,'')='ia' AND COALESCE(v.service_type,'')='repescagem_ia')) AS virt_total,
          (SELECT COUNT(*)::int FROM route_checkpoints rc WHERE rc.customer_id=${id} AND rc.checkpoint_type='check_in'
              AND COALESCE(rc.validation_status,'')<>'cancelled' AND rc.checkpoint_time >= now() - interval '90 days') AS pres90,
          (SELECT COUNT(*)::int FROM route_checkpoints rc WHERE rc.customer_id=${id} AND rc.checkpoint_type='check_in'
              AND COALESCE(rc.validation_status,'')<>'cancelled') AS pres_total,
          (SELECT COUNT(*)::int FROM billing_pipeline bp WHERE bp.customer_id=${id} AND bp.stage::text<>'lixeira'
              AND bp.operation_type='troca' AND bp.created_at >= now() - interval '365 days') AS trocas12,
          (SELECT COUNT(*)::int FROM billing_pipeline bp WHERE bp.customer_id=${id} AND bp.stage::text<>'lixeira'
              AND bp.operation_type='amostra') AS amostras`))[0] || {};
      const naoVendas = rows(await db.execute(sql`
        SELECT COALESCE(NULLIF(no_sale_reason,''),'sem motivo') AS motivo, COUNT(*)::int AS n, MAX(completed_date) AS ultima
          FROM sales_cards WHERE customer_id=${id} AND status='no_sale'
           AND completed_date >= now() - interval '180 days'
         GROUP BY 1 ORDER BY 2 DESC`));
      let estoque: any = { n: 0, ultima: null };
      try {
        estoque = rows(await db.execute(sql`
          SELECT COUNT(*)::int AS n, MAX(created_at) AS ultima FROM change_requests
           WHERE kind='report' AND details->>'reportKind'='nao_venda' AND details->>'motivo' ILIKE '%estoque%'
             AND COALESCE(customer_id, entity_id)::text = ${id}`))[0] || estoque;
      } catch { /* tabela opcional */ }
      const ultimo = rows(await db.execute(sql`
        SELECT data, tipo FROM (
          (SELECT v.attendance_date AS data, 'atendimento virtual' AS tipo FROM virtual_service_logs v
            WHERE v.entity_type='customer' AND v.customer_id=${id} AND v.attendance_date IS NOT NULL
              AND NOT (COALESCE(v.attendant_id,'')='ia' AND COALESCE(v.service_type,'')='repescagem_ia')
            ORDER BY v.attendance_date DESC LIMIT 1)
          UNION ALL
          (SELECT rc.checkpoint_time, 'visita presencial' FROM route_checkpoints rc
            WHERE rc.customer_id=${id} AND rc.checkpoint_type='check_in' AND COALESCE(rc.validation_status,'')<>'cancelled'
            ORDER BY rc.checkpoint_time DESC LIMIT 1)
          UNION ALL
          (SELECT bp.created_at, 'pedido' FROM billing_pipeline bp
            WHERE bp.customer_id=${id} AND bp.stage::text<>'lixeira' ORDER BY bp.created_at DESC LIMIT 1)
        ) x WHERE data IS NOT NULL ORDER BY data DESC LIMIT 1`))[0];

      // ── Relato ────────────────────────────────────────────────────────────
      const conquista: string | null = cart?.conquista || null;
      const relato: string[] = [];
      if (conquista) {
        const viaVenda = cart?.primeiraVenda && cart.primeiraVenda === conquista;
        const anos = diasEntre(conquista, hoje) / 365.25;
        const tempo = anos >= 1 ? `${Math.floor(anos)} ano${Math.floor(anos) > 1 ? "s" : ""}` : `${Math.max(1, Math.round(anos * 12))} ${Math.round(anos * 12) > 1 ? "meses" : "mês"}`;
        relato.push(`Cliente da Honest desde ${br(conquista)} (${tempo}), ${viaVenda ? "data da 1ª venda" : "data do cadastro"}.`);
      } else {
        relato.push(`Cadastrado em ${br(dia(cad.created_at))}, ainda sem nenhuma venda faturada.`);
      }
      const atendTipo = cad.virtual_service ? "virtual" : "presencial";
      const per = cad.visit_periodicity ? String(cad.visit_periodicity) : "";
      relato.push(`Atendimento ${atendTipo}${per ? `, ${per}` : ""}${cad.segmento_principal ? ` · segmento ${cad.segmento_principal}` : ""}${cad.city ? ` · ${cad.city}` : ""}.`);
      if (cart && num(cart.total) > 0) {
        const letra = String(cart.classe || "").slice(0, 1);
        relato.push(`Desde jan/2025 comprou em ${cart.mesesComCompra} ${cart.mesesComCompra === 1 ? "mês" : "meses"}, somando ${brl(num(cart.total))}; média ponderada de ${brl(num(cart.mediaPonderada))}/mês — classe ${cart.classe || letra}.`);
      }
      if (cart?.ultimaVendaData) {
        const sem = num(cart.mesesSemComprar);
        relato.push(`Última compra faturada em ${br(cart.ultimaVendaData)} (${brl(num(cart.ultimaVendaValor))})${sem >= 1 && sem < 999 ? `, há ${sem} ${sem === 1 ? "mês" : "meses"} sem comprar` : ""}${cart.situacao === "perdido" ? " — está no balde de PERDIDOS da carteira" : ""}.`);
      }
      const nvTot = naoVendas.reduce((t: number, x: any) => t + num(x.n), 0);
      const pedacos: string[] = [];
      pedacos.push(`${num(at.virt90)} atendimento${num(at.virt90) === 1 ? "" : "s"} virtua${num(at.virt90) === 1 ? "l" : "is"}`);
      pedacos.push(`${num(at.pres90)} visita${num(at.pres90) === 1 ? "" : "s"} presencia${num(at.pres90) === 1 ? "l" : "is"}`);
      relato.push(`Nos últimos 90 dias: ${pedacos.join(" e ")}.${ultimo ? ` Último contato: ${String(ultimo.tipo)} em ${br(dia(ultimo.data))}.` : ""}`);
      if (nvTot > 0) {
        const motivos = naoVendas.map((x: any) => `${MOTIVOS_NAO_VENDA[x.motivo] || String(x.motivo).replace(/_/g, " ")} (${x.n})`).join(", ");
        relato.push(`Não vendas nos últimos 6 meses: ${nvTot} — ${motivos}.`);
      }
      if (num(estoque.n) > 0) relato.push(`Reportado como "Cliente com Estoque" ${estoque.n} ${num(estoque.n) === 1 ? "vez" : "vezes"} (último em ${br(dia(estoque.ultima))}).`);
      if (num(at.trocas12) > 0) relato.push(`Trocas nos últimos 12 meses: ${at.trocas12}.`);
      if (cart) {
        if (num(cart.debito) > 0) relato.push(`Pagamento: ${brl(num(cart.debito))} vencido em aberto há ${cart.diasVencido} dias.`);
        else if (cart.pontualidade !== null && cart.pontualidade !== undefined) relato.push(`Pagamento em dia hoje; ${Math.round(num(cart.pontualidade) * 100)}% dos títulos pagos até 3 dias do vencimento.`);
        if (num(cart.repescagens) > 0) relato.push(`Caiu em repescagem ${cart.repescagens} ${num(cart.repescagens) === 1 ? "vez" : "vezes"}${cart.ultimaRepescagem ? ` (última em ${br(String(cart.ultimaRepescagem).slice(0, 10))})` : ""}.`);
        const ev = (cart.eventos || []).filter((e: any) => e.tipo === "inativado" || e.tipo === "reativado");
        if (ev.length) relato.push(`Idas e vindas: ${ev.map((e: any) => `${e.tipo} em ${br(e.data)}`).join("; ")}.`);
      }
      if (trocas.length > 1) relato.push(`Já passou por ${trocas.length} trocas de carteira registradas.`);
      if (!cad.is_active) relato.push(`Cadastro INATIVO${cad.inactivated_at ? ` desde ${br(dia(cad.inactivated_at))}` : ""}.`);

      res.json({
        cliente: {
          id, nome: cad.fantasy_name || cad.name, razao: cad.name, documento: doc,
          cidade: [cad.city, cad.state].filter(Boolean).join(" - "), ativo: cad.is_active !== false,
        },
        conquista: {
          data: conquista,
          cadastroEm: cart?.cadastroEm || dia(cad.created_at),
          primeiraVenda: cart?.primeiraVenda || null,
        },
        vendedores: { atual, anterior },
        linhaDoTempo: linhaDoTempo.slice().reverse(),
        trocasRegistradas: trocas.slice().reverse(),
        resumo: cart ? {
          classe: cart.classe, total: num(cart.total), mesesComCompra: cart.mesesComCompra,
          primeiraCompra: mesBr(cart.primeiraCompra), mediaPonderada: num(cart.mediaPonderada),
          ultimaVendaData: cart.ultimaVendaData, ultimaVendaValor: num(cart.ultimaVendaValor),
          debito: num(cart.debito), situacao: cart.situacao,
        } : null,
        relato,
        geradoEm: new Date().toISOString(),
      });
    } catch (e: any) {
      console.error("[cliente-dossie]", e?.message);
      res.status(500).json({ message: "Falha ao montar o dossiê do cliente" });
    }
  });
}
