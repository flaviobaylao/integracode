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
