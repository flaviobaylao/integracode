// Runtime dos Agentes de IA do ChatCenter (Honest Sucos / INTEGRA 2.0).
// SEGURANÇA: só responde conforme system_settings 'agents_runtime_mode' (off|test|on).
// Chama Anthropic via fetch puro (sem dependência). Requer ANTHROPIC_API_KEY.
// FERRAMENTAS (tool-use): transferir_humano, buscar_boleto, consultar_debitos, consultar_produto.
import { db } from './db';
import { sql } from 'drizzle-orm';

const APP_URL = process.env.APP_URL || 'https://integracode-production.up.railway.app';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function normModel(m?: string): string {
  const x = (m || '').trim();
  if (x.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5-20251001';
  if (x.startsWith('claude-opus-4-8')) return 'claude-opus-4-8';
  if (x.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
  return 'claude-sonnet-4-6';
}

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try { await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, ${'agent-runtime'}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`); } catch {}
}

function pickAgentByKeyword(text: string, defId: string): string {
  const t = (text || '').toLowerCase();
  const has = (arr: string[]) => arr.some(k => t.includes(k));
  if (has(['boleto', '2 via', '2a via', 'segunda via', 'pagar', 'pagamento', 'fatura', 'vencid', 'em atraso', 'débito', 'debito', 'cobran', 'pix', 'linha digitável', 'codigo de barras'])) return 'cobranca';
  if (has(['comprar', 'pedido', 'preço', 'preco', 'orçamento', 'orcamento', 'quero', 'valor', 'encomend', 'cardápio', 'cardapio', 'tabela', 'suco'])) return 'vendas';
  return defId;
}

// ===== Ferramentas =====
const TOOL_DEFS: any[] = [
  { name: 'transferir_humano', description: 'Transfere a conversa para um atendente humano quando o cliente pede falar com pessoa, reclama, ou o caso foge do seu escopo. Após chamar, avise o cliente que um atendente vai continuar.', input_schema: { type: 'object', properties: { motivo: { type: 'string', description: 'motivo da transferência' } }, required: [] } },
  { name: 'buscar_boleto', description: 'Busca a 2ª via de boleto/cobrança em aberto do cliente. Retorna link de pagamento, valor e vencimento. Use o documento se o cliente informar; senão usa o cliente da conversa.', input_schema: { type: 'object', properties: { documento: { type: 'string', description: 'CPF ou CNPJ (somente se o cliente informar)' } }, required: [] } },
  { name: 'consultar_debitos', description: 'Consulta os débitos/títulos em aberto (vencidos) do cliente. Retorna total e dias de atraso.', input_schema: { type: 'object', properties: { documento: { type: 'string' } }, required: [] } },
  { name: 'consultar_pedido', description: 'Le o pedido do cliente e devolve tudo sobre ele: numero, data, situacao, valor, forma de pagamento, previsao de entrega, nota fiscal e a LISTA DE PRODUTOS com quantidades. Use SEMPRE que o cliente perguntar qualquer coisa sobre "esse pedido" / "meu pedido" — o que veio, quando chega, quanto ficou, por que travou. NAO peca CPF/CNPJ nem diga que nao ha pedido nesta conversa: consulte primeiro.', input_schema: { type: 'object', properties: { numero: { type: 'string', description: 'numero do pedido, apenas se o cliente citar um especifico' } }, required: [] } },
  { name: 'segunda_via', description: 'Envia a 2ª via de TODOS os títulos vencidos em aberto do cliente: um PIX copia-e-cola por título, com número, vencimento e valor, mais o total. Use SEMPRE que o cliente pedir 2ª via, boleto, chave PIX, "como pago" ou responder pedindo a via de um aviso de pedido. Você JÁ sabe quem é o cliente pela conversa — NÃO peça CPF/CNPJ.', input_schema: { type: 'object', properties: { documento: { type: 'string', description: 'CPF ou CNPJ, apenas se o cliente informar espontaneamente' } }, required: [] } },
  { name: 'consultar_produto', description: 'Consulta preço e disponibilidade de um produto pelo nome/termo.', input_schema: { type: 'object', properties: { termo: { type: 'string', description: 'nome ou parte do nome do produto' } }, required: ['termo'] } },
];

// Ferramenta EXTRA (só habilitada no canal Instagram): registra um pedido no pipeline de faturamento.
const ORDER_TOOL: any = {
  name: 'registrar_pedido',
  description: 'Registra um PEDIDO no pipeline de faturamento. O pedido entra como PENDENTE e NÃO é faturado automaticamente — a equipe confirma antes. Use SOMENTE quando o cliente confirmar que quer comprar E você já tiver coletado TODOS os dados do pedido completo. Você NÃO define o preço: o sistema calcula pela tabela oficial conforme o tipo de cliente (consumidor: varejo até R$200 / atacado acima; revenda: por região). Na triagem, descubra se o cliente é consumidor final ou revendedor; para revenda, pergunte a região (Goiânia, interior de Goiás ou Brasília/entorno). Se faltar qualquer dado, NÃO chame esta ferramenta: pergunte ao cliente primeiro.',
  input_schema: {
    type: 'object',
    properties: {
      tipo_cliente: { type: 'string', enum: ['consumidor', 'revenda'], description: 'perfil do cliente definido na triagem' },
      regiao: { type: 'string', enum: ['goiania', 'interior', 'brasilia'], description: 'obrigatório para revenda: goiania=Goiânia; interior=interior de Goiás; brasilia=Brasília e entorno' },
      itens: { type: 'array', description: 'itens do pedido', items: { type: 'object', properties: { produto: { type: 'string', description: 'nome do produto do catálogo' }, quantidade: { type: 'number' } }, required: ['produto', 'quantidade'] } },
      nome: { type: 'string', description: 'nome completo do cliente' },
      documento: { type: 'string', description: 'CPF ou CNPJ' },
      telefone: { type: 'string' },
      endereco: { type: 'string', description: 'rua/avenida e número' },
      bairro: { type: 'string' },
      cidade: { type: 'string' },
      cep: { type: 'string' },
      forma_pagamento: { type: 'string', description: 'pix, dinheiro, cartão, boleto ou a prazo' },
      dia_entrega: { type: 'string', description: 'dia preferido de entrega (ex: segunda, amanhã)' },
      horario: { type: 'string' },
      observacoes: { type: 'string' },
    },
    required: ['tipo_cliente', 'itens', 'nome', 'documento', 'endereco', 'bairro', 'cidade', 'forma_pagamento', 'dia_entrega'],
  },
};

// Ferramenta EXTRA (só Instagram): gera a cobrança PIX do pedido já registrado e envia o QR + copia-e-cola ao cliente.
const PIX_TOOL: any = {
  name: 'gerar_pix',
  description: 'Gera uma cobrança PIX para o pedido JÁ REGISTRADO nesta conversa e ENVIA automaticamente o QR Code (imagem) + o código copia-e-cola ao cliente para ele pagar. Use SOMENTE depois de já ter chamado registrar_pedido nesta conversa E o cliente confirmar que quer pagar por PIX. Não precisa de parâmetros: o valor vem do pedido registrado. Depois de chamar, NÃO reescreva nem reenvie o código PIX (o sistema já enviou); apenas avise o cliente que é só pagar e que a confirmação é automática.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

// Ferramenta EXTRA: gera um LINK de pagamento por CARTAO DE CREDITO / GOOGLE PAY para o
// pedido ja registrado nesta conversa e envia o link ao cliente. Vale para Instagram e
// WhatsApp (no DM/chat nao da para renderizar o botao do Google Pay -> precisa de link).
const CARD_LINK_TOOL: any = {
  name: 'gerar_link_pagamento',
  description: 'Gera e ENVIA ao cliente um LINK seguro para pagar o pedido JA REGISTRADO nesta conversa com CARTAO DE CREDITO ou GOOGLE PAY (a vista, sem parcelamento). Use SOMENTE depois de ja ter chamado registrar_pedido nesta conversa E o cliente dizer que quer pagar no cartao (ou no Google Pay). Nao precisa de parametros: o valor vem do pedido registrado. Depois de chamar, NAO reescreva o link (o sistema ja enviou); apenas avise o cliente, de forma curta, que e so abrir o link e pagar, e que a confirmacao e automatica.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

// Garante a tabela de vínculo pedido<->cobrança PIX do Instagram (idempotente).
async function ensureIgPixTable(): Promise<void> {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS instagram_pix (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id varchar,
      sales_card_id varchar,
      order_number varchar,
      igsid varchar,
      customer_name varchar,
      customer_document varchar,
      total numeric(12,2),
      charge_id varchar,
      txid varchar,
      status varchar DEFAULT 'registered',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      paid_at timestamptz
    )`);
  } catch {}
}

function brl(v: any) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function onlyDigits(s: any) { return String(s || '').replace(/\D/g, ''); }

// ===== Helpers do registrar_pedido =====
function rid() { return Math.random().toString(36).slice(2, 10); }
function _num(v: any) { const n = Number(v); return isNaN(n) ? 0 : n; }
// Consumidor: varejo (< R$200) ou atacado (>= R$200). Fallback para price padrão.
function priceConsumer(p: any, table: 'retail' | 'wholesale') {
  if (table === 'wholesale') return _num(p.wholesale_price != null ? p.wholesale_price : p.price);
  return _num(p.retail_price != null ? p.retail_price : p.price);
}
// Revenda: tabela por região (Goiânia / interior GO / Brasília). Fallback para price padrão.
function priceRevenda(p: any, regiao: string) {
  if (regiao === 'interior') return _num(p.resale_interior_price != null ? p.resale_interior_price : p.price);
  if (regiao === 'brasilia') return _num(p.resale_brasilia_price != null ? p.resale_brasilia_price : p.price);
  return _num(p.resale_goiania_price != null ? p.resale_goiania_price : p.price);
}
// paymentMethodEnum só aceita a_vista|boleto|pix. Demais (dinheiro/cartão/a prazo) -> a_vista; intenção real fica nas notas.
function mapPayment(v: any): string {
  const s = String(v || '').toLowerCase();
  if (s.includes('pix')) return 'pix';
  if (s.includes('boleto')) return 'boleto';
  return 'a_vista';
}
// routeDay em forma longa (segunda..domingo). hoje/amanhã relativos ao fuso de Brasília (UTC-3).
function mapWeekday(dateStr: any): string {
  const l = String(dateStr || '').toLowerCase();
  if (l.includes('segunda')) return 'segunda';
  if (l.includes('terca') || l.includes('terça')) return 'terca';
  if (l.includes('quarta')) return 'quarta';
  if (l.includes('quinta')) return 'quinta';
  if (l.includes('sexta')) return 'sexta';
  if (l.includes('sabado') || l.includes('sábado')) return 'sabado';
  if (l.includes('domingo')) return 'domingo';
  const days = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
  const dowBR = new Date(Date.now() - 3 * 3600 * 1000).getUTCDay();
  if (l.includes('hoje')) return days[dowBR];
  if (l.includes('amanha') || l.includes('amanhã')) return days[(dowBR + 1) % 7];
  return 'segunda';
}

async function resolveCustomerId(ctx: any, documento?: string): Promise<string | null> {
  if (documento) {
    const d = onlyDigits(documento);
    try {
      const r: any = await db.execute(sql`SELECT id FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g')=${d} OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')=${d} LIMIT 1`);
      if (r.rows?.[0]?.id) return r.rows[0].id;
    } catch {}
  }
  // ATENCAO: ctx.customerId vem de chat_conversations.customer_id, que aponta para
  // chat_customers — NAO para customers (o cadastro do ERP, onde estao pedidos, titulos
  // e boletos). Sao tabelas diferentes, com ids diferentes. Usar aquele id direto fazia
  // toda consulta de pedido/boleto voltar vazia. Por isso: so vale se existir no ERP.
  if (ctx?.customerId && await existeNoErp(ctx.customerId)) return ctx.customerId;

  const d = onlyDigits(ctx?.phone);
  // 1) O cliente chegou respondendo um DISPARO nosso (aviso de pedido, cobranca, rota).
  //    O disparo sabe exatamente para quem foi.
  try {
    if (d.length >= 8) {
      const r: any = await db.execute(sql`SELECT customer_id FROM official_dispatches
        WHERE right(customer_phone, 8) = ${d.slice(-8)} AND customer_id IS NOT NULL
          AND sent_at > now() - interval '30 days'
        ORDER BY sent_at DESC LIMIT 1`);
      const id = r.rows?.[0]?.customer_id;
      if (id && await existeNoErp(String(id))) return String(id);
    }
  } catch {}
  // 2) Telefone do cadastro (DDD + 8 finais, para casar com e sem o 9o digito).
  try {
    if (d.length >= 8) {
      const r: any = await db.execute(sql`SELECT id FROM customers
        WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 8) = ${d.slice(-8)}
          AND COALESCE(is_active, true) = true
        ORDER BY updated_at DESC NULLS LAST LIMIT 1`);
      if (r.rows?.[0]?.id) return String(r.rows[0].id);
    }
  } catch {}
  return null;
}

async function existeNoErp(id: string): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT 1 FROM customers WHERE id = ${id} LIMIT 1`);
    return !!r.rows?.length;
  } catch { return false; }
}

// Pausa da IA numa conversa (setada por transferir_humano). Expira em 'ia_pausa_horas'
// (padrao 24h). Valores legados ('1') seguem pausados ate serem limpos pela rota
// /api/admin/ia-atendimento/retomar.
export async function iaPausada(conversationId: string): Promise<boolean> {
  // FASE 0: uma leitura so, para todo o sistema (ver server/mkt-fase0.ts).
  // Delegar aqui tambem conserta um defeito que estava no ar: a versao anterior usava
  // isNaN(Date.parse(v)) para reconhecer o valor legado '1' — e Date.parse('1') NAO e
  // NaN, vale 2001-01-01. Toda pausa legada era lida como vencida e a IA voltava a
  // responder exatamente nas conversas marcadas para ficarem paradas.
  try {
    const { iaPausadaConsistente } = await import('./mkt-fase0');
    return await iaPausadaConsistente(conversationId);
  } catch {
    // Sem o modulo, o seguro e considerar pausada quando existe qualquer marca.
    return (await getSetting('chat_ai_paused:' + conversationId, '')) !== '';
  }
}

// CONTEXTO DO AVISO QUE ORIGINOU A CONVERSA
// Quem responde "quero ver os produtos deste pedido" esta falando do pedido que NOS
// acabamos de confirmar por mensagem. Sem esse contexto no prompt, a IA nao sabe do que
// "este pedido" trata e pede o numero — para um cliente que acabou de recebe-lo.
async function contextoDoAviso(phone: string): Promise<string> {
  try {
    const d = onlyDigits(phone);
    if (d.length < 8) return '';
    const r: any = await db.execute(sql`
      SELECT template_label, params,
             to_char(sent_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando
      FROM official_dispatches
      WHERE right(customer_phone, 8) = ${d.slice(-8)}
        AND status IN ('enviada','entregue','lida','resposta')
        AND sent_at > now() - interval '48 hours'
      ORDER BY sent_at DESC LIMIT 3`);
    const linhas = (r.rows || []).map((x: any) => {
      const ps: any[] = Array.isArray(x.params) ? x.params : [];
      const rotulo: Record<string, string> = {
        pedido_confirmado: 'confirmamos o PEDIDO ' + (ps[1] || '') + ' no valor de ' + (ps[2] || ''),
        pedido_confirmado_debito: 'confirmamos o PEDIDO ' + (ps[1] || '') + ' (' + (ps[2] || '') + ') e avisamos que esta RETIDO por titulos em aberto: ' + (ps[3] || ''),
        pedido_confirmado_analise: 'confirmamos o PEDIDO ' + (ps[1] || '') + ' (' + (ps[2] || '') + '), em aprovacao interna da condicao ' + (ps[3] || ''),
        pedido_liberado: 'avisamos que o pedido foi LIBERADO',
        entrega_programada: 'avisamos a ENTREGA programada da NF ' + (ps[1] || '') + ' para ' + (ps[2] || ''),
        pedido_saiu_entrega: 'avisamos que o pedido ' + (ps[1] || '') + ' SAIU PARA ENTREGA',
        pedido_entregue: 'avisamos que o pedido ' + (ps[1] || '') + ' foi ENTREGUE',
        entrega_nao_realizada: 'avisamos que a entrega do pedido ' + (ps[1] || '') + ' NAO foi concluida: ' + (ps[2] || ''),
        cobranca_vencimento: 'avisamos o VENCIMENTO do titulo ' + (ps[1] || '') + ' (' + (ps[2] || '') + ') em ' + (ps[3] || ''),
        cobranca_vencida: 'cobramos o titulo ' + (ps[1] || '') + ' (' + (ps[2] || '') + ') vencido em ' + (ps[3] || ''),
        visita_rota_dia: 'avisamos a VISITA do vendedor ' + (ps[1] || '') + ' para ' + (ps[2] || ''),
      };
      const txt = rotulo[String(x.template_label)] || ('enviamos o aviso ' + x.template_label);
      return '- ' + x.quando + ': ' + txt;
    });
    if (!linhas.length) return '';
    return [
      '# O QUE NOS JA AVISAMOS ESTE CLIENTE (ultimas 48h)',
      ...linhas,
      'Quando o cliente disser "este pedido", "meu pedido", "essa entrega" ou "essa cobranca",',
      'ele esta falando DISSO — nao peca o numero do pedido, ja o temos. Use consultar_pedido',
      'para os detalhes (produtos, valor, situacao) e segunda_via para 2a via de titulos.',
    ].join('\n');
  } catch { return ''; }
}

// O cliente esta respondendo a um disparo nosso? Duas condicoes: houve disparo para este
// telefone na janela (ia_disparo_horas, padrao 48h) e NENHUM humano escreveu nesta conversa
// nos ultimos ia_disparo_humano_min (padrao 30) minutos.
async function respostaADisparo(conversationId: string, phone: string): Promise<boolean> {
  try {
    if ((await getSetting('ia_disparo_reabre', 'on')) !== 'on') return false;
    const d = onlyDigits(phone);
    if (d.length < 8) return false;
    const horas = Math.max(1, parseInt(await getSetting('ia_disparo_horas', '48'), 10) || 48);
    const disp: any = await db.execute(sql`SELECT 1 FROM official_dispatches
      WHERE right(customer_phone, 8) = ${d.slice(-8)}
        AND status IN ('enviada','entregue','lida','resposta')
        AND sent_at > now() - make_interval(hours => ${horas}) LIMIT 1`);
    if (!disp.rows?.length) return false;

    const mins = Math.max(1, parseInt(await getSetting('ia_disparo_humano_min', '30'), 10) || 30);
    const hum: any = await db.execute(sql`SELECT 1 FROM chat_messages
      WHERE conversation_id = ${conversationId}
        AND sender_type <> 'customer'
        AND COALESCE(sender_id,'') NOT LIKE 'agent:%'
        AND COALESCE(sender_id,'') <> 'system'
        AND created_at > now() - make_interval(mins => ${mins}) LIMIT 1`);
    return !hum.rows?.length;
  } catch { return false; }
}

// Limpa a pausa de uma conversa (ou de todas as legadas '1').
export async function limparPausa(conversationId?: string): Promise<number> {
  try {
    if (conversationId) {
      await db.execute(sql`DELETE FROM system_settings WHERE key = ${'chat_ai_paused:' + conversationId}`);
      return 1;
    }
    const r: any = await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'chat_ai_paused:%' AND value = '1' RETURNING key`);
    return (r.rows || []).length;
  } catch { return 0; }
}

async function execTool(name: string, input: any, ctx: any): Promise<string> {
  try {
    if (name === 'transferir_humano') {
      if (ctx?.conversationId) {
        // Grava o INSTANTE da transferencia (antes gravava '1' e nada limpava: a conversa e
        // unica por telefone, entao aquele cliente nunca mais era atendido pela IA).
        await setSetting('chat_ai_paused:' + ctx.conversationId, new Date().toISOString());
        try { await db.execute(sql`UPDATE chat_conversations SET status='assigned' WHERE id=${ctx.conversationId}`); } catch {}
        // Modo "IA na frente": a conversa nao entrou na fila no primeiro contato, entao
        // e AGORA que ela vai para um atendente. O repasse e DIRIGIDO: se o dono da
        // carteira do cliente estiver online, a conversa vai para ele em modo exclusivo
        // (so ele le e responde) e ele tem ia_handoff_min para responder; senao vai para
        // qualquer atendente online.
        try {
          if ((await getSetting('ia_front_line', 'off')) === 'on') {
            const { handoffParaHumano } = await import('./ia-fila');
            const h = await handoffParaHumano(ctx.conversationId, String(ctx.phone || ''), String(input?.motivo || ''));
            if (h?.foraExpediente) {
              return 'OK: conversa registrada, MAS hoje NAO e dia util (fim de semana ou feriado) e nao ha atendimento humano. Explique isso ao cliente de forma simpatica, diga que um atendente entra em contato ' + (h.retorno || 'no proximo dia util') + ', e se despeça. NAO prometa retorno hoje.';
            }
            if (h?.semAtendente) {
              return 'OK: conversa liberada para atendimento humano. Neste momento TODOS os atendentes estao ocupados. Diga ao cliente, de forma simpatica e curta, que todos os atendentes estao ocupados no momento e que ele sera atendido em breve. NAO prometa horario. Depois pare de responder.';
            }
            if (h && h.ok === false) {
              return 'OK: conversa liberada para atendimento humano. Avise o cliente que a solicitacao foi registrada e que um atendente retorna assim que possivel. Pare de responder.';
            }
          }
        } catch (e: any) { console.error('[AGENT-RUNTIME] repasse pos-transferencia', e?.message || e); }
      }
      return 'OK: conversa transferida para atendimento humano. Pare de responder e informe o cliente que um atendente assumirá em instantes.';
    }
    if (name === 'buscar_boleto') {
      const cid = await resolveCustomerId(ctx, input?.documento);
      if (!cid) return 'Cliente não identificado. Peça o CPF/CNPJ para localizar o boleto.';
      const r: any = await db.execute(sql`SELECT id, valor_original, data_vencimento, status, linha_digitavel FROM boleto_charges WHERE customer_id=${cid} AND COALESCE(status,'') NOT IN ('liquidado','cancelado','pago') ORDER BY created_at DESC LIMIT 1`);
      const b = r.rows?.[0];
      if (!b) return 'Nenhum boleto em aberto encontrado para este cliente.';
      return `Boleto em aberto encontrado. Valor: ${brl(b.valor_original)}; Vencimento: ${b.data_vencimento ? new Date(b.data_vencimento).toLocaleDateString('pt-BR') : '-'}; Link de pagamento (boleto+PIX): ${APP_URL}/api/boleto-view/${b.id} . Envie esse link ao cliente.`;
    }
    if (name === 'consultar_debitos') {
      const cid = await resolveCustomerId(ctx, input?.documento);
      const d = onlyDigits(input?.documento);
      let row: any = null;
      // Fonte 2.0 (Contas a Receber), NAO mais overdue_debts (Omie desligado). Mesma regra de "vencida".
      if (cid) { const r: any = await db.execute(sql`SELECT max(customer_name) AS client_name, sum(amount - coalesce(amount_paid,0)) AS total_amount, max(((now() AT TIME ZONE 'America/Sao_Paulo')::date - (due_date)::date)) AS max_days_overdue FROM receivables WHERE customer_id=${cid} AND deleted_at IS NULL AND (amount - coalesce(amount_paid,0)) > 0 AND coalesce(import_origin,'') <> 'omie_historico' AND (status IN ('a_vencer','vencida') AND (due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date) HAVING sum(amount - coalesce(amount_paid,0)) > 0`); row = r.rows?.[0]; }
      if (!row && d) { const r: any = await db.execute(sql`SELECT max(customer_name) AS client_name, sum(amount - coalesce(amount_paid,0)) AS total_amount, max(((now() AT TIME ZONE 'America/Sao_Paulo')::date - (due_date)::date)) AS max_days_overdue FROM receivables WHERE regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g')=${d} AND deleted_at IS NULL AND (amount - coalesce(amount_paid,0)) > 0 AND coalesce(import_origin,'') <> 'omie_historico' AND (status IN ('a_vencer','vencida') AND (due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date) HAVING sum(amount - coalesce(amount_paid,0)) > 0`); row = r.rows?.[0]; }
      if (!row) return 'Nenhum débito vencido encontrado para este cliente.';
      return `Débitos em aberto: total ${brl(row.total_amount)}; atraso máximo ${row.max_days_overdue || 0} dias.`;
    }
    if (name === 'consultar_produto') {
      const termo = String(input?.termo || '').trim();
      if (!termo) return 'Informe o nome do produto.';
      const _stop = new Set(['de','da','do','com','e','a','o','os','as','para','por','sabor','ml','l','un','und']);
    const _norm = (x: any) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const _tokens = _norm(termo).split(/[^0-9a-z]+/).filter((t: string) => t.length >= 2 && !_stop.has(t));
    const _all: any = await db.execute(sql`SELECT name, price, retail_price, resale_goiania_price, stock FROM products WHERE is_active=true ORDER BY name`);
    const _rows0 = (_all.rows || []).filter((p: any) => { const n = _norm(p.name); return _tokens.length ? _tokens.every((t: string) => n.includes(t)) : n.includes(_norm(termo)); }).slice(0, 8);
    const r: any = { rows: _rows0 };
      if (!r.rows?.length) return `Nenhum produto encontrado com "${termo}".`;
      return r.rows.map((p: any) => `${p.name}: varejo ${brl(p.retail_price || p.price)}${p.resale_goiania_price ? '; revenda ' + brl(p.resale_goiania_price) : ''}${p.stock != null ? '; estoque ' + p.stock : ''}`).join(' | ');
    }
    if (name === 'consultar_pedido') return await consultarPedido(input || {}, ctx);
    if (name === 'segunda_via') return await segundaVia(input || {}, ctx);
    if (name === 'registrar_pedido') return await registrarPedido(input || {}, ctx);
    if (name === 'gerar_pix') return await gerarPix(input || {}, ctx);
    if (name === 'gerar_link_pagamento') return await gerarLinkPagamento(input || {}, ctx);
    return 'Ferramenta desconhecida.';
  } catch (e: any) { return 'Erro ao executar ferramenta: ' + (e?.message || String(e)).slice(0, 120); }
}

// Registra um pedido no pipeline de faturamento (PENDENTE; confirmação humana antes de faturar).
// Preço SEMPRE pela tabela oficial do catálogo conforme o perfil (consumidor varejo/atacado; revenda por região).
async function registrarPedido(input: any, ctx: any): Promise<string> {
  try {
    const inp = input || {};
    const tipo = String(inp.tipo_cliente || '').toLowerCase();
    const regiao = String(inp.regiao || '').toLowerCase();
    const itens: any[] = Array.isArray(inp.itens) ? inp.itens : [];
    // Completude (o produto pediu "pedido completo" antes de registrar).
    const faltando: string[] = [];
    if (!itens.length) faltando.push('itens (produto + quantidade)');
    if (!String(inp.nome || '').trim()) faltando.push('nome');
    if (!onlyDigits(inp.documento)) faltando.push('CPF/CNPJ');
    if (!String(inp.endereco || '').trim()) faltando.push('endereço (rua e número)');
    if (!String(inp.bairro || '').trim()) faltando.push('bairro');
    if (!String(inp.cidade || '').trim()) faltando.push('cidade');
    if (!String(inp.forma_pagamento || '').trim()) faltando.push('forma de pagamento');
    if (!String(inp.dia_entrega || '').trim()) faltando.push('dia de entrega');
    if (tipo !== 'consumidor' && tipo !== 'revenda') faltando.push('tipo de cliente (consumidor ou revenda)');
    if (tipo === 'revenda' && !['goiania', 'interior', 'brasilia'].includes(regiao)) faltando.push('região da revenda (goiania, interior ou brasilia)');
    if (faltando.length) return 'Ainda faltam dados para registrar o pedido: ' + faltando.join('; ') + '. Pergunte ao cliente e só registre quando tiver tudo.';

    // Catálogo ativo + matcher por tokens (mesma lógica do consultar_produto).
    const _norm = (x: any) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const _stop = new Set(['de', 'da', 'do', 'com', 'e', 'a', 'o', 'os', 'as', 'para', 'por', 'sabor', 'ml', 'l', 'un', 'und', 'suco', 'sucos']);
    const _all: any = await db.execute(sql`SELECT name, price, retail_price, wholesale_price, resale_goiania_price, resale_interior_price, resale_brasilia_price, stock FROM products WHERE is_active=true ORDER BY name`);
    const catalog: any[] = _all.rows || [];
    const matchP = (termo: string) => {
      const toks = _norm(termo).split(/[^0-9a-z]+/).filter((t: string) => t.length >= 2 && !_stop.has(t));
      return catalog.filter((p: any) => { const n = _norm(p.name); return toks.length ? toks.every((t: string) => n.includes(t)) : n.includes(_norm(termo)); });
    };

    const resolved: Array<{ p: any; qtd: number }> = [];
    const naoEnc: string[] = [];
    const ambig: string[] = [];
    for (const it of itens) {
      const termo = String(it?.produto || '').trim();
      const qtd = Math.max(1, parseInt(String(it?.quantidade || '1'), 10) || 1);
      if (!termo) continue;
      const m = matchP(termo);
      if (!m.length) { naoEnc.push(termo); continue; }
      if (m.length > 1) {
        const exact = m.find((p: any) => _norm(p.name) === _norm(termo));
        if (exact) { resolved.push({ p: exact, qtd }); continue; }
        ambig.push(`"${termo}" pode ser: ${m.slice(0, 5).map((p: any) => p.name).join(' / ')}`);
        continue;
      }
      resolved.push({ p: m[0], qtd });
    }
    if (naoEnc.length) return 'Não encontrei no catálogo: ' + naoEnc.join('; ') + '. Confirme o nome exato com o cliente (use consultar_produto) e tente de novo.';
    if (ambig.length) return 'Itens ambíguos, peça ao cliente para especificar: ' + ambig.join(' | ');
    if (!resolved.length) return 'Nenhum item válido para registrar.';

    // Tabela de preço.
    let table: string;
    if (tipo === 'revenda') table = regiao;
    else { let sub = 0; for (const r of resolved) sub += priceConsumer(r.p, 'retail') * r.qtd; table = sub >= 200 ? 'wholesale' : 'retail'; }
    const tabelaLabel: Record<string, string> = { retail: 'Varejo (consumidor)', wholesale: 'Atacado (consumidor a partir de R$200)', goiania: 'Revenda Goiânia', interior: 'Revenda Interior GO', brasilia: 'Revenda Brasília/Entorno' };

    const products = resolved.map((r) => {
      const unit = tipo === 'revenda' ? priceRevenda(r.p, table) : priceConsumer(r.p, table as any);
      return { id: rid(), name: r.p.name, quantity: r.qtd, unitPrice: unit, totalPrice: Number((unit * r.qtd).toFixed(2)) };
    });
    const total = products.reduce((s, p) => s + p.totalPrice, 0);
    if (!(total > 0)) return 'Não consegui calcular o valor (tabela de preço sem valor para esses itens). Melhor transferir para um atendente humano.';

    const { storage } = await import('./storage');
    // Cliente: procura por CPF/CNPJ (e telefone). Se NAO existir, CADASTRA automaticamente
    // (nome, documento, endereco) e vincula ao pedido — assim o card entra no pipeline com os
    // dados corretos do cliente cadastrado, em vez de um id sintetico.
    let customer: any = null;
    const doc = onlyDigits(inp.documento);
    if (doc) { try { customer = (await db.execute(sql`SELECT * FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g')=${doc} OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')=${doc} LIMIT 1`)).rows?.[0] || null; } catch {} }
    if (!customer && inp.telefone) { try { customer = await storage.getCustomerByPhone(onlyDigits(inp.telefone)); } catch {} }
    // Carteira do cliente: se JÁ existe cadastro vinculado a um vendedor REAL (não IA/instagram),
    // a venda deve ir para a carteira desse vendedor. Se não, é lead a capturar.
    const walletSellerId: string | null = (customer && (customer as any).sellerId && !['chatgpt-ai', 'instagram', 'system'].includes(String((customer as any).sellerId))) ? String((customer as any).sellerId) : null;
    if (!customer && doc) {
      const isPJ = doc.length === 14;
      const enderecoFull = String(inp.endereco || '').trim() + (inp.bairro ? ', ' + inp.bairro : '') + (inp.cidade ? ', ' + inp.cidade : '') + (inp.cep ? ' - CEP ' + inp.cep : '');
      try {
        customer = await storage.createCustomer({
          name: String(inp.nome || 'Cliente Instagram').trim(),
          customerType: isPJ ? 'pessoa_juridica' : 'pessoa_fisica',
          cpf: isPJ ? null : doc,
          cnpj: isPJ ? doc : null,
          fantasyName: isPJ ? String(inp.nome || '').trim() : null,
          phone: onlyDigits(inp.telefone) || onlyDigits(ctx?.phone) || '',
          address: enderecoFull || 'A confirmar',
          city: String(inp.cidade || '').trim() || null,
          neighborhood: String(inp.bairro || '').trim() || null,
          zipCode: onlyDigits(inp.cep) || null,
          // Cliente NOVO cadastrado pela IA entra na carteira padrao (system_settings
        // 'ia_carteira_padrao'). Antes nascia com 'chatgpt-ai', ou seja, sem dono — e
        // sem dono o pedido nao cai para ninguem.
        sellerId: await (await import('./ia-fila')).carteiraPadrao(),
          weekdays: JSON.stringify([mapWeekday(inp.dia_entrega)]),
          visitPeriodicity: 'semanal',
          isConsumerClient: tipo !== 'revenda',
          isLead: true,
        } as any);
      } catch {
        try { customer = (await db.execute(sql`SELECT * FROM customers WHERE regexp_replace(COALESCE(cnpj,''),'[^0-9]','','g')=${doc} OR regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')=${doc} LIMIT 1`)).rows?.[0] || null; } catch {} }
    }

    const notes = [
      'PEDIDO via Instagram Direct (atendente IA) — PENDENTE de confirmação humana',
      'Cliente: ' + inp.nome,
      'CPF/CNPJ: ' + inp.documento,
      'Contato: ' + (inp.telefone || ctx?.phone || '-') + (ctx?.username ? ' (@' + ctx.username + ')' : ''),
      'Perfil: ' + (tipo === 'revenda' ? 'Revenda' : 'Consumidor') + ' | Tabela de preço: ' + (tabelaLabel[table] || table),
      'Endereço: ' + inp.endereco + ', ' + inp.bairro + ', ' + inp.cidade + (inp.cep ? ' - CEP ' + inp.cep : ''),
      'Pagamento (informado): ' + inp.forma_pagamento,
      'Entrega (preferida): ' + inp.dia_entrega + (inp.horario ? ' às ' + inp.horario : ''),
      inp.observacoes ? 'Obs: ' + inp.observacoes : '',
      customer ? ('Cliente cadastrado: ' + (customer.fantasyName || customer.name || customer.id)) : '** Cliente NÃO cadastrado — vincular/cadastrar antes de faturar **',
    ].filter(Boolean).join('\n');

    const card: any = await storage.createSalesCard({
      customerId: customer?.id || ('ig-order-' + rid()),
      sellerId: 'chatgpt-ai',
      status: 'pending',
      // Origem real do pedido: antes era fixo 'instagram', o que rotulava errado todo
      // pedido feito por outro canal (WhatsApp) no pipeline e nos relatorios de origem.
      source: (String(ctx?.channel || '') === 'instagram' ? 'instagram' : 'whatsapp'),
      operationType: 'venda',
      saleValue: total.toFixed(2),
      products,
      notes,
      routeDay: mapWeekday(inp.dia_entrega),
      recurrenceType: 'semanal',
      paymentMethod: mapPayment(inp.forma_pagamento),
      isRecurring: false,
      isPermanent: false,
      exclusiveVehicle: false,
      vehicleTypes: ['carro'],
    } as any);

    try { const { autoSendToBillingPipeline } = await import('./billing-pipeline-routes'); await autoSendToBillingPipeline(card, 'chatgpt-ai'); } catch (e: any) { console.error('[IG-ORDER] autoSend', e?.message || e); }

    // 🎯 CENTRAL DE MARKETING (buraco 3): FECHA O CICLO DO ANUNCIO.
    // Se esta conversa nasceu de anuncio (ctwa_clid gravado no toque), liga o toque
    // a ESTE pedido e enfileira o evento Purchase com o valor para a Meta. A partir
    // daqui o algoritmo aprende a otimizar por QUEM COMPRA, nao por quem clica.
    // Fire-and-forget: jamais pode derrubar o registro de um pedido.
    try {
      const { vincularPedidoAConversa } = await import('./mkt-ctwa');
      void vincularPedidoAConversa({
        conversaId: ctx?.conversationId || null,
        salesCardId: card?.id,
        valor: total,
        clienteId: customer?.id || null,
        telefone: onlyDigits(ctx?.phone) || null,
        canal: String(ctx?.channel || '') === 'instagram' ? 'instagram' : 'whatsapp',
      });
    } catch (e: any) { console.error('[IG-ORDER] ctwa (segue):', e?.message || e); }

    // Vincula o pedido para permitir gerar PIX depois (gerar_pix busca por conversation_id).
    try {
      await ensureIgPixTable();
      const _orderNum = 'INT-' + String(card?.id || '').substring(0, 8);
      await db.execute(sql`INSERT INTO instagram_pix (conversation_id, sales_card_id, order_number, igsid, customer_name, customer_document, total, status)
        VALUES (${ctx?.conversationId || null}, ${card?.id || null}, ${_orderNum}, ${onlyDigits(ctx?.phone) || null}, ${String(inp.nome || '')}, ${doc}, ${total.toFixed(2)}, 'registered')`);
    } catch (e: any) { console.error('[IG-ORDER] vinculo pix', e?.message || e); }

    // ROTEAMENTO POR CARTEIRA + CAPTURA DE LEAD (Honest).
    // - Cliente já cadastrado numa carteira → venda vai pro dono da carteira; se ele for
    //   telemarketing, dispara alerta (WhatsApp) para acompanhar a logística.
    // - Cliente NÃO cadastrado em carteira → oferece "capturar cliente" a todos os vendedores
    //   /telemarketing que estiverem online no Integra (primeiro que clicar leva pra sua carteira).
    try {
      const { isTelemarketing, notifyTelemarketingOrder, broadcastLeadCapture } = await import('./lead-capture');
      const _on = 'INT-' + String(card?.id || '').substring(0, 8);
      const info: any = { salesCardId: card?.id || null, orderNumber: _on, channel: String(ctx?.channel || 'whatsapp'), customerId: customer?.id || null, customerName: String(inp.nome || ''), customerDocument: doc };
      if (walletSellerId) {
        const owner = await storage.getUser(walletSellerId).catch(() => null);
        if (owner && isTelemarketing(owner)) await notifyTelemarketingOrder(owner, info);
      } else {
        await broadcastLeadCapture(info);
      }
    } catch (e: any) { console.error('[IG-ORDER] lead-routing', e?.message || e); }

    console.log(`[IG-ORDER] pedido card=${card?.id} total=${total.toFixed(2)} tabela=${table} conv=${ctx?.conversationId}`);
    return 'OK: pedido registrado no pipeline de faturamento como PENDENTE (aguarda confirmação da equipe; NÃO foi faturado). Total ' + brl(total) + ' pela tabela ' + (tabelaLabel[table] || table) + '. Itens: ' + products.map((p) => `${p.quantity}x ${p.name} = ${brl(p.totalPrice)}`).join('; ') + '. Diga ao cliente que o pedido foi registrado e que a equipe vai confirmar valor, pagamento e entrega em breve. NÃO prometa prazo específico de entrega.';
  } catch (e: any) {
    console.error('[IG-ORDER]', e?.message || e);
    return 'Não consegui registrar o pedido agora (erro interno). Transfira para um atendente humano.';
  }
}

// Gera a cobrança PIX do pedido registrado nesta conversa e envia o QR + copia-e-cola ao cliente.
async function gerarPix(_input: any, ctx: any): Promise<string> {
  try {
    if (!ctx?.conversationId) return 'Não consegui identificar a conversa para gerar o PIX. Transfira para um atendente.';
    await ensureIgPixTable();
    // Pedido mais recente desta conversa que ainda não foi pago.
    const r: any = await db.execute(sql`SELECT id, sales_card_id, order_number, igsid, customer_name, customer_document, total, charge_id, status
      FROM instagram_pix WHERE conversation_id = ${ctx.conversationId} AND status IN ('registered','awaiting_payment') ORDER BY created_at DESC LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) return 'Não há pedido registrado nesta conversa para gerar o PIX. Registre o pedido primeiro (registrar_pedido) e depois gere o PIX.';
    const total = Number(row.total);
    if (!(total > 0)) return 'O valor do pedido está indefinido. Transfira para um atendente para gerar a cobrança.';

    // FASE 0 — teto de valor. Ate aqui a unica checagem era `total > 0`: a IA podia
    // gerar cobranca de qualquer valor sozinha. Um anuncio que traga 300 DMs/dia
    // transforma isso em caixa registradora sem auditoria. Acima do teto ela NAO gera,
    // registra a tentativa e passa para uma pessoa. Teto ajustavel sem deploy.
    try {
      const { pixLiberado, registrarPixBarrado } = await import('./mkt-fase0');
      const v = await pixLiberado(total);
      if (!v.liberado) {
        await registrarPixBarrado({
          conversaId: ctx.conversationId, salesCardId: row.sales_card_id,
          pedido: row.order_number, valor: total, teto: v.teto, canal: String(ctx?.channel || ''),
        });
        console.warn('[IG-PIX] BARRADO pelo teto conv=' + ctx.conversationId + ' total=' + total.toFixed(2) + ' teto=' + v.teto.toFixed(2));
        return 'NAO gere o PIX. Este pedido esta acima do valor que voce pode cobrar sozinha. '
          + 'Diga ao cliente, de forma natural e sem citar limite interno, que para um pedido desse tamanho '
          + 'uma pessoa da equipe vai confirmar os dados e enviar a cobranca em seguida — e chame transferir_humano.';
      }
    } catch (e: any) {
      // Sem conseguir avaliar o teto, o seguro e NAO cobrar.
      console.error('[IG-PIX] teto indisponivel, barrando por seguranca:', e?.message || e);
      return 'NAO gere o PIX agora. Peca desculpas ao cliente e chame transferir_humano para uma pessoa concluir o pagamento.';
    }

    const { createImmediateCharge } = await import('./bb-pix-service');
    // Conta financeira com PIX BB habilitado.
    const acc: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_pix_enabled = true AND pix_key IS NOT NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 1`);
    const accountId = acc.rows?.[0]?.id;
    if (!accountId) return 'A cobrança PIX não está configurada no sistema no momento. Peça para o cliente aguardar e transfira para um atendente.';

    let chargeId = row.charge_id;
    let pixCopia = '';
    // Reaproveita cobrança ativa; senão cria nova.
    if (row.status === 'awaiting_payment' && chargeId) {
      const ex: any = await db.execute(sql`SELECT pix_copia_e_cola, status, expires_at FROM pix_charges WHERE id = ${chargeId} LIMIT 1`);
      const exr = ex.rows?.[0];
      const expired = exr?.expires_at ? (new Date(exr.expires_at).getTime() < Date.now()) : false;
      if (exr && String(exr.status) === 'ATIVA' && !expired) { pixCopia = String(exr.pix_copia_e_cola || ''); }
      else { chargeId = null; }
    }
    if (!chargeId) {
      let erpCustomerId: string | null = null;
      try { const c2: any = await db.execute(sql`SELECT customer_id FROM sales_cards WHERE id = ${row.sales_card_id} LIMIT 1`); erpCustomerId = c2.rows?.[0]?.customer_id || null; } catch {}
      const charge: any = await createImmediateCharge(accountId, {
        amount: total,
        debtorName: String(row.customer_name || '').slice(0, 60) || undefined,
        debtorDocument: onlyDigits(row.customer_document) || undefined,
        description: ('Pedido Honest ' + (row.order_number || '')).slice(0, 100),
        expirationSeconds: 3600,
        customerId: erpCustomerId || undefined,
        createdBy: 'ia:' + String(ctx?.channel || 'whatsapp'),
      });
      chargeId = charge.id;
      pixCopia = String(charge.pixCopiaECola || '');
      await db.execute(sql`UPDATE instagram_pix SET charge_id = ${chargeId}, txid = ${charge.txid || null}, status = 'awaiting_payment', updated_at = now() WHERE id = ${row.id}`);
    }

    // Envia o QR (imagem) + o copia-e-cola diretamente na conversa.
    const qrUrl = `${APP_URL}/api/pix-qr/${chargeId}.png`;
    try { if (ctx.sendImage) await ctx.sendImage(qrUrl); } catch {}
    if (ctx.sendText) {
      await ctx.sendText(ctx.phone, `PIX de ${brl(total)} — pedido ${row.order_number}. Copia e cola:`);
      if (pixCopia) await ctx.sendText(ctx.phone, pixCopia);
    }
    console.log(`[IG-PIX] enviado conv=${ctx.conversationId} card=${row.sales_card_id} charge=${chargeId} total=${total.toFixed(2)}`);
    return 'OK: QR Code e código PIX copia-e-cola JÁ FORAM ENVIADOS ao cliente nesta conversa. NÃO reenvie o código. Apenas diga ao cliente, de forma curta e simpática, que é só pagar pelo QR ou copia-e-cola e que a confirmação do pagamento é automática — assim que cair, ele será avisado aqui mesmo. NÃO prometa prazo específico de entrega.';
  } catch (e: any) {
    console.error('[IG-PIX]', e?.message || e);
    return 'Não consegui gerar o PIX agora (erro interno). Peça desculpas ao cliente e transfira para um atendente humano.';
  }
}

// CONSULTA DO PEDIDO
// O cliente que responde "tenho uma duvida" a um aviso de pedido esta perguntando SOBRE
// AQUELE PEDIDO. Antes, a IA so enxergava pedidos criados por ela mesma dentro da
// conversa (instagram_pix) e respondia "nao ha nenhum pedido registrado nessa conversa"
// para um cliente que tinha acabado de receber a confirmacao — a pior resposta possivel.
// Aqui ela le o pedido de verdade: sales_card + etapa do faturamento + bloqueio.
function _situacaoPedido(r: any): string {
  const bloqueado = r.block_status === 'blocked';
  if (bloqueado) {
    return r.block_reason === 'overdue_debt'
      ? 'RETIDO por titulo(s) em aberto — libera sozinho assim que o pagamento for identificado'
      : 'em aprovacao interna';
  }
  const etapa: Record<string, string> = {
    agendado: 'agendado', pedido: 'em preparacao', a_faturar: 'em faturamento',
    faturado: 'faturado', impresso: 'faturado', aguardando_rota: 'aguardando rota',
    em_rota: 'saiu para entrega', entregue: 'entregue',
  };
  if (r.stage && etapa[String(r.stage)]) return etapa[String(r.stage)];
  if (String(r.delivery_status || '') === 'delivered') return 'entregue';
  if (String(r.delivery_status || '') === 'in_transit') return 'saiu para entrega';
  return 'registrado';
}

async function consultarPedido(input: any, ctx: any): Promise<string> {
  try {
    const cid = await resolveCustomerId(ctx, undefined);
    if (!cid) return 'Cliente nao identificado nesta conversa. Peca o CPF/CNPJ ou o numero do pedido e chame a ferramenta de novo.';
    const numero = String(input?.numero || '').trim();

    const r: any = await db.execute(sql`
      SELECT sc.id, sc.status, sc.sale_value, sc.products, sc.payment_method, sc.operation_type,
             sc.completed_date, sc.delivery_status, sc.delivery_scheduled_date, sc.invoice_number,
             bp.stage, bp.order_number, bp.invoice_number AS bp_invoice, bp.scheduled_billing_date,
             bo.block_reason, bo.status AS block_status
      FROM sales_cards sc
      LEFT JOIN LATERAL (SELECT stage, order_number, invoice_number, scheduled_billing_date
                         FROM billing_pipeline b WHERE b.sales_card_id = sc.id
                         ORDER BY created_at DESC LIMIT 1) bp ON true
      LEFT JOIN LATERAL (SELECT block_reason, status FROM blocked_orders o WHERE o.sales_card_id = sc.id
                         ORDER BY blocked_at DESC LIMIT 1) bo ON true
      WHERE sc.customer_id = ${cid}
        AND COALESCE(sc.status,'') NOT IN ('cancelled','telemarketing')
        AND (sc.completed_date IS NOT NULL OR COALESCE(sc.status,'') IN ('blocked','completed','invoiced'))
        AND (${numero || ''} = '' OR COALESCE(bp.order_number,'') = ${numero} OR sc.id::text LIKE ${'%' + numero.replace(/^INT-/i, '') + '%'})
      ORDER BY COALESCE(sc.completed_date, sc.updated_at, sc.created_at) DESC
      LIMIT 1`);
    const p = r.rows?.[0];
    if (!p) return numero
      ? `Nao encontrei o pedido ${numero} para este cliente. Peca desculpas, confirme o numero com o cliente e, se insistir, transfira para um atendente.`
      : 'Este cliente nao tem pedido registrado. Diga isso de forma simpatica e ofereca ajuda para fazer um pedido.';

    const num = p.order_number || ('INT-' + String(p.id).substring(0, 8));
    const data = p.completed_date ? new Date(p.completed_date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-';
    const itens: any[] = Array.isArray(p.products) ? p.products : [];
    const lista = itens.length
      ? itens.slice(0, 20).map((i: any) => `${i.quantity || 1}x ${i.name}${i.totalPrice ? ' (' + brl(i.totalPrice) + ')' : ''}`).join('; ')
      : 'nao consta a lista de itens neste pedido';
    const entrega = p.delivery_scheduled_date
      ? new Date(p.delivery_scheduled_date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      : (p.scheduled_billing_date ? new Date(p.scheduled_billing_date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null);
    const nf = p.bp_invoice || p.invoice_number;

    const partes = [
      `Pedido ${num}`,
      `data ${data}`,
      `situacao: ${_situacaoPedido(p)}`,
      `valor ${brl(p.sale_value)}`,
      p.payment_method ? `pagamento ${String(p.payment_method).replace(/_/g, ' ')}` : '',
      entrega ? `entrega prevista ${entrega}` : '',
      nf ? `NF ${nf}` : '',
      `itens: ${lista}`,
    ].filter(Boolean);

    return 'DADOS DO PEDIDO (responda so o que o cliente perguntou, com estes dados, sem inventar): '
      + partes.join(' · ')
      + (p.block_status === 'blocked' && p.block_reason === 'overdue_debt'
        ? ' | Se o cliente perguntar por que travou ou quiser pagar, use a ferramenta segunda_via.' : '');
  } catch (e: any) {
    console.error('[IA-PEDIDO]', e?.message || e);
    return 'Nao consegui consultar o pedido agora. Peca desculpas e transfira para um atendente humano.';
  }
}

// 2a VIA DE TODOS OS TITULOS EM ABERTO
// O cliente que responde "me envie a 2a via" a um aviso de pedido nao deveria ter que
// informar CPF/CNPJ — o disparo sabe quem ele e. E ele quase nunca quer UM boleto: quer
// pagar o que esta em aberto. Entao esta ferramenta lista TODOS os titulos vencidos e
// manda um PIX copia-e-cola para cada um, reaproveitando cobranca ativa quando existe.
//
// Os codigos sao enviados PELO CODIGO, nunca pelo texto do modelo: copia-e-cola tem ~150
// caracteres e um digito trocado quebra o pagamento.
async function segundaVia(input: any, ctx: any): Promise<string> {
  try {
    const cid = await resolveCustomerId(ctx, input?.documento);
    if (!cid) return 'Cliente nao identificado nesta conversa. Peca o CPF/CNPJ ao cliente e chame a ferramenta de novo.';

    const c: any = await db.execute(sql`SELECT name, fantasy_name, cnpj, cpf FROM customers WHERE id = ${cid} LIMIT 1`);
    const cli = c.rows?.[0];
    const doc = onlyDigits(cli?.cnpj || cli?.cpf || '');
    const nome = String(cli?.fantasy_name || cli?.name || '').slice(0, 60);

    // Mesma regra do bloqueio e da tela de Contas a Receber: em aberto e vencido no fuso BR.
    const t: any = await db.execute(sql`
      SELECT id, title_number, due_date, (amount - COALESCE(amount_paid,0))::float AS saldo
      FROM receivables
      WHERE deleted_at IS NULL
        AND (amount - COALESCE(amount_paid,0)) > 0
        AND COALESCE(import_origin,'') <> 'omie_historico'
        AND status IN ('a_vencer','vencida')
        AND (due_date)::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date
        AND (customer_id = ${cid} OR regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g') = ${doc || '___'})
      ORDER BY due_date
      LIMIT 8`);
    const titulos = t.rows || [];
    if (!titulos.length) return 'Nenhum titulo vencido em aberto para este cliente. Diga isso ao cliente de forma simpatica; se ele insistir, transfira para um atendente.';

    const acc: any = await db.execute(sql`SELECT id FROM financial_accounts WHERE bb_pix_enabled = true AND pix_key IS NOT NULL AND COALESCE(is_active, true) = true ORDER BY created_at LIMIT 1`);
    const accountId = acc.rows?.[0]?.id;
    if (!accountId) return 'A cobranca PIX nao esta configurada no sistema agora. Peca desculpas e transfira para um atendente.';

    const { createImmediateCharge } = await import('./bb-pix-service');
    const linhas: Array<{ titulo: string; venc: string; valor: number; copia: string }> = [];
    let total = 0, falhas = 0;

    for (const tit of titulos) {
      const valor = Math.round(Number(tit.saldo || 0) * 100) / 100;
      if (!(valor > 0)) continue;
      const rotulo = String(tit.title_number || '').trim() || 'titulo';
      const venc = tit.due_date ? new Date(tit.due_date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-';
      let copia = '';
      try {
        // Reaproveita cobranca ATIVA do mesmo titulo (nao cria PIX novo a cada pedido de 2a via).
        const ex: any = await db.execute(sql`SELECT pix_copia_e_cola, status, expires_at, amount
          FROM pix_charges WHERE receivable_id = ${tit.id} AND status = 'ATIVA'
          ORDER BY created_at DESC LIMIT 1`);
        const e = ex.rows?.[0];
        const vencido = e?.expires_at ? new Date(e.expires_at).getTime() < Date.now() : false;
        if (e && !vencido && Math.abs(Number(e.amount) - valor) < 0.01) copia = String(e.pix_copia_e_cola || '');
      } catch {}
      if (!copia) {
        try {
          const ch: any = await createImmediateCharge(accountId, {
            amount: valor,
            debtorName: nome || undefined,
            debtorDocument: doc || undefined,
            description: ('Honest - 2a via ' + rotulo).slice(0, 100),
            expirationSeconds: 86400,      // 24h: 2a via nao pode expirar em 1h
            receivableId: tit.id,
            customerId: cid,
            createdBy: 'ia:' + String(ctx?.channel || 'whatsapp'),
          });
          copia = String(ch?.pixCopiaECola || '');
        } catch (e: any) { falhas++; console.error('[IA-2AVIA] pix', rotulo, e?.message || e); continue; }
      }
      if (!copia) { falhas++; continue; }
      linhas.push({ titulo: rotulo, venc, valor, copia });
      total += valor;
    }

    if (!linhas.length) return 'Nao consegui gerar as cobrancas agora. Peca desculpas ao cliente e transfira para um atendente.';

    // Envia pelo codigo: cabecalho, depois um par (descricao + copia-e-cola) por titulo.
    if (ctx.sendText) {
      const plural = linhas.length > 1;
      await ctx.sendText(ctx.phone, plural
        ? `Segue a 2ª via de ${linhas.length} títulos em aberto, total ${brl(total)}. Vou mandar um PIX para cada um:`
        : `Segue a 2ª via do título em aberto, ${brl(total)}. É só pagar com o PIX abaixo:`);
      for (const l of linhas) {
        await ctx.sendText(ctx.phone, `${l.titulo} · venc. ${l.venc} · ${brl(l.valor)}`);
        await ctx.sendText(ctx.phone, l.copia);
      }
    }
    console.log(`[IA-2AVIA] cliente=${cid} titulos=${linhas.length} total=${total.toFixed(2)} falhas=${falhas}`);
    return `OK: JA FORAM ENVIADOS ao cliente ${linhas.length} codigo(s) PIX copia-e-cola, total ${brl(total)}`
      + (falhas ? `; ${falhas} titulo(s) falharam` : '')
      + '. NAO reescreva os codigos. Apenas confirme de forma curta que a baixa e automatica assim que o pagamento cair'
      + (falhas ? ' e avise que um atendente vai retornar sobre os titulos restantes.' : '.');
  } catch (e: any) {
    console.error('[IA-2AVIA]', e?.message || e);
    return 'Nao consegui emitir a 2a via agora (erro interno). Peca desculpas ao cliente e transfira para um atendente humano.';
  }
}

// Gera o LINK de pagamento (cartao/Google Pay) do pedido registrado nesta conversa e envia ao cliente.
async function gerarLinkPagamento(_input: any, ctx: any): Promise<string> {
  try {
    if (!ctx?.conversationId) return 'Nao consegui identificar a conversa para gerar o link. Transfira para um atendente.';
    await ensureIgPixTable();
    // Mesmo vinculo usado pelo gerar_pix: pedido mais recente da conversa ainda nao pago.
    const r: any = await db.execute(sql`SELECT id, sales_card_id, order_number, customer_name, customer_document, total, status
      FROM instagram_pix WHERE conversation_id = ${ctx.conversationId} AND status IN ('registered','awaiting_payment') ORDER BY created_at DESC LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) return 'Nao ha pedido registrado nesta conversa para gerar o link de pagamento. Registre o pedido primeiro (registrar_pedido) e so depois gere o link.';
    const total = Number(row.total);
    if (!(total > 0)) return 'O valor do pedido esta indefinido. Transfira para um atendente para gerar a cobranca.';

    const { createPaymentLink } = await import('./payment-link');
    const out = await createPaymentLink({
      kind: 'order',
      salesCardId: row.sales_card_id,
      orderNumber: row.order_number,
      conversationId: ctx.conversationId,
      channel: String(ctx.channel || 'whatsapp'),
      customerName: row.customer_name,
      customerDocument: row.customer_document,
      customerPhone: ctx.phone,
      amount: total,
      description: 'Pedido Honest ' + (row.order_number || ''),
      createdBy: 'ia:' + String(ctx.channel || 'whatsapp'),
    });
    if (!out.ok || !out.url) {
      console.error('[IA-PAYLINK] falha:', out.error);
      return 'Nao consegui gerar o link de pagamento agora. Peca desculpas ao cliente e transfira para um atendente humano.';
    }

    if (ctx.sendText) {
      await ctx.sendText(ctx.phone, `Link para pagar ${brl(total)} no cartao ou Google Pay — pedido ${row.order_number || ''}:`);
      await ctx.sendText(ctx.phone, out.url);
    }
    console.log(`[IA-PAYLINK] enviado conv=${ctx.conversationId} card=${row.sales_card_id} total=${total.toFixed(2)} canal=${ctx.channel || '-'}`);
    return 'OK: o LINK de pagamento JA FOI ENVIADO ao cliente nesta conversa. NAO reescreva nem reenvie o link. Apenas diga, de forma curta e simpatica, que e so abrir o link e pagar no cartao ou no Google Pay, que e a vista (sem parcelamento) e que a confirmacao do pagamento e automatica. NAO prometa prazo especifico de entrega.';
  } catch (e: any) {
    console.error('[IA-PAYLINK]', e?.message || e);
    return 'Nao consegui gerar o link de pagamento agora (erro interno). Peca desculpas ao cliente e transfira para um atendente humano.';
  }
}

async function callAnthropic(model: string, system: string, messages: any[], tools?: any[]): Promise<{ ok: boolean; status: number; j: any }> {
  const body: any = { model, max_tokens: 1024, system, messages };
  if (tools && tools.length) body.tools = tools;
  const resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const j: any = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, j };
}

// CENTRAL DE MARKETING (buraco 7): o `usage` da resposta da Anthropic vinha sendo
// jogado fora. Le os tokens de UMA resposta; quem soma o loop de tool-use e o
// generateAgentReply. Tokens de cache tambem sao entrada, entao entram no total.
function lerUso(j: any): { in: number; out: number } {
  const u = j?.usage || {};
  const entrada = Number(u.input_tokens || 0)
    + Number(u.cache_creation_input_tokens || 0)
    + Number(u.cache_read_input_tokens || 0);
  return { in: entrada, out: Number(u.output_tokens || 0) };
}

// Gera resposta. Se ctx (com conversa/cliente) for passado, habilita ferramentas (tool-use loop).
export async function generateAgentReply(agentId: string, messages: Array<{ role: string; content: any }>, ctx?: any): Promise<{ ok: boolean; reply?: string; error?: string; model?: string; usedTools?: string[]; uso?: { tokensIn: number; tokensOut: number; custoBrl: number; rodadas: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY ausente' };
  // Buraco 7 — medicao e teto de custo. Import dinamico para nao criar ciclo e para
  // que uma falha aqui jamais derrube a resposta ao cliente.
  const _t0 = Date.now();
  let _mkt: any = null;
  try { _mkt = await import('./mkt-agent-runs'); } catch (e: any) { console.error('[MKT-RUNS] import:', e?.message || e); }
  let _tokIn = 0, _tokOut = 0, _rodadas = 0;
  const _registrar = async (modelo: string, ferramentas: string[], sucesso: boolean, erro?: string) => {
    if (!_mkt) return;
    try {
      await _mkt.registrarRun({
        agente: agentId,
        gatilho: String(ctx?.gatilho || (ctx?.conversationId ? 'chat' : 'teste')),
        canal: String(ctx?.channel || (ctx ? 'whatsapp' : 'interno')),
        entradaRef: ctx?.conversationId || null,
        modelo, tokensIn: _tokIn, tokensOut: _tokOut, rodadas: Math.max(1, _rodadas),
        ferramentas, duracaoMs: Date.now() - _t0, sucesso, erro: erro || null,
      });
    } catch {}
  };
  // Teto diario por agente (agentes_config.teto_custo_dia). Nulo/0 = sem teto,
  // ou seja, o comportamento de hoje nao muda ate alguem definir um teto.
  if (_mkt) {
    try {
      const t = await _mkt.tetoEstourado(agentId);
      if (t.estourou) {
        console.error('[MKT-RUNS] teto diario estourado', { agente: agentId, teto: t.teto, gasto: t.gasto });
        return { ok: false, error: `teto de custo diario do agente ${agentId} estourado (R$ ${t.gasto.toFixed(2)} de R$ ${t.teto.toFixed(2)})` };
      }
    } catch {}
  }
  try {
    const a: any = await db.execute(sql`SELECT id, nome, modelo, system_prompt, base_conhecimento FROM agentes_config WHERE id = ${agentId} LIMIT 1`);
    const agent = a.rows?.[0];
    if (!agent) return { ok: false, error: 'agente nao encontrado' };
    const g: any = await db.execute(sql`SELECT valor FROM config_global WHERE chave = 'base_comum' LIMIT 1`);
    const base = g.rows?.[0]?.valor || '';
    const kb = (agent.base_conhecimento || '').trim();
    // Data e hora de Brasilia no prompt: sem isso o modelo nao sabe que horas sao e
    // erra a saudacao (dizia "boa tarde" as 10h da manha).
    const _agora = new Date();
    const _dataBR = _agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const _horaBR = _agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const _h = parseInt(_horaBR.slice(0, 2), 10);
    const _saudacao = _h < 12 ? 'bom dia' : (_h < 18 ? 'boa tarde' : 'boa noite');
    const _tempo = [
      '# AGORA (fuso de Brasilia)',
      'Data: ' + _dataBR,
      'Hora: ' + _horaBR,
      'Saudacao correta neste momento: "' + _saudacao + '". Use EXATAMENTE essa — nunca outra.',
      'Regra: ate 11:59 e "bom dia"; das 12:00 as 17:59 e "boa tarde"; a partir das 18:00 e "boa noite".',
      'Se o cliente saudar com o periodo errado, responda com o periodo CERTO, sem corrigi-lo.',
    ].join('\n');
    const _aviso = ctx?.phone ? await contextoDoAviso(String(ctx.phone)) : '';
    // Calendario + retrato do cliente. Sem isso a IA falou em "finalzinho de julho" no dia
    // 05/08 e prometeu prazo sem saber quando o cliente compra nem quando o vendedor passa.
    let _cal = '', _cli = '';
    try {
      const { blocoCalendario, contextoDoCliente } = await import('./contexto-cliente');
      _cal = blocoCalendario();
      if (ctx) {
        const _cid = await resolveCustomerId(ctx, undefined).catch(() => null);
        if (_cid) _cli = await contextoDoCliente(_cid);
      }
    } catch (e: any) { console.error('[CTX-CLIENTE]', e?.message || e); }
    const systemPrompt = _tempo + '\n\n'
      + (_cal ? _cal + '\n\n' : '')
      + (_cli ? _cli + '\n\n' : '')
      + (_aviso ? _aviso + '\n\n' : '')
      + (base ? base + '\n\n' : '')
      + (kb ? '# BASE DE CONHECIMENTO (fatos da Honest — responda so com o que esta aqui; se faltar, ofereca falar com uma pessoa)\n' + kb + '\n\n' : '')
      + (agent.system_prompt || '');
    // normaliza histórico inicial (texto): começa com user, alterna
    const conv: any[] = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof m.content === 'string' ? m.content.trim() : m.content;
      if (typeof content === 'string' && !content) continue;
      if (conv.length && conv[conv.length - 1].role === role && typeof content === 'string' && typeof conv[conv.length - 1].content === 'string') conv[conv.length - 1].content += '\n' + content;
      else conv.push({ role, content });
    }
    while (conv.length && conv[0].role !== 'user') conv.shift();
    if (!conv.length) return { ok: false, error: 'sem mensagem de usuario' };
    const model = normModel(agent.modelo);
    // Ferramentas de venda (registrar_pedido + gerar_pix) fora do Instagram ficam atras da
    // chave 'ia_wpp_vendas' (off por padrao): liga/desliga o "modo Instagram" no WhatsApp
    // sem precisar de deploy. Instagram continua sempre com o pacote completo.
    const _canal = String((ctx as any)?.channel || '');
    const _vendasFora = !!ctx && _canal !== 'instagram' && (await getSetting('ia_wpp_vendas', 'off')) === 'on';
    const tools = ctx
      ? ((_canal === 'instagram' || _vendasFora)
          ? [...TOOL_DEFS, ORDER_TOOL, PIX_TOOL, CARD_LINK_TOOL]
          : [...TOOL_DEFS, CARD_LINK_TOOL])
      : undefined;
    const usedTools: string[] = [];
    // Buraco 7: o custo de UMA resposta e a soma de TODAS as rodadas de tool-use.
    // Medir so a ultima subestimaria em ate 4x nas conversas que usam ferramenta.
    const _uso = async (modelo: string) => {
      const c = _mkt ? await _mkt.calcularCusto(modelo, _tokIn, _tokOut).catch(() => ({ brl: 0 })) : { brl: 0 };
      return { tokensIn: _tokIn, tokensOut: _tokOut, custoBrl: Number((c as any).brl || 0), rodadas: Math.max(1, _rodadas) };
    };
    for (let i = 0; i < 4; i++) {
      const { ok, status, j } = await callAnthropic(model, systemPrompt, conv, tools);
      const u = lerUso(j); _tokIn += u.in; _tokOut += u.out; _rodadas++;
      if (!ok) {
        const erro = 'anthropic ' + status + ': ' + JSON.stringify(j).slice(0, 200);
        await _registrar(model, usedTools, false, erro);
        return { ok: false, error: erro, model, uso: await _uso(model) };
      }
      const content = j.content || [];
      const toolUses = content.filter((c: any) => c.type === 'tool_use');
      if (j.stop_reason === 'tool_use' && toolUses.length && ctx) {
        conv.push({ role: 'assistant', content });
        const results: any[] = [];
        for (const tu of toolUses) { usedTools.push(tu.name); const out = await execTool(tu.name, tu.input || {}, ctx); results.push({ type: 'tool_result', tool_use_id: tu.id, content: out }); }
        conv.push({ role: 'user', content: results });
        continue;
      }
      const reply = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
      await _registrar(model, usedTools, true);
      return { ok: true, reply, model, usedTools, uso: await _uso(model) };
    }
    await _registrar(model, usedTools, true, 'limite de 4 rodadas de ferramenta atingido');
    return { ok: true, reply: '', model, usedTools, uso: await _uso(model) };
  } catch (e: any) {
    await _registrar('', [], false, e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function maybeRunAgent(opts: { phone: string; conversationId: string; incomingText: string; sendText: (to: string, text: string) => Promise<any>; sendImage?: (url: string) => Promise<any>; channel?: string; username?: string; }): Promise<void> {
  try {
    const channel = (opts.channel || 'whatsapp').toLowerCase();
    const isIG = channel === 'instagram';
    const mode = await getSetting(isIG ? 'agents_ig_mode' : 'agents_runtime_mode', 'off');
    // Trilha: cada porta daqui tambem deixa registro. Ver server/ia-takeover.ts (trilha()).
    const _t = async (porta: string, det?: string) => {
      try { const { trilha } = await import('./ia-takeover'); await trilha(opts.conversationId, opts.phone, opts.incomingText, porta, det); } catch {}
    };
    if (mode === 'off') { await _t('agente:modo_off'); return; }
    if (!process.env.ANTHROPIC_API_KEY) { await _t('agente:sem_chave'); return; }
    const phone = onlyDigits(opts.phone);
    const handle = (opts.username || '').replace(/^@/, '').trim().toLowerCase();
    if (mode === 'test') {
      if (isIG) {
        const allow = (await getSetting('agents_ig_test_handles', '')).split(/[,;\n\s]+/).map(s => s.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
        if (!allow.length || !handle || !allow.includes(handle)) return;
      } else {
        // Compara por DDD + 8 finais: o mesmo celular chega com 13 digitos (com o 9)
        // ou 12 (sem o 9), e a comparacao literal deixava a IA muda em modo teste.
        const { telefoneNaLista } = await import('./ia-fila');
        if (!telefoneNaLista(phone, await getSetting('agents_test_numbers', '5562995782812'))) { await _t('agente:fora_da_lista_de_teste'); return; }
      }
    }
    if (!opts.incomingText || !opts.incomingText.trim()) return;

    // FASE 0 — opt-out em QUALQUER canal. Ate aqui "SAIR" so era registrado dentro do
    // if do canal 1841 (chat-routes): quem escrevia pelo 2630 ou pelo Instagram nao
    // entrava na lista. Aqui e o caminho por onde TODA mensagem recebida passa, entao
    // e o lugar certo para capturar - uma vez, para todos os canais.
    try {
      const { pediuParaSair, registrarOptOut } = await import('./mkt-fase0');
      if (pediuParaSair(opts.incomingText)) {
        const c: any = await db.execute(sql`SELECT customer_id FROM chat_conversations WHERE id = ${opts.conversationId} LIMIT 1`);
        const cid = c.rows?.[0]?.customer_id;
        if (cid && await registrarOptOut(String(cid), channel)) {
          await _t('agente:opt_out_registrado', channel);
          // Confirmar e obrigacao, nao cortesia: sem resposta a pessoa nao sabe se saiu.
          try { await opts.sendText(opts.phone, 'Pronto, você não vai mais receber nossas mensagens de campanha. Se um dia quiser voltar, é só escrever aqui.'); } catch {}
          return;
        }
      }
    } catch (e: any) { console.error('[FASE0] opt-out:', e?.message || e); }

    // se a conversa foi transferida p/ humano, não responder mais (expira em ia_pausa_horas).
    // EXCECAO: o cliente esta respondendo a um DISPARO nosso. Quem recebe "recebemos seu
    // pedido" e toca no botao esta falando com a maquina, nao continuando o assunto que foi
    // para o atendente semanas atras — e uma conversa pausada deixava esse toque sem
    // NENHUMA resposta. A excecao so vale se nenhum humano falou aqui nos ultimos minutos,
    // para nao atropelar atendente que esta no meio do atendimento.
    if (await iaPausada(opts.conversationId)) {
      if (!(await respostaADisparo(opts.conversationId, phone))) { await _t('agente:ia_pausada'); return; }
      console.log(`[AGENT] pausa ignorada em ${opts.conversationId}: resposta a disparo recente`);
    }
    const defId = await getSetting(isIG ? 'agents_ig_default' : 'agents_default', isIG ? 'instagram' : 'sdr');
    const routing = await getSetting('agents_routing', 'keyword');
    // contexto do cliente (p/ ferramentas)
    let customerId: string | null = null;
    try { const c: any = await db.execute(sql`SELECT customer_id FROM chat_conversations WHERE id=${opts.conversationId} LIMIT 1`); customerId = c.rows?.[0]?.customer_id || null; } catch {}
    const ctx: any = { conversationId: opts.conversationId, customerId, phone, channel, username: handle, sendText: opts.sendText, sendImage: opts.sendImage };
    // histórico recente (10)
    const h: any = await db.execute(sql`SELECT sender_type, content FROM chat_messages WHERE conversation_id = ${opts.conversationId} ORDER BY created_at DESC LIMIT 40`);
    const hist = (h.rows || []).reverse().map((m: any) => ({ role: m.sender_type === 'customer' ? 'user' : 'assistant', content: String(m.content || '') }));
    if (!hist.length || hist[hist.length - 1].role !== 'user') hist.push({ role: 'user', content: opts.incomingText });
    let chosenId = (!isIG && routing === 'keyword') ? pickAgentByKeyword(opts.incomingText, defId) : defId;
    try { const chk: any = await db.execute(sql`SELECT id FROM agentes_config WHERE id = ${chosenId} AND ativo = true LIMIT 1`); if (!chk.rows?.[0]) chosenId = defId; } catch { chosenId = defId; }
    // Resposta a um disparo de rota do dia -> agente "Rota do Dia"
    try {
      const rd: any = await db.execute(sql`SELECT 1 FROM official_dispatches
        WHERE customer_phone = ${phone} AND use_case = 'rota_do_dia'
          AND created_at > now() - interval '24 hours' LIMIT 1`);
      if (rd.rows?.[0]) {
        const ra: any = await db.execute(sql`SELECT id FROM agentes_config
          WHERE id = 'Rota_do_Dia' AND ativo = true LIMIT 1`);
        if (ra.rows?.[0]) chosenId = 'Rota_do_Dia';
      }
    } catch {}
    const gen = await generateAgentReply(chosenId, hist, ctx);
    if (!gen.ok || !gen.reply) { await _t('agente:modelo_sem_resposta', gen.error || 'resposta vazia'); return; }
    // O envio vem ANTES do registro da mensagem: se falhar, sem a trilha nao sobra rastro.
    let sent: any = null;
    try { sent = await opts.sendText(opts.phone, gen.reply); }
    catch (se: any) { await _t('agente:falha_no_envio', se?.message || String(se)); return; }
    await _t('agente:respondeu', 'via ' + JSON.stringify(sent || {}).slice(0, 120));
    try { const { storage } = await import('./storage'); await storage.createChatMessage({ conversationId: opts.conversationId, senderId: 'agent:' + chosenId, senderType: 'system', content: gen.reply, messageType: 'text', metadata: { agent: chosenId, auto: true, tools: gen.usedTools, delivery: sent } as any }); } catch {}
  } catch (e: any) {
    try { const { trilha } = await import('./ia-takeover'); await trilha(opts.conversationId, opts.phone, opts.incomingText, 'agente:excecao', e?.message || String(e)); } catch {}
    console.error('[AGENT-RUNTIME]', e?.message || e);
  }
}
