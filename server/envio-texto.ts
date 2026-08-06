// ============================================================================
// INTEGRA 2.0 — Envio de texto do atendente: rota certa, fallback e reenvio
//
// A Leticia mandou "Bom dia! Tudo bem?" as 08:05 para a COOPGRAFICA e apareceu
// "⚠ nao entregue". A conversa tinha entrado pelo 1841 (canal OFICIAL da Meta), e no
// canal oficial texto livre so passa dentro da janela de 24h contada a partir da ULTIMA
// mensagem do cliente. Fora dela, so template aprovado — a Meta recusa e a mensagem
// morre. O sistema tentava assim mesmo e devolvia um HTTP cru que ninguem entendia.
//
// Aqui a rota e escolhida antes de tentar:
//   1841 com janela ABERTA  -> sai pelo proprio 1841 (texto livre vale)
//   1841 com janela FECHADA -> sai pelo canal principal (2630), que nao tem essa trava
//   qualquer outro canal    -> sai pelo canal da conversa, como sempre
// E se o envio falhar pelo 1841 mesmo assim, tenta o principal antes de desistir.
//
// O motivo da falha vira texto de gente ("janela de 24h fechada..."), nao HTTP 400.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const FONE_1841 = '5562994981841';

export type Envio = { success: boolean; messageId?: string; error?: string; via?: string; rota?: string };

function so(n: any): string { return String(n || '').replace(/\D/g, ''); }

// Traduz o erro do provedor para algo que o atendente resolve sozinho.
export function explicaFalha(erro: string, canal: string): string {
  const e = String(erro || '');
  if (/canal_desligado/i.test(e)) return `O número ${canal} está desligado no painel de Gestão de Canais.`;
  if (/token/i.test(e)) return 'Integração com o Umbler sem token configurado.';
  if (/contato nao resolvido|chat nao resolvido/i.test(e)) return 'O Umbler não encontrou esse contato/conversa para o canal oficial.';
  if (/24|window|template|re-?engagement|outside/i.test(e)) {
    return 'Janela de 24h do canal oficial fechada: fora dela o WhatsApp só aceita template aprovado. '
      + 'Reenvie — a mensagem sai pelo número principal.';
  }
  if (/HTTP 4\d\d/.test(e)) return 'O WhatsApp recusou a mensagem (' + e.slice(0, 80) + ').';
  if (/HTTP 5\d\d|timeout|ECONN/i.test(e)) return 'O provedor está fora do ar no momento. Tente reenviar em instantes.';
  return e.slice(0, 160);
}

/**
 * Envia um texto pela melhor rota da conversa. Nunca lanca: devolve o resultado.
 */
export async function enviarTexto(conversationId: string, toPhone: string, texto: string): Promise<Envio> {
  const destino = so(toPhone);
  if (!destino) return { success: false, error: 'Telefone do cliente vazio' };
  if (!texto || !texto.trim()) return { success: false, error: 'Mensagem vazia' };

  let canal = '', oficial = false, janelaAberta = false;
  try {
    const r: any = await db.execute(sql`SELECT channel_phone, last_inbound_channel,
        (window_open_until IS NOT NULL AND window_open_until > now()) AS janela
      FROM chat_conversations WHERE id = ${conversationId} LIMIT 1`);
    const row = r.rows?.[0] || {};
    canal = so(row.channel_phone);
    janelaAberta = !!row.janela;
    oficial = canal === FONE_1841 || String(row.last_inbound_channel || '') === 'oficial_1841';
  } catch { /* sem dados da conversa: segue pelo caminho comum */ }

  const principal = async (motivo: string): Promise<Envio> => {
    const { sendUmblerTalkText, canalSaidaPadrao } = await import('./chat-routes');
    const from = await canalSaidaPadrao();
    const r = await sendUmblerTalkText(destino, texto, from || undefined);
    return { ...r, via: so(from) || 'padrao', rota: motivo };
  };

  // Canal oficial: a janela manda.
  if (oficial) {
    if (janelaAberta) {
      try {
        const { sendOfficialText } = await import('./official-dispatch');
        const r = await sendOfficialText(destino, texto);
        if (r?.success) return { success: true, via: '1841', rota: 'oficial, janela aberta' };
        // Falhou no oficial: antes de dar a mensagem como perdida, tenta o principal.
        const alt = await principal('oficial falhou (' + (r?.error || 'sem motivo') + '), saiu pelo principal');
        if (alt.success) return alt;
        return { success: false, via: '1841', rota: 'oficial, janela aberta',
                 error: explicaFalha(r?.error || alt.error || 'falha desconhecida', '1841') };
      } catch (e: any) {
        const alt = await principal('erro no oficial, saiu pelo principal');
        if (alt.success) return alt;
        return { success: false, error: explicaFalha(e?.message || String(e), '1841') };
      }
    }
    // Janela fechada: nem tenta o oficial — a Meta recusaria. Vai direto pelo principal.
    const r = await principal('1841 com janela de 24h fechada — enviado pelo número principal');
    if (r.success) return r;
    return { ...r, error: explicaFalha(r.error || '', r.via || 'principal') };
  }

  // Canais comuns (2630 / 7169): sai pelo mesmo numero em que o cliente escreveu.
  try {
    const { sendUmblerTalkText } = await import('./chat-routes');
    const r = await sendUmblerTalkText(destino, texto, canal || undefined);
    if (r?.success) return { ...r, via: canal || 'padrao', rota: 'canal da conversa' };
    return { ...r, via: canal || 'padrao', rota: 'canal da conversa', error: explicaFalha(r?.error || '', canal || 'padrao') };
  } catch (e: any) {
    return { success: false, error: explicaFalha(e?.message || String(e), canal || 'padrao') };
  }
}

export function registerEnvioTexto(app: any) {
  // Reenviar uma mensagem que nao chegou. Nao cria mensagem nova: reaproveita a que ja
  // esta na conversa e atualiza o status dela — assim o historico nao enche de repetidas.
  app.post('/api/chat/messages/:id/reenviar', async (req: any, res: any) => {
    try {
      const id = String(req.params.id || '');
      const m: any = await db.execute(sql`SELECT m.id, m.conversation_id, m.content, m.message_type, m.metadata,
             c.customer_phone
        FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.id = ${id} LIMIT 1`);
      const msg = m.rows?.[0];
      if (!msg) return res.status(404).json({ error: 'mensagem nao encontrada' });
      if (String(msg.message_type || 'text') !== 'text') {
        return res.status(400).json({ error: 'por enquanto so da para reenviar mensagem de texto' });
      }

      const r = await enviarTexto(String(msg.conversation_id), String(msg.customer_phone), String(msg.content || ''));
      const meta = { ...((msg.metadata as any) || {}), delivery: {
        success: !!r.success, error: r.error || null, providerStatus: r.messageId || null,
        via: r.via || null, rota: r.rota || null, reenviadaEm: new Date().toISOString(),
      } };
      await db.execute(sql`UPDATE chat_messages SET ack = ${r.success ? 1 : 0}, metadata = ${JSON.stringify(meta)}::jsonb
        WHERE id = ${id}`);
      console.log(`[REENVIO] msg=${id} ok=${r.success} via=${r.via} rota=${r.rota} erro=${r.error || '-'}`);
      res.json({ ok: !!r.success, delivery: meta.delivery });
    } catch (e: any) {
      console.error('[REENVIO]', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  // Diagnostico: o que falhou, para quem, por qual canal e com que erro.
  app.get('/api/admin/ia-atendimento/envios-falhos', async (req: any, res: any) => {
    if (process.env.OFICIAL_ADMIN_KEY && req.query.k !== process.env.OFICIAL_ADMIN_KEY) {
      return res.status(403).json({ error: 'forbidden' });
    }
    try {
      const n = Math.min(100, Math.max(5, parseInt(String(req.query.n || '30'), 10) || 30));
      const r: any = await db.execute(sql`
        SELECT to_char(m.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando,
               c.customer_name AS cliente, c.customer_phone AS fone, c.channel_phone AS canal,
               c.last_inbound_channel AS entrou_por,
               (c.window_open_until IS NOT NULL AND c.window_open_until > now()) AS janela_aberta,
               m.metadata->'delivery'->>'error' AS erro,
               LEFT(m.content, 60) AS texto, m.id AS msg
        FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE m.metadata->'delivery'->>'success' = 'false'
        ORDER BY m.created_at DESC LIMIT ${n}`);
      const linhas = r.rows || [];
      const porErro: Record<string, number> = {};
      for (const l of linhas as any[]) { const k = String(l.erro || 'sem erro').slice(0, 70); porErro[k] = (porErro[k] || 0) + 1; }
      res.json({ total: linhas.length, porErro, linhas });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('[ENVIO-TEXTO] registrado (reenviar + envios-falhos)');
}
