// ============================================================================
// INTEGRA 2.0 — Do outro lado tem outro robô
// Muitos clientes usam bot no WhatsApp. Quando a Honest escreve, quem responde e a
// URA deles: "nao foi possivel processar sua ultima mensagem", "aguarde que estou te
// transferindo". Nossa IA lia aquilo como cliente e respondia — e os dois robos ficavam
// conversando um com o outro, gastando janela, mensagem e paciencia.
//
// Aqui a conversa PARA: a IA responde uma vez avisando que aguarda uma pessoa, marca a
// conversa como aguardando resposta e sai. Quem retoma e um atendente.
//
// Wiring: chamado pelo reactiveInbound (ia-takeover), antes de qualquer outra regra.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

function normalizar(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Frases de resposta automatica. Sao TRECHOS longos de proposito: "bot" ou "menu"
// sozinhos apareceriam em conversa de gente ("vou ver no menu do sistema").
const FRASES_ROBO = [
  'nao foi possivel processar sua ultima mensagem',
  'nao foi possivel processar a sua mensagem',
  'formato enviado nao e compativel',
  'envie sua solicitacao em texto',
  'aguarde um momento que estou te transferindo',
  'estou te transferindo para um de nossos atendentes',
  'esta e uma mensagem automatica',
  'mensagem automatica',
  'atendimento automatico',
  'sou o assistente virtual',
  'assistente virtual',
  'digite o numero da opcao',
  'digite uma das opcoes',
  'responda com uma das opcoes',
  'para falar com um atendente digite',
  'escolha uma das opcoes abaixo',
  'menu principal',
  'este numero nao recebe',
  'nao recebemos mensagens neste numero',
  'sua mensagem foi recebida e sera respondida',
  'estamos fora do horario de atendimento',
  'nosso horario de atendimento e',
];

export function pareceRobo(texto: string): boolean {
  const t = normalizar(texto);
  if (!t || t.length < 12) return false;               // "ok", "sim" nao sao robo
  return FRASES_ROBO.some(f => t.includes(f));
}

const AVISO_PADRAO = 'Aguardo a interação de um humano na resposta. 🧡';

/**
 * A conversa deve parar aqui? Devolve o texto a responder (uma unica vez) ou null.
 * Dispara quando: (a) a mensagem tem cara de resposta automatica, ou (b) o cliente
 * repetiu exatamente a mesma mensagem que ja tinha mandado — sinal de laco.
 */
export async function respostaDeRobo(conversationId: string, texto: string): Promise<string | null> {
  try {
    if ((await getSetting('ia_para_com_robo', 'on')) !== 'on') return null;

    let motivo = '';
    if (pareceRobo(texto)) motivo = 'resposta automatica do outro lado';
    else {
      // Laco: a mesma mensagem do cliente chegando de novo, seguida.
      const r: any = await db.execute(sql`SELECT content FROM chat_messages
        WHERE conversation_id = ${conversationId} AND sender_type = 'customer'
        ORDER BY created_at DESC LIMIT 3`);
      const ultimas = (r.rows || []).map((x: any) => normalizar(x.content));
      const atual = normalizar(texto);
      if (atual.length > 15 && ultimas.filter(x => x === atual).length >= 2) motivo = 'cliente repetindo a mesma mensagem';
    }
    if (!motivo) return null;

    // Avisa UMA vez por conversa: sem isso, dois robos trocariam o mesmo aviso sem fim.
    const chave = 'ia_robo_avisado:' + conversationId;
    if ((await getSetting(chave, '')) !== '') {
      console.log(`[ROBO] ${conversationId}: ${motivo} — ja avisado, seguindo em silencio`);
      return '';   // string vazia = nao responde, mas TAMBEM nao chama a IA
    }
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
      VALUES (${chave}, ${new Date().toISOString()}, 'robo-detector')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

    // Tira a IA da conversa e chama gente: quem responde robo e humano.
    try {
      await db.execute(sql`INSERT INTO system_settings (key, value, updated_by)
        VALUES (${'chat_ai_paused:' + conversationId}, ${new Date().toISOString()}, 'robo-detector')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    } catch {}
    try {
      const { marcarAguardando } = await import('./ia-fila');
      await marcarAguardando(conversationId);
    } catch { /* etiqueta e melhor esforco */ }

    console.log(`[ROBO] ${conversationId}: ${motivo} — IA parou e marcou para atendimento humano`);
    return await getSetting('ia_robo_texto', AVISO_PADRAO);
  } catch (e: any) {
    console.error('[ROBO]', e?.message || e);
    return null;
  }
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
