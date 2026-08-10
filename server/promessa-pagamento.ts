// ============================================================================
// INTEGRA 2.0 — "Previsão de Pagamento" (resposta ao aviso de cobrança)
// O botao do template `cobranca_vencida` NAO e o cliente PEDINDO uma previsao — e ele
// se oferecendo para INFORMAR a data em que vai pagar. A IA lia ao contrario e
// respondia "nao tenho acesso a previsao de pagamento por aqui", jogando fora uma
// promessa de pagamento que o financeiro quer ter registrada.
//
// Fluxo:
//   "Previsão de Pagamento" -> pergunta a data e fica aguardando
//   proxima mensagem com data -> grava a promessa e confirma
//   "Será pago hoje"        -> grava a promessa para hoje, direto
//
// Wiring: registerPromessaPagamento(app) e chamado pelo registerChatRoutes.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser } from './authMiddleware';

let _pronta = false;
async function ensureTabela(): Promise<void> {
  if (_pronta) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS promessas_pagamento (
    id serial PRIMARY KEY,
    customer_id varchar(64),
    telefone varchar(20),
    titulo varchar(60),
    valor varchar(30),
    vencimento varchar(20),
    data_prometida date,
    status varchar(20) NOT NULL DEFAULT 'aguardando_data',
    origem varchar(30) DEFAULT 'whatsapp',
    criado_at timestamptz DEFAULT now(),
    atualizado_at timestamptz DEFAULT now()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_promessa_cli ON promessas_pagamento (customer_id, status)`);
  _pronta = true;
}

function normalizar(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9\/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

// Le a data que o cliente escreveu. Aceita 10/08, 10/08/2026, "hoje", "amanha",
// "sexta", "dia 10". Devolve null quando nao ha data — assim uma conversa comum nao
// vira promessa de pagamento por engano.
export function lerData(texto: string, agora = new Date()): Date | null {
  const t = normalizar(texto);
  if (!t) return null;
  const hojeBR = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  hojeBR.setHours(12, 0, 0, 0);

  if (/\bhoje\b/.test(t)) return hojeBR;
  if (/\bamanha\b/.test(t)) { const d = new Date(hojeBR); d.setDate(d.getDate() + 1); return d; }
  if (/depois de amanha/.test(t)) { const d = new Date(hojeBR); d.setDate(d.getDate() + 2); return d; }

  const dm = t.match(/(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?/);
  if (dm) {
    const dia = parseInt(dm[1], 10), mes = parseInt(dm[2], 10) - 1;
    let ano = dm[3] ? parseInt(dm[3], 10) : hojeBR.getFullYear();
    if (ano < 100) ano += 2000;
    const d = new Date(ano, mes, dia, 12, 0, 0);
    if (isNaN(d.getTime())) return null;
    // Data sem ano que ja passou = ano que vem (cliente falando de janeiro em dezembro).
    if (!dm[3] && d < hojeBR) d.setFullYear(ano + 1);
    return d;
  }

  const so = t.match(/\bdia\s+(\d{1,2})\b/);
  if (so) {
    const dia = parseInt(so[1], 10);
    const d = new Date(hojeBR.getFullYear(), hojeBR.getMonth(), dia, 12, 0, 0);
    if (d < hojeBR) d.setMonth(d.getMonth() + 1);
    return d;
  }

  for (const [nome, dow] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp('\\b' + nome + '\\b').test(t)) {
      const d = new Date(hojeBR);
      let delta = (dow - d.getDay() + 7) % 7;
      if (delta === 0) delta = 7;                 // "sexta" dito na sexta = proxima
      d.setDate(d.getDate() + delta);
      return d;
    }
  }
  return null;
}

const fmt = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Trata a resposta ao aviso de cobranca. Devolve o texto a responder, ou null quando a
 * mensagem nao tem a ver com previsao de pagamento (a IA segue normal).
 */
export async function respostaDeCobranca(phone: string, texto: string): Promise<string | null> {
  try {
    await ensureTabela();
    const t = normalizar(texto);
    if (!t || t.length > 80) return null;
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length < 8) return null;
    const fim = d.slice(-8);

    // So vale para quem recebeu aviso de cobranca nas ultimas 72h.
    const disp: any = await db.execute(sql`
      SELECT customer_id, params, template_label FROM official_dispatches
      WHERE right(customer_phone, 8) = ${fim}
        AND use_case = 'cobranca'
        AND status IN ('enviada','entregue','lida','resposta')
        AND sent_at > now() - interval '72 hours'
      ORDER BY sent_at DESC LIMIT 1`);
    const cob = disp.rows?.[0];
    if (!cob) return null;

    const ps: any[] = Array.isArray(cob.params) ? cob.params : [];
    const nome = String(ps[0] || '').split(' ')[0] || '';
    const titulo = String(ps[1] || '');
    const valor = String(ps[2] || '');
    const venc = String(ps[3] || '');

    const abrir = async (status: string, quando: Date | null) => {
      await db.execute(sql`
        INSERT INTO promessas_pagamento (customer_id, telefone, titulo, valor, vencimento, data_prometida, status)
        VALUES (${cob.customer_id || null}, ${d}, ${titulo || null}, ${valor || null}, ${venc || null},
                ${quando ? quando.toISOString().slice(0, 10) : null}, ${status})`);
    };

    // 1) "Será pago hoje" — promessa para hoje, sem perguntar nada.
    if (['sera pago hoje', 'pago hoje', 'pagarei hoje', 'vou pagar hoje'].includes(t)) {
      const hoje = lerData('hoje')!;
      await abrir('registrada', hoje);
      return `Perfeito${nome ? ', ' + nome : ''}! Anotei o pagamento${titulo ? ' do título ' + titulo : ''} para hoje. `
        + `Assim que cair, a baixa é automática. Se precisar da 2ª via, é só pedir aqui. 🧡`;
    }

    // 2) "Previsão de Pagamento" — o cliente quer INFORMAR a data. Pergunta e aguarda.
    if (['previsao de pagamento', 'previsao', 'previsao pagamento'].includes(t)) {
      const pend: any = await db.execute(sql`SELECT 1 FROM promessas_pagamento
        WHERE telefone = ${d} AND status = 'aguardando_data'
          AND criado_at > now() - interval '24 hours' LIMIT 1`);
      if (!pend.rows?.length) await abrir('aguardando_data', null);
      return `Claro${nome ? ', ' + nome : ''}! Para que dia você consegue pagar${titulo ? ' o título ' + titulo : ''}`
        + `${valor ? ' (' + valor + ')' : ''}?\n\nPode responder com a data — por exemplo *10/08* ou *sexta*.`;
    }

    // 3) Chegou uma data e existe uma previsao aguardando: fecha a promessa.
    const pend: any = await db.execute(sql`SELECT id FROM promessas_pagamento
      WHERE telefone = ${d} AND status = 'aguardando_data'
        AND criado_at > now() - interval '24 hours'
      ORDER BY criado_at DESC LIMIT 1`);
    if (!pend.rows?.length) return null;

    const quando = lerData(texto);
    if (!quando) return null;   // sem data reconhecida: deixa a IA conduzir

    await db.execute(sql`UPDATE promessas_pagamento
      SET data_prometida = ${quando.toISOString().slice(0, 10)}, status = 'registrada', atualizado_at = now()
      WHERE id = ${pend.rows[0].id}`);
    return `Anotado${nome ? ', ' + nome : ''}! Registrei sua previsão de pagamento para *${fmt(quando)}*`
      + `${titulo ? ' referente ao título ' + titulo : ''}. Já avisei o financeiro.\n\n`
      + `Se precisar da 2ª via ou do PIX, é só pedir aqui. 🧡`;
  } catch (e: any) {
    console.error('[PROMESSA-PGTO]', e?.message || e);
    return null;
  }
}

export function registerPromessaPagamento(app: any) {
  // Promessas registradas, para o financeiro acompanhar.
  app.get('/api/financeiro/promessas', authenticateUser, async (req: any, res: any) => {
    try {
      await ensureTabela();
      const status = String(req.query.status || 'registrada');
      const r: any = await db.execute(sql`
        SELECT p.id, p.customer_id, p.telefone, p.titulo, p.valor, p.vencimento,
               to_char(p.data_prometida, 'DD/MM/YYYY') AS promessa, p.status,
               -- criado_at e timestamptz: conversao curta (a dupla adiantaria 6h).
               to_char(p.criado_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando,
               COALESCE(c.fantasy_name, c.name) AS cliente
        FROM promessas_pagamento p
        LEFT JOIN customers c ON c.id = p.customer_id
        WHERE p.status = ${status}
        ORDER BY p.data_prometida NULLS LAST, p.criado_at DESC
        LIMIT 200`);
      res.json({ itens: r.rows || [] });
    } catch (e: any) { res.json({ itens: [], erro: e?.message }); }
  });

  console.log('[PROMESSA-PGTO] registrado (/api/financeiro/promessas)');
}
