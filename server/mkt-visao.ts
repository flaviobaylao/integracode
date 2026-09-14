// ============================================================================
// CENTRAL DE MARKETING — VISAO (agente mkt_visao): tags de criativo por imagem
// ----------------------------------------------------------------------------
// Ate aqui as tags de um criativo (gancho, cenario, publico, produto) eram
// digitadas ou adivinhadas por regex do nome do produto. Sem tag nao ha peca:
// o agente de conteudo so escolhe foto com gancho + publico. Este agente olha a
// foto (Haiku, visao) e SUGERE as tags no vocabulario controlado de mkt-assets,
// descreve a cena (o revisor usa para conferir se a copy descreve a foto) e
// avisa se ha pessoa/rosto (direito de imagem).
//
// Regras:
//   - so preenche o que estava VAZIO; tag digitada por humano nunca e sobrescrita
//   - nunca mexe em direitos_ok: se detecta pessoa, escreve na observacao
//   - fire-and-forget no cadastro; tambem roda em lote (crons/rota) para o acervo
//   - modo: system_settings mkt_visao_modo (off|on; padrao on se houver chave)
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_visao';

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}
export async function modo(): Promise<'off' | 'on'> {
  const m = await getSetting('mkt_visao_modo', process.env.ANTHROPIC_API_KEY ? 'on' : 'off');
  return m === 'off' ? 'off' : 'on';
}

export async function classificarAsset(id: number): Promise<{ ok: boolean; tags?: any; descricao?: string; pessoa?: boolean; erro?: string }> {
  if ((await modo()) === 'off') return { ok: false, erro: 'visao desligada' };
  const { verAsset, arquivoDoAsset, GANCHOS, CENARIOS, PUBLICOS } = await import('./mkt-assets');
  const a = await verAsset(id);
  if (!a) return { ok: false, erro: 'criativo nao encontrado' };
  const arq = await arquivoDoAsset(id);
  if (!arq || !arq.buf?.length) return { ok: false, erro: 'sem arquivo' };
  if (arq.buf.length > 4.5 * 1024 * 1024) return { ok: false, erro: 'imagem acima de 4,5 MB' };
  const mime = /^image\/(jpeg|png|webp|gif)$/.test(arq.mime) ? arq.mime : 'image/jpeg';

  const { chamarAgente } = await import('./mkt-llm');
  const r = await chamarAgente({
    agente: AGENTE, nome: 'Visao de Criativos', modeloPadrao: 'claude-haiku-4-5', tetoPadrao: 1,
    promptPadrao: 'Você classifica fotos para o marketing da Honest Sucos Naturais (sucos naturais em garrafa, vendidos a padarias/mercados e ao consumidor). Responda somente JSON.',
    user: 'Classifique esta foto. Vocabulário permitido — gancho: ' + (GANCHOS as readonly string[]).join(', ') + ' · cenario: ' + (CENARIOS as readonly string[]).join(', ') + ' · publico: ' + (PUBLICOS as readonly string[]).join(', ') + '.\n'
      + 'Responda: {"gancho":["até 2 do vocabulário"],"cenario":["até 2"],"publico":["b2b" e/ou "b2c"],"produto":["sabores/produtos visíveis, se der para ler"],"descricao":"1 frase objetiva do que a foto mostra","pessoa":true|false,"qualidade":"boa|media|ruim","motivo_qualidade":"curto"}'
      + (a.titulo ? '\nReferência interna: ' + a.titulo : '') + (a.produto_nome ? '\nProduto cadastrado: ' + a.produto_nome : ''),
    imagem: { base64: arq.buf.toString('base64'), mime }, maxTokens: 500, temperature: 0, gatilho: 'cron', entradaRef: String(id),
  });
  if (!r.ok || !r.json) return { ok: false, erro: r.erro || 'sem JSON' };
  const j = r.json;
  const filtra = (arr: any, voc: readonly string[]) => (Array.isArray(arr) ? arr.map(String) : []).filter(x => voc.includes(x));
  const sug = {
    gancho: filtra(j.gancho, GANCHOS as readonly string[]),
    cenario: filtra(j.cenario, CENARIOS as readonly string[]),
    publico: filtra(j.publico, PUBLICOS as readonly string[]),
    produto: (Array.isArray(j.produto) ? j.produto.map((x: any) => String(x).slice(0, 40)) : []).slice(0, 4),
  };
  const descricao = String(j.descricao || '').slice(0, 300);
  const pessoa = j.pessoa === true;

  // Mescla: so preenche o que esta vazio nas tags atuais
  const atuais: any = a.tags || {};
  const novas: any = { ...atuais };
  for (const k of ['gancho', 'cenario', 'publico', 'produto'] as const) {
    const cur = Array.isArray(atuais[k]) ? atuais[k] : [];
    if (!cur.length && (sug as any)[k].length) novas[k] = (sug as any)[k];
  }
  const obs = [a.observacao ? String(a.observacao) : '', pessoa ? '[visao] ha pessoa/rosto na foto: confirme o direito de imagem antes de liberar' : '', j.qualidade === 'ruim' ? '[visao] qualidade ruim: ' + String(j.motivo_qualidade || '').slice(0, 80) : ''].filter(Boolean).join(' · ');
  try {
    await db.execute(sql`UPDATE mkt_assets SET tags = ${JSON.stringify(novas)}::jsonb, tags_ia = ${JSON.stringify({ ...sug, qualidade: j.qualidade || null })}::jsonb,
      descricao_ia = ${descricao || null}, visao_em = now(), observacao = ${obs || null} WHERE id = ${id}`);
  } catch (e: any) { return { ok: false, erro: 'gravar: ' + String(e?.message || e).slice(0, 100) }; }
  return { ok: true, tags: novas, descricao, pessoa };
}

/** Roda a visao no acervo que ainda nao passou por ela (lote pequeno por chamada). */
export async function classificarPendentes(limite = 20): Promise<{ feitos: number; erros: number }> {
  if ((await modo()) === 'off') return { feitos: 0, erros: 0 };
  let feitos = 0, erros = 0;
  try {
    const r: any = await db.execute(sql`SELECT id FROM mkt_assets WHERE visao_em IS NULL AND COALESCE(ativo, true) = true AND tipo = 'foto' ORDER BY criado_em DESC LIMIT ${Math.min(50, limite)}`);
    for (const row of (r.rows || [])) {
      const x = await classificarAsset(Number(row.id));
      if (x.ok) feitos++; else { erros++; if (/teto|ANTHROPIC/.test(String(x.erro))) break; }
    }
  } catch (e: any) { console.error('[MKT-VISAO] lote:', e?.message || e); }
  return { feitos, erros };
}
