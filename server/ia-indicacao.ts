// ============================================================================
// INTEGRA 2.0 — IA · Indicação (Plano Dobrar Vendas, Proposta 4c) — 11/10/2026
// Decisão do Flavio: R$ 30 para quem indica e R$ 30 para o indicado no 1º pedido.
//
// Fluxo:
//  1. Depois de registrar um pedido, a IA convida o cliente (1x por mês) a indicar outro
//     comércio. Se ele mandar nome + WhatsApp, a IA chama a ferramenta `registrar_indicacao`.
//  2. registrar_indicacao: cria o LEAD (carteira do vendedor do indicador), cria o cupom
//     INDICA30-xxxx (R$ 30 fixo, 1x por cliente, pedido mínimo R$ 80, 60 dias), grava em
//     ia_indicacoes e manda a 1ª mensagem ao indicado pelo 2630 (a IA continua a conversa).
//  3. Cron horário: quando o cupom do indicado é resgatado num pedido concluído/faturado,
//     cria o cupom de R$ 30 do indicador (INDICOU30-xxxx) e avisa os dois.
//
// Gates: ia_indicacao_on (on), ia_indicacao_valor (30), ia_indicacao_min_pedido (80)
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const TZ = 'America/Sao_Paulo';
const dig = (s: any) => String(s || '').replace(/\D/g, '');
function brl(v: any) { const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function mesBR(): string { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7); }
function rid(n = 5): string { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
function title(t: string): string { return String(t || '').toLowerCase().replace(/(^|\s)(\p{L})/gu, (m) => m.toUpperCase()).replace(/\b\d{8,14}\b/g, '').replace(/\b(Ltda|Me|Epp|Eireli|S\/a)\b\.?/gi, '').replace(/\s+/g, ' ').replace(/[\s.,;:!-]+$/g, '').trim(); }
function celular(phone: any): string | null {
  let d = dig(phone).replace(/^55/, '');
  if (d.length === 10 && /^[1-9][0-9][6-9]/.test(d)) d = d.slice(0, 2) + '9' + d.slice(2);
  if (/(\d)\1{6,}/.test(d)) return null;
  return /^[1-9][0-9]9[0-9]{8}$/.test(d) ? '55' + d : null;
}
async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
async function setSetting(key: string, value: string): Promise<void> {
  try {
    await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES (${key}, ${value}, 'ia-indicacao')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  } catch {}
}

let _tabela = false;
async function ensureTabela() {
  if (_tabela) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ia_indicacoes (
    id serial PRIMARY KEY,
    indicador_customer_id varchar(64) NOT NULL,
    indicador_nome varchar(120),
    indicado_nome varchar(120),
    indicado_telefone varchar(20),
    indicado_cidade varchar(80),
    lead_id varchar(64),
    cupom_indicado varchar(40),
    cupom_indicador varchar(40),
    conversation_id varchar(64),
    status varchar(20) DEFAULT 'pendente',   -- pendente | contatado | comprou | recompensado | invalido
    enviado_ok boolean,
    erro text,
    criado_em timestamptz DEFAULT now(),
    comprou_em timestamptz,
    recompensado_em timestamptz)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ia_ind_tel ON ia_indicacoes (indicado_telefone)`);
  _tabela = true;
}

export const INDICACAO_TOOL: any = {
  name: 'registrar_indicacao',
  description: 'Registra a INDICAÇÃO de outro comércio feita pelo cliente desta conversa (programa: R$ 30 de desconto para quem indica e R$ 30 para o indicado no primeiro pedido). Use quando o cliente mandar o nome e o WhatsApp de um estabelecimento. O sistema cria o lead para o vendedor, gera o cupom e já manda a primeira mensagem ao indicado — você só confirma ao cliente que a indicação foi registrada e que o desconto dele é liberado quando o indicado fizer o primeiro pedido.',
  input_schema: { type: 'object', properties: {
    nome_estabelecimento: { type: 'string', description: 'nome do comércio indicado' },
    telefone: { type: 'string', description: 'WhatsApp do indicado, com DDD' },
    contato: { type: 'string', description: 'nome da pessoa de contato, se informado' },
    cidade: { type: 'string', description: 'cidade do indicado, se informada' },
  }, required: ['nome_estabelecimento', 'telefone'] },
};

async function criarCupomFixo(prefixo: string, valor: number, descricao: string, dias: number, minimo: number | null): Promise<string | null> {
  for (let i = 0; i < 5; i++) {
    const code = `${prefixo}-${rid()}`;
    try {
      await db.execute(sql`INSERT INTO coupons (code, description, discount_type, discount_value, valid_from, valid_until, is_active, max_uses, min_order_value, once_per_customer, channels, enabled_2_0, created_by_user_id)
        VALUES (${code}, ${descricao}, 'fixed', ${valor}, now(), ${new Date(Date.now() + dias * 86400000)}, true, 1, ${minimo}, true, 'todos', true, 'ia-indicacao')`);
      return code;
    } catch { /* colisao de codigo: tenta outro */ }
  }
  return null;
}

// Ferramenta chamada pelo agente.
export async function registrarIndicacao(input: any, ctx: any): Promise<string> {
  try {
    await ensureTabela();
    if ((await getSetting('ia_indicacao_on', 'on')) !== 'on') return 'O programa de indicação está desligado no momento. Agradeça e diga que a equipe entra em contato.';
    const { resolveCustomerId } = await import('./agent-runtime');
    const cid = await resolveCustomerId(ctx, undefined);
    if (!cid) return 'Não identifiquei o cliente que está indicando (sem cadastro vinculado a este telefone). Peça o CPF/CNPJ dele e tente de novo.';
    const tel = celular(input?.telefone);
    if (!tel) return 'O telefone informado não parece um celular válido com DDD. Peça o número de WhatsApp do indicado (ex.: 62 9xxxx-xxxx).';
    const nomeInd = title(String(input?.nome_estabelecimento || '')).slice(0, 100);
    if (!nomeInd) return 'Falta o nome do comércio indicado.';
    const valor = Math.max(10, parseFloat(await getSetting('ia_indicacao_valor', '30')) || 30);
    const minimo = parseFloat(await getSetting('ia_indicacao_min_pedido', '80')) || null;

    // Já é cliente ou lead? (mesmo telefone)
    const jaCli: any = await db.execute(sql`SELECT id, COALESCE(NULLIF(fantasy_name,''), name) AS n FROM customers WHERE right(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'), 8) = ${tel.slice(-8)} LIMIT 1`);
    if (jaCli.rows?.length) return `Este telefone já pertence a um cliente da Honest (${jaCli.rows[0].n}). A indicação só vale para comércio novo — agradeça e explique com simpatia.`;
    const jaInd: any = await db.execute(sql`SELECT 1 FROM ia_indicacoes WHERE right(indicado_telefone, 8) = ${tel.slice(-8)} AND status <> 'invalido' LIMIT 1`);
    if (jaInd.rows?.length) return 'Este comércio já foi indicado antes (a indicação vale para quem chegou primeiro). Agradeça e peça se ele conhece outro.';

    const c: any = await db.execute(sql`SELECT COALESCE(NULLIF(fantasy_name,''), name) AS n, seller_id, latitude, longitude, city FROM customers WHERE id = ${cid} LIMIT 1`);
    const ind = c.rows?.[0] || {};
    const nomeIndicador = title(String(ind.n || '')) || 'um cliente';

    // Lead na carteira do vendedor do indicador (coordenadas do indicador como ponto de partida).
    let leadId: string | null = null;
    try {
      const { storage } = await import('./storage');
      const lead: any = await storage.createLead({
        fantasyName: nomeInd, latitude: Number(ind.latitude || -16.6869), longitude: Number(ind.longitude || -49.2648), coordinatesLocked: false,
        city: String(input?.cidade || ind.city || '') || null, contact: String(input?.contato || '') || null, phone: tel,
        observation: `Indicado por ${nomeIndicador} via IA (WhatsApp) em ${new Date().toLocaleDateString('pt-BR', { timeZone: TZ })}. Programa de indicação: R$ ${valor} para os dois no 1º pedido.`,
        status: 'pending', temperature: 'warm', createdBy: 'ia', createdByName: 'IA WhatsApp', assignedTo: ind.seller_id || null, routeType: 'prospeccao',
      } as any);
      leadId = lead?.id || null;
    } catch (e: any) { console.error('[IA-INDICACAO] lead', e?.message || e); }

    const cupom = await criarCupomFixo('INDICA30', valor, `Indicação: R$ ${valor} no 1º pedido de ${nomeInd} (indicado por ${nomeIndicador})`, 60, minimo);
    const ins: any = await db.execute(sql`INSERT INTO ia_indicacoes (indicador_customer_id, indicador_nome, indicado_nome, indicado_telefone, indicado_cidade, lead_id, cupom_indicado, status)
      VALUES (${cid}, ${nomeIndicador}, ${nomeInd}, ${tel}, ${String(input?.cidade || '') || null}, ${leadId}, ${cupom}, 'pendente') RETURNING id`);
    const indId = ins.rows?.[0]?.id;

    // Primeira mensagem ao indicado (2630, texto livre) — a IA segue a conversa quando ele responder.
    let enviado = false;
    try {
      const canal = dig(await getSetting('ia_repescagem_canal', '5562992682630')) || '5562992682630';
      const contato = title(String(input?.contato || ''));
      const texto = `Olá${contato ? ', ' + contato : ''}! Aqui é a Honest Sucos 🧡 ${nomeIndicador} indicou o ${nomeInd} para conhecer nossos sucos naturais — sem conservantes, 8 sabores em 350ml e 900ml, entrega refrigerada.\n\nPela indicação você ganha *${brl(valor)} de desconto no primeiro pedido*${cupom ? ' (cupom *' + cupom + '*)' : ''} e uma *amostra grátis* na próxima passagem do nosso vendedor. Quer que eu te mande a tabela ou já monte um pedido? 🍹`;
      const { sendUmblerTalkText } = await import('./chat-routes');
      const r: any = await sendUmblerTalkText(tel, texto, canal);
      enviado = !!(r && r.success);
      // conversa + mensagem como agent:% para a IA continuar
      let convId: string | null = null;
      try {
        const ex: any = await db.execute(sql`SELECT id FROM chat_conversations WHERE customer_phone NOT LIKE 'ig:%' AND right(regexp_replace(COALESCE(customer_phone,''),'[^0-9]','','g'), 8) = ${tel.slice(-8)} ORDER BY last_message_time DESC NULLS LAST LIMIT 1`);
        convId = ex.rows?.[0]?.id || null;
        if (!convId) {
          const cc: any = await db.execute(sql`INSERT INTO chat_customers (name, phone) VALUES (${nomeInd}, ${tel}) RETURNING id`);
          const nc: any = await db.execute(sql`INSERT INTO chat_conversations (customer_id, customer_name, customer_phone, status, channel, channel_phone, initiated_by) VALUES (${cc.rows?.[0]?.id || null}, ${nomeInd}, ${tel}, 'new', 'whatsapp', ${canal}, 'customer') RETURNING id`);
          convId = nc.rows?.[0]?.id || null;
        }
        if (convId) {
          await db.execute(sql`INSERT INTO chat_messages (conversation_id, sender_id, sender_type, content, message_type, is_read, metadata)
            VALUES (${convId}, 'agent:indicacao', 'system', ${texto}, 'text', true, ${JSON.stringify({ auto: true, origem: 'ia_indicacao', indicacao: indId, delivery: r })}::jsonb)`);
          await db.execute(sql`UPDATE chat_conversations SET last_message_time = now(), updated_at = now() WHERE id = ${convId}`);
        }
      } catch {}
      await db.execute(sql`UPDATE ia_indicacoes SET enviado_ok = ${enviado}, erro = ${enviado ? null : String(r?.error || 'falha')}, conversation_id = ${convId}, status = ${enviado ? 'contatado' : 'pendente'} WHERE id = ${indId}`);
      try { const { espelharConversa } = await import('./ia-espelho'); await espelharConversa({ conversationId: convId || '', phone: tel, ia: texto, agente: 'indicacao', nota: `indicado por ${nomeIndicador}` }); } catch {}
    } catch (e: any) { console.error('[IA-INDICACAO] envio', e?.message || e); }

    return `OK: indicação registrada. ${nomeInd} (${tel}) entrou como lead${ind.seller_id ? ' na carteira do vendedor do cliente' : ''}, ganhou o cupom ${cupom || 'de ' + brl(valor)} e ${enviado ? 'JÁ RECEBEU a primeira mensagem da Honest' : 'será contatado pela equipe'}. Diga ao cliente que a indicação foi registrada e que os ${brl(valor)} de desconto dele são liberados assim que ${nomeInd} fizer o primeiro pedido — ele recebe o cupom por aqui. NÃO reescreva o cupom do indicado para o cliente.`;
  } catch (e: any) {
    console.error('[IA-INDICACAO]', e?.message || e);
    return 'Não consegui registrar a indicação agora (erro interno). Agradeça, anote o nome e o telefone na observação e avise que a equipe registra.';
  }
}

// Convite a indicar: 1x por mês por cliente. Devolve o texto de instrução para a IA (ou '').
export async function instrucaoConvite(customerId: string | null): Promise<string> {
  try {
    if (!customerId || (await getSetting('ia_indicacao_on', 'on')) !== 'on') return '';
    const k = 'ia_indicacao_convite:' + customerId;
    if ((await getSetting(k, '')) === mesBR()) return '';
    await setSetting(k, mesBR());
    const valor = Math.max(10, parseFloat(await getSetting('ia_indicacao_valor', '30')) || 30);
    return ` Depois de confirmar o pedido, CONVIDE o cliente a indicar (uma vez só, de forma leve): "Conhece outro comércio que gostaria de vender Honest? Me manda o nome e o WhatsApp — vocês dois ganham ${brl(valor)} de desconto no próximo pedido." Se ele mandar, chame registrar_indicacao.`;
  } catch { return ''; }
}

// Cron horário: indicado comprou (cupom resgatado em card concluído) -> recompensa o indicador.
export async function recompensarIndicadores(): Promise<{ recompensados: number }> {
  let n = 0;
  try {
    await ensureTabela();
    const r: any = await db.execute(sql`
      SELECT i.id, i.indicador_customer_id, i.indicador_nome, i.indicado_nome, i.cupom_indicado, cr.sales_card_id, cu.phone AS tel_indicador
      FROM ia_indicacoes i
      JOIN coupon_redemptions cr ON upper(cr.coupon_code) = upper(i.cupom_indicado)
      JOIN sales_cards sc ON sc.id = cr.sales_card_id AND COALESCE(sc.status,'') IN ('completed','invoiced','blocked')
      JOIN customers cu ON cu.id = i.indicador_customer_id
      WHERE i.status IN ('pendente','contatado','comprou') AND i.cupom_indicador IS NULL
      LIMIT 50`);
    const valor = Math.max(10, parseFloat(await getSetting('ia_indicacao_valor', '30')) || 30);
    const minimo = parseFloat(await getSetting('ia_indicacao_min_pedido', '80')) || null;
    for (const x of (r.rows || []) as any[]) {
      const cupom = await criarCupomFixo('INDICOU30', valor, `Recompensa de indicação: ${x.indicador_nome} indicou ${x.indicado_nome}`, 90, minimo);
      await db.execute(sql`UPDATE ia_indicacoes SET cupom_indicador = ${cupom}, status = 'recompensado', comprou_em = COALESCE(comprou_em, now()), recompensado_em = now() WHERE id = ${x.id}`);
      const tel = celular(x.tel_indicador);
      if (tel && cupom) {
        try {
          const canal = dig(await getSetting('ia_repescagem_canal', '5562992682630')) || '5562992682630';
          const { sendUmblerTalkText } = await import('./chat-routes');
          await sendUmblerTalkText(tel, `Boa notícia, ${x.indicador_nome}! 🎉 O ${x.indicado_nome}, que você indicou, fez o primeiro pedido na Honest. Seus *${brl(valor)} de desconto* estão liberados: cupom *${cupom}* para o seu próximo pedido (vale 90 dias). É só me dizer quando quiser repor que eu aplico. 🧡`);
        } catch {}
      }
      n++;
    }
    if (n) console.log(`[IA-INDICACAO] ${n} indicador(es) recompensado(s)`);
  } catch (e: any) { console.error('[IA-INDICACAO] recompensa', e?.message || e); }
  return { recompensados: n };
}

export function registerIaIndicacao(app: any) {
  const guard = (req: any) => !process.env.OFICIAL_ADMIN_KEY || req.query.k === process.env.OFICIAL_ADMIN_KEY;
  app.get('/api/admin/ia-indicacao', async (req: any, res: any) => {
    if (!guard(req)) return res.status(403).json({ error: 'forbidden' });
    try {
      await ensureTabela();
      if (String(req.query.run || '') === '1') await recompensarIndicadores();
      const r: any = await db.execute(sql`SELECT id, indicador_nome, indicado_nome, indicado_telefone, status, cupom_indicado, cupom_indicador, enviado_ok, criado_em FROM ia_indicacoes ORDER BY criado_em DESC LIMIT 100`);
      res.json({ ativo: await getSetting('ia_indicacao_on', 'on'), valor: await getSetting('ia_indicacao_valor', '30'), indicacoes: r.rows || [] });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  try { setTimeout(() => setInterval(() => { recompensarIndicadores().catch(() => {}); }, 60 * 60 * 1000), 5 * 60 * 1000); } catch {}
  console.log('[IA-INDICACAO] registrado (registrar_indicacao + recompensa horaria)');
}
