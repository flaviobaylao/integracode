// ============================================================================
// CENTRAL DE MARKETING — PUBLICADOR (mkt_publicador): a peca aprovada vai ao ar
// ----------------------------------------------------------------------------
// Ate aqui a peca aprovada chegava no WhatsApp e alguem postava na mao e
// respondia "POSTEI 31 <link>". Com o Instagram conectado (mkt-ig-auth) e a
// permissao instagram_business_content_publish, a Central publica sozinha:
//
//   foto(s) assinada(s) em /mkt/foto/:id?k=..&ig=1 (JPEG, proporcao valida)
//     -> POST {ig-user-id}/media            (container; carrossel se 2+ fotos)
//     -> POST {ig-user-id}/media_publish    (vai ao ar)
//     -> GET  {media-id}?fields=permalink   (link do post)
//     -> marcarPublicada(peca, {externalMediaId, permalink})  -> social_posts + uso do criativo
//
// Modos (system_settings.mkt_publicador_modo): off | test | on. Nasce em 'test':
// cria o container (a Meta valida a foto e a legenda) e PARA — nada vai ao ar.
// Em 'on' publica e avisa o aprovador no WhatsApp com o link. Se falhar, a peca
// segue pelo caminho antigo (entrega manual) com o motivo no aviso.
//
// So publica o que um humano aprovou. Peca 'agendado' sai na hora marcada.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_publicador';
export const MODOS = ['off', 'test', 'on'] as const;

export async function modo(): Promise<string> {
  try {
    const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key = 'mkt_publicador_modo' LIMIT 1"));
    const v = r.rows?.[0]?.value;
    return v ? String(v).replace(/^"|"$/g, '') : 'test';
  } catch { return 'test'; }
}
export async function definirModo(m: string, quem = 'mkt-publicador'): Promise<{ ok: boolean; erro?: string }> {
  if (!(MODOS as readonly string[]).includes(m)) return { ok: false, erro: 'modo inválido' };
  if (m !== 'off') {
    const { credenciais } = await import('./mkt-ig-auth');
    const c = await credenciais();
    if (!c.ok) return { ok: false, erro: 'Instagram não conectado — clique em Conectar Instagram antes de ligar o publicador' };
    if (c.origem === 'instagram_login' && !(c.permissoes || []).includes('instagram_business_content_publish')) return { ok: false, erro: 'o token conectado não tem instagram_business_content_publish — reconecte e marque Permitir' };
  }
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('mkt_publicador_modo', ${m}, ${quem}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
  return { ok: true };
}

async function graph(metodo: 'GET' | 'POST', caminho: string, params: Record<string, string>): Promise<{ ok: boolean; corpo: any; erro?: string; codigo?: number }> {
  const { credenciais } = await import('./mkt-ig-auth');
  const c = await credenciais();
  if (!c.ok) return { ok: false, corpo: null, erro: c.origem === 'nenhuma' ? 'Instagram não conectado' : 'token do Instagram vencido' };
  const qs = new URLSearchParams({ ...params, access_token: c.token }).toString();
  try {
    const r = metodo === 'GET'
      ? await fetch(c.base + '/' + caminho + '?' + qs)
      : await fetch(c.base + '/' + caminho, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) return { ok: false, corpo: j, erro: j?.error?.message || ('HTTP ' + r.status), codigo: j?.error?.code };
    return { ok: true, corpo: j };
  } catch (e: any) { return { ok: false, corpo: null, erro: String(e?.message || e) }; }
}

async function contaId(): Promise<string> {
  const { credenciais } = await import('./mkt-ig-auth');
  const c = await credenciais();
  return c.origem === 'instagram_login' ? 'me' : String(c.userId || 'me');
}

/** Espera o container ficar FINISHED (a Meta processa a imagem em segundos). */
async function esperarContainer(id: string, tentativas = 8): Promise<{ ok: boolean; status?: string; erro?: string }> {
  for (let i = 0; i < tentativas; i++) {
    const r = await graph('GET', id, { fields: 'status_code,status' });
    if (!r.ok) return { ok: false, erro: r.erro };
    const st = String(r.corpo?.status_code || '');
    if (st === 'FINISHED') return { ok: true, status: st };
    if (st === 'ERROR' || st === 'EXPIRED') return { ok: false, status: st, erro: String(r.corpo?.status || st) };
    await new Promise(res => setTimeout(res, 2500));
  }
  return { ok: false, erro: 'container não ficou pronto a tempo' };
}

function legendaDaPeca(p: any): string {
  let t = String(p.copy || '').trim();
  if (!t && p.titulo) t = String(p.titulo);
  return t.slice(0, 2200);
}

export type ResultadoPublicacao = { ok: boolean; modo: string; simulado?: boolean; mediaId?: string; permalink?: string; containerId?: string; erro?: string };

/** Publica UMA peca (aprovada/agendada). Em 'test' so cria o container. */
export async function publicarPeca(pecaId: string, opts: { quem?: string; forcarModo?: string } = {}): Promise<ResultadoPublicacao> {
  const m = opts.forcarModo || await modo();
  if (m === 'off') return { ok: false, modo: m, erro: 'publicador desligado' };
  const { verPeca, marcarPublicada } = await import('./mkt-esteira');
  const p: any = await verPeca(pecaId);
  if (!p) return { ok: false, modo: m, erro: 'peça não encontrada' };
  if (!['aprovado', 'agendado'].includes(String(p.estado))) return { ok: false, modo: m, erro: 'só peça aprovada/agendada vai ao ar (estado: ' + p.estado + ')' };
  if (String(p.canal || 'instagram') !== 'instagram') return { ok: false, modo: m, erro: 'publicador só cobre Instagram (canal ' + p.canal + ')' };
  const assets: number[] = (Array.isArray(p.asset_ids) ? p.asset_ids : []).map(Number).filter((n: number) => Number.isFinite(n)).slice(0, 10);
  if (!assets.length) return { ok: false, modo: m, erro: 'peça sem criativo — o Instagram exige foto' };

  const { urlFoto } = await import('./mkt-entrega');
  const conta = await contaId();
  const legenda = legendaDaPeca(p);
  const inicio = Date.now();

  let containerId = '';
  if (assets.length === 1) {
    const r = await graph('POST', conta + '/media', { image_url: urlFoto(assets[0]) + '&ig=1', caption: legenda });
    if (!r.ok) return await falha(p, m, 'container: ' + r.erro, inicio);
    containerId = String(r.corpo?.id || '');
  } else {
    const filhos: string[] = [];
    for (const a of assets) {
      const r = await graph('POST', conta + '/media', { image_url: urlFoto(a) + '&ig=1', is_carousel_item: 'true' });
      if (!r.ok) return await falha(p, m, 'item ' + a + ' do carrossel: ' + r.erro, inicio);
      filhos.push(String(r.corpo?.id || ''));
    }
    for (const f of filhos) { const w = await esperarContainer(f); if (!w.ok) return await falha(p, m, 'item do carrossel: ' + w.erro, inicio); }
    const r = await graph('POST', conta + '/media', { media_type: 'CAROUSEL', children: filhos.join(','), caption: legenda });
    if (!r.ok) return await falha(p, m, 'carrossel: ' + r.erro, inicio);
    containerId = String(r.corpo?.id || '');
  }
  const pronto = await esperarContainer(containerId);
  if (!pronto.ok) return await falha(p, m, 'processamento: ' + pronto.erro, inicio);

  if (m === 'test') {
    await registrar(p, { ok: true, simulado: true, containerId }, inicio);
    return { ok: true, modo: m, simulado: true, containerId };
  }

  const pub = await graph('POST', conta + '/media_publish', { creation_id: containerId });
  if (!pub.ok) return await falha(p, m, 'media_publish: ' + pub.erro, inicio);
  const mediaId = String(pub.corpo?.id || '');
  const link = await graph('GET', mediaId, { fields: 'permalink' });
  const permalink = link.ok ? String(link.corpo?.permalink || '') : '';

  const mv = await marcarPublicada(String(p.id), { externalMediaId: mediaId, permalink: permalink || null, quem: opts.quem || AGENTE });
  if (!mv.ok) console.warn('[MKT-PUBLICADOR] publicou mas nao marcou a peca:', mv.erro);
  await registrar(p, { ok: true, mediaId, permalink }, inicio);
  return { ok: true, modo: m, mediaId, permalink, containerId };
}

async function falha(p: any, m: string, erro: string, inicio: number): Promise<ResultadoPublicacao> {
  await registrar(p, { ok: false, erro }, inicio);
  return { ok: false, modo: m, erro };
}

async function registrar(p: any, r: any, inicio: number): Promise<void> {
  try {
    const { registrarRun } = await import('./mkt-agent-runs');
    await registrarRun({ agente: AGENTE, modelo: 'graph-api', provedor: 'meta', tokensIn: 0, tokensOut: 0, gatilho: 'cron', entradaRef: 'peca:' + p.id, sucesso: !!r.ok, erro: r.erro || (r.simulado ? 'simulado:' + r.containerId : null), duracaoMs: Date.now() - inicio } as any);
  } catch { /* registro nao pode derrubar a publicacao */ }
}

/**
 * Cron: publica o que venceu. `slotDiario` = true no horario da entrega (09:05):
 * ai as pecas 'aprovado' sem agendamento tambem saem. Fora dele, so as agendadas.
 */
export async function publicarVencidas(opts: { slotDiario?: boolean; quem?: string } = {}): Promise<{ modo: string; publicadas: number; simuladas: number; falhas: { numero: number; erro: string }[] }> {
  const m = await modo();
  const out = { modo: m, publicadas: 0, simuladas: 0, falhas: [] as { numero: number; erro: string }[] };
  if (m === 'off') return out;
  const r: any = await db.execute(sql`
    SELECT id, numero, titulo FROM mkt_pieces
     WHERE canal = 'instagram' AND entregue_em IS NULL
       AND ( (estado = 'agendado' AND agendado_para IS NOT NULL AND agendado_para <= now())
             ${opts.slotDiario ? sql`OR (estado = 'aprovado' AND agendado_para IS NULL)` : sql``} )
     ORDER BY COALESCE(agendado_para, criado_em) ASC LIMIT 5`);
  const pecas: any[] = r.rows || [];
  if (!pecas.length) return out;
  const { aprovadores } = await import('./mkt-acoes');
  const tels = await aprovadores();
  const { enviarInterno } = await import('./envio-texto');
  for (const p of pecas) {
    const res = await publicarPeca(String(p.id), { quem: opts.quem || 'cron' });
    if (res.ok && res.simulado) {
      out.simuladas++;
      // Em teste a peca continua indo pelo caminho manual (entregarAprovadas) — so registramos que a Meta aceitou.
      console.log('[MKT-PUBLICADOR] teste: peca #' + p.numero + ' aceita pela Meta (container ' + res.containerId + '), nada foi ao ar');
    } else if (res.ok) {
      out.publicadas++;
      await db.execute(sql`UPDATE mkt_pieces SET entregue_em = now() WHERE id = ${p.id}`);
      const txt = '📣 *Peça #' + p.numero + ' publicada no Instagram*' + (p.titulo ? ' · ' + p.titulo : '') + (res.permalink ? '\n' + res.permalink : '') + '\nOs números entram na medição em 24h.';
      for (const t of tels) { try { await enviarInterno(t, txt); } catch {} }
    } else {
      out.falhas.push({ numero: Number(p.numero), erro: String(res.erro) });
      // Falhou: a peca segue para a entrega manual (entregarAprovadas pega 'aprovado' sem entregue_em) com o motivo.
      const txt = '⚠️ Peça #' + p.numero + ': não consegui publicar sozinho (' + String(res.erro).slice(0, 200) + '). Ela chega para você postar na mão.';
      for (const t of tels) { try { await enviarInterno(t, txt); } catch {} }
    }
  }
  if (out.publicadas || out.falhas.length || out.simuladas) console.log('[MKT-PUBLICADOR] ' + out.publicadas + ' publicada(s), ' + out.simuladas + ' simulada(s), ' + out.falhas.length + ' falha(s)');
  return out;
}

export async function panorama(): Promise<any> {
  const { status } = await import('./mkt-ig-auth');
  const st = await status();
  const fila: any = await db.execute(sql.raw(`SELECT COUNT(*) FILTER (WHERE estado = 'aprovado')::int AS aprovadas, COUNT(*) FILTER (WHERE estado = 'agendado')::int AS agendadas,
    COUNT(*) FILTER (WHERE estado = 'publicado' AND publicado_em >= now() - interval '30 days')::int AS publicadas30 FROM mkt_pieces WHERE canal = 'instagram'`));
  const runs: any = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE sucesso)::int AS ok, MAX(criado_em) AS ultimo FROM mkt_agent_runs WHERE agente = '${AGENTE}' AND criado_em >= now() - interval '30 days'`));
  return { modo: await modo(), instagram: st, fila: fila.rows?.[0] || {}, runs30d: runs.rows?.[0] || {} };
}
