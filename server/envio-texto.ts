// ============================================================================
// INTEGRA 2.0 — Envio de texto do atendente: rota certa, fallback e reenvio
//
// A Leticia mandou "Bom dia! Tudo bem?" as 08:05 para a COOPGRAFICA e apareceu
// "⚠ nao entregue". A conversa tinha entrado pelo 1841 (canal OFICIAL da Meta), e no
// canal oficial texto livre so passa dentro da janela de 24h contada a partir da ULTIMA
// mensagem do cliente. Fora dela, so template aprovado — a Meta recusa e a mensagem
// morre. O sistema tentava assim mesmo e devolvia um HTTP cru que ninguem entendia.
//
// O erro cru era HTTP 400 com {"ChatId":["ContactCannotReceiveMessages",
// "ContactInactiveTemplateRequired"]} — ou seja, a janela. Duas coisas mudam aqui:
//
// 1) O envio deixa de tentar UM numero so. Percorre os numeros da Honest em cadeia
//    (o da conversa, o padrao, os demais) e para no primeiro que aceitar. Se um canal
//    esta com a janela fechada, outro pode entregar.
// 2) Quando NENHUM aceita, o motivo vira texto de gente: o cliente esta fora da janela
//    de 24h e so um template aprovado reabre a conversa. Sem isso o atendente ficava
//    reescrevendo a mesma mensagem contra uma parede.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const FONE_1841 = '5562994981841';

// Os tres numeros da Honest, na ordem em que vale a pena tentar. O oficial fica por
// ultimo: e ele que tem a trava de 24h da Meta.
const CANAIS = [
  { fone: '5562992682630', nome: '2630 (principal)' },
  { fone: '5562993227169', nome: '7169 (reserva)' },
  { fone: FONE_1841, nome: '1841 (oficial)' },
];

export type Envio = { success: boolean; messageId?: string; error?: string; via?: string; rota?: string; tentativas?: any[] };

function so(n: any): string { return String(n || '').replace(/\D/g, ''); }

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

// O provedor recusou porque a janela de 24h fechou? Nesse caso trocar de numero pode
// resolver (canal broker nao tem a trava) — por isso vale tentar o proximo da fila.
function janelaFechada(erro: string): boolean {
  return /ContactInactiveTemplateRequired|ContactCannotReceiveMessages|template|24h|outside|re-?engagement/i.test(String(erro || ''));
}

// Traduz o erro do provedor para algo que o atendente resolve sozinho.
export function explicaFalha(erro: string, canal: string): string {
  const e = String(erro || '');
  if (/canal_desligado/i.test(e)) return `O número ${canal} está desligado no painel de Gestão de Canais.`;
  if (/token/i.test(e)) return 'Integração com o Umbler sem token configurado.';
  if (/contato nao resolvido|chat nao resolvido/i.test(e)) return 'O Umbler não encontrou esse contato para este canal.';
  if (janelaFechada(e)) {
    return 'O cliente está fora da janela de 24h em todos os números: o WhatsApp só entrega mensagem livre '
      + 'até 24h depois da ÚLTIMA mensagem do cliente. Para reabrir a conversa é preciso um template aprovado '
      + '(os disparos de pedido/entrega/cobrança fazem isso) — ou esperar o cliente escrever.';
  }
  if (/HTTP 5\d\d|timeout|ECONN/i.test(e)) return 'O provedor está fora do ar no momento. Tente reenviar em instantes.';
  if (/HTTP 4\d\d/.test(e)) return 'O WhatsApp recusou a mensagem (' + e.slice(0, 120) + ').';
  return e.slice(0, 200);
}

/**
 * Envia um texto tentando os numeros em cadeia. Antes o sistema tentava UM numero so e
 * desistia — se aquele canal estivesse com a janela fechada, a mensagem morria mesmo
 * havendo outro numero capaz de entregar. Nunca lanca: devolve o resultado e o caminho.
 */
export async function enviarTexto(conversationId: string, toPhone: string, texto: string): Promise<Envio> {
  const destino = so(toPhone);
  if (!destino) return { success: false, error: 'Telefone do cliente vazio' };
  if (!texto || !texto.trim()) return { success: false, error: 'Mensagem vazia' };

  let canalDaConversa = '', oficial = false, janelaAberta = false;
  try {
    const r: any = await db.execute(sql`SELECT channel_phone, last_inbound_channel,
        (window_open_until IS NOT NULL AND window_open_until > now()) AS janela
      FROM chat_conversations WHERE id = ${conversationId} LIMIT 1`);
    const row = r.rows?.[0] || {};
    canalDaConversa = so(row.channel_phone);
    janelaAberta = !!row.janela;
    oficial = canalDaConversa === FONE_1841 || String(row.last_inbound_channel || '') === 'oficial_1841';
  } catch { /* sem dados da conversa: segue pela ordem padrao */ }

  const { sendUmblerTalkText, canalSaidaPadrao } = await import('./chat-routes');
  const { canalAtivoPorTelefone } = await import('./canais-gestao');
  const padrao = so(await canalSaidaPadrao());

  // ------------------------------------------------------------------------
  // ETAPA 3 — atendimento SO pelo 1841 (chave `envio_so_oficial`).
  // Desligada (padrao), tudo segue como hoje: a escada de canais tenta os outros numeros
  // quando o oficial recusa, e e ela que vem salvando mensagem fora da janela.
  // Ligada, a escada some: o 1841 e o unico caminho. Fora da janela de 24h a mensagem NAO
  // sai — e isso e intencional, e a regra da Meta. A saida passa a ser o botao "Retomar
  // contato" (etapa 2), com template aprovado.
  // Rollback: `envio_so_oficial = off` no painel de Regras (MARCO ZERO HONEST).
  // ------------------------------------------------------------------------
  const soOficial = (await getSetting('envio_so_oficial', 'off')) === 'on';

  const fila: string[] = [];
  const põe = (f: string) => { const d = so(f); if (d && !fila.includes(d)) fila.push(d); };
  if (soOficial) {
    põe(FONE_1841);
  } else {
    // Ordem: o numero em que o cliente escreveu primeiro (e o que ele reconhece), depois o
    // padrao, depois os demais. O 1841 so entra na frente quando a janela dele esta aberta.
    if (oficial && janelaAberta) põe(FONE_1841);
    else if (canalDaConversa && canalDaConversa !== FONE_1841) põe(canalDaConversa);
    põe(padrao);
    for (const c of CANAIS) if (c.fone !== FONE_1841) põe(c.fone);
    if (oficial && janelaAberta) { /* ja esta na frente */ } else põe(FONE_1841);
  }

  // Com o modo so-oficial ligado e a janela fechada, nem vale tentar: a Meta recusa e o
  // atendente perde tempo. Melhor devolver na hora o que ele precisa fazer.
  if (soOficial && !janelaAberta) {
    return {
      success: false, via: FONE_1841, rota: 'so 1841, janela de 24h fechada', tentativas: [],
      error: 'Fora da janela de 24h: o WhatsApp não entrega mensagem livre agora. '
        + 'Use "Retomar contato" e envie um template aprovado — a janela reabre quando o cliente responder.',
    };
  }

  const tentativas: any[] = [];
  for (const fone of fila) {
    if (!(await canalAtivoPorTelefone(fone).catch(() => true))) {
      tentativas.push({ canal: fone, resultado: 'desligado no painel' });
      continue;
    }
    // O 1841 com janela aberta tem endpoint proprio (chat oficial).
    if (fone === FONE_1841 && janelaAberta) {
      try {
        const { sendOfficialText } = await import('./official-dispatch');
        const r = await sendOfficialText(destino, texto);
        tentativas.push({ canal: fone, resultado: r?.success ? 'entregue' : (r?.error || 'falhou') });
        if (r?.success) return { success: true, via: '1841', rota: 'canal oficial, janela aberta', tentativas };
        continue;
      } catch (e: any) { tentativas.push({ canal: fone, resultado: e?.message || String(e) }); continue; }
    }
    try {
      const r = await sendUmblerTalkText(destino, texto, fone);
      tentativas.push({ canal: fone, resultado: r?.success ? 'entregue' : (r?.error || 'falhou') });
      if (r?.success) {
        const nome = CANAIS.find(c => c.fone === fone)?.nome || fone;
        return { success: true, messageId: r.messageId, via: fone,
                 rota: fila[0] === fone ? 'canal da conversa' : ('enviado pelo ' + nome), tentativas };
      }
      // Erro que nao e de janela (canal fora do ar, config): nao adianta insistir igual,
      // mas o proximo numero pode estar bom — segue a fila do mesmo jeito.
    } catch (e: any) { tentativas.push({ canal: fone, resultado: e?.message || String(e) }); }
  }

  const ultimo = tentativas.length ? String(tentativas[tentativas.length - 1].resultado || '') : '';
  const algumaJanela = tentativas.some(t => janelaFechada(String(t.resultado || '')));
  return { success: false, tentativas, via: fila[0] || undefined,
           rota: 'tentou ' + fila.length + ' número(s)',
           error: explicaFalha(algumaJanela ? 'ContactInactiveTemplateRequired' : ultimo, fila[0] || 'padrao') };
}


/**
 * Aviso INTERNO (vendedor, coordenacao) — nao e conversa com cliente.
 *
 * Estas mensagens sairam do ar quando o canal de saida padrao virou o 1841: aviso de
 * pedido, bloqueio e debito passaram a tentar o canal OFICIAL, onde texto livre so passa
 * dentro da janela de 24h. Vendedor nao "conversa" com o numero oficial, entao a janela
 * dele esta sempre fechada e TODA notificacao era recusada em silencio (confirmado pelo
 * teste da automacao: ContactCannotReceiveMessages / ContactInactiveTemplateRequired).
 *
 * Aqui a ordem e o contrario da conversa com cliente: os canais comuns primeiro, e o
 * oficial so como ultimo recurso. Aviso interno nunca deveria depender de janela.
 */
export async function enviarInterno(toPhone: string, texto: string): Promise<Envio> {
  const destino = so(toPhone);
  if (!destino) return { success: false, error: 'Telefone vazio' };
  if (!texto || !texto.trim()) return { success: false, error: 'Mensagem vazia' };

  const { sendUmblerTalkText } = await import('./chat-routes');
  const { canalAtivoPorTelefone } = await import('./canais-gestao');

  // Preferencia configuravel; sem ela, os comuns na ordem e o oficial por ultimo.
  const preferido = so(await getSetting('canal_saida_interna', ''));
  const fila: string[] = [];
  const põe = (f: string) => { const d = so(f); if (d && !fila.includes(d)) fila.push(d); };
  põe(preferido);
  for (const c of CANAIS) if (c.fone !== FONE_1841) põe(c.fone);
  põe(FONE_1841);

  const tentativas: any[] = [];
  for (const fone of fila) {
    if (!(await canalAtivoPorTelefone(fone).catch(() => true))) {
      tentativas.push({ canal: fone, resultado: 'desligado no painel' });
      continue;
    }
    try {
      const r = await sendUmblerTalkText(destino, texto, fone);
      tentativas.push({ canal: fone, resultado: r?.success ? 'entregue' : (r?.error || 'falhou') });
      if (r?.success) {
        const nome = CANAIS.find(c => c.fone === fone)?.nome || fone;
        return { success: true, messageId: r.messageId, via: fone, rota: 'aviso interno pelo ' + nome, tentativas };
      }
    } catch (e: any) { tentativas.push({ canal: fone, resultado: e?.message || String(e) }); }
  }
  const ultimo = tentativas.length ? String(tentativas[tentativas.length - 1].resultado || '') : '';
  return { success: false, tentativas, rota: 'tentou ' + fila.length + ' número(s)',
           error: explicaFalha(ultimo, fila[0] || 'padrao') };
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
