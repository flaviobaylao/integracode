// ============================================================================
// INTEGRA 2.0 — Retomada de contato (etapa 2 da migração "atender só pelo 1841")
//
// A etapa 1 mostrou ao atendente QUANDO a janela de 24h está fechada. Isso, sozinho, é
// uma parede: ele passa a saber que não pode escrever, mas continua sem saída. Esta etapa
// dá a saída — a única que a Meta permite: mandar um TEMPLATE APROVADO.
//
// O template não abre a janela por si. Quem abre é a RESPOSTA do cliente. Por isso todo
// template de retomada precisa de botão: um toque já conta como resposta e libera 24h de
// texto livre. Template sem botão deixa o cliente sem um jeito fácil de responder — e a
// conversa continua travada.
//
// Categoria importa (e custa dinheiro):
//   UTILITY  — ligado a algo que o cliente já fez (pedido, entrega, título em aberto).
//              Dentro da janela aberta é gratuito; fora dela é cobrado, mas barato.
//   MARKETING— abordagem fria, oferta, "vamos fazer um pedido?". Sempre cobrado, exige
//              opt-in e é o que a Meta rejeita quando alguém tenta disfarçar de utility.
// Este módulo NÃO decide a categoria: ele usa a que está cadastrada no whatsapp_templates,
// que é a mesma aprovada na Meta. Marcar errado aqui não engana a Meta, só quebra o envio.
//
// Wiring: registerRetomada(app) chamado pelo registerChatRoutes (depois da sessão).
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// Um template só entra na lista de retomada se estiver marcado para isso na observação.
// Assim o atendente não vê os 10 templates do sistema (pedido_confirmado, entrega...) —
// esses são disparados por acontecimento, não por gente.
const MARCA_RETOMADA = '[retomada]';

// O rotulo tecnico ("retomada_pedido · UTILITY") nao diz nada para um vendedor. O nome
// amigavel vem do que estiver DEPOIS da marca na observacao:
//     [retomada] Falar sobre um pedido
// Assim da para renomear pelo cadastro do template, sem deploy e sem nova aprovacao na
// Meta — o label continua sendo a chave do disparo, so a leitura muda.
function nomeAmigavel(label: string, observacao: string): string {
  const i = String(observacao || '').toLowerCase().indexOf(MARCA_RETOMADA);
  if (i >= 0) {
    const resto = String(observacao).slice(i + MARCA_RETOMADA.length).trim();
    if (resto) return resto.slice(0, 60);
  }
  // Sem nome no cadastro: pelo menos tira o underline e a cara de banco de dados.
  const limpo = String(label).replace(/_/g, ' ').trim();
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

export type TemplateRetomada = {
  label: string;
  nome: string;          // como o atendente le na lista
  umblerId: string | null;
  categoria: string;
  corpo: string;
  botoes: string[];
  variaveis: number;
  ativo: boolean;
};

// Conta as variáveis {{1}}, {{2}}... do corpo aprovado. É o que diz quantos campos o
// atendente precisa preencher — e o que evita o erro de mandar params a mais/a menos.
export function contaVariaveis(corpo: string): number {
  const m = String(corpo || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  let max = 0;
  for (const v of m) {
    const n = parseInt(String(v).replace(/\D/g, ''), 10);
    if (n > max) max = n;
  }
  return max;
}

// Variável de template não aceita quebra de linha, tab nem 4+ espaços seguidos — a Meta
// recusa com "Param text cannot have new-line/tab characters or more than 4 consecutive
// spaces". Limpa antes de enviar, em vez de descobrir no erro.
export function limpaParam(s: any): string {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 300);
}

export async function templatesDeRetomada(): Promise<TemplateRetomada[]> {
  try {
    // A coluna e `is_active` — nao `ativo`. Escrever o nome errado aqui nao dava erro na
    // tela: a consulta estourava, o catch devolvia [] e o atendente via "nenhum template
    // de retomada", como se ninguem tivesse cadastrado. Por isso o erro agora sobe.
    const r: any = await db.execute(sql`
      SELECT label, umbler_id, coalesce(categoria,'UTILITY') AS categoria,
             coalesce(corpo,'') AS corpo, coalesce(observacao,'') AS observacao,
             COALESCE(is_active, true) AS ativo, botoes
      FROM whatsapp_templates
      WHERE coalesce(observacao,'') ILIKE ${'%' + MARCA_RETOMADA + '%'}
      ORDER BY label`);
    return (r.rows || []).map((t: any) => ({
      label: String(t.label),
      nome: nomeAmigavel(String(t.label), String(t.observacao || '')),
      umblerId: t.umbler_id || null,
      categoria: String(t.categoria || 'UTILITY').toUpperCase(),
      corpo: String(t.corpo || ''),
      botoes: Array.isArray(t.botoes) ? t.botoes : [],
      variaveis: contaVariaveis(String(t.corpo || '')),
      ativo: !!t.ativo,
    }));
  } catch (e: any) {
    console.error('[RETOMADA] lista', e?.message || e);
    throw e;   // lista vazia por engano e pior do que erro visivel
  }
}

// Prévia: o texto exatamente como o cliente vai ler, com os params já no lugar.
export function montaPrevia(corpo: string, params: string[]): string {
  let out = String(corpo || '');
  params.forEach((p, i) => { out = out.split('{{' + (i + 1) + '}}').join(limpaParam(p)); });
  return out;
}

export function registerRetomada(app: any) {
  // Quais templates o atendente pode usar para reabrir uma conversa, e o que preencher.
  app.get('/api/chat/retomada/templates', async (_req: any, res: any) => {
    try {
      const todos = await templatesDeRetomada();
      const itens = todos.filter(t => t.ativo && t.umblerId);
      // Diz POR QUE um template marcado nao apareceu, em vez de sumir sem explicacao.
      const fora = todos.filter(t => !(t.ativo && t.umblerId))
        .map(t => ({ label: t.label, motivo: !t.ativo ? 'desligado' : 'sem umbler_id (importe do Umbler)' }));
      res.json({ itens, fora, marca: MARCA_RETOMADA });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Dispara a retomada nesta conversa. Passa pelo MESMO caminho dos disparos automáticos
  // (enqueueOfficialDispatch), então herda de graça: teto diário, limite por minuto,
  // liga/desliga por template, dedup e o registro em official_dispatches.
  app.post('/api/chat/conversations/:id/retomar', async (req: any, res: any) => {
    try {
      const convId = String(req.params.id || '');
      const label = String(req.body?.label || '').trim();
      const params: string[] = Array.isArray(req.body?.params) ? req.body.params.map(limpaParam) : [];
      if (!convId || !label) return res.status(400).json({ error: 'informe a conversa e o template' });

      const c: any = await db.execute(sql`SELECT id, customer_id, customer_phone, customer_name,
          (window_open_until IS NOT NULL AND window_open_until > now()) AS janela_aberta
        FROM chat_conversations WHERE id = ${convId} LIMIT 1`);
      const conv = c.rows?.[0];
      if (!conv) return res.status(404).json({ error: 'conversa nao encontrada' });

      // Janela aberta não precisa de template: texto livre é gratuito e chega na hora.
      // Gastar template aqui é queimar dinheiro à toa.
      if (conv.janela_aberta) {
        return res.status(400).json({
          error: 'A janela de 24h desta conversa está ABERTA — é só escrever normalmente, sem gastar template.',
          code: 'JANELA_ABERTA',
        });
      }

      const tpl = (await templatesDeRetomada()).find(t => t.label === label);
      if (!tpl) return res.status(404).json({ error: 'template de retomada nao encontrado' });
      if (!tpl.ativo || !tpl.umblerId) return res.status(400).json({ error: 'template desligado ou sem id do Umbler' });
      if (params.length !== tpl.variaveis) {
        return res.status(400).json({ error: `este template pede ${tpl.variaveis} campo(s) e vieram ${params.length}` });
      }

      const { enqueueOfficialDispatch } = await import('./official-dispatch');
      // campaign com a conversa e o minuto: evita disparo duplo por clique repetido, mas
      // permite retomar de novo mais tarde se o cliente continuar sem responder.
      const minuto = new Date().toISOString().slice(0, 16);
      const r = await enqueueOfficialDispatch({
        customerId: conv.customer_id || undefined,
        customerPhone: String(conv.customer_phone || ''),
        templateLabel: label,
        params,
        useCase: 'retomada',
        campaign: 'retomada:' + convId + ':' + minuto,
        category: tpl.categoria,
      });

      if (r !== 'enfileirado') {
        return res.status(400).json({ error: 'nao foi enfileirado: ' + r, resultado: r });
      }

      // Registra na conversa o que foi enviado, para o histórico não ter buraco.
      const previa = montaPrevia(tpl.corpo, params);
      try {
        await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read)
          VALUES (${convId}, ${'agent:retomada'}, 'system',
                  ${'[Retomada · ' + label + '] ' + previa}, 'text', true)`);
      } catch {}
      console.log(`[RETOMADA] conv=${convId} template=${label} categoria=${tpl.categoria}`);
      res.json({ ok: true, enfileirado: true, previa, categoria: tpl.categoria });
    } catch (e: any) {
      console.error('[RETOMADA]', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  console.log('[RETOMADA] registrado (/api/chat/retomada/templates + /conversations/:id/retomar)');
}
