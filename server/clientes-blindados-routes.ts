// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES BLINDADOS — aba "Clientes blindados" de Metas de Vendas.
//
// GET /api/reports/clientes-blindados?dias=60   (admin / coordenação / administrativo)
//
// Pedido do Flavio (14/11/2026): achar clientes que o vendedor orientou a não
// atender outros canais da Honest. O sinal é o cliente que COMPRA com o dono da
// carteira mas NÃO RESPONDE a Honest pelos outros canais.
//
// Réguas (janela = últimos `dias`, padrão 60):
//  • TENTATIVAS DA HONEST = dias em que alguém que NÃO é o dono da carteira mandou
//    mensagem ao cliente pelo WhatsApp oficial (ChatCenter: chat_messages com
//    sender_type 'agent', na conversa do telefone do cliente).
//  • RESPOSTAS = dias em que o cliente escreveu no WhatsApp oficial
//    + atendimentos registrados por outra pessoa (virtual_service_logs)
//    + pedidos digitados por outra pessoa (billing_pipeline).
//  • PEDIDOS DO DONO = pedidos no pipeline digitados pelo dono da carteira.
//  • BLINDADO  = 3+ tentativas, nenhuma resposta e pelo menos 1 pedido do dono.
//    ATENÇÃO   = 1 ou 2 tentativas, nenhuma resposta e pelo menos 1 pedido do dono.
//    RESPONDE  = alguma resposta. SEM TENTATIVA = a Honest não tentou contato.
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
      const MIN_TENT = 3;

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
        return !!i && i.ativo && ["vendedor", "telemarketing"].includes(i.role);
      };

      // ── carteira: clientes ativos com dono vendedor/telemarketing ativo ──
      const clientes = await q(`
        SELECT id, name, fantasy_name, city, phone, contact, seller_id
        FROM customers
        WHERE is_active = true AND COALESCE(is_supplier, false) = false AND COALESCE(is_lead, false) = false`);
      type Cli = {
        id: string; nome: string; cidade: string; telefone: string; contato: string;
        dono: string; chave: string | null;
        tentDias: Set<string>; respDias: Set<string>; atendOutros: number; pedidosOutros: number; pedidosDono: number;
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
          tentDias: new Set(), respDias: new Set(), atendOutros: 0, pedidosOutros: 0, pedidosDono: 0,
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
          if (r.tipo === "customer") o.respDias.add(r.dia);
          else if (resolve(r.sender_id) !== o.dono) o.tentDias.add(r.dia);
        }
      }

      // ── atendimentos registrados por outra pessoa ────────────────────────
      const atend = await q(`
        SELECT customer_id, attendant_id
        FROM virtual_service_logs
        WHERE COALESCE(entity_type, 'customer') = 'customer'
          AND attendance_date >= now() - interval '${dias} days'`);
      for (const r of atend) {
        const o = cli.get(r.customer_id); if (!o) continue;
        if (resolve(r.attendant_id) !== o.dono) o.atendOutros++;
      }

      // ── pedidos no pipeline: do dono x de outros ─────────────────────────
      const peds = await q(`
        SELECT customer_id, seller_id
        FROM billing_pipeline
        WHERE created_at >= now() - interval '${dias} days'
          AND COALESCE(stage::text, '') <> 'lixeira'`);
      for (const r of peds) {
        const o = cli.get(r.customer_id); if (!o) continue;
        const quem = resolve(r.seller_id);
        if (quem && quem === o.dono) o.pedidosDono++;
        else if (quem) o.pedidosOutros++;
      }

      // ── classificação ────────────────────────────────────────────────────
      const lista: any[] = [];
      const porVend = new Map<string, any>();
      for (const o of cli.values()) {
        const tent = o.tentDias.size;
        const resp = o.respDias.size + o.atendOutros + o.pedidosOutros;
        let situacao: "blindado" | "atencao" | "responde" | "sem_tentativa";
        if (resp > 0) situacao = "responde";
        else if (tent === 0) situacao = "sem_tentativa";
        else if (o.pedidosDono >= 1 && tent >= MIN_TENT) situacao = "blindado";
        else if (o.pedidosDono >= 1) situacao = "atencao";
        else situacao = "sem_tentativa"; // tentou, não respondeu e também não compra: não é sinal de blindagem

        const v = porVend.get(o.dono) || {
          vendedorId: o.dono, vendedor: info.get(o.dono)?.nome || o.dono,
          tipo: info.get(o.dono)?.role === "telemarketing" ? "Interno" : "Externo",
          clientes: 0, semTelefone: 0, comTentativa: 0, responderam: 0, blindados: 0, atencao: 0,
        };
        v.clientes++;
        if (!o.chave) v.semTelefone++;
        if (tent > 0) v.comTentativa++;
        if (tent > 0 && resp > 0) v.responderam++;
        if (situacao === "blindado") v.blindados++;
        if (situacao === "atencao") v.atencao++;
        porVend.set(o.dono, v);

        if (situacao === "blindado" || situacao === "atencao") {
          lista.push({
            clienteId: o.id, cliente: o.nome, cidade: o.cidade, telefone: o.telefone, contato: o.contato,
            vendedorId: o.dono, vendedor: v.vendedor, situacao,
            tentativas: tent, diasTentativa: Array.from(o.tentDias).sort().reverse().slice(0, 10),
            pedidosDono: o.pedidosDono,
          });
        }
      }
      const vendedores = Array.from(porVend.values()).map((v) => ({
        ...v,
        taxaResposta: v.comTentativa ? Math.round((v.responderam / v.comTentativa) * 1000) / 10 : null,
        pctBlindados: v.comTentativa ? Math.round((v.blindados / v.comTentativa) * 1000) / 10 : null,
      })).sort((a, b) => (b.pctBlindados ?? -1) - (a.pctBlindados ?? -1) || b.blindados - a.blindados);
      lista.sort((a, b) => (a.situacao === b.situacao ? b.tentativas - a.tentativas : a.situacao === "blindado" ? -1 : 1));

      const tot = vendedores.reduce((s, v) => ({
        clientes: s.clientes + v.clientes, comTentativa: s.comTentativa + v.comTentativa,
        responderam: s.responderam + v.responderam, blindados: s.blindados + v.blindados, atencao: s.atencao + v.atencao,
      }), { clientes: 0, comTentativa: 0, responderam: 0, blindados: 0, atencao: 0 });

      res.json({
        ok: true, dias, minTentativas: MIN_TENT,
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
