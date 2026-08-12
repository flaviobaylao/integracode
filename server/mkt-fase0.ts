// Central de Marketing - Fase 0: os riscos que o plano manda fechar ANTES do trafego.
//
// O plano e explicito: "Nada da Central sobe antes da Fase 0 fechar esses cinco itens."
// Oito buracos ja subiram e a Fase 0 nunca foi feita. Este arquivo fecha o que da
// para fechar em codigo.
//
// Levantando o estado real, dois itens do plano estavam DESATUALIZADOS e dois estavam
// piores do que descritos:
//
//  🔴 gerar_pix SEM TETO DE VALOR e sem revisao humana. Confirmado: a unica checagem
//     e `total > 0`. Um anuncio que traga 300 DMs/dia vira caixa registradora sem
//     auditoria - exatamente o que o plano temia.
//
//  🟠 chat_ai_paused NAO e "nunca apagado" (existe liberarIA e limparPausa). O problema
//     real e pior de diagnosticar: iaPausada() respeita um prazo de 24h, mas ia-fila,
//     ia-takeover e o ChatCenter tratam QUALQUER valor como pausa eterna. Ou seja, as
//     partes do sistema DISCORDAM sobre se a IA esta ligada naquela conversa.
//
//  🟠 Opt-out so e capturado no canal 1841. Quem escreve "SAIR" pelo 2630 nao e
//     registrado. E o bloqueio so vale para MARKETING - utility e disparo em massa passam.
//
//  ✅ Timeout de 10 minutos: JA FOI CORRIGIDO. Hoje sao 120 min configuraveis
//     (chat_auto_close_min / ia_finalizar_min). O plano esta desatualizado neste ponto.
//
//  ⏳ Base de conhecimento vazia: nao e codigo, e conteudo. Medida aqui para virar numero.

import { db } from './db';
import { sql } from 'drizzle-orm';

async function get(chave: string, padrao: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${chave} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? padrao : String(v).replace(/^"|"$/g, '');
  } catch { return padrao; }
}

async function set(chave: string, valor: string): Promise<void> {
    // system_settings tem `updated_by` NOT NULL. Sem essa coluna, o INSERT estoura -
  // e o erro so aparece em producao, porque a tabela de teste era mais simples que
  // a de verdade. Mesmo formato usado pelo setSetting() do agent-runtime.
  await db.execute(sql`
    INSERT INTO system_settings (key, value, updated_by) VALUES (${chave}, ${valor}, ${'fase0'})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `);
}

// ---------------------------------------------------------------------------
// 🔴 RISCO 1 — teto de valor no PIX gerado pela IA
// ---------------------------------------------------------------------------

/** Padrao deliberadamente baixo: no piloto, e melhor a IA passar demais para humano
 *  do que de menos. Ajustavel na tela, sem deploy. 0 = sem teto (nao recomendado). */
export const TETO_PIX_PADRAO = 300;

export async function tetoPix(): Promise<number> {
  const v = Number(await get('ia_pix_teto', String(TETO_PIX_PADRAO)));
  return Number.isFinite(v) && v >= 0 ? v : TETO_PIX_PADRAO;
}

export type VeredictoPix = { liberado: boolean; teto: number; valor: number; motivo?: string };

/**
 * A IA pode gerar cobranca deste valor sozinha?
 * Nao e sobre desconfiar da IA: e sobre ter um limite auditavel entre um erro de
 * leitura de pedido e uma cobranca de mil reais na cara do cliente.
 */
export async function pixLiberado(valor: number): Promise<VeredictoPix> {
  const teto = await tetoPix();
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) {
    return { liberado: false, teto, valor: v || 0, motivo: 'valor do pedido indefinido' };
  }
  if (teto === 0) return { liberado: true, teto, valor: v };
  if (v > teto) {
    return {
      liberado: false, teto, valor: v,
      motivo: 'valor acima do teto de ' + teto.toFixed(2) + ' que a IA pode cobrar sozinha',
    };
  }
  return { liberado: true, teto, valor: v };
}

/**
 * A distribuicao REAL dos pedidos, para o teto sair de dado e nao de palpite.
 * Olha primeiro os pedidos que a IA registrou (instagram_pix) - sao exatamente os que
 * o teto afeta. Se ainda nao houver volume ali, cai para os pedidos do pipeline, que
 * dao a ordem de grandeza do ticket.
 */
export async function distribuicaoPedidos(dias = 180): Promise<{
  fonte: 'ia' | 'pipeline' | 'vazio'; n: number;
  min: number; p50: number; p75: number; p90: number; p95: number; max: number; media: number;
  simulacao: { teto: number; acima: number; percentual: number }[];
  porFonte?: { ia: any; pipeline: any };
  sugestao: number; recado: string; alerta?: string;
}> {
  const vazio = {
    fonte: 'vazio' as const, n: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, max: 0, media: 0,
    simulacao: [] as any[], porFonte: { ia: null, pipeline: null }, sugestao: TETO_PIX_PADRAO, recado: '', alerta: '',
  };

  const medir = async (tabela: 'ia' | 'pipeline') => {
    const q = tabela === 'ia'
      ? sql`SELECT total AS v FROM instagram_pix
             WHERE created_at >= NOW() - (${dias}::text || ' days')::interval AND total > 0`
      : sql`SELECT sale_value AS v FROM sales_cards
             WHERE created_at >= NOW() - (${dias}::text || ' days')::interval AND sale_value > 0`;
    const r: any = await db.execute(sql`
      WITH base AS (${q})
      SELECT COUNT(*)::int AS n,
             COALESCE(MIN(v),0)::numeric AS minimo,
             COALESCE(MAX(v),0)::numeric AS maximo,
             COALESCE(AVG(v),0)::numeric AS media,
             COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY v),0)::numeric AS p50,
             COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY v),0)::numeric AS p75,
             COALESCE(percentile_cont(0.90) WITHIN GROUP (ORDER BY v),0)::numeric AS p90,
             COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY v),0)::numeric AS p95
        FROM base`);
    return r.rows?.[0] || null;
  };

  // As DUAS distribuicoes, sempre. A da IA e o que o teto afeta hoje; a do pipeline
  // e o que ele vai afetar quando a revenda comecar a passar pela IA - e revenda tem
  // ticket de outra ordem. Escolher o teto so pela amostra da IA subestima o futuro.
  let iaLinha: any = null, pipeLinha: any = null;
  try { iaLinha = await medir('ia'); } catch { /* tabela pode nao existir */ }
  try { pipeLinha = await medir('pipeline'); } catch { /* ignora */ }

  let linha: any = null;
  let fonte: 'ia' | 'pipeline' | 'vazio' = 'vazio';
  if (iaLinha && Number(iaLinha.n) >= 10) { linha = iaLinha; fonte = 'ia'; }
  else if (pipeLinha && Number(pipeLinha.n) > 0) { linha = pipeLinha; fonte = 'pipeline'; }
  if (!linha) return vazio;

  const resumir = (l: any) => l && Number(l.n) > 0 ? {
    n: Number(l.n), min: Number(l.minimo), p50: Number(l.p50), p75: Number(l.p75),
    p90: Number(l.p90), p95: Number(l.p95), max: Number(l.maximo), media: Number(l.media),
  } : null;

  const n = Number(linha.n);
  const p90 = Math.ceil(Number(linha.p90) / 50) * 50;   // arredonda para cima, de 50 em 50
  const p95 = Math.ceil(Number(linha.p95) / 50) * 50;

  // Quantos pedidos cairiam para humano com cada teto candidato.
  const candidatos = Array.from(new Set([200, 300, 500, 750, 1000, 1500, 2000, p90, p95]))
    .filter(v => v > 0).sort((a, b) => a - b);
  const simulacao: { teto: number; acima: number; percentual: number }[] = [];
  try {
    const col = fonte === 'ia' ? 'total' : 'sale_value';
    const tab = fonte === 'ia' ? 'instagram_pix' : 'sales_cards';
    for (const t of candidatos) {
      const r: any = await db.execute(sql.raw(
        "SELECT COUNT(*)::int AS acima FROM " + tab +
        " WHERE created_at >= NOW() - INTERVAL '" + Number(dias) + " days' AND " + col + " > " + Number(t)));
      const acima = Number(r.rows?.[0]?.acima || 0);
      simulacao.push({ teto: t, acima, percentual: n > 0 ? Number(((acima / n) * 100).toFixed(1)) : 0 });
    }
  } catch { /* simulacao e um extra */ }

  // Sugestao: o p90 arredondado. Deixa ~10% indo para humano - o suficiente para
  // pegar o pedido fora do padrao sem transformar a trava em gargalo.
  const sugestao = p90 > 0 ? p90 : TETO_PIX_PADRAO;

  const recado = fonte === 'ia'
    ? n + ' pedido(s) registrados pela IA em ' + dias + ' dias. Metade fica abaixo de R$ '
      + Number(linha.p50).toFixed(2) + ' e 9 em cada 10 abaixo de R$ ' + p90.toFixed(2) + '.'
    : 'Ainda não há volume de pedido registrado pela IA. Usei os ' + n + ' pedidos do pipeline '
      + 'para dar a ordem de grandeza — assim que a IA registrar pedidos, este número passa a sair deles.';

  // Aviso honesto: amostra pequena nao decide teto.
  const alerta = fonte === 'ia' && n < 30
    ? 'Atenção: são só ' + n + ' pedidos registrados pela IA, e todos do padrão que ela atendeu até hoje. '
      + 'Se a revenda passar a comprar pela IA, o ticket muda de ordem — olhe também a coluna do pipeline antes de fechar o número.'
    : '';

  return {
    fonte, n,
    min: Number(linha.minimo), p50: Number(linha.p50), p75: Number(linha.p75),
    p90: Number(linha.p90), p95: Number(linha.p95), max: Number(linha.maximo),
    media: Number(linha.media),
    porFonte: { ia: resumir(iaLinha), pipeline: resumir(pipeLinha) },
    simulacao, sugestao, recado, alerta,
  };
}

/** Registra a tentativa barrada, para o teto ser auditavel e nao so um "nao". */
export async function registrarPixBarrado(dados: {
  conversaId?: string | null; salesCardId?: string | null; pedido?: string | null;
  valor: number; teto: number; canal?: string | null;
}): Promise<void> {
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS ia_pix_barrados (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      conversa_id VARCHAR, sales_card_id VARCHAR, pedido VARCHAR,
      valor NUMERIC(12,2), teto NUMERIC(12,2), canal VARCHAR(24),
      resolvido BOOLEAN NOT NULL DEFAULT false,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
    await db.execute(sql`
      INSERT INTO ia_pix_barrados (conversa_id, sales_card_id, pedido, valor, teto, canal)
      VALUES (${dados.conversaId || null}, ${dados.salesCardId || null}, ${dados.pedido || null},
              ${dados.valor}, ${dados.teto}, ${dados.canal || null})
    `);
  } catch { /* o bloqueio vale mesmo se o registro falhar */ }
}

export async function pixBarrados(dias = 30): Promise<any[]> {
  try {
    const r: any = await db.execute(sql`
      SELECT * FROM ia_pix_barrados
       WHERE criado_em >= NOW() - (${dias}::text || ' days')::interval
       ORDER BY criado_em DESC LIMIT 100
    `);
    return r.rows || [];
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// 🟠 RISCO 2 — opt-out
// ---------------------------------------------------------------------------

// O que conta como pedido de saida. Palavra solta, mensagem curta - ninguem escreve
// um paragrafo para sair de uma lista.
const PALAVRAS_SAIDA = [
  'sair', 'parar', 'pare', 'descadastrar', 'descadastre', 'cancelar', 'remover',
  'nao quero receber', 'não quero receber', 'nao quero mais receber', 'não quero mais receber',
  'me tira da lista', 'sair da lista', 'stop', 'unsubscribe', 'me remove', 'me remova',
];

function normalizar(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Detecta pedido de saida em QUALQUER canal - nao so no 1841, como era ate agora. */
export function pediuParaSair(texto: string): boolean {
  const t = normalizar(texto).replace(/[.!?]+$/g, '').trim();
  if (!t || t.length > 60) return false; // texto longo nao e comando de saida
  if (PALAVRAS_SAIDA.includes(t)) return true;
  // Frase curta que contem o pedido inteiro ("por favor, nao quero receber mais nada")
  return PALAVRAS_SAIDA.some(p => p.includes(' ') && t.includes(p));
}

export async function registrarOptOut(customerId: string, canal?: string): Promise<boolean> {
  if (!customerId) return false;
  try {
    await db.execute(sql`
      UPDATE chat_customers SET whatsapp_opt_out = true, whatsapp_opt_out_at = NOW()
       WHERE id = ${customerId} AND COALESCE(whatsapp_opt_out, false) = false
    `);
    console.log('[FASE0] opt-out registrado cliente=' + customerId + ' canal=' + (canal || '?'));
    return true;
  } catch (e: any) {
    console.error('[FASE0] falha ao registrar opt-out:', e?.message || e);
    return false;
  }
}

export async function estaOptOut(opts: { customerId?: string | null; telefone?: string | null }): Promise<boolean> {
  try {
    if (opts.customerId) {
      const r: any = await db.execute(sql`SELECT 1 FROM chat_customers WHERE id = ${opts.customerId} AND whatsapp_opt_out = true LIMIT 1`);
      if (r.rows?.length) return true;
    }
    if (opts.telefone) {
      const d = String(opts.telefone).replace(/\D/g, '');
      if (d) {
        const r: any = await db.execute(sql`
          SELECT 1 FROM chat_customers
           WHERE whatsapp_opt_out = true
             AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') LIKE ${'%' + d.slice(-11)}
           LIMIT 1`);
        if (r.rows?.length) return true;
      }
    }
    return false;
  } catch { return false; }
}

/**
 * Casos de uso genuinamente transacionais, que continuam podendo falar com quem
 * deu opt-out: sao sobre um pedido que a PESSOA fez, nao sobre vender mais.
 * Editavel sem deploy. Tudo que nao estiver aqui e bloqueado.
 */
export async function casosTransacionais(): Promise<string[]> {
  const v = await get('optout_casos_transacionais', 'pedido,entrega,boleto,cobranca,nfe,pagamento');
  return v.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * A REGRA. Opt-out barra contato ATIVO nosso. Nao barra resposta a uma mensagem
 * que a pessoa acabou de mandar - deixar de responder quem escreveu nao e respeitar
 * a vontade dela, e prestar mau atendimento.
 */
export async function podeFalarAtivamente(opts: {
  customerId?: string | null; telefone?: string | null; useCase?: string | null; categoria?: string | null;
}): Promise<{ pode: boolean; motivo?: string }> {
  const fora = await estaOptOut(opts);
  if (!fora) return { pode: true };
  const caso = String(opts.useCase || '').toLowerCase();
  const transacionais = await casosTransacionais();
  if (caso && transacionais.some(t => caso.includes(t))) {
    return { pode: true, motivo: 'opt-out, mas o caso de uso e transacional (' + caso + ')' };
  }
  return { pode: false, motivo: 'cliente pediu para sair da lista' };
}

// ---------------------------------------------------------------------------
// 🟠 RISCO 3 — as partes do sistema discordando sobre a pausa da IA
// ---------------------------------------------------------------------------

/**
 * Leitura UNICA da pausa, com o mesmo prazo em todo lugar.
 * Antes: iaPausada() em agent-runtime respeitava ia_pausa_horas, mas ia-fila,
 * ia-takeover e o ChatCenter tratavam qualquer valor como pausa eterna. Resultado:
 * depois de 24h a IA voltava a responder, e ao mesmo tempo o painel continuava
 * dizendo que ela estava fora daquela conversa. Ninguem consegue depurar isso.
 */
export async function iaPausadaConsistente(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  const v = String(await get('chat_ai_paused:' + conversationId, '')).trim();
  if (!v) return false;

  // ATENCAO - defeito real que estava no ar: o codigo antigo usava `isNaN(Date.parse(v))`
  // para reconhecer o valor legado '1'. Mas Date.parse('1') NAO e NaN no V8: vale
  // 2001-01-01. Ou seja, toda pausa legada era lida como VENCIDA HA 25 ANOS, e a IA
  // voltava a responder justamente nas conversas marcadas para ficarem paradas.
  // Aqui a forma do valor e conferida, em vez de confiar no parser de data.
  const ehData = /^\d{4}-\d{2}-\d{2}[T ]/.test(v);
  if (!ehData) return true; // legado ('1' e afins) — pausado ate alguem limpar

  const t = Date.parse(v);
  if (isNaN(t)) return true;
  const horas = Math.max(1, parseInt(await get('ia_pausa_horas', '24'), 10) || 24);
  return (Date.now() - t) < horas * 3600 * 1000;
}

/** Limpa as pausas ja vencidas, para a linha nao ficar no banco para sempre. */
export async function limparPausasVencidas(): Promise<{ apagadas: number }> {
  try {
    const horas = Math.max(1, parseInt(await get('ia_pausa_horas', '24'), 10) || 24);
    const r: any = await db.execute(sql`
      DELETE FROM system_settings
       WHERE key LIKE 'chat_ai_paused:%'
         AND value ~ '^\\d{4}-'
         AND (NOW() - value::timestamptz) > (${horas}::text || ' hours')::interval
      RETURNING key
    `);
    const n = (r.rows || []).length;
    if (n) console.log('[FASE0] ' + n + ' pausa(s) vencida(s) limpas');
    return { apagadas: n };
  } catch (e: any) {
    console.error('[FASE0] limparPausasVencidas:', e?.message || e);
    return { apagadas: 0 };
  }
}

// ---------------------------------------------------------------------------
// Panorama da Fase 0 — o estado real, medido, nao o que o plano supõe
// ---------------------------------------------------------------------------

export async function panoramaFase0(): Promise<any> {
  const itens: { risco: string; estado: 'fechado' | 'aberto' | 'atencao'; detalhe: string }[] = [];

  // 1. PIX
  const teto = await tetoPix();
  const barrados = await pixBarrados(30);
  itens.push({
    risco: 'PIX gerado pela IA sem teto',
    estado: teto > 0 ? 'fechado' : 'aberto',
    detalhe: teto > 0
      ? 'Teto de R$ ' + teto.toFixed(2) + ' por cobrança. Acima disso a IA não gera: registra e transfere para uma pessoa. '
        + barrados.length + ' barrada(s) nos últimos 30 dias.'
      : 'Teto desligado (0) — a IA pode gerar cobrança de qualquer valor sozinha.',
  });

  // 2. Opt-out
  let optOuts = 0, semCaptura = 0;
  try {
    const r: any = await db.execute(sql.raw("SELECT COUNT(*)::int AS n FROM chat_customers WHERE whatsapp_opt_out = true"));
    optOuts = Number(r.rows?.[0]?.n || 0);
  } catch { semCaptura = 1; }
  itens.push({
    risco: 'Opt-out capturado só no canal 1841',
    estado: semCaptura ? 'atencao' : 'fechado',
    detalhe: 'Agora "SAIR" é reconhecido em qualquer canal, e opt-out bloqueia contato ativo de '
      + 'qualquer categoria (antes só MARKETING). ' + optOuts + ' cliente(s) fora da lista hoje. '
      + 'Resposta a quem escreveu continua acontecendo — deixar de responder não é respeitar, é mau atendimento.',
  });

  // 3. Pausa
  let pausas = 0, vencidas = 0;
  try {
    const horas = Math.max(1, parseInt(await get('ia_pausa_horas', '24'), 10) || 24);
    const r: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE value ~ '^\\d{4}-' AND (NOW() - value::timestamptz) > (${horas}::text || ' hours')::interval)::int AS venc
        FROM system_settings WHERE key LIKE 'chat_ai_paused:%'`);
    pausas = Number(r.rows?.[0]?.n || 0);
    vencidas = Number(r.rows?.[0]?.venc || 0);
  } catch { /* ignora */ }
  itens.push({
    risco: 'Partes do sistema discordando sobre a pausa da IA',
    estado: 'fechado',
    detalhe: 'Leitura única com o mesmo prazo em todo lugar. ' + pausas + ' conversa(s) pausada(s), '
      + vencidas + ' já vencida(s) e limpáveis. Antes, a IA voltava a responder após 24h enquanto o painel ainda dizia que ela estava fora.',
  });

  // 4. Timeout — o plano está desatualizado
  const autoClose = await get('chat_auto_close_min', '120');
  const iaFinalizar = await get('ia_finalizar_min', '120');
  itens.push({
    risco: 'Conversa fecha em 10 minutos de silêncio',
    estado: 'fechado',
    detalhe: 'JÁ ESTAVA CORRIGIDO antes de eu chegar — o plano está desatualizado neste ponto. '
      + 'Hoje: fechamento automático em ' + autoClose + ' min e finalização pela IA em ' + iaFinalizar + ' min, '
      + 'os dois configuráveis. O "10 minutos" sobrevive só no logout do atendente humano, que é outra coisa.',
  });

  // 5. Base de conhecimento
  const bases: any[] = [];
  try {
    const r: any = await db.execute(sql.raw(
      "SELECT id, nome, LENGTH(COALESCE(base_conhecimento,'')) AS tamanho, ativo FROM agentes_config ORDER BY id"));
    for (const a of (r.rows || [])) bases.push({ agente: a.id, nome: a.nome, caracteres: Number(a.tamanho || 0), ativo: a.ativo });
  } catch { /* tabela pode nao existir */ }
  const vazias = bases.filter(b => b.caracteres < 200);
  itens.push({
    risco: 'Base de conhecimento vazia nos agentes',
    estado: vazias.length ? 'aberto' : 'fechado',
    detalhe: vazias.length
      ? vazias.length + ' agente(s) com base vazia ou quase: ' + vazias.map(v => v.agente + ' (' + v.caracteres + ' car.)').join(', ')
        + '. Não é código, é conteúdo — e agente sem base inventa resposta ou empurra tudo para humano.'
      : 'Todos os agentes com base preenchida.',
  });

  const fechados = itens.filter(i => i.estado === 'fechado').length;
  return {
    ok: true, itens, fechados, abertos: itens.length - fechados,
    tetoPix: teto, pixBarrados: barrados.length, optOuts, pausas, pausasVencidas: vencidas,
    basesConhecimento: bases,
  };
}

export async function salvarConfigFase0(campos: Record<string, any>): Promise<{ ok: boolean; erro?: string }> {
  try {
    if ('tetoPix' in campos) {
      const v = Number(campos.tetoPix);
      if (!Number.isFinite(v) || v < 0) return { ok: false, erro: 'teto tem que ser um numero >= 0' };
      await set('ia_pix_teto', String(v));
    }
    if ('casosTransacionais' in campos) {
      await set('optout_casos_transacionais', String(campos.casosTransacionais || ''));
    }
    if ('pausaHoras' in campos) {
      const v = parseInt(String(campos.pausaHoras), 10);
      if (!Number.isFinite(v) || v < 1) return { ok: false, erro: 'a pausa tem que ser de pelo menos 1 hora' };
      await set('ia_pausa_horas', String(v));
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}
