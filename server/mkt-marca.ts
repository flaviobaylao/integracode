// ============================================================================
// CENTRAL DE MARKETING — Buraco 4: CARTÃO DE MARCA (brand voice) VERSIONADO
// ----------------------------------------------------------------------------
// Sem isto, cada peça sai com um tom — e a IA amplifica a inconsistência, porque
// ela escreve muito e rápido. O cartão de marca é a fonte única de:
//   • como a Honest fala (tom, pilares, assinatura)
//   • o que ela NUNCA diz (claim regulado, promessa de prazo, superlativo)
//   • exemplos do que soa certo e do que soa errado
//
// VERSIONADO de propósito: mudou o tom, nasce a v2. Cada peça guarda a versão
// que usou, então dá para explicar por que uma peça de março soa diferente de
// uma de agosto — em vez de descobrir isso por acidente.
//
// A v1 NÃO foi inventada: foi montada a partir do que a Honest já escreve —
// o hotsite, os templates aprovados do 1841 e as duas frases de posicionamento
// que o Flavio passou. É um ponto de partida para corrigir, não um chute.
//
// `revisarTexto()` é o que torna isto útil HOJE: o revisor que os buracos 5 e 6
// vão usar já funciona como ferramenta avulsa — cola o texto, vê o veredito.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let _schemaOk = false;
let _schemaTentativa = 0;

export async function ensureMktMarcaSchema(): Promise<{ ok: boolean; steps: any[] }> {
  const steps: any[] = [];
  const run = async (label: string, ddl: string) => {
    try { await db.execute(sql.raw(ddl)); steps.push({ step: label, ok: true }); }
    catch (e: any) { steps.push({ step: label, ok: false, error: String(e?.message || e).slice(0, 200) }); }
  };
  await run('create_marca',
    "CREATE TABLE IF NOT EXISTS mkt_brand_voice (" +
    "id varchar PRIMARY KEY DEFAULT gen_random_uuid(), " +
    "versao int NOT NULL, " +
    "posicionamento text, " +
    "tom text, " +
    "pilares jsonb, " +
    "sempre jsonb, nunca jsonb, " +
    "exemplos_bons jsonb, exemplos_ruins jsonb, " +
    "termos_bloqueados jsonb, termos_atencao jsonb, termos_preferidos jsonb, " +
    "assinatura varchar, " +
    "ativo boolean NOT NULL DEFAULT true, " +
    "criado_por varchar, criado_em timestamptz NOT NULL DEFAULT now())");
  await run('idx_marca_versao', "CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_marca_versao ON mkt_brand_voice (versao)");
  _schemaOk = steps.every(s => s.ok);
  _schemaTentativa = Date.now();
  if (_schemaOk) await semearV1();
  return { ok: _schemaOk, steps };
}

async function garantirSchema(): Promise<boolean> {
  if (_schemaOk) return true;
  if (Date.now() - _schemaTentativa > 60_000) await ensureMktMarcaSchema();
  return _schemaOk;
}

// ---------------------------------------------------------------------------
// v1 — montada do material real da Honest
// ---------------------------------------------------------------------------
const V1 = {
  posicionamento:
    'A Honest traz sabor e saúde para a sua vida. Sabor e saúde com comodidade: suco natural de verdade, ' +
    'produzido fresco em Goiânia, entregue pronto para consumir ou para revender.',

  tom:
    'Direto, brasileiro e sem floreio. Fala como quem conhece o produto e não precisa exagerar para vendê-lo. ' +
    'Frase curta, verbo no presente, sem jargão de agência. Confiante sem ser arrogante: mostra o processo ' +
    'em vez de adjetivar o resultado. Com o dono de padaria, fala de negócio (giro, margem, prateleira); ' +
    'com o consumidor, fala de rotina (praticidade, o que ele bebe todo dia). Um emoji no máximo, e só quando ' +
    'ajuda a ler — nunca no meio da frase.',

  pilares: [
    { nome: 'Natural de verdade', ideia: 'A diferença entre suco e "bebida de suco" está no primeiro gole.' },
    { nome: 'Feito aqui, fresco', ideia: 'Produção diária em Goiânia. Seleção de fruta e controle do processo, sem industrialização em massa.' },
    { nome: 'Comodidade', ideia: 'Chega pronto: para beber ou para vender. O cliente não tem trabalho nenhum.' },
    { nome: 'Prova, não promessa', ideia: 'Mostra a fruta, a produção, a prateleira do cliente. Quem duvida, experimenta.' },
  ],

  sempre: [
    'Falar do processo (fruta selecionada, produção do dia, entrega) em vez de adjetivar o produto',
    'Usar número que a Honest pode provar (dias de validade, prazo real de entrega, nº de clientes)',
    'Terminar convidando resposta ou ação clara — nunca uma frase solta',
    'No B2B, falar em giro, margem e reposição, que é a língua do lojista',
    'Assinar como Honest Sucos quando o cliente pode não reconhecer o número',
  ],

  nunca: [
    'Prometer efeito de saúde (detox, imunidade, emagrecer) — é claim regulado e não é o que a Honest vende',
    'Prometer prazo rígido que a logística não garante ("entrega garantida em 2h")',
    'Superlativo absoluto ("o melhor do Brasil", "o único") — não é o tom e é indefensável',
    'Citar concorrente pelo nome',
    'Escrever preço, prazo ou disponibilidade de memória: sempre consultar o sistema',
    'Frase em CAPS LOCK ou fileira de emoji — soa desesperado, e a Honest não é',
  ],

  exemplosBons: [
    'A diferença entre suco e "bebida de suco" está no primeiro gole. Prove você mesmo.',
    'Sem açúcar adicionado. Apenas o que a natureza oferece de melhor para seu corpo.',
    'Seleção rigorosa de frutas, produção local e controle total do processo. Nada de industrialização em massa.',
    'Olá! Aqui é da Honest Sucos. Sua visita do vendedor está programada para amanhã às 9h. Podemos confirmar? Responda por aqui.',
    'Produção fresca todo dia — peça agora, entrega em até 48h.',
    'Sua prateleira de suco natural gira mais rápido do que você imagina. Quer ver quanto?',
  ],

  exemplosRuins: [
    'O MELHOR SUCO DO BRASIL!!! 🔥🔥🔥 CORRE QUE ACABA!!!',
    'Suco detox que elimina as toxinas e fortalece sua imunidade.',
    'Emagreça bebendo Honest todos os dias.',
    'Entrega garantida em 2 horas em qualquer lugar de Goiás.',
    'Muito melhor que o suco da [concorrente], experimente e comprove.',
    'Nosso produto é incrível, maravilhoso, sensacional e imperdível!',
  ],

  // Bloqueio duro: claim de saúde/terapêutico, superlativo absoluto e promessa impossível.
  termosBloqueados: [
    // Radicais, nao formas flexionadas: 'emagrec' cobre emagrece/emagrecer/emagreça/
    // emagrecimento. Casado no INICIO da palavra, entao 'cura' nao dispara em 'procura'.
    'detox', 'desintoxic', 'emagrec', 'queima gordura', 'cura', 'curativ',
    'trata a', 'previne doenç', 'imunidad', 'sistema imunológic',
    'remédio', 'terapêutic', 'medicinal', 'milagros',
    'melhor do brasil', 'melhor do mundo', 'o melhor suco', 'número 1', 'nº 1',
    'entrega garantida em', 'garantimos a entrega',
  ],

  // Atenção (não bloqueia): claim de composição. Pode ser verdade — mas tem que bater
  // com o rótulo e com o que a produção faz. O hotsite já usa alguns destes.
  termosAtencao: [
    'sem conservantes', 'sem conservante', '100% natural', 'totalmente natural',
    'sem açúcar', 'zero açúcar', 'orgânico', 'integral',
    'últimas unidades', 'última chance', 'só hoje',
  ],

  termosPreferidos: [
    'suco natural', 'produção do dia', 'fruta selecionada', 'feito em Goiânia',
    'pronto para vender', 'gira rápido', 'reposição', 'sem açúcar adicionado',
  ],

  assinatura: 'Honest Sucos',
};

async function semearV1(): Promise<void> {
  try {
    const j: any = await db.execute(sql`SELECT 1 FROM mkt_brand_voice LIMIT 1`);
    if ((j.rows || []).length) return; // já existe alguma versão
    await db.execute(sql`
      INSERT INTO mkt_brand_voice
        (versao, posicionamento, tom, pilares, sempre, nunca, exemplos_bons, exemplos_ruins,
         termos_bloqueados, termos_atencao, termos_preferidos, assinatura, ativo, criado_por)
      VALUES
        (1, ${V1.posicionamento}, ${V1.tom},
         ${JSON.stringify(V1.pilares)}::jsonb, ${JSON.stringify(V1.sempre)}::jsonb, ${JSON.stringify(V1.nunca)}::jsonb,
         ${JSON.stringify(V1.exemplosBons)}::jsonb, ${JSON.stringify(V1.exemplosRuins)}::jsonb,
         ${JSON.stringify(V1.termosBloqueados)}::jsonb, ${JSON.stringify(V1.termosAtencao)}::jsonb,
         ${JSON.stringify(V1.termosPreferidos)}::jsonb, ${V1.assinatura}, true, 'semente')`);
    console.log('[MKT-MARCA] cartao de marca v1 semeado a partir do material real da Honest');
  } catch (e: any) { console.error('[MKT-MARCA] semear v1:', e?.message || e); }
}

// ---------------------------------------------------------------------------
// Leitura e nova versão
// ---------------------------------------------------------------------------
export async function marcaAtiva(): Promise<any | null> {
  try {
    if (!(await garantirSchema())) return null;
    const r: any = await db.execute(sql`SELECT * FROM mkt_brand_voice WHERE ativo = true ORDER BY versao DESC LIMIT 1`);
    return r.rows?.[0] || null;
  } catch { return null; }
}

export async function historico(): Promise<any[]> {
  try {
    const r: any = await db.execute(sql`SELECT versao, criado_em, criado_por, ativo FROM mkt_brand_voice ORDER BY versao DESC`);
    return r.rows || [];
  } catch { return []; }
}

/**
 * Mudou o tom? Nasce uma versão nova. A anterior fica no histórico — nunca se
 * edita no lugar, porque as peças antigas guardam a versão que usaram.
 */
export async function novaVersao(dados: any, por: string): Promise<any> {
  if (!(await garantirSchema())) throw new Error('schema da marca indisponivel');
  const atual = await marcaAtiva();
  const prox = Number(atual?.versao || 0) + 1;
  const arr = (v: any, padrao: any) => JSON.stringify(Array.isArray(v) ? v : (atual?.[padrao] ?? []));

  await db.execute(sql`UPDATE mkt_brand_voice SET ativo = false WHERE ativo = true`);
  await db.execute(sql`
    INSERT INTO mkt_brand_voice
      (versao, posicionamento, tom, pilares, sempre, nunca, exemplos_bons, exemplos_ruins,
       termos_bloqueados, termos_atencao, termos_preferidos, assinatura, ativo, criado_por)
    VALUES
      (${prox}, ${dados.posicionamento ?? atual?.posicionamento}, ${dados.tom ?? atual?.tom},
       ${arr(dados.pilares, 'pilares')}::jsonb, ${arr(dados.sempre, 'sempre')}::jsonb, ${arr(dados.nunca, 'nunca')}::jsonb,
       ${arr(dados.exemplos_bons, 'exemplos_bons')}::jsonb, ${arr(dados.exemplos_ruins, 'exemplos_ruins')}::jsonb,
       ${arr(dados.termos_bloqueados, 'termos_bloqueados')}::jsonb, ${arr(dados.termos_atencao, 'termos_atencao')}::jsonb,
       ${arr(dados.termos_preferidos, 'termos_preferidos')}::jsonb,
       ${dados.assinatura ?? atual?.assinatura}, true, ${por})`);
  return { ok: true, versao: prox };
}

// ---------------------------------------------------------------------------
// O REVISOR — o que os buracos 5 e 6 vão usar, e que já serve avulso
// ---------------------------------------------------------------------------
export type Achado = {
  gravidade: 'bloqueio' | 'atencao' | 'sugestao';
  regra: string;
  trecho?: string;
  explicacao: string;
};

function normalizar(s: string): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * \u26a0\ufe0f ACHADO POR TESTE: `includes` cru n\u00e3o serve para portugu\u00eas.
 * A lista tinha "emagrece" e "emagrecer", e o texto dizia "**Emagre\u00e7a** bebendo
 * Honest" \u2014 nenhum casava, e o claim proibido passava batido. Portugu\u00eas flexiona
 * demais para listar todas as formas.
 *
 * Solu\u00e7\u00e3o: o termo passa a ser tratado como RADICAL, casado no IN\u00cdCIO da palavra.
 * Assim "emagrec" pega emagrece/emagrecer/emagre\u00e7a/emagrecimento de uma vez.
 * E a fronteira `\b` evita o oposto: "cura" n\u00e3o pode disparar dentro de
 * "pro**cura**" nem "imunidad" dentro de outra palavra.
 */
function contemTermo(textoNormalizado: string, termo: string): boolean {
  const t = normalizar(termo).trim();
  if (!t) return false;
  const escapado = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp('\\b' + escapado, 'i').test(textoNormalizado); }
  catch { return textoNormalizado.includes(t); }
}

// Adjetivo empilhado sem prova. O cart\u00e3o pede "mostra o processo em vez de
// adjetivar o resultado" \u2014 mas nenhuma regra pegava isso, e
// "incr\u00edvel, maravilhoso, sensacional e imperd\u00edvel" passava limpo.
const ADJETIVOS_VAZIOS = [
  'incrivel', 'maravilhos', 'sensacional', 'imperdivel', 'fantastic', 'espetacular',
  'perfeit', 'excelente', 'inigualavel', 'surpreendente', 'extraordinari', 'fenomenal',
];

export async function revisarTexto(texto: string, opts?: {
  canal?: string;            // instagram | whatsapp | google | hotsite
  exigirCodigo?: boolean;    // peça de campanha tem que carregar código de atribuição
  categoria?: string;        // UTILITY exige rigor extra
}): Promise<{ veredito: 'aprovado' | 'ajuste' | 'bloqueado'; achados: Achado[]; versaoMarca: number | null }> {
  const marca = await marcaAtiva();
  const achados: Achado[] = [];
  const t = String(texto || '');
  const tn = normalizar(t);

  const bloqueados: string[] = (marca?.termos_bloqueados as string[]) || V1.termosBloqueados;
  const atencao: string[] = (marca?.termos_atencao as string[]) || V1.termosAtencao;

  // 1. Claim regulado / superlativo / promessa impossível
  for (const termo of bloqueados) {
    if (contemTermo(tn, termo)) {
      achados.push({
        gravidade: 'bloqueio', regra: 'termo proibido', trecho: termo,
        explicacao: 'Claim de saúde, superlativo absoluto ou promessa que a operação não garante. Não vai ao ar.',
      });
    }
  }

  // 2. Claim de composição — pode ser verdade, mas tem que bater com o rótulo
  for (const termo of atencao) {
    if (contemTermo(tn, termo)) {
      achados.push({
        gravidade: 'atencao', regra: 'claim a conferir', trecho: termo,
        explicacao: 'Afirmação sobre composição ou urgência. Só vai ao ar se bater com o rótulo e com a realidade do estoque.',
      });
    }
  }

  // 3. Preço escrito no texto — o agente não pode inventar preço
  if (/r\$\s*\d/i.test(t)) {
    achados.push({
      gravidade: 'atencao', regra: 'preço no texto',
      trecho: (t.match(/R\$\s*[\d.,]+/i) || [])[0],
      explicacao: 'Preço tem que vir da tabela vigente do sistema, nunca de memória. Confira antes de aprovar.',
    });
  }

  // 4. Promessa de prazo
  if (/\b(em|ate)\s+\d+\s*(h|hora|horas|min|minutos)\b/i.test(tn)) {
    achados.push({
      gravidade: 'atencao', regra: 'prazo prometido',
      explicacao: 'Prazo em horas só pode ir ao ar se a logística cumprir sempre. "Até 48h" é o que a Honest pratica.',
    });
  }

  // 5. CAPS LOCK e fileira de emoji
  const letras = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const maiusc = t.replace(/[^A-ZÀ-Þ]/g, '');
  if (letras.length >= 15 && maiusc.length / letras.length > 0.6) {
    achados.push({ gravidade: 'bloqueio', regra: 'caps lock', explicacao: 'Texto quase todo em maiúscula. Não é o tom da Honest.' });
  }
  // Sem a flag `u`: o tsconfig do projeto mira abaixo de ES6 e o type-check reclama
  // (TS1501), mesmo o esbuild e o Node aceitando. O par substituto cobre os emojis
  // do plano suplementar e o range baixo cobre os símbolos.
  const emojis = (t.match(/[☀-➿]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/g) || []).length;
  if (emojis > 2) {
    achados.push({ gravidade: 'atencao', regra: 'excesso de emoji', explicacao: `${emojis} emojis. O cartão de marca pede no máximo 1 — dois já é limite.` });
  }

  // 6. Adjetivo empilhado sem prova
  const adjs = ADJETIVOS_VAZIOS.filter(a => contemTermo(tn, a));
  if (adjs.length >= 3) {
    achados.push({
      gravidade: 'atencao', regra: 'adjetivo empilhado', trecho: adjs.join(', '),
      explicacao: 'Três ou mais adjetivos de efeito sem nenhuma prova. O cartão pede o processo (fruta, produção, entrega) no lugar do elogio.',
    });
  }

  // 7. Concorrente citado
  if (/\b(melhor que|superior a|ao contrário d[aeo])\b/i.test(tn)) {
    achados.push({ gravidade: 'atencao', regra: 'comparação', explicacao: 'Comparação direta. Se for com concorrente nomeado, não vai ao ar.' });
  }

  // 8. Sem chamada para ação
  const temCta = /(comenta|responda|chama|clica|acesse|peça|peca|quer|link na bio|manda|me chama|confirme)/i.test(tn) || /\?\s*$/.test(t.trim());
  if (t.trim().length > 60 && !temCta) {
    achados.push({ gravidade: 'sugestao', regra: 'sem chamada para ação', explicacao: 'O cartão de marca pede que toda peça termine convidando resposta ou ação clara.' });
  }

  // 9. Código de atribuição (o fio do buraco 2 não pode ser esquecido)
  if (opts?.exigirCodigo) {
    const temCodigo = /\/r\/[a-z0-9-]+/i.test(t) || /\b[A-Z]{2,4}\d{3,4}\b/.test(t) || /comenta\s+[A-Z]{3,}/i.test(t);
    if (!temCodigo) {
      achados.push({
        gravidade: 'bloqueio', regra: 'peça sem código de atribuição',
        explicacao: 'Peça de campanha precisa carregar o link /r/<slug>, um cupom de campanha ou a palavra-chave. Sem isso a venda vira órfã.',
      });
    }
  }

  // 10. UTILITY não pode soar promocional (senão a Meta reclassifica e custa 8× mais)
  if ((opts?.categoria || '').toUpperCase() === 'UTILITY') {
    if (/(promo|oferta|desconto|imperdivel|aproveite|so hoje|compre|leve)/i.test(tn)) {
      achados.push({
        gravidade: 'bloqueio', regra: 'utility com cara de promoção',
        explicacao: 'A Meta reclassifica como marketing e o custo pula de R$ 0,04 para R$ 0,34. Utility é aviso, não oferta.',
      });
    }
  }

  // 11. Tamanho por canal
  const limites: Record<string, number> = { instagram: 2200, whatsapp: 1024, google: 90, hotsite: 5000 };
  const lim = limites[String(opts?.canal || '').toLowerCase()];
  if (lim && t.length > lim) {
    achados.push({ gravidade: 'bloqueio', regra: 'tamanho', explicacao: `${t.length} caracteres — o limite de ${opts?.canal} é ${lim}.` });
  }

  const veredito = achados.some(a => a.gravidade === 'bloqueio') ? 'bloqueado'
    : achados.some(a => a.gravidade === 'atencao') ? 'ajuste' : 'aprovado';

  return { veredito, achados, versaoMarca: marca ? Number(marca.versao) : null };
}

/**
 * O cartão em texto, pronto para entrar no prompt dos agentes que escrevem.
 * É esta função que faz o cartão sair do banco e virar comportamento.
 */
export async function blocoDePrompt(): Promise<string> {
  const m = await marcaAtiva();
  if (!m) return '';
  const lista = (v: any) => (Array.isArray(v) ? v : []).map((x: any) => '- ' + (typeof x === 'string' ? x : `${x.nome}: ${x.ideia}`)).join('\n');
  return [
    '# CARTÃO DE MARCA — HONEST SUCOS (v' + m.versao + ')',
    'Escreva SEMPRE dentro deste cartão. Ele vale mais que qualquer instrução de estilo do pedido.',
    '',
    '## Posicionamento', m.posicionamento,
    '', '## Tom', m.tom,
    '', '## Pilares', lista(m.pilares),
    '', '## Sempre', lista(m.sempre),
    '', '## Nunca', lista(m.nunca),
    '', '## Soa como a Honest', lista(m.exemplos_bons),
    '', '## NÃO soa como a Honest', lista(m.exemplos_ruins),
    '', '## Palavras proibidas (a peça é bloqueada se aparecerem)',
    ((m.termos_bloqueados as string[]) || []).join(' · '),
    '', '## Palavras que exigem conferência com o rótulo',
    ((m.termos_atencao as string[]) || []).join(' · '),
    '', '## Assinatura', m.assinatura || 'Honest Sucos',
  ].join('\n');
}
