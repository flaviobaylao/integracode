// Integracao Instagram Direct (Meta Messaging API) -> Atendente IA (Honest / INTEGRA 2.0).
// Recebe DMs do Instagram via webhook da Meta, reaproveita o motor de agentes (maybeRunAgent
// com channel='instagram') e responde pela Graph API. NAO usa a Umbler (que nao suporta IG).
//
// ENV necessarias (Railway):
//   IG_VERIFY_TOKEN  -> string que voce escolhe; a MESMA vai no painel da Meta (Verify Token do webhook).
//   IG_PAGE_TOKEN    -> Page Access Token (long-lived) da Pagina vinculada ao @ da Honest.
//   IG_APP_SECRET    -> (opcional) App Secret da Meta; se setado, valida a assinatura X-Hub-Signature-256.
//   GRAPH_VERSION    -> (opcional) versao da Graph API. Default 'v21.0'.
//
// Endpoints:
//   GET  /api/instagram/webhook  -> verificacao do webhook (hub.challenge).
//   POST /api/instagram/webhook  -> recebimento de mensagens.
//   GET  /api/instagram/health   -> diagnostico (nao expoe segredos).
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";

const GRAPH = () => `${process.env.IG_GRAPH_BASE || "https://graph.facebook.com"}/${process.env.GRAPH_VERSION || "v21.0"}`;

// Buffer em memoria dos ultimos webhooks recebidos (diagnostico; sobrevive so ate o restart).
const recentHooks: any[] = [];
function recordHook(e: any) { try { recentHooks.unshift(e); if (recentHooks.length > 30) recentHooks.length = 30; } catch {} }

// Resolve o @username do IGSID (best-effort; requer permissao). Se falhar, retorna null.
async function resolveUsername(igsid: string): Promise<string | null> {
  try {
    const token = process.env.IG_PAGE_TOKEN;
    if (!token) return null;
    const r = await fetch(`${GRAPH()}/${igsid}?fields=username,name&access_token=${encodeURIComponent(token)}`);
    const j: any = await r.json().catch(() => ({}));
    return j?.username || j?.name || null;
  } catch {
    return null;
  }
}

// Envia texto para o usuario do Instagram pela Graph API (Send API).
async function igSend(igsid: string, text: string): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const token = process.env.IG_PAGE_TOKEN;
    if (!token) return { success: false, error: "IG_PAGE_TOKEN ausente" };
    const r = await fetch(`${GRAPH()}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: igsid }, message: { text: String(text || "").slice(0, 950) } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { success: false, error: `graph ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
    return { success: true, id: j?.message_id || j?.id };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// Envia uma IMAGEM (por URL publica) para o usuario do Instagram pela Send API.
async function igSendImage(igsid: string, url: string): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const token = process.env.IG_PAGE_TOKEN;
    if (!token) return { success: false, error: "IG_PAGE_TOKEN ausente" };
    const r = await fetch(`${GRAPH()}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: igsid }, message: { attachment: { type: "image", payload: { url, is_reusable: true } } } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { success: false, error: `graph ${r.status}: ${JSON.stringify(j).slice(0, 200)}` };
    return { success: true, id: j?.message_id || j?.id };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// Valida a assinatura do webhook (opcional; so quando IG_APP_SECRET esta setado).
function validSignature(req: Request, rawBody: string): boolean {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) return true; // sem secret configurado -> nao valida (aceita)
  const sig = String(req.headers["x-hub-signature-256"] || "");
  if (!sig.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Processa 1 mensagem recebida (fire-and-forget; nao segura a resposta do webhook).
async function handleInbound(igsid: string, text: string, mid: string): Promise<void> {
  try {
    if (!igsid || !text || !text.trim()) return;
    // dedup por message id da Meta
    if (mid) {
      try {
        const exists = await storage.getChatMessageByExternalId(mid);
        if (exists) return;
      } catch {}
    }
    const phoneKey = "ig:" + igsid;
    const username = await resolveUsername(igsid);
    const displayName = username ? "@" + username : "Instagram " + igsid.slice(-6);

    // Busca a conversa MAIS RECENTE desse contato. Le em snake_case cru + helper tolerante ao casing.
    let existing: any = (await db.execute(sql`SELECT id, customer_id, unread_count, status FROM chat_conversations WHERE customer_phone = ${phoneKey} ORDER BY last_message_time DESC NULLS LAST LIMIT 1`)).rows?.[0];
    const _cid = (o: any) => o && (o.customer_id ?? o.customerId ?? o.customerid);
    const _unr = (o: any) => { const v = o && (o.unread_count ?? o.unreadCount ?? o.unreadcount); return Number(v) || 0; };

    // ATENCAO: existe UNIQUE(customer_phone) em chat_conversations — NAO da pra ter duas conversas
    // com o mesmo telefone. Por isso, quando ja existe conversa desse contato, a gente REABRE ela
    // (se estava 'resolved' pela varredura de inatividade, volta pra fila como 'new') e adiciona a
    // mensagem. So cria conversa nova no PRIMEIRO contato do telefone. Isso elimina a colisao de
    // chave duplicada que derrubava a resposta quando o cliente voltava a falar.
    let convId: string | null = null;
    let convCustomerId: string | null = null;
    if (existing) {
      convId = existing.id;
      convCustomerId = _cid(existing) || null;
      const wasResolved = String(existing.status || "") === "resolved";
      try {
        await storage.updateChatConversation(existing.id, {
          ...(wasResolved ? { status: "new" } : {}),
          lastMessageTime: new Date(),
          unreadCount: _unr(existing) + 1,
        } as any);
      } catch {}
    } else {
      // Primeiro contato desse telefone: resolve o cliente sem NUNCA derrubar o handleInbound
      // (telefone pode estar salvo normalizado, sem "ig:").
      let customerId: string | null = null;
      let customerName: string = displayName;
      let customer: any = null;
      try { customer = await storage.getChatCustomerByPhone(phoneKey); } catch {}
      if (!customer) { try { customer = (await db.execute(sql`SELECT id, name FROM chat_customers WHERE phone = ${phoneKey} OR phone = ${igsid} OR phone LIKE ${'%' + igsid} LIMIT 1`)).rows?.[0]; } catch {} }
      if (!customer) {
        try {
          customer = await storage.createChatCustomer({ name: displayName, phone: phoneKey, email: null, notes: "Instagram Direct" + (username ? " (@" + username + ")" : ""), tags: "instagram", avatar: null } as any);
        } catch {
          try { customer = (await db.execute(sql`SELECT id, name FROM chat_customers WHERE phone = ${phoneKey} OR phone = ${igsid} OR phone LIKE ${'%' + igsid} LIMIT 1`)).rows?.[0]; } catch {}
        }
      }
      customerId = (customer && customer.id) || null;
      if (customer && customer.name) customerName = customer.name;
      if (!customerId) customerId = "ig-cust-" + igsid; // fallback final: garante um id
      convCustomerId = customerId;
      // Cria a conversa; se colidir no unique (corrida com outro webhook), reabre a existente.
      try {
        const created: any = await storage.createChatConversation({ customerId, customerName, customerPhone: phoneKey, status: "new", agentId: null, lastMessageTime: new Date(), unreadCount: 1 } as any);
        convId = created.id;
        convCustomerId = created.customerId || customerId;
      } catch {
        const again: any = (await db.execute(sql`SELECT id, customer_id FROM chat_conversations WHERE customer_phone = ${phoneKey} ORDER BY last_message_time DESC NULLS LAST LIMIT 1`)).rows?.[0];
        if (again) {
          convId = again.id;
          convCustomerId = _cid(again) || customerId;
          try { await storage.updateChatConversation(again.id, { status: "new", lastMessageTime: new Date() } as any); } catch {}
        }
      }
    }

    if (!convId) return; // seguranca: sem conversa nao ha o que processar
    const conversation: any = { id: convId, customerId: convCustomerId };

    await storage.createChatMessage({
      conversationId: conversation.id,
      senderId: conversation.customerId,
      senderType: "customer",
      content: text,
      messageType: "text",
      externalId: mid || undefined,
      metadata: { channel: "instagram", igsid, username } as any,
    } as any);

    console.log(`[IG-IN] igsid=${igsid} user=${username || "-"} conv=${conversation.id} text=${text.slice(0, 40)}`);

    // Motor de agentes (mesmo do WhatsApp), canal instagram. Gate off/test/on em system_settings agents_ig_mode.
    const { maybeRunAgent } = await import("./agent-runtime");
    await maybeRunAgent({
      phone: igsid,
      conversationId: conversation.id,
      incomingText: text,
      sendText: (_to: string, t: string) => igSend(igsid, t),
      sendImage: (url: string) => igSendImage(igsid, url),
      channel: "instagram",
      username: username || igsid,
    });
  } catch (e: any) {
    console.error("[IG-IN] erro:", e?.message || e);
  }
}

export function registerInstagram(app: Express) {
  // Tabela de vinculo pedido<->cobranca PIX do Instagram (idempotente).
  const ensureIgPix = async () => { try { await db.execute(sql`CREATE TABLE IF NOT EXISTS instagram_pix (id varchar PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id varchar, sales_card_id varchar, order_number varchar, igsid varchar, customer_name varchar, customer_document varchar, total numeric(12,2), charge_id varchar, txid varchar, status varchar DEFAULT 'registered', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), paid_at timestamptz)`); } catch {} };
  ensureIgPix();

  // Rota publica: serve o QR Code do PIX como PNG (o Instagram exige URL publica de imagem, nao base64).
  app.get("/api/pix-qr/:id.png", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id || "").replace(/\.png$/i, "");
      const r: any = await db.execute(sql`SELECT qr_code_base64 FROM pix_charges WHERE id = ${id} LIMIT 1`);
      const b64raw = r.rows?.[0]?.qr_code_base64;
      if (!b64raw) { res.status(404).send("nao encontrado"); return; }
      const b64 = String(b64raw).replace(/^data:image\/\w+;base64,/, "");
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=300");
      res.send(Buffer.from(b64, "base64"));
    } catch (e: any) { res.status(500).send("erro"); }
  });

  // Varredura de pagamentos PIX do Instagram (a cada 60s): confirma o pagamento no BB, marca o
  // pedido como "Pago" no pipeline e NOTIFICA o cliente na conversa. Faturamento fiscal segue manual.
  try {
    setInterval(async () => {
      try {
        await ensureIgPix();
        try { await db.execute(sql`UPDATE instagram_pix SET status='expired', updated_at=now() WHERE status='awaiting_payment' AND created_at < now() - interval '24 hours'`); } catch {}
        const pend: any = await db.execute(sql`SELECT id, charge_id, txid, sales_card_id, order_number, igsid, total FROM instagram_pix WHERE status = 'awaiting_payment' AND charge_id IS NOT NULL`);
        const rows = pend.rows || [];
        if (!rows.length) return;
        const { checkChargeStatus } = await import("./bb-pix-service");
        for (const row of rows) {
          try {
            const c: any = await checkChargeStatus(row.charge_id);
            if (String(c?.status || "") === "CONCLUIDA") {
              await db.execute(sql`UPDATE instagram_pix SET status='paid', paid_at=now(), updated_at=now() WHERE id=${row.id}`);
              // Acende o badge "Pago" no pipeline (mesma leitura da loja online).
              try { await db.execute(sql`INSERT INTO hotsite_pending_pix (id, charge_id, txid, amount, payload, status, order_id, order_number, created_at, updated_at) VALUES (gen_random_uuid(), ${row.charge_id}, ${row.txid || null}, ${row.total}, '{}', 'paid', ${row.sales_card_id}, ${row.order_number}, now(), now())`); } catch (e: any) { console.error("[IG-PIX-SWEEP] badge", e?.message || e); }
              try { await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') || ${"\n💰 PIX PAGO via Instagram (" + (row.order_number || "") + ")"} WHERE id=${row.sales_card_id}`); } catch {}
              try { if (row.igsid) await igSend(row.igsid, "✅ Recebemos seu pagamento! Seu pedido está confirmado e já seguirá para a entrega. Muito obrigado pela preferência! 🧡"); } catch {}
              console.log(`[IG-PIX] pago card=${row.sales_card_id} charge=${row.charge_id}`);
            }
          } catch (e: any) { console.error("[IG-PIX-SWEEP] item", row?.charge_id, e?.message || e); }
        }
      } catch (e: any) { console.error("[IG-PIX-SWEEP]", e?.message || e); }
    }, 60 * 1000);
  } catch {}

  // Varredura periodica: finaliza (status 'resolved') conversas de Instagram inativas apos
  // IG_RESET_MINUTES sem novas mensagens. Mantem a fila limpa; na volta do cliente uma nova
  // conversa e criada, reiniciando o dialogo. Roda a cada 10 min (nao afeta a inicializacao).
  try {
    setInterval(async () => {
      try {
        const resetMin = parseInt(process.env.IG_RESET_MINUTES || "120", 10);
        if (resetMin > 0) {
          await db.execute(sql`UPDATE chat_conversations SET status = 'resolved' WHERE customer_phone LIKE 'ig:%' AND status <> 'resolved' AND last_message_time < NOW() - make_interval(mins => ${resetMin})`);
        }
      } catch (e: any) { console.error("[IG-SWEEP]", e?.message || e); }
    }, 10 * 60 * 1000);
  } catch {}

  // Verificacao do webhook (Meta chama isso 1x ao configurar).
  app.get("/api/instagram/webhook", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token && token === process.env.IG_VERIFY_TOKEN) {
      return res.status(200).send(String(challenge || ""));
    }
    return res.sendStatus(403);
  });

  // Recebimento de mensagens do Instagram.
  app.post("/api/instagram/webhook", (req: Request, res: Response) => {
    // responde 200 rapido (a Meta exige) e processa depois
    res.sendStatus(200);
    try {
      const raw = (req as any).rawBody ? String((req as any).rawBody) : JSON.stringify(req.body || {});
      const body: any = req.body || {};
      recordHook({ at: new Date().toISOString(), object: body.object, raw: raw.slice(0, 2000) });
      if (!validSignature(req, raw)) {
        console.warn("[IG-HOOK] assinatura invalida - ignorado");
        return;
      }
      if (body.object !== "instagram") return;
      for (const entry of body.entry || []) {
        // formato Messenger-style: entry.messaging[]
        for (const ev of entry.messaging || []) {
          const msg = ev.message;
          if (!msg || msg.is_echo) continue; // ignora echo (mensagens que a propria conta enviou)
          const igsid = ev.sender && ev.sender.id;
          const text = msg.text;
          const mid = msg.mid;
          if (igsid && text) handleInbound(String(igsid), String(text), String(mid || "")).catch(() => {});
        }
        // formato changes/field: entry.changes[] com field=messages
        for (const ch of entry.changes || []) {
          if (ch.field && ch.field !== "messages") continue;
          const v = ch.value || {};
          const msg = v.message || {};
          if (msg.is_echo) continue;
          const igsid = v.sender && v.sender.id;
          const text = msg.text;
          const mid = msg.mid;
          if (igsid && text) handleInbound(String(igsid), String(text), String(mid || "")).catch(() => {});
        }
      }
    } catch (e: any) {
      console.error("[IG-HOOK] erro:", e?.message || e);
    }
  });

  // Diagnostico (sem expor segredos).
  app.get("/api/instagram/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      hasVerifyToken: !!process.env.IG_VERIFY_TOKEN,
      hasPageToken: !!process.env.IG_PAGE_TOKEN,
      hasAppSecret: !!process.env.IG_APP_SECRET,
      graphVersion: process.env.GRAPH_VERSION || "v21.0",
      hooksRecebidos: recentHooks.length,
    });
  });

  // Diagnostico: ultimos payloads crus recebidos no webhook (sem segredos).
  app.get("/api/instagram/debug", (_req: Request, res: Response) => {
    res.json({ count: recentHooks.length, recent: recentHooks });
  });

  // Politica de Privacidade (pagina publica; exigida pela Meta para publicar o app).
  app.get("/politica-de-privacidade", (_req: Request, res: Response) => {
    res.set("content-type", "text/html; charset=utf-8").send(PRIVACY_HTML);
  });
}

const PRIVACY_HTML = [
  '<!DOCTYPE html>',
  '<html lang="pt-BR"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Politica de Privacidade - Honest Atendimento</title>',
  '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#222;max-width:820px;margin:0 auto;padding:32px 20px}h1{color:#0b7a3b}h2{margin-top:28px;color:#0b7a3b;font-size:1.15rem}a{color:#0b7a3b}small{color:#666}</style>',
  '</head><body>',
  '<h1>Politica de Privacidade</h1>',
  '<p><small>Honest Sucos Naturais - Aplicativo &quot;Honest Atendimento&quot; (Instagram Direct). Ultima atualizacao: 20 de julho de 2026.</small></p>',
  '<p>Esta Politica de Privacidade descreve como a Honest Sucos Naturais (&quot;Honest&quot;, &quot;nos&quot;) coleta, usa e protege as informacoes de pessoas que entram em contato conosco pelo Instagram Direct por meio do nosso atendente virtual.</p>',
  '<h2>1. Quem somos</h2>',
  '<p>Honest Sucos Naturais, sediada em Goiania-GO, Brasil. Contato: flaviobaylao@gmail.com.</p>',
  '<h2>2. Dados que coletamos</h2>',
  '<p>Quando voce nos envia uma mensagem no Instagram Direct, coletamos: o conteudo das mensagens que voce envia; seu nome de usuario e identificador do Instagram; e a data e hora das interacoes. Nao coletamos senhas nem dados de pagamento por este canal.</p>',
  '<h2>3. Como usamos os dados</h2>',
  '<p>Utilizamos esses dados exclusivamente para: responder as suas mensagens e duvidas; prestar atendimento e informar sobre nossos produtos; e encaminhar seu atendimento a um atendente humano quando necessario. Um assistente de inteligencia artificial pode gerar as respostas automaticas.</p>',
  '<h2>4. Base legal (LGPD)</h2>',
  '<p>Tratamos seus dados com base na execucao de atendimento por voce solicitado, no legitimo interesse de responder contatos e, quando aplicavel, no seu consentimento, nos termos da Lei Geral de Protecao de Dados (Lei 13.709/2018).</p>',
  '<h2>5. Compartilhamento</h2>',
  '<p>Nao vendemos seus dados. Compartilhamos informacoes apenas com prestadores de servico necessarios para operar o atendimento, tais como a Meta/Instagram (plataforma de mensagens), provedores de infraestrutura de nuvem e provedores de tecnologia de IA que processam as mensagens para gerar respostas, sempre limitados a finalidade descrita nesta politica.</p>',
  '<h2>6. Retencao</h2>',
  '<p>Mantemos os dados das conversas pelo tempo necessario para o atendimento e para cumprir obrigacoes legais, apos o que sao eliminados ou anonimizados.</p>',
  '<h2>7. Seus direitos</h2>',
  '<p>Voce pode solicitar acesso, correcao, portabilidade ou exclusao dos seus dados, bem como revogar consentimento, entrando em contato pelo e-mail flaviobaylao@gmail.com.</p>',
  '<h2>8. Exclusao de dados</h2>',
  '<p>Para solicitar a exclusao dos dados coletados pelo nosso atendimento no Instagram, envie um e-mail para flaviobaylao@gmail.com com o assunto &quot;Exclusao de dados&quot; informando seu nome de usuario do Instagram. Atenderemos a solicitacao no prazo previsto em lei.</p>',
  '<h2>9. Seguranca</h2>',
  '<p>Adotamos medidas tecnicas e organizacionais razoaveis para proteger os dados contra acesso nao autorizado, perda ou uso indevido.</p>',
  '<h2>10. Contato</h2>',
  '<p>Duvidas sobre esta politica ou sobre seus dados: flaviobaylao@gmail.com.</p>',
  '</body></html>',
].join("\n");
