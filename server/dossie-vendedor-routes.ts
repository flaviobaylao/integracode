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
               created_at::date::text AS criado, inactivated_at::date::text AS inativado,
               -- Motivo da inativacao: a mesma coluna que a Gestao de Clientes
               -- mostra. A trilha de inativacao (server/inativacao-trilha.ts)
               -- preenche ate o acervo antigo, entao vazio aqui quer dizer que
               -- ninguem registrou — e e' isso que a tela deve dizer.
               NULLIF(TRIM(COALESCE(status_reason,'')),'') AS motivo
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

      // ── ÚLTIMO VENDEDOR REGISTRADO de cada cliente ───────────────────────
      // Para a coluna "Último vendedor" da relação de clientes sem vendedor e
      // inativados (Flavio, 13/11/2026): a pergunta ali é "quem perdeu este
      // cliente", e o cadastro não responde — quando o cliente sai da carteira,
      // `customers.seller_id` fica vazio e não sobra rastro nele.
      //
      // O rastro está no histórico: `customer_change_history` grava cada troca
      // MANUAL de vendedor (field='sellerId'), com o rótulo do usuário em
      // new_value. A linha mais recente de cada cliente é o último vendedor que
      // alguém definiu. DISTINCT ON + ORDER BY created_at DESC pega essa linha.
      //
      // COBERTURA: a auditoria começou em set/2026, e só registra troca manual.
      // Cliente que perdeu a carteira antes disso, ou por sincronização, não tem
      // linha nenhuma — e aí a tela diz "não registrado" em vez de inventar um
      // nome. O rótulo é resolvido para o usuário quando bate com um cadastro;
      // quando não bate (vendedor que saiu, nome digitado diferente), vale o
      // texto gravado na época, que ainda é a melhor informação que existe.
      const ultimoVendedor = new Map<string, string>();
      try {
        const hist = await q(`
          SELECT DISTINCT ON (customer_id) customer_id, new_value
          FROM customer_change_history
          WHERE field = 'sellerId' AND NULLIF(TRIM(COALESCE(new_value,'')),'') IS NOT NULL
          ORDER BY customer_id, created_at DESC`);
        const porRotulo = new Map<string, string>();
        for (const u of users) {
          const nome = nomeUser.get(u.id) || "";
          for (const k of [nome, u.email, u.id]) {
            const chave = String(k || "").trim().toLowerCase();
            if (chave && !porRotulo.has(chave)) porRotulo.set(chave, nome);
          }
        }
        for (const r of hist) {
          const bruto = String(r.new_value || "").trim();
          if (!bruto) continue;
          ultimoVendedor.set(String(r.customer_id), porRotulo.get(bruto.toLowerCase()) || nomeUser.get(resolve(bruto) || "") || bruto);
        }
      } catch (e: any) { console.warn("[dossie-vendedores] historico de vendedor indisponivel:", e?.message || e); }

      // ── leads ─────────────────────────────────────────────────────────────
      const leadRows = await q(`SELECT created_by, assigned_to, status::text AS status FROM leads`);

      // ── rede de cada cliente (a mesma da aba Rede de Cliente) ────────────
      // Serve ao sub-filtro por rede da tabela anual: numa rede, o movimento de
      // uma filial so' faz sentido lido junto com o das outras. Num ambiente
      // sem a tabela de redes a consulta falha e o filtro simplesmente nao tem
      // o que oferecer — nenhuma tela cai por causa de um filtro a mais.
      const redePorCliente = new Map<string, string>();
      try {
        for (const r of await q(`
          SELECT m.customer_id, r.nome
          FROM cliente_rede_membros m
          JOIN cliente_redes r ON r.id = m.rede_id`)) {
          const nome = String(r.nome || "").trim();
          if (nome) redePorCliente.set(String(r.customer_id), nome);
        }
      } catch (e: any) { console.warn("[dossie-vendedores] redes indisponiveis:", e?.message || e); }

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
          motivo: c.motivo || null,
          ultimoVendedor: ultimoVendedor.get(String(c.id)) || null,
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
          rede: c.customerId ? (redePorCliente.get(String(c.customerId)) || "") : "",
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

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/reports/estoque-levantamento
  //
  // Levantamento pedido pelo Flavio (13/11/2026): desde que existem o report e o
  // Inbox, quantos CLIENTES tiveram report de "Cliente com Estoque", por VENDEDOR
  // e por PERIODICIDADE; e, no mesmo molde, quantos desses tiveram DEPOIS uma
  // solicitação de inativação.
  //
  // POR QUE UMA CONSULTA PRÓPRIA, e não a lista do Inbox: a rota que a tela usa
  // tem teto de 500 linhas e esconde cliente INATIVO — e cliente inativo é
  // justamente a segunda tabela inteira. Ler por lá daria um número baixo e
  // plausível, que é o pior tipo de número errado.
  //
  // O QUE CONTA COMO "COM ESTOQUE": report do Inbox (kind='report',
  // reportKind='nao_venda') cujo motivo gravado menciona estoque. São dois
  // textos, do atendimento presencial e do virtual ("Cliente com Estoque" e
  // "Não Venda (virtual) — Cliente com Estoque"), por isso o ILIKE em vez de
  // igualdade. A conferência contra sales_cards.no_sale_reason='com_estoque'
  // vai junto na resposta.
  //
  // VENDEDOR é quem REGISTROU o report, não o dono da carteira hoje: a pergunta
  // é sobre o que cada vendedor está reportando. Cliente reportado por dois
  // vendedores conta uma vez em cada linha — por isso o total das linhas pode
  // passar do total de clientes distintos, que vem separado na resposta.
  // PERIODICIDADE é a do cadastro de hoje (é o único valor que existe).
  // ───────────────────────────────────────────────────────────────────────────
  app.get("/api/reports/estoque-levantamento", authenticateUser, async (req: Request, res: Response) => {
    try {
      const u: any = (req as any).currentUser || (req as any).user || null;
      if (!["admin", "coordinator", "administrative"].includes(String(u?.role || ""))) {
        return res.status(403).json({ ok: false, error: "Sem permissão" });
      }

      // 1) Reports de estoque: um por cliente+vendedor+momento.
      const reports = await q(`
        SELECT cr.id,
               COALESCE(cr.customer_id, cr.entity_id) AS cliente_id,
               cr.seller_id, cr.seller_name,
               cr.details->>'motivo'  AS motivo,
               (cr.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
               cr.created_at
        FROM change_requests cr
        WHERE cr.kind = 'report'
          AND cr.details->>'reportKind' = 'nao_venda'
          AND cr.details->>'motivo' ILIKE '%estoque%'
          AND cr.entity_type = 'customer'
        ORDER BY cr.created_at`);

      // 2) Solicitações de inativação (o vendedor pedindo para inativar).
      const inativacoes = await q(`
        SELECT COALESCE(cr.customer_id, cr.entity_id) AS cliente_id,
               cr.seller_id, cr.seller_name, cr.status,
               cr.details->>'inativar' AS motivo,
               (cr.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
               cr.created_at
        FROM change_requests cr
        WHERE cr.kind = 'solicitacao'
          AND cr.types ? 'inativar'
          AND cr.entity_type = 'customer'
        ORDER BY cr.created_at`);

      // 3) Conferência independente: a mesma não-venda pelo lado do card.
      const porCard = await q(`
        SELECT COUNT(*)::int AS reports, COUNT(DISTINCT customer_id)::int AS clientes
        FROM sales_cards
        WHERE no_sale_reason = 'com_estoque'`);

      // 4) Cadastro dos clientes citados.
      const ids = Array.from(new Set([...reports, ...inativacoes].map((r: any) => String(r.cliente_id || "")).filter(Boolean)));
      const lista = ids.length ? ids.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",") : `''`;
      const cad = await q(`
        SELECT c.id, COALESCE(NULLIF(c.fantasy_name,''), c.name) AS nome, c.city,
               LOWER(COALESCE(c.visit_periodicity::text,'semanal')) AS periodicidade,
               c.is_active, c.seller_id,
               c.inactivated_at::date::text AS inativado
        FROM customers c WHERE c.id IN (${lista})`);
      const cadPorId = new Map(cad.map((c: any) => [String(c.id), c]));

      // 5) Nome do vendedor: o gravado no report, e o do cadastro como reserva.
      const users = await q(`SELECT id, first_name, last_name, email FROM users`);
      const nomeDe = new Map<string, string>();
      for (const x of users) nomeDe.set(String(x.id), [x.first_name, x.last_name].filter(Boolean).join(" ").trim() || x.email || x.id);
      // O ID MANDA, nao o nome gravado no report. `seller_name` foi gravado ora
      // com o nome completo, ora com o prefixo do e-mail ("Gilmar M" e
      // "gilmarmfilho", "Carlos T" e "Carlos T.", "leticia"): confiar nele parte
      // a mesma pessoa em duas linhas e o levantamento mente por construcao.
      // `resolve` ainda cobre o id em formato de codigo Omie.
      const vendedorDo = (r: any) => {
        const porId = nomeDe.get(String(r.seller_id || "")) || nomeDe.get(resolve(r.seller_id) || "");
        return porId || String(r.seller_name || "").trim() || "Sem vendedor";
      };

      // 6) Primeiro report de estoque de cada par cliente+vendedor.
      type Linha = { clienteId: string; vendedor: string; primeiro: string; ultimo: string; reports: number };
      const porPar = new Map<string, Linha>();
      for (const r of reports) {
        const cid = String(r.cliente_id || ""); if (!cid) continue;
        const v = vendedorDo(r);
        const k = `${cid}|${v}`;
        const atual = porPar.get(k);
        if (atual) { atual.reports++; atual.ultimo = String(r.dia); }
        else porPar.set(k, { clienteId: cid, vendedor: v, primeiro: String(r.dia), ultimo: String(r.dia), reports: 1 });
      }

      // 7) Inativação DEPOIS do report: a data do pedido tem que ser posterior
      //    (ou igual) à do primeiro report de estoque daquele cliente.
      const inatPorCliente = new Map<string, any[]>();
      for (const i of inativacoes) {
        const cid = String(i.cliente_id || ""); if (!cid) continue;
        const a = inatPorCliente.get(cid); if (a) a.push(i); else inatPorCliente.set(cid, [i]);
      }

      const PERS = ["semanal", "quinzenal", "mensal"];
      const vazio = () => ({ semanal: 0, quinzenal: 0, mensal: 0, outra: 0, total: 0 });
      const tabA = new Map<string, any>();   // todos os com estoque
      const tabB = new Map<string, any>();   // com estoque e depois pedido de inativação
      const detalhe: any[] = [];

      for (const l of porPar.values()) {
        const c: any = cadPorId.get(l.clienteId) || {};
        const per = PERS.includes(String(c.periodicidade)) ? String(c.periodicidade) : "outra";
        const add = (m: Map<string, any>) => {
          const a = m.get(l.vendedor) || { vendedor: l.vendedor, ...vazio() };
          a[per]++; a.total++; m.set(l.vendedor, a);
        };
        add(tabA);
        const pedidos = (inatPorCliente.get(l.clienteId) || []).filter((i: any) => String(i.dia) >= l.primeiro);
        if (pedidos.length) add(tabB);
        detalhe.push({
          clienteId: l.clienteId, cliente: c.nome || "(sem cadastro)", cidade: c.city || "",
          periodicidade: per, vendedorReport: l.vendedor,
          reportsEstoque: l.reports, primeiroReport: l.primeiro, ultimoReport: l.ultimo,
          pedidoInativacao: pedidos.length ? pedidos[0].dia : null,
          statusPedido: pedidos.length ? pedidos[0].status : null,
          motivoPedido: pedidos.length ? pedidos[0].motivo : null,
          clienteAtivoHoje: c.is_active === true,
          inativadoEm: c.inativado || null,
        });
      }

      const ordena = (m: Map<string, any>) => Array.from(m.values()).sort((a, b) => b.total - a.total || String(a.vendedor).localeCompare(String(b.vendedor), "pt-BR"));
      const soma = (arr: any[]) => arr.reduce((s, x) => {
        for (const k of ["semanal", "quinzenal", "mensal", "outra", "total"]) s[k] += x[k];
        return s;
      }, vazio());

      const A = ordena(tabA), B = ordena(tabB);
      const dias = reports.map((r: any) => String(r.dia)).sort();

      // DIAGNOSTICO DO CRUZAMENTO. A tabela B veio vazia na primeira rodada e um
      // zero sem explicacao nao e' resposta: pode ser "nenhum cliente com
      // estoque foi pedido para inativar" ou "o cruzamento nao esta' casando".
      // Estes numeros separam os dois casos sem precisar de outra consulta.
      const diasInat = inativacoes.map((i: any) => String(i.dia)).sort();
      const idsComEstoque = new Set(Array.from(porPar.values()).map((l) => l.clienteId));
      const primeiroReportDe = new Map<string, string>();
      for (const l of porPar.values()) {
        const atual = primeiroReportDe.get(l.clienteId);
        if (!atual || l.primeiro < atual) primeiroReportDe.set(l.clienteId, l.primeiro);
      }
      const inatDeQuemTemEstoque = inativacoes.filter((i: any) => idsComEstoque.has(String(i.cliente_id || "")));
      const antesDoReport = inatDeQuemTemEstoque.filter(
        (i: any) => String(i.dia) < (primeiroReportDe.get(String(i.cliente_id)) || "9999"));

      res.json({
        ok: true,
        periodo: { primeiroReport: dias[0] || null, ultimoReport: dias[dias.length - 1] || null },
        comEstoque: {
          linhas: A, total: soma(A),
          clientesDistintos: new Set(Array.from(porPar.values()).map((l) => l.clienteId)).size,
          reports: reports.length,
        },
        comEstoqueEDepoisInativacao: {
          linhas: B, total: soma(B),
          clientesDistintos: new Set(detalhe.filter((d) => d.pedidoInativacao).map((d) => d.clienteId)).size,
        },
        conferencia: {
          porSalesCards: porCard[0] || null,
          pedidosInativacaoNoTotal: inativacoes.length,
          pedidosInativacaoPeriodo: { primeiro: diasInat[0] || null, ultimo: diasInat[diasInat.length - 1] || null },
          clientesComEstoqueQueTemAlgumPedidoDeInativacao: new Set(inatDeQuemTemEstoque.map((i: any) => String(i.cliente_id))).size,
          dessesComPedidoANTESDoReport: new Set(antesDoReport.map((i: any) => String(i.cliente_id))).size,
          clientesDoEstoqueJaInativos: detalhe.filter((d) => !d.clienteAtivoHoje).length,
          observacao: "Vendedor = quem registrou o report. Cliente reportado por dois vendedores conta em cada linha, por isso a soma das linhas pode passar do total de clientes distintos.",
        },
        detalhe: detalhe.sort((a, b) => String(a.vendedorReport).localeCompare(String(b.vendedorReport), "pt-BR") || String(a.cliente).localeCompare(String(b.cliente), "pt-BR")),
      });
    } catch (e: any) {
      console.error("[estoque-levantamento]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
