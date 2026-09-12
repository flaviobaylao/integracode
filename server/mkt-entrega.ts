// ============================================================================
// CENTRAL DE MARKETING — ENTREGA DA PECA APROVADA NO WHATSAPP (sem publicador)
// ----------------------------------------------------------------------------
// Enquanto o App Review da Meta (instagram_content_publish) nao sai, a peca
// aprovada morria em 'aprovado' ate alguem lembrar de abrir /marketing, copiar a
// legenda, baixar a foto e postar. Agora, as 09:00, cada peca aprovada e ainda
// nao entregue chega PRONTA no WhatsApp do gestor: legenda + link da foto em
// tamanho original + o numero curto. Ele posta no celular e responde
//   POSTEI 31 https://www.instagram.com/p/...
// e a peca vira 'publicado' com o permalink (que alimenta a serie de metricas).
//
// A foto sai por rota publica ASSINADA (/mkt/foto/:id?k=hmac) — sem login no
// celular, sem expor o acervo inteiro: so quem tem o link daquela foto abre.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';
import { createHmac } from 'crypto';

const APP_URL = process.env.APP_URL || 'https://integracode-production.up.railway.app';

function segredo(): string {
  return process.env.MKT_FOTO_KEY || process.env.MKT_PULSO_KEY || process.env.SESSION_SECRET || 'integra-mkt-foto';
}
export function assinarFoto(id: number): string {
  return createHmac('sha256', segredo()).update('foto:' + id).digest('hex').slice(0, 24);
}
export function fotoConfere(id: number, k: string): boolean {
  return !!k && assinarFoto(id) === String(k);
}
export function urlFoto(id: number): string {
  return APP_URL.replace(/\/+$/, '') + '/mkt/foto/' + id + '?k=' + assinarFoto(id);
}

/** Texto de uma peca pronta para postar. */
export function textoDaPeca(p: any): string {
  const linhas: string[] = [];
  linhas.push('📝 *Peça #' + p.numero + ' pronta para postar* · ' + String(p.canal || 'instagram') + (p.gancho ? ' · ' + p.gancho : ''));
  if (p.titulo) linhas.push(String(p.titulo));
  linhas.push('');
  linhas.push(String(p.copy || ''));
  const assets: any[] = Array.isArray(p.asset_ids) ? p.asset_ids : [];
  if (assets.length) {
    linhas.push('');
    linhas.push('📷 Foto' + (assets.length > 1 ? 's' : '') + ':');
    for (const a of assets.slice(0, 4)) linhas.push(urlFoto(Number(a)));
  }
  const vars: string[] = Array.isArray(p.variacoes) ? p.variacoes : [];
  if (vars.length) {
    linhas.push('');
    linhas.push('Outras primeiras linhas, se preferir:');
    for (const v of vars) linhas.push('• ' + v);
  }
  linhas.push('');
  linhas.push('Depois de postar, responda: *POSTEI ' + p.numero + ' <link do post>*');
  return linhas.join('\n');
}

/** Entrega as pecas aprovadas/agendadas (vencidas) ainda nao entregues. */
export async function entregarAprovadas(opts: { forcar?: boolean } = {}): Promise<{ entregues: number; falhas: number; semAprovador?: boolean }> {
  const { ensureMktEsteiraSchema } = await import('./mkt-esteira');
  await ensureMktEsteiraSchema();
  try { await db.execute(sql.raw("ALTER TABLE mkt_pieces ADD COLUMN IF NOT EXISTS entregue_em timestamptz")); await db.execute(sql.raw("ALTER TABLE mkt_pieces ADD COLUMN IF NOT EXISTS numero serial")); await db.execute(sql.raw("ALTER TABLE mkt_pieces ADD COLUMN IF NOT EXISTS variacoes jsonb NOT NULL DEFAULT '[]'::jsonb")); } catch {}
  const r: any = await db.execute(sql`
    SELECT * FROM mkt_pieces
     WHERE (estado = 'aprovado' OR (estado = 'agendado' AND agendado_para IS NOT NULL AND agendado_para <= now() + interval '2 hours'))
       AND (entregue_em IS NULL ${opts.forcar ? sql`OR true` : sql``})
     ORDER BY criado_em ASC LIMIT 10`);
  const pecas: any[] = r.rows || [];
  if (!pecas.length) return { entregues: 0, falhas: 0 };
  const { aprovadores } = await import('./mkt-acoes');
  const tels = await aprovadores();
  if (!tels.length) { console.warn('[MKT-ENTREGA] nenhum aprovador cadastrado — pecas aprovadas nao entregues'); return { entregues: 0, falhas: pecas.length, semAprovador: true }; }
  const { enviarInterno } = await import('./envio-texto');
  let entregues = 0, falhas = 0;
  for (const p of pecas) {
    const texto = textoDaPeca(p).slice(0, 3900);
    let ok = false;
    for (const t of tels) { const e = await enviarInterno(t, texto); ok = ok || !!e.success; }
    if (ok) { entregues++; await db.execute(sql`UPDATE mkt_pieces SET entregue_em = now() WHERE id = ${p.id}`); }
    else falhas++;
  }
  return { entregues, falhas };
}

/** "POSTEI 31 https://instagram.com/p/xyz" → marca publicada. Devolve resposta ou null. */
export async function responderPostei(telefone: string, texto: string): Promise<string | null> {
  const m = String(texto || '').trim().match(/^(postei|publiquei|publicad[oa]|no ar)\s+#?(\d+)\s*(https?:\/\/\S+)?/i);
  if (!m) return null;
  const { aprovadores, ehAprovador } = await import('./mkt-acoes');
  if (!ehAprovador(telefone, await aprovadores())) return null;
  const numero = Number(m[2]);
  const permalink = m[3] || null;
  const p: any = (await db.execute(sql`SELECT id, estado, titulo FROM mkt_pieces WHERE numero = ${numero} LIMIT 1`) as any).rows?.[0];
  if (!p) return 'Não achei a peça #' + numero + '.';
  const { marcarPublicada } = await import('./mkt-esteira');
  const r = await marcarPublicada(String(p.id), { permalink, quem: 'whatsapp:' + String(telefone).replace(/\D/g, '') });
  if (!r.ok) return 'Peça #' + numero + ': ' + (r.erro || 'não deu');
  return '✅ Peça #' + numero + ' marcada como publicada' + (permalink ? ' com o link' : ' (sem link — mande "POSTEI ' + numero + ' <link>" para eu guardar o permalink)') + '. ' + (r.usosRegistrados || 0) + ' criativo(s) passam a contar no desempenho.';
}

export function registerMktEntrega(app: any) {
  // Foto assinada: sem login, so com o hash daquele id.
  app.get('/mkt/foto/:id', async (req: any, res: any) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || !fotoConfere(id, String(req.query.k || ''))) return res.status(404).end();
      const { arquivoDoAsset } = await import('./mkt-assets');
      const a = await arquivoDoAsset(id);
      if (!a) return res.status(404).end();
      res.setHeader('Content-Type', a.mime || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.end(a.buf);
    } catch { res.status(500).end(); }
  });
}
