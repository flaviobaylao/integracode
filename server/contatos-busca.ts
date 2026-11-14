// server/contatos-busca.ts
// -----------------------------------------------------------------------------
// BUSCAR NO WHATSAPP (nov/2026) — botão ao lado de Telefone + Responsável no computador.
// Procura nome/telefone nas fontes que o Integra já tem:
//   1) conversas de WhatsApp guardadas (chat_conversations — vindas da Umbler);
//   2) agenda "Telefones de Clientes" (phonebook_contacts: nome e contato da empresa);
//   3) Umbler ao vivo (somente leitura): por telefone e, se a API aceitar, por nome.
// GET /api/contatos-whatsapp?q=...  →  { itens: [{ telefone, responsavel, empresa, origem }] }
// -----------------------------------------------------------------------------
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const rows = (r: any) => ((r?.rows ?? r ?? []) as any[]);
const dig = (v: any) => String(v ?? "").replace(/\D/g, "");
const k8 = (v: any) => dig(v).slice(-8);

type Item = { telefone: string; responsavel: string; empresa: string; origem: string };

export function registerContatosBusca(app: Express): void {
  app.get("/api/contatos-whatsapp", authenticateUser, async (req: any, res) => {
    try {
      const q = String(req.query?.q || "").trim().slice(0, 60);
      const d = dig(q);
      const porTelefone = d.length >= 4;
      if (!porTelefone && q.length < 3) return res.json({ itens: [] });
      const like = "%" + q + "%";
      const likeDig = "%" + d + "%";
      const mapa = new Map<string, Item>();
      const add = (tel: any, responsavel: any, empresa: any, origem: string) => {
        const t = dig(tel);
        if (t.length < 10) return;
        const k = k8(t);
        const cur = mapa.get(k) || { telefone: t, responsavel: "", empresa: "", origem };
        const r = String(responsavel || "").trim();
        const e = String(empresa || "").trim();
        if (r && !cur.responsavel) cur.responsavel = r;
        if (e && !cur.empresa) cur.empresa = e;
        if (!cur.origem.includes(origem)) cur.origem = cur.origem + " + " + origem;
        mapa.set(k, cur);
      };

      // 1) Conversas guardadas (nome do WhatsApp).
      try {
        const r = rows(await db.execute(porTelefone
          ? sql`SELECT customer_phone, customer_name FROM chat_conversations
                 WHERE regexp_replace(COALESCE(customer_phone,''), '[^0-9]', '', 'g') LIKE ${likeDig}
                 ORDER BY last_message_time DESC NULLS LAST LIMIT 20`
          : sql`SELECT customer_phone, customer_name FROM chat_conversations
                 WHERE customer_name ILIKE ${like}
                 ORDER BY last_message_time DESC NULLS LAST LIMIT 20`));
        for (const x of r) add(x.customer_phone, "", x.customer_name, "WhatsApp");
      } catch { /* tabela ausente: segue */ }

      // 2) Agenda "Telefones de Clientes" (nome + contato da empresa, quando houver).
      try {
        let temContato = false;
        try {
          const c = rows(await db.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'phonebook_contacts' AND column_name = 'contact_name' LIMIT 1`));
          temContato = c.length > 0;
        } catch { /* noop */ }
        const r = rows(await db.execute(temContato
          ? (porTelefone
            ? sql`SELECT phone, name, contact_name FROM phonebook_contacts WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE ${likeDig} LIMIT 20`
            : sql`SELECT phone, name, contact_name FROM phonebook_contacts WHERE name ILIKE ${like} OR contact_name ILIKE ${like} LIMIT 20`)
          : (porTelefone
            ? sql`SELECT phone, name, NULL AS contact_name FROM phonebook_contacts WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE ${likeDig} LIMIT 20`
            : sql`SELECT phone, name, NULL AS contact_name FROM phonebook_contacts WHERE name ILIKE ${like} LIMIT 20`)));
        for (const x of r) add(x.phone, x.contact_name, x.name, "Agenda do Integra");
      } catch { /* noop */ }

      // 3) Umbler ao vivo (somente leitura).
      try {
        const { buscarContatosUmbler } = await import("./official-dispatch");
        for (const c of await buscarContatosUmbler(q)) add(c.telefone, "", c.nome, "Umbler");
      } catch { /* noop */ }

      // Nome de pessoa salvo na Umbler/WhatsApp vira sugestão de responsável quando não parece empresa.
      const EMPRESA = /\b(ltda|me|eireli|s\/?a|honest|padaria|panificadora|emporio|empório|mercado|supermercado|restaurante|lanchonete|cafe|café|colegio|colégio|escola|distribuidora|loja|bar|burger|pizzaria|conveniencia|conveniência|academia)\b/i;
      const itens = Array.from(mapa.values()).slice(0, 15).map((it) => {
        if (!it.responsavel && it.empresa && !EMPRESA.test(it.empresa) && it.empresa.split(" ").length <= 4) {
          return { ...it, responsavel: it.empresa, empresa: "" };
        }
        return it;
      });
      res.json({ itens });
    } catch (e: any) {
      res.status(500).json({ itens: [], error: e?.message || "falha" });
    }
  });
}
