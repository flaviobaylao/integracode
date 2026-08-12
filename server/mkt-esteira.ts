// Central de Marketing - buraco 6: esteira de estados + fila de aprovacao.
//
// O buraco: "sem portao, ou o gestor vira gargalo, ou a IA publica sem revisao".
// As duas metades importam. Um portao que exige olhar peca por peca no desktop
// e tao ruim quanto nao ter portao - o gestor para de aprovar e a Central morre.
//
// Por isso a regra numero 3 do plano e tratada como requisito, nao como detalhe:
// "aprovar duas semanas de conteudo tem que caber em 5 minutos no celular".
// Dai a decisao em LOTE, a fila enxuta e o preview que cabe num cartao de telefone.
//
// Decisoes:
//  - id varchar/uuid, como o resto do modulo (a licao do buraco 5: mkt_campanhas.id
//    e varchar; SERIAL aqui quebraria o join de novo).
//  - Transicao de estado e validada por tabela. Estado nao muda "na mao".
//  - TODA transicao grava em mkt_audit: quem, de onde, para onde, quando.
//  - Peca que o revisor BLOQUEOU nao vira aprovada sem alguem assumir por escrito.
//  - Retrabalho tem teto de 2 rodadas - depois escala para humano com o motivo.
//  - DDL preguicosa, nunca no boot.

import { db } from './db';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// A esteira
// ---------------------------------------------------------------------------

export const ESTADOS = [
  'rascunho', 'em_producao', 'em_revisao_ia', 'bloqueado',
  'aguardando_aprovacao', 'reprovado', 'aprovado', 'agendado', 'publicado',
] as const;
export type Estado = typeof ESTADOS[number];

/** Para onde cada estado pode ir. O que nao esta aqui e recusado. */
const TRANSICOES: Record<Estado, Estado[]> = {
  rascunho: ['em_producao', 'em_revisao_ia'],
  em_producao: ['em_revisao_ia', 'rascunho'],
  em_revisao_ia: ['bloqueado', 'aguardando_aprovacao'],
  bloqueado: ['em_producao', 'aguardando_aprovacao', 'reprovado'],
  aguardando_aprovacao: ['aprovado', 'reprovado', 'em_producao'],
  reprovado: ['em_producao'],
  aprovado: ['agendado', 'publicado', 'em_producao'],
  agendado: ['publicado', 'aprovado', 'em_producao'],
  publicado: [],
};

/** Teto de idas e voltas entre producao e revisao (regra 2 do plano). */
export const MAX_RODADAS = 2;

export const CANAIS = ['instagram', 'facebook', 'whatsapp', 'google', 'hotsite'] as const;

export function podeIr(de: string, para: string): boolean {
  const lista = TRANSICOES[de as Estado];
  return Array.isArray(lista) && lista.includes(para as Estado);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktEsteiraSchema(): Promise<{ ok: boolean; steps: { sql: string; ok: boolean; erro?: string }[] }> {
  const steps: { sql: string; ok: boolean; erro?: string }[] = [];
  const ddl: string[] = [
    // id varchar como mkt_campanhas / mkt_links - senao o join quebra em producao.
    `CREATE TABLE IF NOT EXISTS mkt_pieces (
       id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       campanha_id VARCHAR,
       canal VARCHAR(24) NOT NULL DEFAULT 'instagram',
       formato VARCHAR(24),
       gancho VARCHAR(24),
       titulo VARCHAR,
       copy TEXT NOT NULL DEFAULT '',
       asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
       cta_tipo VARCHAR(24),
       cta_slug VARCHAR,
       agendado_para TIMESTAMPTZ,
       estado VARCHAR(24) NOT NULL DEFAULT 'rascunho',
       rodada INTEGER NOT NULL DEFAULT 0,
       escalado BOOLEAN NOT NULL DEFAULT false,
       brand_voice_versao INTEGER,
       origem VARCHAR(16) NOT NULL DEFAULT 'humano',
       agente VARCHAR(32),
       publicado_em TIMESTAMPTZ,
       external_media_id VARCHAR,
       permalink TEXT,
       criado_por VARCHAR,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS mkt_pieces_estado_idx ON mkt_pieces (estado, criado_em DESC)`,
    `CREATE INDEX IF NOT EXISTS mkt_pieces_camp_idx ON mkt_pieces (campanha_id)`,
    `CREATE TABLE IF NOT EXISTS mkt_reviews (
       id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       piece_id VARCHAR NOT NULL,
       agente VARCHAR(32) NOT NULL DEFAULT 'mkt_compliance',
       veredito VARCHAR(16) NOT NULL,
       itens JSONB NOT NULL DEFAULT '[]'::jsonb,
       motivo TEXT,
       rodada INTEGER NOT NULL DEFAULT 0,
       versao_marca INTEGER,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS mkt_reviews_piece_idx ON mkt_reviews (piece_id, criado_em DESC)`,
    `CREATE TABLE IF NOT EXISTS mkt_approvals (
       id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       piece_id VARCHAR NOT NULL,
       decisao VARCHAR(16) NOT NULL,
       decidido_por VARCHAR,
       comentario TEXT,
       sobrepos_bloqueio BOOLEAN NOT NULL DEFAULT false,
       lote VARCHAR,
       decidido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS mkt_approvals_piece_idx ON mkt_approvals (piece_id, decidido_em DESC)`,
    `CREATE TABLE IF NOT EXISTS mkt_audit (
       id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       entidade VARCHAR(24) NOT NULL,
       entidade_id VARCHAR NOT NULL,
       de_estado VARCHAR(24),
       para_estado VARCHAR(24),
       ator VARCHAR(16) NOT NULL DEFAULT 'humano',
       ator_id VARCHAR,
       payload JSONB,
       criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS mkt_audit_ent_idx ON mkt_audit (entidade, entidade_id, criado_em DESC)`,
  ];

  for (const s of ddl) {
    try { await db.execute(sql.raw(s)); steps.push({ sql: s.slice(0, 60), ok: true }); }
    catch (e: any) { steps.push({ sql: s.slice(0, 60), ok: false, erro: String(e?.message || e) }); }
  }
  const ok = steps.every(s => s.ok);
  _schemaOk = ok;
  return { ok, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  if (Date.now() - _schemaTentativa < 60_000) return false;
  _schemaTentativa = Date.now();
  await ensureMktEsteiraSchema();
  return _schemaOk;
}

// ---------------------------------------------------------------------------
// Auditoria - regra 1 do plano: todo estado grava quem/o que/quando
// ---------------------------------------------------------------------------

async function auditar(entidadeId: string, de: string | null, para: string | null, ator: 'humano' | 'agente', atorId?: string | null, payload?: any): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mkt_audit (entidade, entidade_id, de_estado, para_estado, ator, ator_id, payload)
      VALUES ('peca', ${entidadeId}, ${de}, ${para}, ${ator}, ${atorId || null}, ${payload ? JSON.stringify(payload) : null}::jsonb)
    `);
  } catch { /* auditoria nunca derruba a operacao que ela audita */ }
}

/** Muda o estado com a transicao validada. Quem chama nao escreve estado na mao. */
async function mover(id: string, de: string, para: string, ator: 'humano' | 'agente', atorId?: string | null, extra?: Record<string, any>, payload?: any): Promise<{ ok: boolean; erro?: string }> {
  if (!podeIr(de, para)) {
    return { ok: false, erro: 'transicao invalida: ' + de + ' -> ' + para };
  }
  try {
    await db.execute(sql`UPDATE mkt_pieces SET estado = ${para}, atualizado_em = NOW() WHERE id = ${id}`);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        // Colunas fixas e conhecidas - nada vindo do usuario entra aqui como nome.
        if (k === 'rodada') await db.execute(sql`UPDATE mkt_pieces SET rodada = ${Number(v)} WHERE id = ${id}`);
        else if (k === 'escalado') await db.execute(sql`UPDATE mkt_pieces SET escalado = ${!!v} WHERE id = ${id}`);
        else if (k === 'brand_voice_versao') await db.execute(sql`UPDATE mkt_pieces SET brand_voice_versao = ${v == null ? null : Number(v)} WHERE id = ${id}`);
        else if (k === 'agendado_para') await db.execute(sql`UPDATE mkt_pieces SET agendado_para = ${v || null} WHERE id = ${id}`);
        else if (k === 'publicado_em') await db.execute(sql`UPDATE mkt_pieces SET publicado_em = NOW() WHERE id = ${id}`);
        else if (k === 'external_media_id') await db.execute(sql`UPDATE mkt_pieces SET external_media_id = ${v || null} WHERE id = ${id}`);
        else if (k === 'permalink') await db.execute(sql`UPDATE mkt_pieces SET permalink = ${v || null} WHERE id = ${id}`);
      }
    }
    await auditar(id, de, para, ator, atorId, payload);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Criar e editar
// ---------------------------------------------------------------------------

export type NovaPeca = {
  campanhaId?: string | null;
  canal?: string;
  formato?: string | null;
  gancho?: string | null;
  titulo?: string | null;
  copy?: string;
  assetIds?: (string | number)[];
  ctaTipo?: string | null;
  ctaSlug?: string | null;
  agendadoPara?: string | null;
  origem?: 'humano' | 'agente';
  agente?: string | null;
  criadoPor?: string | null;
};

export async function criarPeca(p: NovaPeca): Promise<{ ok: boolean; id?: string; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const canal = (CANAIS as readonly string[]).includes(String(p.canal)) ? String(p.canal) : 'instagram';
  const assets = Array.isArray(p.assetIds) ? p.assetIds.map(String).filter(Boolean) : [];
  try {
    const r: any = await db.execute(sql`
      INSERT INTO mkt_pieces (campanha_id, canal, formato, gancho, titulo, copy, asset_ids,
                              cta_tipo, cta_slug, agendado_para, origem, agente, criado_por)
      VALUES (${p.campanhaId || null}, ${canal}, ${p.formato || null}, ${p.gancho || null},
              ${p.titulo || null}, ${String(p.copy || '')}, ${JSON.stringify(assets)}::jsonb,
              ${p.ctaTipo || null}, ${p.ctaSlug || null}, ${p.agendadoPara || null},
              ${p.origem === 'agente' ? 'agente' : 'humano'}, ${p.agente || null}, ${p.criadoPor || null})
      RETURNING id
    `);
    const id = String(r.rows[0].id);
    await auditar(id, null, 'rascunho', p.origem === 'agente' ? 'agente' : 'humano', p.agente || p.criadoPor, { canal });
    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

export async function verPeca(id: string): Promise<any | null> {
  if (!(await garantirSchema())) return null;
  const pid = String(id || '').trim();
  if (!pid) return null;
  const r: any = await db.execute(sql`SELECT * FROM mkt_pieces WHERE id = ${pid} LIMIT 1`);
  return r.rows?.[0] || null;
}

export async function editarPeca(id: string, campos: Partial<NovaPeca>): Promise<{ ok: boolean; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const p = await verPeca(id);
  if (!p) return { ok: false, erro: 'peca nao encontrada' };
  // Peca publicada e historico: nao se reescreve o que ja foi ao ar.
  if (p.estado === 'publicado') return { ok: false, erro: 'peca ja publicada - o que foi ao ar nao muda' };
  try {
    // Mexer no texto de uma peca barrada É o conserto: ela volta para producao
    // sozinha. Sem isto ela ficava presa - 'bloqueado' nao vai direto para
    // revisao, e nao existia nada que a tirasse de la. Achado em producao.
    if (p.estado === 'bloqueado' || p.estado === 'reprovado') {
      await mover(id, p.estado, 'em_producao', 'humano', null, undefined, { motivo: 'peca editada' });
    }
    if (campos.copy !== undefined) await db.execute(sql`UPDATE mkt_pieces SET copy = ${String(campos.copy)} WHERE id = ${id}`);
    if (campos.titulo !== undefined) await db.execute(sql`UPDATE mkt_pieces SET titulo = ${campos.titulo || null} WHERE id = ${id}`);
    if (campos.gancho !== undefined) await db.execute(sql`UPDATE mkt_pieces SET gancho = ${campos.gancho || null} WHERE id = ${id}`);
    if (campos.ctaSlug !== undefined) await db.execute(sql`UPDATE mkt_pieces SET cta_slug = ${campos.ctaSlug || null} WHERE id = ${id}`);
    if (campos.campanhaId !== undefined) await db.execute(sql`UPDATE mkt_pieces SET campanha_id = ${campos.campanhaId || null} WHERE id = ${id}`);
    if (campos.assetIds !== undefined) {
      const assets = Array.isArray(campos.assetIds) ? campos.assetIds.map(String).filter(Boolean) : [];
      await db.execute(sql`UPDATE mkt_pieces SET asset_ids = ${JSON.stringify(assets)}::jsonb WHERE id = ${id}`);
    }
    await db.execute(sql`UPDATE mkt_pieces SET atualizado_em = NOW() WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Revisao automatica - o mkt_compliance do plano, que ja existe (buraco 4)
// ---------------------------------------------------------------------------

export async function enviarParaRevisao(id: string, atorId?: string | null): Promise<{
  ok: boolean; estado?: string; veredito?: string; achados?: any[]; rodada?: number;
  escalado?: boolean; erro?: string;
}> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const p = await verPeca(id);
  if (!p) return { ok: false, erro: 'peca nao encontrada' };
  if (!podeIr(p.estado, 'em_revisao_ia')) {
    // Mensagem que diz o que fazer, nao so o que deu errado.
    const dica = p.estado === 'bloqueado'
      ? 'peca barrada pelo revisor: corrija o texto (isso ja devolve ela para producao) e mande revisar de novo'
      : p.estado === 'aguardando_aprovacao' ? 'esta peca ja esta na fila esperando decisao'
      : p.estado === 'publicado' ? 'peca ja publicada'
      : 'estado ' + p.estado + ' nao vai para revisao';
    return { ok: false, erro: dica };
  }

  const rodada = Number(p.rodada || 0) + 1;
  const mv = await mover(id, p.estado, 'em_revisao_ia', 'agente', atorId, { rodada }, { rodada });
  if (!mv.ok) return { ok: false, erro: mv.erro };

  // O revisor do buraco 4. Peca de campanha SEM codigo de atribuicao e bloqueio
  // automatico - por isso exigirCodigo vai ligado quando ha campanha.
  let veredito = 'aprovado';
  let achados: any[] = [];
  let versaoMarca: number | null = null;
  try {
    const { revisarTexto } = await import('./mkt-marca');
    const r = await revisarTexto(String(p.copy || ''), {
      canal: String(p.canal || 'instagram'),
      exigirCodigo: !!p.campanha_id,
      categoria: String(p.canal) === 'whatsapp' ? 'UTILITY' : undefined,
    });
    veredito = r.veredito;
    achados = r.achados || [];
    versaoMarca = r.versaoMarca;
  } catch (e: any) {
    // Revisor fora do ar nao pode virar "aprovado por omissao".
    veredito = 'bloqueado';
    achados = [{ regra: 'revisor indisponivel', gravidade: 'bloqueio', explicacao: String(e?.message || e) }];
  }

  try {
    await db.execute(sql`
      INSERT INTO mkt_reviews (piece_id, agente, veredito, itens, motivo, rodada, versao_marca)
      VALUES (${id}, 'mkt_compliance', ${veredito}, ${JSON.stringify(achados)}::jsonb,
              ${achados.filter((a: any) => a.gravidade === 'bloqueio').map((a: any) => a.regra).join(' · ') || null},
              ${rodada}, ${versaoMarca})
    `);
  } catch { /* o veredito ja vale mesmo se o historico falhar */ }

  if (veredito === 'bloqueado') {
    // Regra 2: retrabalho tem teto. Estourou, escala para humano COM o motivo,
    // em vez de devolver para o agente queimar token de novo.
    const escalado = rodada >= MAX_RODADAS;
    const destino = escalado ? 'aguardando_aprovacao' : 'bloqueado';
    await mover(id, 'em_revisao_ia', destino, 'agente', atorId, { escalado, brand_voice_versao: versaoMarca }, { veredito, rodada, escalado });
    return { ok: true, estado: destino, veredito, achados, rodada, escalado };
  }

  await mover(id, 'em_revisao_ia', 'aguardando_aprovacao', 'agente', atorId, { brand_voice_versao: versaoMarca }, { veredito, rodada });
  return { ok: true, estado: 'aguardando_aprovacao', veredito, achados, rodada, escalado: false };
}

// ---------------------------------------------------------------------------
// A fila - o que decide o projeto
// ---------------------------------------------------------------------------
// Enxuta de proposito: o que cabe num cartao de celular e nada alem disso.
// Peca com 40 campos nao e aprovada no onibus, e adiada.

export async function fila(limite = 40): Promise<{
  total: number; bloqueadas: number; comAviso: number; limpas: number; pecas: any[];
}> {
  const vazio = { total: 0, bloqueadas: 0, comAviso: 0, limpas: 0, pecas: [] as any[] };
  if (!(await garantirSchema())) return vazio;
  const lim = Math.min(Math.max(Number(limite) || 40, 1), 200);

  const r: any = await db.execute(sql`
    SELECT p.id, p.canal, p.formato, p.gancho, p.titulo, p.copy, p.asset_ids,
           p.cta_slug, p.campanha_id, p.rodada, p.escalado, p.agendado_para,
           p.origem, p.agente, p.criado_em, p.brand_voice_versao,
           c.codigo AS campanha_codigo, c.nome AS campanha_nome,
           r.veredito, r.itens, r.motivo
      FROM mkt_pieces p
      LEFT JOIN LATERAL (
        SELECT veredito, itens, motivo FROM mkt_reviews
         WHERE piece_id = p.id ORDER BY criado_em DESC LIMIT 1
      ) r ON true
      LEFT JOIN mkt_campanhas c ON c.id = p.campanha_id
     WHERE p.estado = 'aguardando_aprovacao'
     ORDER BY p.escalado DESC, p.agendado_para ASC NULLS LAST, p.criado_em ASC
     LIMIT ${lim}
  `);

  const pecas = (r.rows || []).map((x: any) => {
    const itens: any[] = Array.isArray(x.itens) ? x.itens : [];
    const bloqueios = itens.filter(i => i.gravidade === 'bloqueio');
    const avisos = itens.filter(i => i.gravidade === 'atencao');
    const assets: string[] = Array.isArray(x.asset_ids) ? x.asset_ids.map(String) : [];
    return {
      ...x,
      // Endereco pronto da miniatura: a fila do celular nao pode pedir 3 chamadas por peca.
      miniaturas: assets.slice(0, 3).map(a => '/api/mkt/assets/' + a + '/arquivo'),
      assetIds: assets,
      bloqueios: bloqueios.map(b => b.regra + (b.trecho ? ': ' + b.trecho : '')),
      avisos: avisos.map(b => b.regra),
      // Prévia curta: o suficiente para reconhecer a peça sem abrir.
      previa: String(x.copy || '').slice(0, 180),
      precisaAtencao: bloqueios.length > 0,
    };
  });

  return {
    total: pecas.length,
    bloqueadas: pecas.filter((p: any) => p.precisaAtencao).length,
    comAviso: pecas.filter((p: any) => !p.precisaAtencao && p.avisos.length > 0).length,
    limpas: pecas.filter((p: any) => !p.precisaAtencao && p.avisos.length === 0).length,
    pecas,
  };
}

// ---------------------------------------------------------------------------
// Decisao EM LOTE
// ---------------------------------------------------------------------------

export type Decisao = 'aprovar' | 'reprovar' | 'devolver';

export type ResultadoItem = { id: string; ok: boolean; estado?: string; motivo?: string };

export async function decidir(
  ids: string[],
  decisao: Decisao,
  opts?: { comentario?: string | null; quem?: string | null; assumirBloqueio?: boolean }
): Promise<{ ok: boolean; lote: string; aplicados: number; recusados: number; itens: ResultadoItem[]; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, lote: '', aplicados: 0, recusados: 0, itens: [], erro: 'schema indisponivel' };
  const lista = Array.from(new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean)));
  if (!lista.length) return { ok: false, lote: '', aplicados: 0, recusados: 0, itens: [], erro: 'nenhuma peca informada' };
  if (!['aprovar', 'reprovar', 'devolver'].includes(decisao)) {
    return { ok: false, lote: '', aplicados: 0, recusados: 0, itens: [], erro: 'decisao invalida' };
  }
  if (decisao !== 'aprovar' && !String(opts?.comentario || '').trim()) {
    // Devolver sem dizer o que esta errado joga o problema de volta sem informacao.
    return { ok: false, lote: '', aplicados: 0, recusados: 0, itens: [], erro: 'reprovar e devolver exigem comentario' };
  }

  let lote = '';
  try {
    const r: any = await db.execute(sql.raw('SELECT gen_random_uuid()::text AS id'));
    lote = String(r.rows[0].id);
  } catch { lote = 'lote'; }

  const destino: Estado = decisao === 'aprovar' ? 'aprovado' : decisao === 'reprovar' ? 'reprovado' : 'em_producao';
  const itens: ResultadoItem[] = [];

  for (const id of lista) {
    const p = await verPeca(id);
    if (!p) { itens.push({ id, ok: false, motivo: 'peca nao encontrada' }); continue; }
    if (p.estado !== 'aguardando_aprovacao') {
      itens.push({ id, ok: false, estado: p.estado, motivo: 'nao esta na fila (estado: ' + p.estado + ')' });
      continue;
    }

    // O portao de verdade: peca que o revisor BLOQUEOU nao vira aprovada de
    // raspao num "aprovar tudo". Quem quiser aprovar assume por escrito.
    let sobrepos = false;
    if (decisao === 'aprovar') {
      const ult: any = await db.execute(sql`SELECT veredito FROM mkt_reviews WHERE piece_id = ${id} ORDER BY criado_em DESC LIMIT 1`);
      const veredito = ult.rows?.[0]?.veredito;
      if (veredito === 'bloqueado') {
        if (!opts?.assumirBloqueio) {
          itens.push({ id, ok: false, estado: p.estado, motivo: 'o revisor bloqueou esta peca - aprovar exige assumir o bloqueio' });
          continue;
        }
        sobrepos = true;
      }
    }

    const mv = await mover(id, p.estado, destino, 'humano', opts?.quem, undefined, { decisao, lote, sobrepos });
    if (!mv.ok) { itens.push({ id, ok: false, estado: p.estado, motivo: mv.erro }); continue; }

    try {
      await db.execute(sql`
        INSERT INTO mkt_approvals (piece_id, decisao, decidido_por, comentario, sobrepos_bloqueio, lote)
        VALUES (${id}, ${decisao}, ${opts?.quem || null}, ${opts?.comentario || null}, ${sobrepos}, ${lote})
      `);
    } catch { /* a transicao ja esta auditada */ }

    itens.push({ id, ok: true, estado: destino });
  }

  const aplicados = itens.filter(i => i.ok).length;
  return { ok: aplicados > 0, lote, aplicados, recusados: itens.length - aplicados, itens };
}

/** "Aprovar tudo, exceto estas" - o gesto que o plano pede na regra 3. */
export async function aprovarTudoExceto(excecoes: string[], opts?: { quem?: string | null; assumirBloqueio?: boolean }): Promise<any> {
  const f = await fila(200);
  const fora = new Set((Array.isArray(excecoes) ? excecoes : []).map(String));
  const alvos = f.pecas.map((p: any) => String(p.id)).filter(id => !fora.has(id));
  if (!alvos.length) return { ok: false, aplicados: 0, recusados: 0, itens: [], erro: 'nada para aprovar' };
  return decidir(alvos, 'aprovar', opts);
}

// ---------------------------------------------------------------------------
// Publicar
// ---------------------------------------------------------------------------
// O publicador automatico depende do App Review da Meta (buraco 1). Ate la, o
// plano ja previa: a peca sai pronta e voce posta no celular. Marcar como
// publicada aqui e o que fecha o ciclo - e e SO AQUI que o criativo conta uso,
// porque uso e o que foi ao ar, nao o que foi aprovado.

export async function marcarPublicada(id: string, dados?: { externalMediaId?: string | null; permalink?: string | null; quem?: string | null }): Promise<{
  ok: boolean; estado?: string; usosRegistrados?: number; postId?: string | null; avisos?: string[]; erro?: string;
}> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const p = await verPeca(id);
  if (!p) return { ok: false, erro: 'peca nao encontrada' };
  if (!podeIr(p.estado, 'publicado')) return { ok: false, erro: 'so peca aprovada ou agendada vai ao ar (estado: ' + p.estado + ')' };

  const mv = await mover(id, p.estado, 'publicado', 'humano', dados?.quem, {
    publicado_em: true, external_media_id: dados?.externalMediaId, permalink: dados?.permalink,
  }, { permalink: dados?.permalink || null });
  if (!mv.ok) return { ok: false, erro: mv.erro };

  // Buraco 1: peca publicada vira registro de post, sem digitar nada duas vezes.
  // A peca ja sabe canal, gancho, campanha, criativo e legenda - o registro so herda.
  let postId: string | null = null;
  try {
    const { registrarDaPeca } = await import('./mkt-posts');
    const rp = await registrarDaPeca({ ...p, permalink: dados?.permalink || p.permalink }, dados?.permalink, dados?.quem);
    if (rp.ok) postId = rp.id || null;
  } catch { /* o registro do post nao pode impedir a peca de ser marcada como publicada */ }

  // Fecha o laco com o buraco 5: o criativo entra em descanso e passa a contar
  // no desempenho por gancho, com a campanha desta peca.
  const avisos: string[] = [];
  let usos = 0;
  const assets: string[] = Array.isArray(p.asset_ids) ? p.asset_ids.map(String) : [];
  if (assets.length) {
    try {
      const { registrarUso } = await import('./mkt-assets');
      for (const a of assets) {
        const r = await registrarUso({
          assetId: Number(a), canal: String(p.canal || ''),
          campanhaId: p.campanha_id || null, linkSlug: p.cta_slug || null,
          gancho: p.gancho || null, ref: 'peca:' + id, criadoPor: dados?.quem || null,
          ignorarDescanso: true, // ja foi ao ar: negar o registro nao desfaz o post
        });
        if (r.ok) usos++;
        else avisos.push('criativo ' + a + ': ' + (r.motivo || r.erro));
      }
    } catch (e: any) {
      avisos.push('biblioteca de criativos indisponivel: ' + String(e?.message || e));
    }
  }

  return { ok: true, estado: 'publicado', usosRegistrados: usos, postId, avisos };
}

export async function agendar(id: string, quando: string, quem?: string | null): Promise<{ ok: boolean; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const p = await verPeca(id);
  if (!p) return { ok: false, erro: 'peca nao encontrada' };
  if (!quando) return { ok: false, erro: 'informe a data' };
  return mover(id, p.estado, 'agendado', 'humano', quem, { agendado_para: quando }, { quando });
}

// ---------------------------------------------------------------------------
// Historico e panorama
// ---------------------------------------------------------------------------

/**
 * Apaga uma peca. Peca PUBLICADA nunca sai: e historico, e o uso do criativo
 * aponta para ela. Para tirar da frente algo que nao vai ao ar, o caminho e
 * reprovar - apagar e so para o que foi criado por engano.
 */
export async function removerPeca(id: string): Promise<{ ok: boolean; erro?: string }> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const p = await verPeca(id);
  if (!p) return { ok: false, erro: 'peca nao encontrada' };
  if (p.estado === 'publicado') return { ok: false, erro: 'peca publicada nao se apaga - ela e o historico do que foi ao ar' };
  try {
    await db.execute(sql`DELETE FROM mkt_reviews WHERE piece_id = ${id}`);
    await db.execute(sql`DELETE FROM mkt_approvals WHERE piece_id = ${id}`);
    await auditar(id, p.estado, null, 'humano', null, { acao: 'apagada' });
    await db.execute(sql`DELETE FROM mkt_pieces WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, erro: String(e?.message || e) };
  }
}

/** Peças num estado, com o mesmo enxugamento da fila (miniatura pronta, prévia curta). */
export async function listarPorEstado(estado: string, limite = 30): Promise<any[]> {
  if (!(await garantirSchema())) return [];
  if (!(ESTADOS as readonly string[]).includes(String(estado))) return [];
  const lim = Math.min(Math.max(Number(limite) || 30, 1), 200);
  const r: any = await db.execute(sql`
    SELECT p.id, p.canal, p.gancho, p.titulo, p.copy, p.asset_ids, p.cta_slug,
           p.campanha_id, p.estado, p.agendado_para, p.publicado_em, p.permalink,
           p.origem, p.criado_em, c.codigo AS campanha_codigo
      FROM mkt_pieces p
      LEFT JOIN mkt_campanhas c ON c.id = p.campanha_id
     WHERE p.estado = ${estado}
     ORDER BY p.atualizado_em DESC
     LIMIT ${lim}
  `);
  return (r.rows || []).map((x: any) => {
    const assets: string[] = Array.isArray(x.asset_ids) ? x.asset_ids.map(String) : [];
    return {
      ...x,
      assetIds: assets,
      miniaturas: assets.slice(0, 3).map(a => '/api/mkt/assets/' + a + '/arquivo'),
      previa: String(x.copy || '').slice(0, 180),
    };
  });
}

export async function historicoDaPeca(id: string): Promise<{ peca: any; revisoes: any[]; decisoes: any[]; trilha: any[] }> {
  const vazio = { peca: null, revisoes: [], decisoes: [], trilha: [] };
  if (!(await garantirSchema())) return vazio;
  const peca = await verPeca(id);
  if (!peca) return vazio;
  const rev: any = await db.execute(sql`SELECT * FROM mkt_reviews WHERE piece_id = ${id} ORDER BY criado_em ASC`);
  const dec: any = await db.execute(sql`SELECT * FROM mkt_approvals WHERE piece_id = ${id} ORDER BY decidido_em ASC`);
  const aud: any = await db.execute(sql`SELECT * FROM mkt_audit WHERE entidade = 'peca' AND entidade_id = ${id} ORDER BY criado_em ASC`);
  return { peca, revisoes: rev.rows || [], decisoes: dec.rows || [], trilha: aud.rows || [] };
}

export async function panoramaEsteira(dias = 30): Promise<any> {
  if (!(await garantirSchema())) return { ok: false, erro: 'schema indisponivel' };
  const porEstado: any = await db.execute(sql`SELECT estado, COUNT(*)::int AS n FROM mkt_pieces GROUP BY estado`);
  const g: any = await db.execute(sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE estado = 'aguardando_aprovacao')::int AS na_fila,
           COUNT(*) FILTER (WHERE estado = 'aguardando_aprovacao' AND escalado)::int AS escaladas,
           COUNT(*) FILTER (WHERE estado = 'bloqueado')::int AS bloqueadas,
           COUNT(*) FILTER (WHERE estado = 'publicado')::int AS publicadas,
           COUNT(*) FILTER (WHERE origem = 'agente')::int AS de_agente
      FROM mkt_pieces
     WHERE criado_em >= NOW() - (${dias}::text || ' days')::interval
  `);
  // Quanto tempo a peca espera voce. E o numero que diz se o portao virou gargalo.
  const espera: any = await db.execute(sql`
    SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (a.decidido_em - p.criado_em)) / 3600)::numeric, 1), 0) AS horas
      FROM mkt_approvals a JOIN mkt_pieces p ON p.id = a.piece_id
     WHERE a.decidido_em >= NOW() - (${dias}::text || ' days')::interval
  `);
  const revisor: any = await db.execute(sql`
    SELECT veredito, COUNT(*)::int AS n FROM mkt_reviews
     WHERE criado_em >= NOW() - (${dias}::text || ' days')::interval
     GROUP BY veredito
  `);
  return {
    ok: true, dias,
    ...(g.rows?.[0] || {}),
    horasMediasAteDecisao: Number(espera.rows?.[0]?.horas || 0),
    porEstado: porEstado.rows || [],
    revisorIA: revisor.rows || [],
    maxRodadas: MAX_RODADAS,
    estados: ESTADOS,
  };
}
