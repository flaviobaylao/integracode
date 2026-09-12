// ============================================================================
// CENTRAL DE MARKETING — REVISOR LLM (agente mkt_revisor)
// ----------------------------------------------------------------------------
// O revisor do buraco 4 (mkt-marca.revisarTexto) e regex: pega termo proibido,
// preco no texto, caps lock, CTA ausente. Nao entende FATO ("produzido em
// Goiania" quando a fabrica e em Bela Vista), nem TOM, nem se a copy descreve
// o que a foto mostra. Este agente entra DEPOIS do regex, que continua como
// trava dura:
//   - regex bloqueou  -> bloqueado (o LLM nem roda; nao gasta)
//   - regex aprovou   -> LLM confere fato, tom e coerencia com a foto
//       - 'bloqueado' com motivo factual/claim -> bloqueia (rodada conta)
//       - 'ajuste'                             -> aprova com achados 'atencao'
//       - 'aprovado'                           -> aprova
// Nunca aprova para o ar: quem aprova continua sendo o humano na fila.
// Modo: system_settings mkt_revisor_modo (off|on; padrao on se houver chave).
// Falha do LLM NAO vira bloqueio (o regex ja passou): vira achado 'atencao'
// "revisor de IA indisponivel" — o humano ve e decide.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_revisor';

const PROMPT_PADRAO = `Você é o revisor de marketing da Honest Sucos Naturais. Recebe uma peça (texto + descrição da foto + canal) e confere, nesta ordem:
1. FATO: tudo que a peça afirma sobre a empresa, produto, cidade, fábrica, prazo, preço, frequência de produção precisa estar nos FATOS fornecidos. Fato que não está lá é erro grave. A fábrica é em Bela Vista de Goiás; Goiânia é filial/entrega.
2. CLAIM: nada de promessa de saúde (cura, emagrece, imunidade, detox), superlativo sem prova ("melhor do Brasil"), comparação nominal com concorrente, depoimento inventado.
3. FOTO: a copy só pode descrever o que a descrição da foto mostra.
4. TOM: dentro do cartão de marca (direto, honesto, sem adjetivo vazio, sem caps lock, no máximo 2 emojis).
5. CANAL: tamanho e forma adequados (Instagram: legenda curta com CTA; WhatsApp UTILITY: sem cara de promoção).

Responda SOMENTE JSON: {"veredito":"aprovado"|"ajuste"|"bloqueado","itens":[{"gravidade":"bloqueio"|"atencao"|"sugestao","regra":"fato|claim|foto|tom|canal","trecho":"...","explicacao":"..."}],"resumo":"1 frase"}.
Use "bloqueado" apenas para erro de FATO ou CLAIM. Tom e sugestões são "ajuste"/"atencao". Seja específico e curto.`;

async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

export async function modo(): Promise<'off' | 'on'> {
  const m = await getSetting('mkt_revisor_modo', process.env.ANTHROPIC_API_KEY ? 'on' : 'off');
  return m === 'off' ? 'off' : 'on';
}

export type Achado = { gravidade: 'bloqueio' | 'atencao' | 'sugestao'; regra: string; trecho?: string; explicacao: string };

export async function revisarComIA(peca: { id?: string; copy: string; canal: string; gancho?: string | null; assetIds?: any[] }): Promise<{ rodou: boolean; veredito: 'aprovado' | 'ajuste' | 'bloqueado'; achados: Achado[]; resumo?: string }> {
  if ((await modo()) === 'off') return { rodou: false, veredito: 'aprovado', achados: [] };
  // Contexto: cartao de marca + fatos + descricao da foto (tags)
  let cartao = '', fatos = '', foto = '';
  try { const { blocoDePrompt } = await import('./mkt-marca'); cartao = String((await blocoDePrompt()) || ''); } catch {}
  try { const { fatosDaEmpresa } = await import('./mkt-agente-conteudo'); fatos = await fatosDaEmpresa(); } catch {}
  try {
    const ids = (peca.assetIds || []).map(Number).filter(n => n > 0);
    if (ids.length) {
      const { verAsset } = await import('./mkt-assets');
      const a = await verAsset(ids[0]);
      const t = a?.tags || {};
      foto = [a?.titulo, Array.isArray(t.cenario) ? 'cenario: ' + t.cenario.join(', ') : '', Array.isArray(t.produto) ? 'produto: ' + t.produto.join(', ') : '', a?.descricao_ia ? 'descricao: ' + a.descricao_ia : ''].filter(Boolean).join(' · ');
    }
  } catch {}
  const { chamarAgente } = await import('./mkt-llm');
  const r = await chamarAgente({
    agente: AGENTE, nome: 'Revisor de Marketing', promptPadrao: PROMPT_PADRAO, modeloPadrao: 'claude-haiku-4-5', tetoPadrao: 1,
    systemExtra: [cartao ? '# CARTAO DE MARCA\n' + cartao : '', fatos ? '# FATOS DA EMPRESA (unica fonte de fato)\n' + fatos : ''].filter(Boolean).join('\n\n'),
    user: 'Canal: ' + peca.canal + (peca.gancho ? ' · gancho: ' + peca.gancho : '') + '\nFoto: ' + (foto || 'sem descricao') + '\n\nPECA:\n' + String(peca.copy || ''),
    maxTokens: 1200, temperature: 0, gatilho: 'cron', entradaRef: peca.id || null,
  });
  if (!r.ok || !r.json) {
    return { rodou: false, veredito: 'ajuste', achados: [{ gravidade: 'atencao', regra: 'revisor_ia', explicacao: 'revisor de IA indisponivel (' + (r.erro || 'sem JSON') + '); o regex passou — confira fato e tom a mao' }] };
  }
  const j = r.json;
  const itens: Achado[] = (Array.isArray(j.itens) ? j.itens : []).map((i: any) => ({
    gravidade: (['bloqueio', 'atencao', 'sugestao'].includes(i?.gravidade) ? i.gravidade : 'atencao'),
    regra: 'ia:' + String(i?.regra || 'geral').slice(0, 24), trecho: i?.trecho ? String(i.trecho).slice(0, 160) : undefined,
    explicacao: String(i?.explicacao || '').slice(0, 300),
  }));
  let veredito: 'aprovado' | 'ajuste' | 'bloqueado' = ['aprovado', 'ajuste', 'bloqueado'].includes(j.veredito) ? j.veredito : 'ajuste';
  // Bloqueio so com item de bloqueio em fato/claim — o resto e ajuste.
  const temBloqueio = itens.some(i => i.gravidade === 'bloqueio' && /fato|claim/.test(i.regra));
  if (veredito === 'bloqueado' && !temBloqueio) veredito = 'ajuste';
  if (veredito !== 'bloqueado') for (const i of itens) if (i.gravidade === 'bloqueio') i.gravidade = 'atencao';
  return { rodou: true, veredito, achados: itens, resumo: j.resumo ? String(j.resumo).slice(0, 200) : undefined };
}
