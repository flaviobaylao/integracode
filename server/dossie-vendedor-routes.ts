// ─────────────────────────────────────────────────────────────────────────────
// DOSSIÊ POR VENDEDOR — aba "Dossiê do vendedor" da Gestão de Carteiras.
//
// GET  /api/reports/dossie-vendedores?ano=2026
// POST /api/reports/dossie-vendedores/inicio  { userId, data: 'YYYY-MM-DD' | null }  (admin)
//
// Um JSON com TODOS os vendedores de uma vez: a tela escolhe entre "Toda a
// Honest" e um vendedor sem nova chamada. Réguas (as mesmas das outras abas):
//
//  • INÍCIO NA ATIVIDADE = data ajustada à mão (system_settings
//    `dossie_inicio_<userId>`) ou, sem ajuste, o 1º pedido que ele digitou no
//    pipeline. Sem pedido nenhum, o cadastro do usuário. O pipeline só existe
//    desde a virada para o 2.0, por isso a data é ajustável.
//  • CONQUISTA do cliente = a menor entre o cadastro e a 1ª venda de todos os
//    tempos (mesma régua da coluna "Data de conquista").
//  • HERDADO = cliente da carteira atual conquistado ANTES do início dele.
//    CONQUISTADO (cliente novo) = conquistado a partir do início dele.
//  • INATIVADOS POR ELE = mudanças de "Ativo: Sim → Não" gravadas na auditoria
//    do cadastro com o usuário dele. A auditoria só existe desde set/2026.
//  • VENDAS DELE = pedidos que ele digitou no pipeline (regra do implantador).
//  • FATURAMENTO DA CARTEIRA = o que os clientes da carteira atual faturaram,
//    na régua da aba Carteira (computeCarteiraClientes).
// Vendedor e telemarketing recebem só o próprio dossiê.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { computeCarteiraClientes } from "./carteira-routes";

const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];
const limpa = (x: any) => String(x ?? "").replace(/[^A-Za-z0-9_-]/g, "");

function mesAtualBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

const CNPJS_FORA = ["28295493000153", "28295493000234", "28295493000315", "52921727000105", "14877972000173"];

export function registerDossieVendedor(app: Express) {
  app.get("/api/reports/dossie-vendedores", authenticateUser, async (req: Request, res: Response) => {
    try {
      const hoje = mesAtualBR();
      const anoAtual = Number(hoje.slice(0, 4));
      let ano = Number(String(req.query.ano || anoAtual).slice(0, 4));
      if (!Number.isFinite(ano) || ano < 2020 || ano > anoAtual) ano = anoAtual;
      const inicioAno = `${ano}-01`;
      const fimAno = ano === anoAtual ? hoje : `${ano}-12`;

      const usuario: any = (req as any).currentUser || (req as any).user || null;
      const restrito = ["vendedor", "telemarketing"].includes(String(usuario?.role || ""));

      // ── usuários e mapa "qualquer id de vendedor" → id do usuário ─────────
      const users = await q(`SELECT id, first_name, last_name, email, role::text AS role, is_active,
                                    created_at::date::text AS criado, omie_vendor_code, omie_vendor_codes, seller_type
                             FROM users`);
      const idDe = new Map<string, string>();
      const nomeUser = new Map<string, string>();
      for (const u of users) {
        const nome = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || u.id;
        nomeUser.set(u.id, nome);
        idDe.set(String(u.id), u.id);
        const codes: string[] = [];
        if (u.omie_vendor_code) codes.push(String(u.omie_vendor_code));
        if (u.omie_vendor_codes && typeof u.omie_vendor_codes === "object") for (const v of Object.values(u.omie_vendor_codes)) if (v) codes.push(String(v));
        for (const c of codes) { if (!idDe.has(c)) idDe.set(c, u.id); if (!idDe.has(`omie-vendor-${c}`)) idDe.set(`omie-vendor-${c}`, u.id); }
      }
      const resolve = (sid: any): string | null => {
        const s = String(sid ?? "").trim();
        if (!s) return null;
        return idDe.get(s) || idDe.get(s.replace(/^omie-vendor-/, "")) || null;
      };

      // ── ajustes manuais de data de início ────────────────────────────────
      const ajustes = new Map<string, string>();
      try {
        for (const r of await q(`SELECT key, value FROM system_settings WHERE key LIKE 'dossie_inicio_%'`)) {
          const v = String(r.value || "").replace(/"/g, "").slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(v)) ajustes.set(String(r.key).replace("dossie_inicio_", ""), v);
        }
      } catch { /* tabela sempre existe; sem ajuste, segue */ }

      // ── pipeline: 1º pedido de cada vendedor e as vendas dele no ano ─────
      const pipe = await q(`
        SELECT seller_id,
               MIN(created_at)::date::text AS primeiro,
               COUNT(*)::int AS pedidos_total
        FROM billing_pipeline
        WHERE COALESCE(stage::text,'') <> 'lixeira' AND COALESCE(seller_id,'') <> ''
        GROUP BY seller_id`);
      const primeiroPedido = new Map<string, string>();
      for (const r of pipe) {
        const id = resolve(r.seller_id); if (!id) continue;
        const p = String(r.primeiro);
        if (!primeiroPedido.has(id) || p < primeiroPedido.get(id)!) primeiroPedido.set(id, p);
      }
      const vendasRows = await q(`
        SELECT seller_id,
               to_char(created_at, 'YYYY-MM') AS mes,
               COUNT(*)::int AS pedidos,
               COALESCE(SUM(NULLIF(sale_value::text,'')::numeric),0)::float AS valor
        FROM billing_pipeline
        WHERE COALESCE(stage::text,'') <> 'lixeira' AND COALESCE(seller_id,'') <> ''
          AND created_at >= '${inicioAno}-01'::date AND created_at < ('${fimAno}-01'::date + interval '1 month')
        GROUP BY 1, 2`);

      // ── 1ª venda / vendas de todos os tempos por documento ───────────────
      const vidaRows = await q(`
        SELECT NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') AS doc,
               MIN(issue_date)::date::text AS primeira,
               COUNT(*)::int AS titulos,
               COALESCE(SUM(NULLIF(amount::text,'')::numeric),0)::float AS valor
        FROM receivables
        WHERE deleted_at IS NULL AND issue_date IS NOT NULL
          AND COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')
          AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
          AND NOT (UPPER(COALESCE(category,'')) ~ '(APORTE|SOCIO|SÓCIO|EMPREST|ADIANT|DEVOLU|TROCA|AMOSTRA|BONIFICA|BRINDE|DOACAO|DOAÇÃO|REMESSA|TRANSFER)'
                   OR TRIM(COALESCE(category,'')) ~ '^[0-9]+([.-][0-9]+)*$')
          AND regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g') NOT IN (${CNPJS_FORA.map((c) => `'${c}'`).join(",")})
        GROUP BY 1`);
      const vida = new Map<string, { primeira: string; titulos: number; valor: number }>();
      for (const r of vidaRows) if (r.doc) vida.set(String(r.doc), { primeira: String(r.primeira), titulos: Number(r.titulos) || 0, valor: Number(r.valor) || 0 });

      // ── cadastro de clientes (carteira atual) ────────────────────────────
      const custRows = await q(`
        SELECT id, COALESCE(NULLIF(fantasy_name,''), name) AS nome, name AS razao,
               NULLIF(regexp_replace(COALESCE(NULLIF(cnpj,''),NULLIF(cpf,''),''),'[^0-9]','','g'),'') AS doc,
               seller_id, is_active, city, COALESCE(NULLIF(TRIM(segmento_principal),''),'(Sem segmento)') AS segmento,
               created_at::date::text AS criado, inactivated_at::date::text AS inativado
        FROM customers
        WHERE COALESCE(is_supplier,false) = false AND COALESCE(is_lead,false) = false`);

      // ── faturamento do ano por cliente (régua da aba Carteira) ───────────
      const { clientes: fatCli, meses } = await computeCarteiraClientes({ inicio: inicioAno, fim: fimAno, restrito: false });
      const fatPorCust = new Map<string, any>();
      const fatPorDoc = new Map<string, any>();
      for (const c of fatCli) {
        if (c.customerId) fatPorCust.set(String(c.customerId), c);
        if (c.doc) fatPorDoc.set(String(c.doc), c);
      }

      // ── inativações registradas na auditoria ─────────────────────────────
      let inatRows: any[] = [];
      try {
        inatRows = await q(`
          SELECT customer_id, changed_by_user_id, created_at::date::text AS data
          FROM customer_change_history
          WHERE field = 'isActive' AND lower(COALESCE(new_value,'')) NOT IN ('sim','true','t','1')`);
      } catch { inatRows = []; }

      // ── leads ─────────────────────────────────────────────────────────────
      const leadRows = await q(`SELECT created_by, assigned_to, status::text AS status FROM leads`);

      // ── monta por vendedor ───────────────────────────────────────────────
      type Cli = any;
      const porVend = new Map<string, Cli[]>();
      const semVendedor: Cli[] = [];
      const custById = new Map<string, any>();
      for (const c of custRows) {
        const vid = resolve(c.seller_id);
        const v = c.doc ? vida.get(String(c.doc)) : undefined;
        const conquista = [c.criado, v?.primeira].filter(Boolean).sort()[0] || null;
        const fat = fatPorCust.get(String(c.id)) || (c.doc ? fatPorDoc.get(String(c.doc)) : null);
        const item = {
          id: c.id, nome: String(c.nome || "(sem nome)"), doc: c.doc || null, cidade: c.city || "",
          segmento: c.segmento, ativo: c.is_active === true, conquista, cadastro: c.criado, inativado: c.inativado,
          vendasVida: v?.titulos || 0, valorVida: v?.valor || 0, primeiraVenda: v?.primeira || null,
          fatAno: fat ? Number(fat.total) || 0 : 0, vendedorId: vid,
        };
        custById.set(String(c.id), item);
        if (vid) { if (!porVend.has(vid)) porVend.set(vid, []); porVend.get(vid)!.push(item); }
        else semVendedor.push(item);
      }

      // Vendedores que entram no dossiê: papel vendedor/telemarketing ativos, ou
      // qualquer usuário que tenha carteira ou pedido no ano.
      const comPedidoAno = new Set<string>();
      for (const r of vendasRows) { const id = resolve(r.seller_id); if (id) comPedidoAno.add(id); }
      const elegiveis = users.filter((u) =>
        (["vendedor", "telemarketing"].includes(String(u.role)) && u.is_active) || porVend.has(u.id) || comPedidoAno.has(u.id));

      const vendedores = elegiveis.map((u) => {
        const id = u.id;
        const carteira = porVend.get(id) || [];
        const inicio = ajustes.get(id) || primeiroPedido.get(id) || u.criado || null;
        const herdados = carteira.filter((c) => !c.conquista || (inicio && c.conquista < inicio));
        const conquistados = carteira.filter((c) => c.conquista && inicio && c.conquista >= inicio)
          .sort((a, b) => String(b.conquista).localeCompare(String(a.conquista)));
        const vendasMes: Record<string, number> = {}; const pedidosMes: Record<string, number> = {};
        for (const r of vendasRows) if (resolve(r.seller_id) === id) {
          vendasMes[r.mes] = (vendasMes[r.mes] || 0) + (Number(r.valor) || 0);
          pedidosMes[r.mes] = (pedidosMes[r.mes] || 0) + (Number(r.pedidos) || 0);
        }
        const carteiraMes: Record<string, number> = {};
        const segMap = new Map<string, { clientes: number; ativos: number; valor: number }>();
        for (const c of carteira) {
          const fat = fatPorCust.get(String(c.id)) || (c.doc ? fatPorDoc.get(String(c.doc)) : null);
          if (fat?.porMes) for (const m of meses) { const val = Number(fat.porMes[m]) || 0; if (val) carteiraMes[m] = (carteiraMes[m] || 0) + val; }
          const s = segMap.get(c.segmento) || { clientes: 0, ativos: 0, valor: 0 };
          s.clientes++; if (c.ativo) s.ativos++; s.valor += c.fatAno; segMap.set(c.segmento, s);
        }
        const inativadosPorEle = inatRows.filter((r) => String(r.changed_by_user_id || "") === id);
        const idsCarteira = new Set(carteira.map((c) => String(c.id)));
        const inativadosNaCarteira = carteira.filter((c) => !c.ativo).length;
        const meusLeads = leadRows.filter((l) => String(l.created_by || "") === id);
        const leadsAtribuidos = leadRows.filter((l) => String(l.assigned_to || "") === id);
        const contaStatus = (arr: any[]) => ({
          total: arr.length,
          convertidos: arr.filter((l) => l.status === "converted").length,
          descartados: arr.filter((l) => l.status === "discarded").length,
          emAndamento: arr.filter((l) => !["converted", "discarded"].includes(l.status)).length,
        });
        return {
          id, nome: nomeUser.get(id), papel: u.role, tipo: u.seller_type || null, ativoUsuario: !!u.is_active,
          cadastroUsuario: u.criado, primeiroPedido: primeiroPedido.get(id) || null, inicioAjustado: ajustes.get(id) || null, inicio,
          carteira: { total: carteira.length, ativos: carteira.filter((c) => c.ativo).length, inativos: carteira.filter((c) => !c.ativo).length,
                      fatAno: carteira.reduce((s, c) => s + c.fatAno, 0), compraramAno: carteira.filter((c) => c.fatAno > 0).length },
          herdados: { total: herdados.length, ativos: herdados.filter((c) => c.ativo).length, compraramAno: herdados.filter((c) => c.fatAno > 0).length,
                      fatAno: herdados.reduce((s, c) => s + c.fatAno, 0) },
          conquistados: conquistados.map((c) => ({ id: c.id, nome: c.nome, cidade: c.cidade, segmento: c.segmento, ativo: c.ativo,
                      conquista: c.conquista, vendasVida: c.vendasVida, valorVida: c.valorVida, fatAno: c.fatAno })),
          inativadosPorEle: { total: inativadosPorEle.length,
                      lista: inativadosPorEle.map((r) => ({ data: r.data, cliente: custById.get(String(r.customer_id))?.nome || r.customer_id,
                                                           daCarteira: idsCarteira.has(String(r.customer_id)) }))
                                             .sort((a, b) => String(b.data).localeCompare(String(a.data))) },
          inativadosNaCarteira,
          leads: { cadastrados: contaStatus(meusLeads), atribuidos: contaStatus(leadsAtribuidos) },
          vendasMes, pedidosMes, carteiraMes,
          segmentos: Array.from(segMap.entries()).map(([segmento, s]) => ({ segmento, ...s })).sort((a, b) => b.valor - a.valor || b.clientes - a.clientes),
        };
      }).filter((v) => v.carteira.total > 0 || Object.keys(v.vendasMes).length > 0 || v.leads.cadastrados.total > 0)
        .sort((a, b) => b.carteira.fatAno - a.carteira.fatAno);

      // Lista anual: todo cliente que comprou no ano, com o mês a mês.
      const clientesAno = fatCli.filter((c: any) => (Number(c.total) || 0) > 0).map((c: any) => {
        const cad = c.customerId ? custById.get(String(c.customerId)) : null;
        return {
          id: c.customerId || c.chave, nome: c.nome, doc: c.doc || null, cidade: c.cidade || "", segmento: c.segmento,
          ativo: c.ativo === true, vendedorId: cad ? cad.vendedorId : null, vendedor: c.vendedor || "Sem vendedor",
          porMes: c.porMes || {}, total: Number(c.total) || 0,
        };
      });

      const meuId = restrito ? String(usuario?.id || "") : null;
      res.json({
        ok: true, ano, meses, mesCorrente: hoje, restrito,
        vendedores: meuId ? vendedores.filter((v) => v.id === meuId) : vendedores,
        semVendedor: meuId ? [] : semVendedor.sort((a, b) => b.fatAno - a.fatAno || Number(b.ativo) - Number(a.ativo)),
        clientesAno: meuId ? clientesAno.filter((c: any) => c.vendedorId === meuId) : clientesAno,
      });
    } catch (e: any) {
      console.error("[dossie-vendedores]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // Ajuste manual da data de início do vendedor (admin/coordenação).
  app.post("/api/reports/dossie-vendedores/inicio", authenticateUser, async (req: Request, res: Response) => {
    try {
      const u: any = (req as any).currentUser || (req as any).user || null;
      if (!["admin", "coordinator", "administrative"].includes(String(u?.role || ""))) return res.status(403).json({ ok: false, error: "Sem permissão" });
      const userId = limpa(req.body?.userId);
      if (!userId) return res.status(400).json({ ok: false, error: "userId obrigatório" });
      const data = String(req.body?.data || "").slice(0, 10);
      const key = `dossie_inicio_${userId}`;
      if (!data) {
        await db.execute(sql`DELETE FROM system_settings WHERE key = ${key}`);
        return res.json({ ok: true, removido: true });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ ok: false, error: "data inválida" });
      const quem = String(u?.email || u?.id || "admin");
      await db.execute(sql`
        INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${data}, ${quem})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      res.json({ ok: true, data });
    } catch (e: any) {
      console.error("[dossie-vendedores/inicio]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
