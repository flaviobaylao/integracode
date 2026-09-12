// ---------------------------------------------------------------------------
// Central de Marketing — o que faltava entrar na esteira
// ---------------------------------------------------------------------------
// Medido em 22/08: a esteira tem revisor de IA, portao de aprovacao, decisao em
// lote e vigia de peca vencida. E `de_agente: 0`. Funil com filtro bom e sem
// entrada. Este arquivo e a entrada.
//
// O QUE ELE NAO FAZ, de proposito:
//  - nao publica. Cria a peca e manda para revisao; ela para em
//    `aguardando_aprovacao` e espera um humano. O portao continua sendo o desenho.
//  - nao inventa fato de produto. A copy sai do cartao de marca e das TAGS do
//    criativo escolhido. Nao ha numero, promessa de saude nem preco vindo do
//    modelo. O revisor bloqueia claim proibido de qualquer jeito, mas depender
//    so do revisor seria contar com a rede em vez de nao cair.
//  - nao escolhe sozinho o ritmo. Quantas pecas por semana e decisao editorial
//    do dono, nao minha: e uma chave em system_settings, comeca em 3.
//  - nao cria peca sem link rastreavel. Peca que vai ao ar sem codigo de
//    atribuicao gera pedido sem origem — o buraco que a Central existe para
//    fechar. Sem link, ele avisa em vez de produzir.
//
// MODO off/test/on, como o resto da casa. Nasce `off`.
//   off  — inerte
//   test — escolhe, escreve e DEVOLVE o plano sem gravar nada
//   on   — grava a peca e manda para revisao

import { db } from './db';
import { sql } from 'drizzle-orm';

export const AGENTE = 'mkt_conteudo';
export const MODOS = ['off', 'test', 'on'] as const;

const PADRAO = {
  mkt_conteudo_modo: 'off',
  mkt_conteudo_por_semana: '3',   // ritmo — decisao editorial, nao minha
  mkt_conteudo_b2b_pct: '70',     // o negocio e 70% revenda; a pauta segue o negocio
  mkt_conteudo_canal: 'instagram',
  // Endereco publico que entra NA COPY. Sem ele a chamada saia como `/r/slug`,
  // que numa legenda de Instagram nao e link nenhum. Fica em system_settings
  // para trocar de dominio sem deploy.
  mkt_conteudo_base_url: 'https://loja.bebahonest.com.br',
};

async function cfg(chave: keyof typeof PADRAO): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${chave} LIMIT 1`);
    const v = r.rows?.[0]?.value;
    return v == null ? PADRAO[chave] : String(v).replace(/^"|"$/g, '');
  } catch { return PADRAO[chave]; }
}

export async function modo(): Promise<string> {
  const m = await cfg('mkt_conteudo_modo');
  return (MODOS as readonly string[]).includes(m) ? m : 'off';
}

export async function definirModo(novo: string, quem?: string): Promise<{ ok: boolean; modo?: string; erro?: string }> {
  if (!(MODOS as readonly string[]).includes(novo)) return { ok: false, erro: 'modo invalido' };
  // Ligar em `on` sem chave de IA produziria peca vazia todo dia. Melhor recusar
  // agora, com o motivo, do que sujar a fila de aprovacao amanha.
  if (novo === 'on' && !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, erro: 'ANTHROPIC_API_KEY ausente: o agente escreveria peca vazia' };
  }
  try {
    await db.execute(sql`
      INSERT INTO system_settings (key, value, updated_by) VALUES ('mkt_conteudo_modo', ${novo}, ${quem || AGENTE})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
    return { ok: true, modo: novo };
  } catch (e: any) { return { ok: false, erro: String(e?.message || e) }; }
}

export async function parametros(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(PADRAO) as (keyof typeof PADRAO)[]) out[k] = await cfg(k);
  return out;
}

export async function definirParametros(campos: Record<string, any>, quem?: string): Promise<{ ok: boolean; aplicados: string[] }> {
  const aplicados: string[] = [];
  for (const k of Object.keys(campos)) {
    if (!(k in PADRAO)) continue;
    if (k === 'mkt_conteudo_modo') continue; // modo tem porta propria, com a trava da chave de IA
    try {
      await db.execute(sql`
        INSERT INTO system_settings (key, value, updated_by) VALUES (${k}, ${String(campos[k])}, ${quem || AGENTE})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`);
      aplicados.push(k);
    } catch { /* uma chave ruim nao derruba as outras */ }
  }
  return { ok: true, aplicados };
}

// ---------------------------------------------------------------------------
// 1. Quanto ainda cabe esta semana
// ---------------------------------------------------------------------------
// Conta peca DO AGENTE criada nos ultimos 7 dias, em qualquer estado — inclusive
// reprovada. Peca reprovada consumiu revisao e atencao humana; fingir que nao
// existiu faria o agente insistir no mesmo dia em que foi recusado.

export async function saldoDaSemana(): Promise<{ cota: number; feitas: number; cabe: number }> {
  const cota = Math.max(0, Number(await cfg('mkt_conteudo_por_semana')) || 0);
  let feitas = 0;
  try {
    const r: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM mkt_pieces
       WHERE origem = 'agente' AND agente = ${AGENTE} AND criado_em >= NOW() - INTERVAL '7 days'`);
    feitas = Number(r.rows?.[0]?.n || 0);
  } catch { /* tabela ainda nao existe: saldo cheio */ }
  return { cota, feitas, cabe: Math.max(0, cota - feitas) };
}

// ---------------------------------------------------------------------------
// 2. Qual assunto
// ---------------------------------------------------------------------------
// Duas perguntas, nesta ordem: para QUEM (b2b/b2c) e com que GANCHO.
//
// O publico segue o negocio: 70% revenda. Nao e sorteio a cada peca — e o
// historico das ultimas pecas que decide, senao uma sequencia de azar deixa o
// B2B semanas sem aparecer num negocio que e 70% B2B.
//
// O gancho so entra se TIVER FOTO. Combinacao sem criativo elegivel nao vira
// peca — viraria pedido de foto disfarcado de peca.

export type Assunto = { publico: 'b2b' | 'b2c'; gancho: string; cenas: number; motivo: string };

async function publicoDaVez(): Promise<'b2b' | 'b2c'> {
  const alvo = Math.min(100, Math.max(0, Number(await cfg('mkt_conteudo_b2b_pct')) || 0));
  try {
    const r: any = await db.execute(sql`
      SELECT gancho, titulo FROM mkt_pieces
       WHERE origem = 'agente' AND agente = ${AGENTE}
       ORDER BY criado_em DESC LIMIT 10`);
    const ultimas = r.rows || [];
    if (!ultimas.length) return alvo >= 50 ? 'b2b' : 'b2c';
    // O publico nao esta em coluna propria: fica no titulo que o agente escreve.
    const b2b = ultimas.filter((x: any) => /\[b2b\]/i.test(String(x.titulo || ''))).length;
    const pctAtual = (b2b / ultimas.length) * 100;
    return pctAtual < alvo ? 'b2b' : 'b2c';
  } catch {
    return alvo >= 50 ? 'b2b' : 'b2c';
  }
}

/**
 * Escolhe o gancho entre os que TEM foto disponivel.
 *
 * Prefere o de melhor receita por uso — mas so quando o desempenho e marcado
 * como confiavel. Ranking com amostra pequena e pior que ranking nenhum: parece
 * resposta. Enquanto nao ha dado, roda o menos usado recentemente, que e como
 * se ganha dado.
 */
export async function escolherAssunto(): Promise<{ ok: boolean; assunto?: Assunto; erro?: string; disponiveis?: any[] }> {
  const publico = await publicoDaVez();
  const { buscar } = await import('./mkt-assets');

  const { GANCHOS } = await import('./mkt-assets');
  const comFoto: { gancho: string; cenas: number; pecas: number }[] = [];
  for (const g of GANCHOS as readonly string[]) {
    const lista = await buscar({ soElegiveis: true, publico, gancho: g, limite: 300 } as any);
    if (!lista.length) continue;
    const cenas = new Set(lista.map((a: any) => a.familia ?? ('id:' + a.id))).size;
    comFoto.push({ gancho: g, cenas, pecas: lista.length });
  }
  if (!comFoto.length) {
    return { ok: false, erro: 'nenhum gancho de ' + publico + ' tem criativo elegivel hoje', disponiveis: [] };
  }

  // Desempenho, se ele tiver o direito de opinar.
  let melhor: string | null = null;
  try {
    const { desempenhoPorTag } = await import('./mkt-assets');
    const d = await desempenhoPorTag('gancho', 90);
    const confiaveis = (d.linhas || []).filter((l: any) => l.confiavel && comFoto.some(c => c.gancho === l.valor));
    if (confiaveis.length) {
      confiaveis.sort((a: any, b: any) => b.receitaPorUso - a.receitaPorUso);
      melhor = confiaveis[0].valor;
    }
  } catch { /* sem desempenho: segue pelo rodizio */ }

  if (melhor) {
    const c = comFoto.find(x => x.gancho === melhor)!;
    return { ok: true, assunto: { publico, gancho: melhor, cenas: c.cenas, motivo: 'melhor receita por uso (amostra confiavel)' }, disponiveis: comFoto };
  }

  // Rodizio: o gancho que o agente usou ha mais tempo, desempatando por quem tem
  // mais cenas — mais cenas significa mais folego antes de repetir.
  let usoRecente = new Map<string, string>();
  try {
    const r: any = await db.execute(sql`
      SELECT gancho, MAX(criado_em) AS ultimo FROM mkt_pieces
       WHERE origem = 'agente' AND agente = ${AGENTE} AND gancho IS NOT NULL
       GROUP BY gancho`);
    for (const x of (r.rows || [])) usoRecente.set(String(x.gancho), String(x.ultimo));
  } catch { /* sem historico: qualquer um serve */ }

  comFoto.sort((a, b) => {
    const ua = usoRecente.get(a.gancho) || '';
    const ub = usoRecente.get(b.gancho) || '';
    if (ua !== ub) return ua < ub ? -1 : 1;   // nunca usado ('') vem primeiro
    return b.cenas - a.cenas;
  });
  const c = comFoto[0];
  return {
    ok: true,
    assunto: { publico, gancho: c.gancho, cenas: c.cenas, motivo: usoRecente.has(c.gancho) ? 'ha mais tempo sem ir ao ar' : 'ainda nao foi ao ar' },
    disponiveis: comFoto,
  };
}

// ---------------------------------------------------------------------------
// 3. Qual foto
// ---------------------------------------------------------------------------
// `buscar({soElegiveis})` ja aplica o descanso POR FAMILIA (mkt-semelhanca.ts),
// entao aqui nao ha risco de escolher a irma gemea da que foi ao ar ontem.
// Entre as elegiveis, a que descansou mais — e o criterio que espalha o uso pelo
// banco em vez de gastar sempre as primeiras.

export async function escolherCriativo(publico: string, gancho: string, formato?: string): Promise<any | null> {
  const { buscar } = await import('./mkt-assets');
  const lista = await buscar({ soElegiveis: true, publico, gancho, formato, limite: 300 } as any);
  if (!lista.length) return null;
  const ordenada = [...lista].sort((a: any, b: any) => {
    const ua = a.ultimo_uso ? new Date(a.ultimo_uso).getTime() : 0;
    const ub = b.ultimo_uso ? new Date(b.ultimo_uso).getTime() : 0;
    return ua - ub;   // nunca usado (0) primeiro
  });
  return ordenada[0];
}

// ---------------------------------------------------------------------------
// 4. Qual link
// ---------------------------------------------------------------------------
// Sem link rastreavel a peca vira pedido sem origem — o buraco que a Central
// existe para fechar. Prefere link do canal; se nao houver, qualquer link ativo;
// se nao houver nenhum, RECUSA em vez de produzir peca cega.

/**
 * SPRINT 2 (set/2026): link POR PECA, nao o link mais clicado do canal.
 *
 * Com um so link para todas as pecas, a atribuicao por peca era impossivel e
 * `desempenhoPorTag` nunca ficava "confiavel" (exige campanha exclusiva). Agora
 * cada peca nasce com campanha do mes (IG0926) + link proprio
 * (/r/ig-20260912-margem-x1) com utm_content = gancho. Peca com campanha_id
 * tambem liga o `exigirCodigo` do revisor.
 */
export async function linkDaPeca(canal: string, gancho: string, publico: string): Promise<{ slug: string; destino: string; campanhaId: string; codigo: string } | null> {
  try {
    const { ensureMktAtribuicaoSchema, normalizarSlug } = await import('./mkt-atribuicao');
    await ensureMktAtribuicaoSchema();
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const mm = String(agora.getMonth() + 1).padStart(2, '0'), yy = String(agora.getFullYear()).slice(2);
    const prefixo = canal === 'instagram' ? 'IG' : canal === 'facebook' ? 'FB' : canal === 'whatsapp' ? 'WA' : 'MK';
    const codigo = prefixo + mm + yy;
    const c: any = await db.execute(sql`
      INSERT INTO mkt_campanhas (codigo, nome, objetivo, canal, publico, ativo)
      VALUES (${codigo}, ${'Conteudo ' + canal + ' ' + mm + '/' + yy}, ${publico === 'b2b' ? 'aquisicao_b2b' : 'b2c'}, ${canal}, ${publico === 'b2b' ? 'b2b_revenda' : 'b2c_consumidor'}, true)
      ON CONFLICT (codigo) DO UPDATE SET ativo = true RETURNING id`);
    const campanhaId = String(c.rows?.[0]?.id || '');
    if (!campanhaId) return null;
    const dia = agora.toISOString().slice(0, 10).replace(/-/g, '');
    const sufixo = Math.random().toString(36).slice(2, 5);
    const slug = normalizarSlug(prefixo.toLowerCase() + '-' + dia + '-' + gancho + '-' + sufixo);
    const destino = '/shop';
    await db.execute(sql`
      INSERT INTO mkt_links (slug, destino, campanha_id, utm_source, utm_medium, utm_campaign, utm_content, ativo, criado_por)
      VALUES (${slug}, ${destino}, ${campanhaId}, ${canal}, ${'organico'}, ${codigo.toLowerCase()}, ${gancho}, true, ${AGENTE})
      ON CONFLICT (slug) DO NOTHING`);
    return { slug, destino, campanhaId, codigo };
  } catch (e: any) {
    console.error('[MKT-CONTEUDO] linkDaPeca:', e?.message || e);
    return null;
  }
}

export async function escolherLink(canal: string): Promise<{ slug: string; destino: string } | null> {
  try {
    const r: any = await db.execute(sql`
      SELECT slug, destino, utm_source FROM mkt_links
       WHERE ativo = true
       ORDER BY (utm_source = ${canal}) DESC, cliques DESC, criado_em ASC
       LIMIT 1`);
    const l = r.rows?.[0];
    return l ? { slug: String(l.slug), destino: String(l.destino) } : null;
  } catch { return null; }
}

/**
 * O endereco que vai NA COPY — sempre o `/r/<slug>` absoluto, nunca o destino.
 *
 * ACHADO EM PRODUCAO (25/08), rodando o agente em modo test: a copy saiu com
 * "Acesse: /r/bio-instagram". Caminho relativo numa legenda de Instagram nao e
 * link — ninguem clica, e a peca vai ao ar cega.
 *
 * A regra antiga era `destino.startsWith('http') ? destino : '/r/'+slug`, e o
 * ramo do `http` era o pior dos dois: mandar o cliente direto ao destino PULA o
 * /r/, que e justamente onde o clique e gravado e os utm sao colados. A peca
 * ficaria clicavel e sem origem — exatamente o buraco que a Central existe para
 * fechar. Hoje os cinco links tem destino '/shop' (relativo), entao so o
 * primeiro sintoma apareceu; um dia alguem cadastra um destino absoluto e a
 * atribuicao some sem aviso.
 *
 * Por isso: o tracker SEMPRE, e absoluto.
 */
export async function linkPublico(slug: string): Promise<string> {
  let base = (await cfg('mkt_conteudo_base_url')).trim();
  if (!/^https?:\/\//i.test(base)) base = PADRAO.mkt_conteudo_base_url;
  return base.replace(/\/+$/, '') + '/r/' + String(slug || '').replace(/^\/+/, '');
}

// ---------------------------------------------------------------------------
// 5. O texto
// ---------------------------------------------------------------------------

const DICA_DE_GANCHO: Record<string, string> = {
  margem: 'quanto sobra para quem revende',
  giro: 'a velocidade com que sai da prateleira',
  sabor: 'o gosto, a experiencia de beber',
  saude: 'natural, sem acucar adicionado — SEM prometer efeito no corpo',
  comodidade: 'a facilidade de comprar, receber e repor',
  preco: 'o que custa, sem inventar numero que voce nao tem',
  novidade: 'o que mudou ou chegou agora',
  confianca: 'como o produto e feito, quem faz, o cuidado no processo',
  prova_social: 'gente de verdade usando — sem inventar depoimento',
};

/**
 * Os fatos da empresa, na fonte que os atendentes ja usam.
 *
 * ACHADO POR LEITURA DA SAIDA, nao por teste: a primeira versao deste agente
 * recebia so o cartao de marca — tom, voz, o que nunca dizer. Fato de produto,
 * nenhum. E modelo sem fato nao fica calado: ele preenche com o que soa
 * plausivel. Escreveu "produzimos tudo aqui em Goiania, diariamente" quando a
 * fabrica e em Bela Vista de Goias e Goiania e a filial.
 *
 * O revisor de marca nao pega isso: ele barra claim proibido e adjetivo vazio,
 * nao geografia errada. Fato errado sobre a propria empresa passa limpo.
 *
 * A base de conhecimento dos atendentes e a fonte certa: ja e verificada, ja
 * esta em producao respondendo cliente, e e mantida num lugar so. Puxo de la em
 * vez de escrever uma segunda copia que ia divergir na primeira mudanca.
 */
export async function fatosDaEmpresa(): Promise<string> {
  try {
    const r: any = await db.execute(sql`
      SELECT base_conhecimento FROM agentes_config
       WHERE COALESCE(base_conhecimento, '') <> ''
       ORDER BY LENGTH(base_conhecimento) DESC LIMIT 1`);
    return String(r.rows?.[0]?.base_conhecimento || '').trim();
  } catch { return ''; }
}

export function montarPrompt(o: {
  cartao: string; publico: string; gancho: string; canal: string;
  criativo: any; link: string; fatos?: string;
}): { sistema: string; pedido: string } {
  const t = o.criativo?.tags || {};
  const cenario = Array.isArray(t.cenario) ? t.cenario.join(', ') : '';
  const quem = o.publico === 'b2b'
    ? 'dono de padaria, mercadinho ou distribuidor que REVENDE o produto'
    : 'pessoa que bebe o suco';

  const fatos = String(o.fatos || '').trim();

  const sistema = [
    o.cartao,
    '',
    ...(fatos ? [
      '# FATOS DA HONEST — A UNICA FONTE DE FATO QUE VOCE TEM',
      'Tudo que voce afirmar sobre a empresa, o produto, prazo, preco, cidade,',
      'entrega ou processo TEM que sair daqui, literalmente. Nao complete, nao',
      'arredonde, nao suponha. Se a informacao nao esta abaixo, ela nao entra na',
      'peca — escreva a peca sem ela.',
      '',
      fatos,
      '',
    ] : []),
    '# REGRAS DESTA TAREFA (valem junto com o cartao)',
    '- Voce esta escrevendo UMA peca para ' + o.canal + '.',
    '- Nao invente numero, percentual, preco, prazo, premio nem depoimento.',
    '  Se voce nao recebeu o dado aqui, ele nao existe.',
    '- Cidade, endereco e local de producao: so os que estao nos FATOS acima.',
    '  Confundir fabrica com filial e erro grave.',
    '- Nao diga com que frequencia algo acontece ("diariamente", "toda semana")',
    '  a menos que esteja escrito nos FATOS.',
    '- Nao prometa efeito no corpo, cura, emagrecimento nem imunidade.',
    '- Descreva apenas o que esta NA FOTO descrita abaixo. Se a foto nao mostra,',
    '  nao escreva.',
    '- Termine com uma chamada para o link, escrito exatamente como recebido.',
    '  O endereco fecha a peca SOZINHO: nada de ponto, virgula ou parentese',
    '  colado nele. O Instagram engole o sinal para dentro do link e ele morre.',
    '- Preco, sabor disponivel e estoque: SO via a ferramenta consultar_produto.',
    '  Se nao consultar, nao cite. Nunca de memoria.',
    '- Alem da copy, escreva 3 VARIACOES da primeira linha (o gancho dos 3',
    '  primeiros segundos), genuinamente diferentes entre si — e o que alimenta',
    '  o teste de criativo. Cada uma com ate 90 caracteres.',
    '- Devolva SO um JSON: {"titulo": "...", "copy": "...", "variacoes": ["...", "...", "..."]}.',
    '  Nada fora do JSON.',
    '- O titulo e interno, para a fila de aprovacao: curto e descritivo.',
  ].join('\n');

  const pedido = [
    'Publico: ' + quem + '.',
    'Gancho: ' + o.gancho + ' — ' + (DICA_DE_GANCHO[o.gancho] || o.gancho) + '.',
    'A foto que vai junto mostra: ' + (cenario || 'produto Honest') + '.',
    o.criativo?.titulo ? 'Referencia interna da foto: ' + o.criativo.titulo : '',
    'Link para a chamada: ' + o.link,
  ].filter(Boolean).join('\n');

  return { sistema, pedido };
}

async function escrever(sistema: string, pedido: string, gatilho = 'cron'): Promise<{ titulo: string; copy: string; variacoes: string[] } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    // SPRINT 2 (set/2026): saiu do gpt-4o-mini (fora do runtime, fora do custo,
    // sem tools) e entrou no caminho unico dos agentes de marketing: prompt e
    // teto em agentes_config, custo em mkt_agent_runs, preco so via tool.
    const { chamarAgente, TOOL_CONSULTAR_PRODUTO } = await import('./mkt-llm');
    // SPRINT 3: os aprendizados ativos do otimizador/gestor entram no prompt.
    let aprend = '';
    try {
      const l: any = await db.execute(sql`SELECT enunciado, acao_sugerida FROM mkt_learnings WHERE ativo = true AND (evidencia->>'tema' LIKE 'gancho:%' OR evidencia->>'tema' IN ('geral','humano')) ORDER BY criado_em DESC LIMIT 8`);
      if (l.rows?.length) aprend = '\n\n# APRENDIZADOS (o que ja funcionou ou nao — respeite)\n' + l.rows.map((x: any) => '- ' + x.enunciado + (x.acao_sugerida ? ' → ' + x.acao_sugerida : '')).join('\n');
    } catch {}
    const r = await chamarAgente({
      agente: AGENTE, nome: 'Agente de Conteudo', modeloPadrao: 'claude-sonnet-4-6', tetoPadrao: 2,
      promptPadrao: 'Voce e o redator da Honest Sucos Naturais. Escreve pecas curtas, honestas e especificas, sempre dentro do cartao de marca e dos fatos recebidos.',
      systemExtra: sistema + aprend, user: pedido, tools: [TOOL_CONSULTAR_PRODUTO], maxTokens: 1500, temperature: 0.7, gatilho,
    });
    if (!r.ok || !r.json) { if (!r.ok) console.error('[MKT-CONTEUDO]', r.erro); return null; }
    const j = r.json;
    const copy = String(j.copy || '').trim();
    if (!copy) return null;
    const variacoes = Array.isArray(j.variacoes) ? j.variacoes.map((v: any) => String(v || '').trim()).filter(Boolean).slice(0, 3) : [];
    return { titulo: String(j.titulo || '').trim().slice(0, 120), copy, variacoes };
  } catch {
    return null;
  }
}

/**
 * Descola do endereco a pontuacao que o modelo gruda nele.
 *
 * ACHADO NA PRIMEIRA PECA REAL (25/08): a copy terminou em
 * "...Conheca mais em https://loja.bebahonest.com.br/r/bio-instagram." — com
 * ponto colado. Instagram, WhatsApp e boa parte dos clientes puxam esse ponto
 * PARA DENTRO do link ao transformar o texto em clicavel, e o endereco quebra.
 *
 * O prompt ja pede para nao colar. Isso nao basta: a regra "escrito exatamente
 * como recebido" ja estava la e o modelo colou o ponto mesmo assim. Instrucao
 * de prompt e pedido, nao garantia — a garantia tem que ser codigo depois.
 *
 * Tira so o que esta ENCOSTADO no endereco exato. Perder uma virgula e nota de
 * rodape; link morto e a peca inteira perdida.
 */
export function soltarPontuacaoDoLink(copy: string, url: string): string {
  const texto = String(copy || '');
  const alvo = String(url || '');
  if (!texto || !alvo) return texto;
  try {
    const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return texto.replace(new RegExp(escapado + '[.,;:!?)\\]>"\'”»]+', 'g'), () => alvo).trim();
  } catch { return texto; }
}

// ---------------------------------------------------------------------------
// 6. A rodada
// ---------------------------------------------------------------------------

export type Rodada = {
  ok: boolean;
  modo: string;
  criou?: boolean;
  pieceId?: string;
  estado?: string;
  veredito?: string;
  assunto?: Assunto;
  criativoId?: number;
  link?: string;
  titulo?: string;
  copy?: string;
  variacoes?: string[];
  saldo?: { cota: number; feitas: number; cabe: number };
  motivo?: string;
};

export async function rodar(opts?: { forcar?: boolean; quem?: string | null; gancho?: string | null; publico?: 'b2b' | 'b2c' | null; acaoId?: string | null; modoForcado?: string | null }): Promise<Rodada> {
  const m = opts?.modoForcado || await modo();
  if (m === 'off') return { ok: false, modo: m, motivo: 'agente de conteudo desligado' };

  const saldo = await saldoDaSemana();
  if (!opts?.forcar && saldo.cabe <= 0) {
    return { ok: true, modo: m, criou: false, saldo, motivo: 'cota da semana cumprida (' + saldo.feitas + '/' + saldo.cota + ')' };
  }

  const canal = await cfg('mkt_conteudo_canal');

  // Pauta vinda de fora (Radar/acao aprovada): gancho e publico ja decididos.
  let a: any;
  if (opts?.gancho) {
    const { GANCHOS } = await import('./mkt-assets');
    if (!(GANCHOS as readonly string[]).includes(String(opts.gancho))) return { ok: false, modo: m, saldo, motivo: 'gancho desconhecido: ' + opts.gancho };
    a = { ok: true, assunto: { publico: opts.publico || 'b2b', gancho: String(opts.gancho), cenas: 0, motivo: 'pauta do Radar' } };
  } else {
    a = await escolherAssunto();
    if (a.ok && a.assunto && opts?.publico) a.assunto.publico = opts.publico;
  }
  if (!a.ok || !a.assunto) return { ok: false, modo: m, saldo, motivo: a.erro || 'sem assunto possivel' };

  const criativo = await escolherCriativo(a.assunto.publico, a.assunto.gancho);
  if (!criativo) return { ok: false, modo: m, saldo, assunto: a.assunto, motivo: 'sem criativo elegivel para ' + a.assunto.publico + ' x ' + a.assunto.gancho };

  // Link proprio da peca (campanha do mes + slug com gancho). Em test nao cria nada.
  const link = m === 'test'
    ? await escolherLink(canal).then(l => l ? { ...l, campanhaId: null as string | null, codigo: '' } : null)
    : await linkDaPeca(canal, a.assunto.gancho, a.assunto.publico);
  if (!link) {
    return {
      ok: false, modo: m, saldo, assunto: a.assunto, criativoId: criativo.id,
      motivo: m === 'test' ? 'nenhum link rastreavel cadastrado (em modo on o agente cria um por peca)' : 'nao consegui criar campanha/link para a peca',
    };
  }

  let cartao = '';
  try { const { blocoDePrompt } = await import('./mkt-marca'); cartao = await blocoDePrompt(); } catch { /* segue sem cartao */ }
  if (!cartao) {
    return { ok: false, modo: m, saldo, assunto: a.assunto, motivo: 'cartao de marca indisponivel: escrever sem ele e escrever sem voz' };
  }

  // Sem os fatos ele preenche com o que soa plausivel — ja escreveu a cidade
  // errada por causa disso. Sem eles, nao escreve.
  const fatos = await fatosDaEmpresa();
  if (!fatos) {
    return { ok: false, modo: m, saldo, assunto: a.assunto, motivo: 'base de conhecimento vazia: sem fato o modelo inventa, e ja inventou' };
  }

  // Sempre o tracker absoluto: e ele que grava o clique e cola os utm.
  const enderecoNaCopy = await linkPublico(link.slug);

  const { sistema, pedido } = montarPrompt({
    cartao, publico: a.assunto.publico, gancho: a.assunto.gancho, canal,
    criativo, link: enderecoNaCopy,
    fatos,
  });

  const texto = await escrever(sistema, pedido, opts?.quem === 'cron' ? 'cron' : 'api');
  if (!texto) return { ok: false, modo: m, saldo, assunto: a.assunto, criativoId: criativo.id, motivo: 'o modelo nao devolveu texto utilizavel (chave, teto ou JSON invalido — veja mkt_agent_runs)' };

  // O prompt pede para nao colar pontuacao no endereco. Isso e pedido; a
  // garantia e esta linha.
  texto.copy = soltarPontuacaoDoLink(texto.copy, enderecoNaCopy);

  // O titulo carrega [b2b]/[b2c] porque e por ele que publicoDaVez le o historico
  // (mkt_pieces nao tem coluna de publico e criar uma so para isso seria migracao
  // de schema para um dado que ja cabe no titulo).
  const titulo = '[' + a.assunto.publico + '] ' + (texto.titulo || a.assunto.gancho);

  if (m === 'test') {
    return {
      ok: true, modo: m, criou: false, saldo, assunto: a.assunto, criativoId: criativo.id,
      link: enderecoNaCopy, titulo, copy: texto.copy, variacoes: texto.variacoes, motivo: 'modo test: nada foi gravado',
    };
  }

  const { criarPeca, enviarParaRevisao } = await import('./mkt-esteira');
  const c = await criarPeca({
    canal, gancho: a.assunto.gancho, titulo, copy: texto.copy,
    assetIds: [criativo.id], ctaTipo: 'link', ctaSlug: link.slug, campanhaId: link.campanhaId || null,
    origem: 'agente', agente: AGENTE, criadoPor: opts?.quem || AGENTE,
  });
  if (!c.ok || !c.id) return { ok: false, modo: m, saldo, assunto: a.assunto, motivo: c.erro || 'falha ao criar a peca' };
  // Variacoes de gancho, acao de origem e post_ref do link — colunas aditivas.
  try {
    await db.execute(sql`UPDATE mkt_pieces SET variacoes = ${JSON.stringify(texto.variacoes || [])}::jsonb, acao_id = ${opts?.acaoId || null} WHERE id = ${c.id}`);
    await db.execute(sql`UPDATE mkt_links SET post_ref = ${c.id} WHERE slug = ${link.slug}`);
  } catch {}

  const rev = await enviarParaRevisao(c.id, AGENTE);

  return {
    ok: true, modo: m, criou: true, pieceId: c.id, estado: rev.estado, veredito: rev.veredito,
    saldo, assunto: a.assunto, criativoId: criativo.id, link: enderecoNaCopy,
    titulo, copy: texto.copy, variacoes: texto.variacoes,
  };
}

// ---------------------------------------------------------------------------
// Prontidao — os portoes de `rodar()`, conferidos ANTES de rodar
// ---------------------------------------------------------------------------
// ACHADO POR LEITURA DO CODIGO: `panorama()` calculava `impedimento` olhando so
// o assunto. Mas `rodar()` para em mais quatro lugares depois dele — criativo,
// link rastreavel, cartao de marca e base de conhecimento — e no fim ainda
// precisa da chave de IA para escrever. Com o assunto resolvido a tela dizia
// `impedimento: null` enquanto o agente nao produzia nada.
//
// Tela verde com agente parado e pior que tela vermelha: ninguem vai procurar
// o que a tela afirma que esta certo.
//
// Nenhum portao aqui gasta dinheiro: sao leituras de banco e uma variavel de
// ambiente. A unica chamada paga (o modelo escrevendo) continua so em `rodar()`.

export type Portao = { id: string; ok: boolean; detalhe: string };

export async function prontidao(): Promise<{
  pronto: boolean; portoes: Portao[]; impedimento: string | null;
  assunto: Assunto | null; disponiveis: any[];
}> {
  const portoes: Portao[] = [];
  const add = (id: string, ok: boolean, detalhe: string) => { portoes.push({ id, ok, detalhe }); };

  const canal = await cfg('mkt_conteudo_canal');

  const a: any = await escolherAssunto().catch((e: any) => ({ ok: false, erro: String(e?.message || e) }));
  const assunto: Assunto | null = (a.ok && a.assunto) ? a.assunto : null;
  const disponiveis: any[] = a.disponiveis || [];
  add('assunto', !!assunto,
    assunto ? (assunto.publico + ' x ' + assunto.gancho) : (a.erro || 'sem assunto possivel'));

  if (assunto) {
    const c = await escolherCriativo(assunto.publico, assunto.gancho).catch(() => null);
    add('criativo', !!c, c ? ('foto #' + c.id) : ('sem criativo elegivel para ' + assunto.publico + ' x ' + assunto.gancho));
  } else {
    add('criativo', false, 'depende do assunto');
  }

  add('link', true, 'o agente cria campanha do mes + link proprio por peca (/r/' + (canal === 'instagram' ? 'ig' : 'mk') + '-<data>-<gancho>)');

  let cartao = '';
  try { const { blocoDePrompt } = await import('./mkt-marca'); cartao = String((await blocoDePrompt()) || '').trim(); } catch { cartao = ''; }
  add('cartao_de_marca', !!cartao,
    cartao ? (cartao.length + ' caracteres') : 'cartao de marca indisponivel: escrever sem ele e escrever sem voz');

  const fatos = await fatosDaEmpresa().catch(() => '');
  add('base_de_conhecimento', !!fatos,
    fatos ? (fatos.length + ' caracteres') : 'base de conhecimento vazia: sem fato o modelo inventa, e ja inventou');

  add('chave_de_ia', !!process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY ? 'presente (Anthropic, custo em mkt_agent_runs)' : 'ANTHROPIC_API_KEY ausente: o agente escreveria peca vazia');

  const primeiro = portoes.find(p => !p.ok);
  return { pronto: !primeiro, portoes, impedimento: primeiro ? primeiro.detalhe : null, assunto, disponiveis };
}

// ---------------------------------------------------------------------------
// Panorama para a tela
// ---------------------------------------------------------------------------

export async function panorama(): Promise<any> {
  const m = await modo();
  const saldo = await saldoDaSemana();
  const p = await parametros();
  const pr: any = await prontidao().catch((e: any) => ({
    pronto: false, portoes: [], impedimento: 'falha ao conferir prontidao: ' + String(e?.message || e),
    assunto: null, disponiveis: [],
  }));
  let noAr = 0;
  try {
    const r: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM mkt_pieces WHERE origem = 'agente' AND agente = ${AGENTE}`);
    noAr = Number(r.rows?.[0]?.n || 0);
  } catch { /* tabela ainda nao existe */ }
  return {
    ok: true, modo: m, parametros: p, saldo, pecasDoAgente: noAr,
    temChaveIA: !!process.env.ANTHROPIC_API_KEY,
    proximoAssunto: pr.assunto,
    ganchosComFoto: pr.disponiveis || [],
    pronto: pr.pronto,
    portoes: pr.portoes,
    impedimento: pr.impedimento,
  };
}
