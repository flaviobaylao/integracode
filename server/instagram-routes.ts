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

const GRAPH = () => `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}`;

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

    let conversation = await storage.getChatConversationByPhone(phoneKey);
    if (!conversation) {
      let customer = await storage.getChatCustomerByPhone(phoneKey);
      if (!customer) {
        customer = await storage.createChatCustomer({
          name: displayName,
          phone: phoneKey,
          email: null,
          notes: "Instagram Direct" + (username ? " (@" + username + ")" : ""),
          tags: "instagram",
          avatar: null,
        } as any);
      }
      conversation = await storage.createChatConversation({
        customerId: customer.id,
        customerName: customer.name,
        customerPhone: phoneKey,
        status: "new",
        agentId: null,
        lastMessageTime: new Date(),
        unreadCount: 1,
      } as any);
    } else {
      await storage.updateChatConversation(conversation.id, {
        lastMessageTime: new Date(),
        unreadCount: (conversation.unreadCount || 0) + 1,
      } as any);
    }

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
      channel: "instagram",
      username: username || igsid,
    });
  } catch (e: any) {
    console.error("[IG-IN] erro:", e?.message || e);
  }
}

export function registerInstagram(app: Express) {
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
      if (!validSignature(req, raw)) {
        console.warn("[IG-HOOK] assinatura invalida - ignorado");
        return;
      }
      const body: any = req.body || {};
      if (body.object !== "instagram") return;
      for (const entry of body.entry || []) {
        for (const ev of entry.messaging || []) {
          const msg = ev.message;
          if (!msg || msg.is_echo) continue; // ignora echo (mensagens que a propria conta enviou)
          const igsid = ev.sender && ev.sender.id;
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
    });
  });
}
