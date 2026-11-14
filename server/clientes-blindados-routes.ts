// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES BLINDADOS — aba "Clientes blindados" de Metas de Vendas.
//
// GET /api/reports/clientes-blindados?dias=60   (admin / coordenação / administrativo)
//
// Pedido do Flavio (14/11/2026): achar clientes que o vendedor orientou a não
// atender outros canais da Honest. O sinal é o cliente que COMPRA com o dono da
// carteira mas NÃO RESPONDE a Honest pelos outros canais.
//
// Réguas (janela = últimos `dias`, padrão 60) — revistas em 14/11/2026:
//  • CONTATO = dia em que OUTRO VENDEDOR (interno ou externo, pessoa de verdade,
//    ≠ dono da carteira) falou com o cliente: mensagem enviada por ele no
//    WhatsApp oficial (chat_messages sender_type 'agent' com o id dele) ou
//    atendimento registrado por ele (virtual_service_logs). Mensagens da IA
//    (sender_type 'system', id 'agent:…') e as enviadas fora do app NÃO contam.
//  • Cada contato tem um desfecho:
//      COMPROU      = o vendedor que contatou digitou pedido do cliente em até 2 dias.
//      ESQUIVA      = ninguém vendeu por esse contato, mas o DONO digitou pedido
//                     de 0 a 3 dias depois (o "não preciso hoje" seguido de pedido
//                     com o vendedor) — conta tenha o cliente respondido ou não.
//      SEM RESPOSTA = o cliente não respondeu em até 2 dias.
//      RESPONDEU    = respondeu, sem compra de ninguém nos dias seguintes (neutro).
//  • BLINDADO  = 2+ esquivas, ou 3+ contatos sem resposta, com pedido do dono e
//                nenhuma compra pelos outros vendedores.
//    ATENÇÃO   = 1 esquiva, ou 1–2 contatos sem resposta, mesmo quadro.
//    RESPONDE  = comprou com outro vendedor ou respondeu sem sinal de esquiva.
//    SEM CONTATO = nenhum outro vendedor falou com o cliente no período.
//  • Telefone casa por DDD + últimos 8 dígitos (ignora 55 e o 9º dígito).
// É um indicador para investigar, não prova: a confirmação é o contato direto da
// coordenação com o comprador.
// ─────────────────────────────────────────────────────────────────────────────
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

/** DDD + últimos 8 dígitos; null se não der para montar. */
export function chaveTelefone(raw: any): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10) return null;
  const ddd = d.slice(0, 2);
  const fim = d.slice(-8);
  if (/^0+$/.test(fim)) return null; // placeholder (00) 0000-0000
  return ddd + fim;
}

export function registerClientesBlindados(app: Express) {
  app.get("/api/reports/clientes-blindados", authenticateUser, async (req: Request, res: Response) => {
    try {
      const usuario: any = (req as any).currentUser || (req as any).user || null;
      if (!["admin", "coordinator", "administrative"].includes(String(usuario?.role || ""))) {
        return res.status(403).json({ ok: false, error: "Sem permissão" });
      }
      let dias = Number(req.query.dias || 60);
      if (!Number.isFinite(dias) || dias < 7) dias = 60;
      if (dias > 365) dias = 365;
      const MIN_TENT = 3;      // contatos sem resposta para blindado
      const MIN_ESQUIVA = 2;   // esquivas para blindado
      const JANELA_ESQUIVA = 3; // dias após o contato em que o pedido do dono conta como esquiva

      // ── usuários: qualquer id de vendedor → id do usuário ────────────────
      const users = await q(`SELECT id, first_name, last_name, email, role::text AS role, is_active,
                                    omie_vendor_code, omie_vendor_codes
                             FROM users`);
      const idDe = new Map<string, string>();
      const info = new Map<string, { nome: string; role: string; ativo: boolean }>();
      for (const u of users) {
        const nome = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || u.id;
        info.set(u.id, { nome, role: String(u.role || ""), ativo: !!u.is_active });
        idDe.set(String(u.id), u.id);
        const codes: string[] = [];
        if (u.omie_vendor_code) codes.push(String(u.omie_vendor_code));
        if (u.omie_vendor_codes && typeof u.omie_vendor_codes === "object") {
          for (const v of Object.values(u.omie_vendor_codes)) if (v) codes.push(String(v));
        }
        for (const c of codes) {
          if (!idDe.has(c)) idDe.set(c, u.id);
          if (!idDe.has(`omie-vendor-${c}`)) idDe.set(`omie-vendor-${c}`, u.id);
        }
      }
      const resolve = (sid: any): string | null => {
        const s = String(sid ?? "").trim();
        if (!s) return null;
        return idDe.get(s) || idDe.get(s.replace(/^omie-vendor-/, "")) || null;
      };
      const ehVendedor = (id: string | null) => {
        if (!id) return false;
        const i = info.get(id);
        // Contas de sistema/canal (Hotsite, Instagram, Honest Admin/Colaboradores/Fornecedores) não têm carteira de verdade.
        if (!i || /^(hotsite|instagram|honest\b|\[canal\])/i.test(i.nome.trim())) return false;
        return i.ativo && ["vendedor", "telemarketing"].includes(i.role);
      };

      // ── carteira: clientes ativos com dono vendedor/telemarketing ativo ──
      const clientes = await q(`
        SELECT id, name, fantasy_name, city, phone, contact, seller_id
        FROM customers
        WHERE is_active = true AND COALESCE(is_supplier, false) = false AND COALESCE(is_lead, false) = false`);
      type Cli = {
        id: string; nome: string; cidade: string; telefone: string; contato: string;
        dono: string; chave: string | null;
        contatos: Map<string, Set<string>>; // dia -> vendedores (≠ dono) que contataram
        respDias: Set<string>; pedDono: Set<string>; pedPor: Map<string, Set<string>>; // vendedor -> dias de pedido
        pedidosDono: number;
      };
      const cli = new Map<string, Cli>();
      const porChave = new Map<string, Cli[]>();
      for (const c of clientes) {
        const dono = resolve(c.seller_id);
        if (!ehVendedor(dono)) continue;
        const chave = chaveTelefone(c.phone);
        const o: Cli = {
          id: c.id, nome: c.fantasy_name || c.name || c.id, cidade: c.city || "", telefone: c.phone || "",
          contato: c.contact || "", dono: dono!, chave,
          contatos: new Map(), respDias: new Set(), pedDono: new Set(), pedPor: new Map(), pedidosDono: 0,
        };
        cli.set(c.id, o);
        if (chave) { const l = porChave.get(chave) || []; l.push(o); porChave.set(chave, l); }
      }

      // ── WhatsApp oficial: mensagens por dia, por telefone ────────────────
      const msgs = await q(`
        SELECT c.customer_phone AS fone, m.sender_type::text AS tipo, m.sender_id,
               ((m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
        FROM chat_messages m
        JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.created_at >= now() - interval '${dias} days'
          AND m.sender_type::text IN ('agent', 'customer')
        GROUP BY 1, 2, 3, 4`);
      let msgsCasadas = 0;
      for (const r of msgs) {
        const chave = chaveTelefone(r.fone);
        if (!chave) continue;
        const lista = porChave.get(chave);
        if (!lista) continue;
        msgsCasadas++;
        for (const o of lista) {
          if (r.tipo === "customer") { o.respDias.add(r.dia); continue; }
          const quem = resolve(r.sender_id);
          // Só pessoa vendedora (interna/externa) que não é o dono. IA e envios de fora do app ficam de fora.
          if (!quem || quem === o.dono || !ehVendedor(quem)) continue;
          const set = o.contatos.get(r.dia) || new Set<string>(); set.add(quem); o.contatos.set(r.dia, set);
        }
      }

      // ── atendimentos registrados por outra pessoa ────────────────────────
      const atend = await q(`
        SELECT customer_id, attendant_id,
               ((attendance_date AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
        FROM virtual_service_logs
        WHERE COALESCE(entity_type, 'customer') = 'customer'
          AND attendance_date >= now() - interval '${dias} days'`);
      for (const r of atend) {
        const o = cli.get(r.customer_id); if (!o) continue;
        const quem = resolve(r.attendant_id);
        if (!quem || quem === o.dono || !ehVendedor(quem)) continue;
        // Atendimento registrado = o cliente atendeu: conta como contato e como resposta no dia.
        const set = o.contatos.get(r.dia) || new Set<string>(); set.add(quem); o.contatos.set(r.dia, set);
        o.respDias.add(r.dia);
      }

      // ── pedidos no pipeline: do dono x de outros ─────────────────────────
      const peds = await q(`
        SELECT customer_id, seller_id,
               ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
        FROM billing_pipeline
        WHERE created_at >= now() - interval '${dias} days'
          AND COALESCE(stage::text, '') <> 'lixeira'`);
      for (const r of peds) {
        const o = cli.get(r.customer_id); if (!o) continue;
        const quem = resolve(r.seller_id);
        if (!quem) continue;
        if (quem === o.dono) { o.pedidosDono++; o.pedDono.add(r.dia); }
        else { const set = o.pedPor.get(quem) || new Set<string>(); set.add(r.dia); o.pedPor.set(quem, set); }
      }

      // ── classificação ────────────────────────────────────────────────────
      const lista: any[] = [];
      const porVend = new Map<string, any>();
      const somaDias = (d: string, n: number) => {
        const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
      };
      const temEntre = (set: Set<string> | undefined, d: string, ate: number) => {
        if (!set) return false;
        for (let i = 0; i <= ate; i++) if (set.has(somaDias(d, i))) return true;
        return false;
      };
      for (const o of cli.values()) {
        let semResp = 0, esquivas = 0, compras = 0, respondeu = 0;
        const diasEsquiva: string[] = [], diasSemResp: string[] = [];
        for (const [dia, quem] of o.contatos) {
          const comprouComQuemContatou = Array.from(quem).some((u) => temEntre(o.pedPor.get(u), dia, 2));
          if (comprouComQuemContatou) { compras++; continue; }
          if (temEntre(o.pedDono, dia, JANELA_ESQUIVA)) { esquivas++; diasEsquiva.push(dia); continue; }
          if (temEntre(o.respDias, dia, 2)) { respondeu++; continue; }
          semResp++; diasSemResp.push(dia);
        }
        const tent = o.contatos.size;
        let situacao: "blindado" | "atencao" | "responde" | "sem_tentativa";
        if (tent === 0) situacao = "sem_tentativa";
        else if (compras > 0) situacao = "responde";
        else if (o.pedidosDono === 0) situacao = respondeu > 0 ? "responde" : "sem_tentativa"; // não compra de ninguém: não é sinal de blindagem
        else if (esquivas >= MIN_ESQUIVA || semResp >= MIN_TENT) situacao = "blindado";
        else if (esquivas >= 1 || semResp >= 1) situacao = "atencao";
        else situacao = "responde";
        const resp = compras + respondeu + esquivas; // respostas (inclui as esquivas, em que ele respondeu e comprou com o dono)

        const v = porVend.get(o.dono) || {
          vendedorId: o.dono, vendedor: info.get(o.dono)?.nome || o.dono,
          tipo: info.get(o.dono)?.role === "telemarketing" ? "Interno" : "Externo",
          clientes: 0, semTelefone: 0, comTentativa: 0, responderam: 0, esquivas: 0, blindados: 0, atencao: 0,
        };
        v.clientes++;
        if (!o.chave) v.semTelefone++;
        if (tent > 0) v.comTentativa++;
        if (tent > 0 && resp > 0) v.responderam++;
        v.esquivas += esquivas;
        if (situacao === "blindado") v.blindados++;
        if (situacao === "atencao") v.atencao++;
        porVend.set(o.dono, v);

        if (situacao === "blindado" || situacao === "atencao") {
          lista.push({
            clienteId: o.id, cliente: o.nome, cidade: o.cidade, telefone: o.telefone, contato: o.contato,
            vendedorId: o.dono, vendedor: v.vendedor, situacao,
            tentativas: tent, esquivas, semResposta: semResp, compras,
            diasEsquiva: diasEsquiva.sort().reverse().slice(0, 10),
            diasTentativa: Array.from(o.contatos.keys()).sort().reverse().slice(0, 10),
            pedidosDono: o.pedidosDono,
          });
        }
      }
      const vendedores = Array.from(porVend.values()).map((v) => ({
        ...v,
        taxaResposta: v.comTentativa ? Math.round((v.responderam / v.comTentativa) * 1000) / 10 : null,
        pctBlindados: v.comTentativa ? Math.round((v.blindados / v.comTentativa) * 1000) / 10 : null,
      })).sort((a, b) => (b.pctBlindados ?? -1) - (a.pctBlindados ?? -1) || b.blindados - a.blindados);
      lista.sort((a, b) => (a.situacao === b.situacao ? (b.esquivas - a.esquivas) || (b.tentativas - a.tentativas) : a.situacao === "blindado" ? -1 : 1));

      const tot = vendedores.reduce((s, v) => ({
        clientes: s.clientes + v.clientes, comTentativa: s.comTentativa + v.comTentativa,
        responderam: s.responderam + v.responderam, esquivas: s.esquivas + v.esquivas, blindados: s.blindados + v.blindados, atencao: s.atencao + v.atencao,
      }), { clientes: 0, comTentativa: 0, responderam: 0, esquivas: 0, blindados: 0, atencao: 0 });

      res.json({
        ok: true, dias, minTentativas: MIN_TENT, minEsquivas: MIN_ESQUIVA, janelaEsquiva: JANELA_ESQUIVA,
        totais: { ...tot, taxaResposta: tot.comTentativa ? Math.round((tot.responderam / tot.comTentativa) * 1000) / 10 : null },
        vendedores, clientes: lista,
        diag: { mensagensDia: msgs.length, mensagensCasadas: msgsCasadas, atendimentos: atend.length, pedidos: peds.length },
      });
    } catch (e: any) {
      console.error("[clientes-blindados]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
