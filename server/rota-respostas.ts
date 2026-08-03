// ============================================================================
// INTEGRA 2.0 — Resposta do cliente ao aviso de VISITA (rota do dia)
// O template pergunta "podemos confirmar?" e o cliente toca em "Sim, confirmar" ou
// "Não". Sem tratamento proprio, esse toque chegava a IA como um "Sim" solto: ela nao
// sabia do que se tratava e respondia "o que voce gostaria de confirmar?".
//
// Aqui o toque vira DECISAO registrada:
//   Sim, confirmar -> confirmado  (agradece)
//   Nao            -> pergunta o motivo em 3 opcoes:
//                     1 estoque · 2 indisponivel · 3 remarcar
//
// A decisao aparece como etiqueta no card do cliente na Rota do Dia, para o vendedor
// nao ir a um cliente que ja avisou que nao vai comprar hoje.
//
// Wiring: registerRotaRespostas(app) e chamado pelo registerChatRoutes (depois da sessao).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser } from './authMiddleware';

let _pronta = false;
async function ensureTabela(): Promise<void> {
  if (_pronta) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS rota_decisoes (
    id serial PRIMARY KEY,
    customer_id varchar(64) NOT NULL,
    data_rota date NOT NULL,
    decisao varchar(20) NOT NULL,
    detalhe text,
    telefone varchar(20),
    criado_at timestamptz DEFAULT now(),
    atualizado_at timestamptz DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_rota_dec_cli_data ON rota_decisoes (customer_id, data_rota)`);
  _pronta = true;
}

export const ROTULO_DECISAO: Record<string, string> = {
  confirmado: 'Visita confirmada',
  recusado: 'Cliente recusou',
  estoque: 'Tem estoque',
  indisponivel: 'Indisponível hoje',
  remarcar: 'Quer remarcar',
};

function normalizar(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function registrar(customerId: string, decisao: string, detalhe: string, telefone: string): Promise<void> {
  await ensureTabela();
  await db.execute(sql`
    INSERT INTO rota_decisoes (customer_id, data_rota, decisao, detalhe, telefone)
    VALUES (${customerId}, (now() AT TIME ZONE 'America/Sao_Paulo')::date, ${decisao}, ${detalhe || null}, ${telefone || null})
    ON CONFLICT (customer_id, data_rota)
    DO UPDATE SET decisao = EXCLUDED.decisao, detalhe = EXCLUDED.detalhe, atualizado_at = now()`);
}

const PERGUNTA_MOTIVO = 'Sem problema! Para eu avisar o vendedor, qual é o motivo?\n\n'
  + '1️⃣ Tenho estoque suficiente ainda\n'
  + '2️⃣ Não estarei disponível hoje\n'
  + '3️⃣ Remarcar para outro dia\n\n'
  + 'Responda com o número da opção.';

/**
 * Trata a resposta ao aviso de visita. Devolve o texto a responder (e ja registra a
 * decisao), ou null quando a mensagem nao tem a ver com a rota — ai a IA segue normal.
 */
export async function respostaDaRota(phone: string, texto: string): Promise<string | null> {
  try {
    const t = normalizar(texto);
    if (!t || t.length > 60) return null;

    let d = String(phone || '').replace(/\D/g, '');
    if (d.length < 8) return null;

    // So vale para quem recebeu o aviso de visita nas ultimas horas.
    const horas = 20;
    const disp: any = await db.execute(sql`
      SELECT customer_id, params FROM official_dispatches
      WHERE right(customer_phone, 8) = ${d.slice(-8)}
        AND use_case = 'rota_do_dia'
        AND status IN ('enviada','entregue','lida','resposta')
        AND sent_at > now() - make_interval(hours => ${horas})
      ORDER BY sent_at DESC LIMIT 1`);
    const rota = disp.rows?.[0];
    if (!rota?.customer_id) return null;

    const params: any[] = Array.isArray(rota.params) ? rota.params : [];
    const nome = String(params[0] || '').split(' ')[0] || '';
    const vendedor = String(params[1] || 'seu vendedor');

    // 1) Confirmou
    if (['sim confirmar', 'sim', 'confirmar', 'confirmo', 'pode vir'].includes(t)) {
      await registrar(rota.customer_id, 'confirmado', 'respondeu o botao de confirmacao', d);
      return `Obrigado pela confirmação${nome ? ', ' + nome : ''}! Já avisei ${vendedor} — ele passa aí hoje. 🧡`;
    }

    // 2) Recusou -> abre as tres opcoes
    if (['nao', 'nao obrigado', 'hoje nao'].includes(t)) {
      await registrar(rota.customer_id, 'recusado', 'respondeu o botao Nao', d);
      return PERGUNTA_MOTIVO;
    }

    // 3) Escolheu o motivo. So aceita se ele ja tinha recusado hoje — assim um "1"
    //    solto no meio de outra conversa nao vira decisao de rota.
    const jaRecusou: any = await db.execute(sql`SELECT decisao FROM rota_decisoes
      WHERE customer_id = ${rota.customer_id}
        AND data_rota = (now() AT TIME ZONE 'America/Sao_Paulo')::date LIMIT 1`);
    const anterior = String(jaRecusou.rows?.[0]?.decisao || '');
    if (anterior !== 'recusado') return null;

    const eh = (n: string, palavras: string[]) => t === n || palavras.some(p => t.includes(p));
    if (eh('1', ['estoque'])) {
      await registrar(rota.customer_id, 'estoque', 'ainda tem estoque', d);
      return `Entendido${nome ? ', ' + nome : ''}! Vou avisar ${vendedor} que você ainda está abastecido. Na próxima passagem a gente se fala. 🧡`;
    }
    if (eh('2', ['nao estarei', 'indisponivel', 'nao vou estar', 'fechado'])) {
      await registrar(rota.customer_id, 'indisponivel', 'nao estara disponivel hoje', d);
      return `Sem problema${nome ? ', ' + nome : ''}! Avisei ${vendedor} que hoje não dá. Ele te procura no próximo dia de rota. 🧡`;
    }
    if (eh('3', ['remarcar', 'outro dia', 'remarca'])) {
      await registrar(rota.customer_id, 'remarcar', 'pediu para remarcar', d);
      return `Combinado${nome ? ', ' + nome : ''}! ${vendedor} vai falar com você para marcar o melhor dia. 🧡`;
    }
    return null;
  } catch (e: any) {
    console.error('[ROTA-RESPOSTA]', e?.message || e);
    return null;   // qualquer erro: a IA atende normalmente
  }
}

export function registerRotaRespostas(app: any) {
  // Decisoes do dia, para a Rota do Dia mostrar a etiqueta no card do cliente.
  app.get('/api/rota-do-dia/decisoes', authenticateUser, async (req: any, res: any) => {
    try {
      await ensureTabela();
      const data = String(req.query.date || '').slice(0, 10);
      const r: any = data
        ? await db.execute(sql`SELECT customer_id, decisao, detalhe,
             to_char(atualizado_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora
             FROM rota_decisoes WHERE data_rota = ${data}::date`)
        : await db.execute(sql`SELECT customer_id, decisao, detalhe,
             to_char(atualizado_at AT TIME ZONE 'America/Sao_Paulo','HH24:MI') AS hora
             FROM rota_decisoes WHERE data_rota = (now() AT TIME ZONE 'America/Sao_Paulo')::date`);
      const itens: any = {};
      for (const x of (r.rows || [])) {
        itens[String(x.customer_id)] = {
          decisao: x.decisao, rotulo: ROTULO_DECISAO[String(x.decisao)] || x.decisao,
          detalhe: x.detalhe, hora: x.hora,
        };
      }
      res.json({ itens });
    } catch (e: any) { res.json({ itens: {}, erro: e?.message }); }
  });

  console.log('[ROTA-RESPOSTAS] registrado (/api/rota-do-dia/decisoes)');
}
