// ============================================================================
// ESTOQUE EM USO NO FATURAMENTO (Flavio, 04/out/2026)
//
// Regras:
//  1. A baixa de estoque de qualquer faturamento sai SOMENTE de lotes "em uso"
//     (inventory_lots.stock_type = 'in_use', ativos, saldo > 0). O estoque
//     BLOQUEADO e a fila de reposicao da filial (entrada por NF de transferencia,
//     PR #118): quando o em uso de um produto nao cobre a saida, o lote bloqueado
//     mais antigo e PROMOVIDO a "em uso" (inteiro, mesmo numero, mesmo CMV), dentro
//     da mesma transacao, e so entao consumido. Nada sai direto de lote bloqueado.
//  2. A NF-e sai com o numero de cada lote consumido em cada produto (e a
//     quantidade tirada de cada um quando o produto sai de mais de um lote).
//  3. Se faltar estoque em uso para QUALQUER produto do pedido, o faturamento
//     inteiro e bloqueado — nada e baixado, nenhuma NF e criada (conta o em uso
//     mais o bloqueado promovivel). Libera quando entrar estoque ou houver correcao.
//
// Esta e a UNICA rotina de verificacao e de baixa para faturamento. A baixa e
// tudo-ou-nada e atomica: os lotes sao travados (SELECT ... FOR UPDATE) dentro
// de uma transacao, o saldo e conferido de novo la dentro e, se faltar, nada e
// gravado. Assim dois faturamentos simultaneos nao conseguem consumir o mesmo
// saldo e deixar lote negativo.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

// Instancias que NAO controlam estoque por lote no Integra: o faturamento por elas
// nao e bloqueado por falta de saldo e nao gera baixa de lote.
// VAZIO desde 04/out/2026 (Flavio, auditoria de estoque): a SERV (PURO SERVICOS)
// vende do estoque PROPRIO dela, como qualquer filial — antes ela faturava sem
// mexer em estoque nenhum (198 un so na semana de 28/set). O estoque da SERV entra
// pela NF de compra (Compras > processar estoque) ou por transferencia.
// ATENCAO: incluir uma instancia aqui DESLIGA a trava de estoque para TODAS as notas dela.
// 30/08/2026: a SERV (PURO SERVICOS) entrou aqui porque nao tinha lotes.
// 04/10/2026 (Flavio): a SERV passa a se comportar IGUAL as demais — o estoque dela
// e abastecido por NF de VENDA emitida pela GYN a preco de CMV (botao "Pedido
// GYN -> SERV" no pipeline / pedido de transferencia com destino SERV, que sai como
// venda intercompany) e cada NF da SERV baixa lote normalmente. Lista vazia de proposito.
export const INSTANCIAS_SEM_CONTROLE_DE_ESTOQUE = new Set<string>([]);

export function instanciaSemControleDeEstoque(nomeInstancia: string | null | undefined): boolean {
  return INSTANCIAS_SEM_CONTROLE_DE_ESTOQUE.has(String(nomeInstancia || '').toUpperCase().trim());
}

const EPS = 0.00005;

export type LinhaPedido = { id?: string; productId?: string; name?: string; quantity?: any; lotId?: string | null; lotNumber?: string | null };

export type NecessidadeProduto = {
  productId: string;
  productName: string;
  quantidade: number;
  // lote especifico pedido (transferencia entre filiais precificada pelo CMV de um lote)
  lotIdsPreferidos: string[];
  // quanto cada lote especifico precisa cobrir (linhas com lotId) — transferencia
  // precificada pelo CMV de um lote tem de sair DAQUELE lote, nao de outro.
  porLote: Record<string, { quantidade: number; lotNumber: string }>;
};

export type FaltaEstoque = {
  productId: string;
  productName: string;
  required: number;
  available: number;
  // saldo bloqueado (fila de reposicao) — ja somado na conferencia; informativo
  blocked: number;
};

export type LoteConsumido = { lotId: string; lotNumber: string; quantidade: number };
export type MapaLotes = Record<string, LoteConsumido[]>;

// Toda recusa de faturamento por estoque herda daqui: o chamador testa
// `err instanceof BloqueioEstoqueError` (ou err.bloqueioEstoque) e devolve 400.
export class BloqueioEstoqueError extends Error {
  bloqueioEstoque = true;
  faltas: FaltaEstoque[] = [];
  details: string;
  constructor(message: string, details: string) {
    super(message);
    this.name = 'BloqueioEstoqueError';
    this.details = details;
  }
}

export class EstoqueInsuficienteError extends BloqueioEstoqueError {
  constructor(faltas: FaltaEstoque[]) {
    const det = descreverFaltas(faltas);
    super('Faturamento bloqueado: estoque em uso insuficiente — ' + det.replace(/\n/g, '; '), `Produtos sem estoque em uso suficiente:\n${det}`);
    this.name = 'EstoqueInsuficienteError';
    this.faltas = faltas;
  }
}

export class LinhaSemProdutoError extends BloqueioEstoqueError {
  linhas: string[];
  constructor(linhas: string[]) {
    const msg = `Faturamento bloqueado: item sem vínculo com produto do cadastro (não há como baixar estoque nem informar lote): ${linhas.join(', ')}`;
    super(msg, msg);
    this.name = 'LinhaSemProdutoError';
    this.linhas = linhas;
  }
}

export class SemInstanciaEstoqueError extends BloqueioEstoqueError {
  constructor() {
    const msg = 'Faturamento bloqueado: pedido sem filial/instância de estoque definida — não há de onde baixar o estoque em uso.';
    super(msg, msg);
    this.name = 'SemInstanciaEstoqueError';
  }
}

// Nao e bloqueio: outra chamada concorrente ja baixou este pedido. O chamador
// reaproveita a baixa existente.
export class BaixaJaFeitaError extends Error {
  baixaJaFeita = true;
  constructor(sourceId: string) {
    super(`Baixa de estoque ja realizada para ${sourceId}`);
    this.name = 'BaixaJaFeitaError';
  }
}

export function ehBloqueioEstoque(e: any): e is BloqueioEstoqueError {
  return !!e && (e instanceof BloqueioEstoqueError || e.bloqueioEstoque === true);
}

const fmtQtd = (n: number) => {
  const r = Math.round(n * 10000) / 10000;
  return Number.isInteger(r) ? String(r) : r.toFixed(4).replace(/0+$/, '').replace('.', ',');
};

export function descreverFaltas(faltas: FaltaEstoque[]): string {
  return faltas.map((f) =>
    `• ${f.productName}: necessário ${fmtQtd(f.required)}, disponível em uso ${fmtQtd(f.available)}`
    + (f.blocked > EPS ? ` + ${fmtQtd(f.blocked)} bloqueado (fila de reposição) — mesmo liberando o bloqueado não cobre` : ''),
  ).join('\n');
}

// Soma as linhas do pedido por produto. Um pedido com o mesmo produto em duas
// linhas precisa de saldo para a SOMA — conferir linha a linha deixava passar
// pedido que, junto, nao cabia no estoque.
export function agregarLinhas(products: LinhaPedido[] | null | undefined): { necessidades: NecessidadeProduto[]; semProduto: string[] } {
  const mapa = new Map<string, NecessidadeProduto>();
  const semProduto: string[] = [];
  for (const p of (Array.isArray(products) ? products : [])) {
    if (!p) continue;
    const qtd = Number(p.quantity) || 0;
    if (qtd <= 0) continue; // linha zerada e barrada por validateOrderLines
    const pid = p.id || p.productId;
    if (!pid) { semProduto.push(String(p.name || 'item sem nome')); continue; }
    const n = mapa.get(pid) || { productId: pid, productName: String(p.name || pid), quantidade: 0, lotIdsPreferidos: [], porLote: {} };
    n.quantidade += qtd;
    if (p.lotId) {
      if (!n.lotIdsPreferidos.includes(p.lotId)) n.lotIdsPreferidos.push(p.lotId);
      const pl = n.porLote[p.lotId] || { quantidade: 0, lotNumber: String(p.lotNumber || p.lotId) };
      pl.quantidade += qtd;
      n.porLote[p.lotId] = pl;
    }
    mapa.set(pid, n);
  }
  return { necessidades: Array.from(mapa.values()), semProduto };
}

const rowsOf = (r: any): any[] => (r?.rows ?? r ?? []) as any[];

// Linhas que pediram um lote especifico: o lote tem de estar EM USO e cobrir a
// quantidade pedida dele. `lotesEmUso` = lotes em uso do produto (id, qtd).
function faltasPorLote(n: NecessidadeProduto, lotesEmUso: Array<{ id: string; qtd: number }>): FaltaEstoque[] {
  const out: FaltaEstoque[] = [];
  for (const [lotId, req] of Object.entries(n.porLote)) {
    const l = lotesEmUso.find((x) => x.id === lotId);
    const disp = l ? Number(l.qtd) || 0 : 0;
    if (disp + EPS < req.quantidade) {
      out.push({ productId: n.productId, productName: `${n.productName} (lote ${req.lotNumber})`, required: req.quantidade, available: disp, blocked: 0 });
    }
  }
  return out;
}

// Conferencia (sem travar). Usada para recusar cedo, com mensagem, antes de
// qualquer efeito colateral. A baixa confere de novo dentro da transacao.
export async function verificarEstoqueEmUso(instanceId: string, products: LinhaPedido[] | null | undefined): Promise<{ valid: boolean; shortages: FaltaEstoque[]; semProduto: string[] }> {
  const { necessidades, semProduto } = agregarLinhas(products);
  const shortages: FaltaEstoque[] = [];
  for (const n of necessidades) {
    const r = rowsOf(await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN stock_type = 'in_use' AND quantity > 0 THEN quantity ELSE 0 END), 0)::float8 AS em_uso,
        COALESCE(SUM(CASE WHEN stock_type <> 'in_use' AND quantity > 0 THEN quantity ELSE 0 END), 0)::float8 AS outros
      FROM inventory_lots
      WHERE product_id = ${n.productId} AND instance_id = ${instanceId} AND is_active = true`))[0] || {};
    const disponivel = Number(r.em_uso) || 0;
    const bloqueado = Number(r.outros) || 0;
    // Bloqueado = fila de reposicao (entrada por transferencia): e liberado para
    // "em uso" na baixa, FIFO, quando o em uso nao cobre. So falta se nem somando cobre.
    if (disponivel + bloqueado + EPS < n.quantidade) {
      shortages.push({ productId: n.productId, productName: n.productName, required: n.quantidade, available: disponivel, blocked: bloqueado });
    } else if (Object.keys(n.porLote).length) {
      const ls = rowsOf(await db.execute(sql`
        SELECT id, quantity::float8 AS qtd FROM inventory_lots
        WHERE product_id = ${n.productId} AND instance_id = ${instanceId} AND stock_type = 'in_use' AND is_active = true AND quantity > 0`));
      shortages.push(...faltasPorLote(n, ls));
    }
  }
  return { valid: shortages.length === 0 && semProduto.length === 0, shortages, semProduto };
}

// Baixa tudo-ou-nada, somente de lotes em uso, FIFO (mais antigo primeiro;
// lote pedido explicitamente vai na frente). Lanca EstoqueInsuficienteError
// sem gravar nada se algum produto nao couber.
export async function baixarEstoqueEmUso(opts: {
  instanceId: string;
  products: LinhaPedido[] | null | undefined;
  sourceId: string;
  rotulo: string;
  createdBy: string | null;
  sourceType?: 'invoice' | 'order' | 'manual';
  // Se informado, a baixa NAO acontece quando ja existe consumo para sourceId
  // posterior a esta data (null = qualquer data): lanca BaixaJaFeitaError. A
  // conferencia e feita DENTRO da transacao, sob trava por sourceId, para dois
  // cliques/retentativas simultaneos nao baixarem duas vezes o mesmo pedido.
  impedirDuplicadaDesde?: string | null;
}): Promise<MapaLotes> {
  const { necessidades, semProduto } = agregarLinhas(opts.products);
  if (semProduto.length) throw new LinhaSemProdutoError(semProduto);
  const mapa: MapaLotes = {};
  if (!necessidades.length) return mapa;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'estoque-baixa:' + opts.sourceId}))`);
    if (opts.impedirDuplicadaDesde !== undefined) {
      const desde = opts.impedirDuplicadaDesde;
      const ja = rowsOf(await tx.execute(sql`
        SELECT 1 FROM inventory_movements
        WHERE source_type = 'invoice' AND source_id = ${opts.sourceId} AND movement_type = 'consume'
          AND COALESCE(notes, '') NOT LIKE '%[estorno-transferencia]%'
          AND COALESCE(notes, '') NOT LIKE '%[estornado]%'
          AND (${desde}::text IS NULL OR created_at > ${desde}::timestamp)
        LIMIT 1`));
      if (ja.length) throw new BaixaJaFeitaError(opts.sourceId);
    }
    // Ordem fixa de travamento (por product_id) evita deadlock entre dois
    // faturamentos que tenham os mesmos produtos em ordens diferentes.
    const ordenadas = [...necessidades].sort((a, b) => a.productId.localeCompare(b.productId));
    const planos: Array<{ n: NecessidadeProduto; lotes: any[] }> = []; // lotes em FIFO (created_at)
    const faltas: FaltaEstoque[] = [];

    for (const n of ordenadas) {
      const lotes = rowsOf(await tx.execute(sql`
        SELECT id, lot_number, quantity::float8 AS qtd
        FROM inventory_lots
        WHERE product_id = ${n.productId} AND instance_id = ${opts.instanceId}
          AND stock_type = 'in_use' AND is_active = true AND quantity > 0
        ORDER BY created_at ASC NULLS LAST, lot_number ASC
        FOR UPDATE`));
      let disponivel = lotes.reduce((s, l) => s + (Number(l.qtd) || 0), 0);
      if (disponivel + EPS < n.quantidade) {
        // PROMOCAO DO BLOQUEADO (Flavio, 04/out/2026): o bloqueado e a fila de
        // reposicao da filial (entrada por NF de transferencia). Quando o em uso nao
        // cobre, o lote bloqueado mais antigo vira "em uso" — inteiro, com o PROPRIO
        // numero e CMV — ate cobrir. Se nem a fila toda cobre, nada e promovido
        // (o throw abaixo desfaz a transacao inteira).
        const bloqueados = rowsOf(await tx.execute(sql`
          SELECT id, lot_number, quantity::float8 AS qtd
          FROM inventory_lots
          WHERE product_id = ${n.productId} AND instance_id = ${opts.instanceId}
            AND stock_type = 'blocked' AND is_active = true AND quantity > 0
          ORDER BY created_at ASC NULLS LAST, lot_number ASC
          FOR UPDATE`));
        const totalBloq = bloqueados.reduce((s, l) => s + (Number(l.qtd) || 0), 0);
        if (disponivel + totalBloq + EPS < n.quantidade) {
          faltas.push({ productId: n.productId, productName: n.productName, required: n.quantidade, available: disponivel, blocked: totalBloq });
          continue;
        }
        for (const b of bloqueados) {
          if (disponivel + EPS >= n.quantidade) break;
          const q = Number(b.qtd) || 0;
          await tx.execute(sql`UPDATE inventory_lots SET stock_type = 'in_use', updated_at = now() WHERE id = ${b.id}`);
          await tx.execute(sql`
            INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
            VALUES (gen_random_uuid()::varchar, ${b.id}, ${n.productId}, ${opts.instanceId}, 'transfer',
                    ${q.toFixed(4)}, ${q.toFixed(4)}, ${q.toFixed(4)}, ${opts.sourceType || 'invoice'}, ${opts.sourceId}, ${b.lot_number},
                    ${`Lote bloqueado ${b.lot_number} liberado para estoque em uso (estoque em uso esgotado) - ${opts.rotulo}`},
                    ${opts.createdBy}, now())`);
          console.log(`🔓 [ESTOQUE-EM-USO] ${opts.rotulo}: lote ${b.lot_number} (${fmtQtd(q)} un) promovido de bloqueado para em uso`);
          lotes.push(b);
          disponivel += q;
        }
      }
      const fl = faltasPorLote(n, lotes);
      if (fl.length) { faltas.push(...fl); continue; }
      planos.push({ n, lotes });
    }

    if (faltas.length) throw new EstoqueInsuficienteError(faltas);

    for (const { n, lotes } of planos) {
      // Quanto sai de cada lote: primeiro o que as linhas pediram de lotes
      // especificos (exatamente), depois o restante em FIFO pelo saldo que sobrou.
      const tirar = new Map<string, number>();
      let restante = n.quantidade;
      for (const [lotId, req] of Object.entries(n.porLote)) {
        tirar.set(lotId, req.quantidade);
        restante -= req.quantidade;
      }
      for (const l of lotes) {
        if (restante <= EPS) break;
        const sobra = (Number(l.qtd) || 0) - (tirar.get(l.id) || 0);
        if (sobra <= EPS) continue;
        const q = Math.min(restante, sobra);
        tirar.set(l.id, (tirar.get(l.id) || 0) + q);
        restante -= q;
      }
      const consumidos: LoteConsumido[] = [];
      for (const l of lotes) {
        const tira = tirar.get(l.id) || 0;
        if (tira <= EPS) continue;
        const atual = Number(l.qtd) || 0;
        const novo = atual - tira;
        await tx.execute(sql`
          UPDATE inventory_lots SET quantity = ${novo.toFixed(4)}, updated_at = now() WHERE id = ${l.id}`);
        await tx.execute(sql`
          INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
          VALUES (gen_random_uuid()::varchar, ${l.id}, ${n.productId}, ${opts.instanceId}, 'consume',
                  ${tira.toFixed(4)}, ${atual.toFixed(4)}, ${novo.toFixed(4)},
                  ${opts.sourceType || 'invoice'}, ${opts.sourceId}, ${l.lot_number},
                  ${`Baixa automática (estoque em uso) - ${opts.rotulo} - ${n.productName}`},
                  ${opts.createdBy}, now())`);
        consumidos.push({ lotId: l.id, lotNumber: String(l.lot_number || ''), quantidade: tira });
      }
      mapa[n.productId] = consumidos;
      console.log(`📦 [ESTOQUE-EM-USO] ${opts.rotulo}: ${n.productName} ${fmtQtd(n.quantidade)} un ← ${consumidos.map((c) => `${c.lotNumber}(${fmtQtd(c.quantidade)})`).join(', ')}`);
    }
  });

  return mapa;
}

// Lotes ja baixados para uma origem (card do pipeline e/ou NF). Usado quando o
// faturamento e refeito (card que voltou para "Faturado", NF retransmitida): a
// baixa nao se repete, mas a NF nova tem de continuar saindo com os lotes.
// `desde`: so conta consumos POSTERIORES a essa data (o ultimo estorno do pedido)
// — consumo anterior a um cancelamento ja voltou para o estoque e nao e mais lote
// desta nota.
export async function lotesJaBaixados(sourceIds: Array<string | null | undefined>, desde?: string | null): Promise<MapaLotes | null> {
  const ids = sourceIds.filter(Boolean).map(String);
  if (!ids.length) return null;
  // `desde` e o texto do proprio timestamp do banco (ver ultimoEstornoDoPedido):
  // comparar sem passar por Date do JS evita perder microssegundos e fuso.
  const desdeIso = desde || null;
  const r = rowsOf(await db.execute(sql`
    SELECT product_id, lot_id, lot_number, SUM(ABS(quantity::float8)) AS q, MIN(created_at) AS primeiro
    FROM inventory_movements
    WHERE source_type = 'invoice' AND movement_type = 'consume' AND source_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      AND COALESCE(notes, '') NOT LIKE '%[estorno-transferencia]%'
      AND COALESCE(notes, '') NOT LIKE '%[estornado]%'
      AND (${desdeIso}::text IS NULL OR created_at > ${desdeIso}::timestamp)
    GROUP BY product_id, lot_id, lot_number
    ORDER BY primeiro ASC`));
  if (!r.length) return null;
  const mapa: MapaLotes = {};
  for (const m of r) {
    (mapa[m.product_id] ||= []).push({ lotId: m.lot_id, lotNumber: String(m.lot_number || ''), quantidade: Number(m.q) || 0 });
  }
  return mapa;
}

// Data do ultimo ESTORNO de estoque ligado ao pedido: movimentos cancel_reversal
// gravados com o id do card ou com o id de qualquer NF dele (por sales_card_id ou,
// no pedido interno sem card, pela referencia "Pedido pipeline interno - <n>").
export async function ultimoEstornoDoPedido(item: { id: string; salesCardId?: string | null; orderNumber?: string | null }): Promise<string | null> {
  const ref = item.orderNumber ? 'Pedido pipeline interno - ' + item.orderNumber : null;
  const r = rowsOf(await db.execute(sql`
    SELECT MAX(m.created_at)::text AS ult FROM inventory_movements m
    WHERE m.movement_type = 'cancel_reversal' AND m.source_type = 'invoice'
      AND (m.source_id = ${item.id}
           OR m.source_id IN (
                SELECT id FROM fiscal_invoices
                WHERE (${item.salesCardId || null}::varchar IS NOT NULL AND sales_card_id = ${item.salesCardId || null})
                   OR (${ref}::varchar IS NOT NULL AND sales_card_id IS NULL AND notes = ${ref})))`))[0];
  return r?.ult ? String(r.ult) : null;
}

// Baixa VIGENTE de um pedido do pipeline: consumos gravados para o card DEPOIS do
// ultimo estorno do pedido. Pedido refaturado apos NF cancelada/devolvida volta a
// baixar (a baixa antiga ja voltou ao estoque), e a NF nova sai so com os lotes
// da baixa nova.
export async function baixaVigenteDoPedido(item: { id: string; salesCardId?: string | null; orderNumber?: string | null }): Promise<MapaLotes | null> {
  return lotesJaBaixados([item.id], await ultimoEstornoDoPedido(item));
}

// Texto do lote para a NF. Um lote: "Lote: L123". Varios: "Lote: L123 (40) / L124 (20)".
export function textoLotes(consumidos: LoteConsumido[] | null | undefined): string {
  const ls = (consumidos || []).filter((c) => c.lotNumber);
  if (!ls.length) return '';
  if (ls.length === 1) return `Lote: ${ls[0].lotNumber}`;
  return `Lote: ${ls.map((c) => `${c.lotNumber} (${fmtQtd(c.quantidade)})`).join(' / ')}`;
}

// Reparte os lotes consumidos (agregados por produto) entre as linhas da NF, na
// ordem das linhas. Quando o mesmo produto aparece em mais de uma linha, cada uma
// leva so os lotes e quantidades que cabem a ela; a linha que pediu um lote
// especifico (transferencia) pega aquele lote primeiro.
export function distribuirLotes(
  mapa: MapaLotes | null | undefined,
  linhas: Array<{ id?: string | null; productId?: string | null; quantity?: any; lotId?: string | null }>,
): LoteConsumido[][] {
  const fila = new Map<string, LoteConsumido[]>(
    Object.entries(mapa || {}).map(([pid, ls]) => [pid, (ls || []).map((l) => ({ ...l }))]),
  );
  const out: LoteConsumido[][] = linhas.map(() => []);
  const tirar = (idx: number, so?: string | null) => {
    const linha = linhas[idx];
    const ls = fila.get(String(linha?.id || linha?.productId || ''));
    if (!ls || !ls.length) return;
    let falta = (Number(linha?.quantity) || 0) - out[idx].reduce((a, c) => a + c.quantidade, 0);
    for (const l of ls) {
      if (falta <= EPS) break;
      if (so && l.lotId !== so) continue;
      if (l.quantidade <= EPS) continue;
      const q = Math.min(falta, l.quantidade);
      const ja = out[idx].find((c) => c.lotId === l.lotId);
      if (ja) ja.quantidade += q; else out[idx].push({ lotId: l.lotId, lotNumber: l.lotNumber, quantidade: q });
      l.quantidade -= q;
      falta -= q;
    }
  };
  // 1a passada: linhas que pediram lote especifico pegam o seu lote.
  linhas.forEach((l, i) => { if (l?.lotId) tirar(i, l.lotId); });
  // 2a passada: todo o resto (inclusive o que faltou nas linhas com lote) em ordem.
  linhas.forEach((_l, i) => tirar(i));
  return out;
}

// Nome do item sem o sufixo de lote (para regravar o lote sem duplicar).
export function nomeSemLote(nome: string | null | undefined): string {
  const n = String(nome || '');
  return n.replace(/\s*[-–]\s*Lote:.*$/i, '').replace(/\s*Lote:.*$/i, '').trim() || n;
}

// Compatibilidade com quem recebe o lotMap antigo (Record<productId, string[]>).
export function mapaParaNumeros(m: MapaLotes): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [pid, ls] of Object.entries(m)) {
    const nums = Array.from(new Set(ls.map((l) => l.lotNumber).filter(Boolean)));
    if (nums.length) out[pid] = nums;
  }
  return out;
}

// Estorno EXATO de uma baixa feita por baixarEstoqueEmUso — devolve cada
// quantidade ao lote de onde saiu. Usado quando a NF manual e recusada pela
// SEFAZ logo depois da baixa (a mercadoria nao saiu).
export async function estornarBaixa(sourceId: string, motivo: string, by: string | null): Promise<number> {
  let n = 0;
  await db.transaction(async (tx) => {
    const movs = rowsOf(await tx.execute(sql`
      SELECT * FROM inventory_movements
      WHERE source_type = 'invoice' AND source_id = ${sourceId} AND movement_type = 'consume'
        AND COALESCE(notes, '') NOT LIKE '%[estornado]%'
      ORDER BY created_at ASC FOR UPDATE`));
    for (const mv of movs) {
      const qty = Math.abs(Number(mv.quantity) || 0);
      if (qty <= 0) continue;
      const lot = rowsOf(await tx.execute(sql`SELECT id, quantity::float8 AS q FROM inventory_lots WHERE id = ${mv.lot_id} FOR UPDATE`))[0];
      if (!lot) continue;
      const prev = Number(lot.q) || 0;
      const novo = prev + qty;
      await tx.execute(sql`UPDATE inventory_lots SET quantity = ${novo.toFixed(4)}, is_active = true, updated_at = now() WHERE id = ${lot.id}`);
      await tx.execute(sql`
        INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
        VALUES (gen_random_uuid()::varchar, ${mv.lot_id}, ${mv.product_id}, ${mv.instance_id}, 'cancel_reversal',
                ${qty.toFixed(4)}, ${prev.toFixed(4)}, ${novo.toFixed(4)}, 'invoice', ${sourceId}, ${mv.lot_number},
                ${'Estorno da baixa — ' + motivo}, ${by}, now())`);
      await tx.execute(sql`UPDATE inventory_movements SET notes = COALESCE(notes, '') || ' [estornado]' WHERE id = ${mv.id}`);
      n++;
    }
  });
  return n;
}


// ============================================================================
// AUDITORIA DE ESTOQUE 28/set-04/out/2026 — estorno, espelho e lixeira pelos
// MOVIMENTOS REAIS (Flavio, 04/out/2026)
// ============================================================================
const MARCA_ESTORNADO = '[estornado]';
const MARCA_ESTORNO_TRF = '[estorno-transferencia]';
const soDigitos = (v: any) => String(v ?? '').replace(/\D/g, '');

// Numero de lote canonico: sem espacos, maiusculo. "h180626" e "H180626" eram
// dois lotes do mesmo produto na mesma filial para o FIFO e para o recall.
export function normalizarNumeroLote(v: any): string {
  return String(v ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

export type ResultadoEstornoMov = { handled: boolean; undone: string[]; warnings: string[]; nadaABaixar?: boolean };

// Estorna as baixas (consume) e entradas espelho (replenish) VIVAS gravadas com
// os source_ids informados. Cada baixa volta ao MESMO lote na MESMA quantidade;
// cada espelho sai do lote do destino. Idempotente pela marca [estornado].
// Sem movimento nenhum, nada volta — o estoque nunca e inventado.
export async function estornarMovimentos(sourceIds: string[], opts: { by: string | null; rotulo: string; novoSourceId: string }): Promise<ResultadoEstornoMov> {
  const undone: string[] = [];
  const warnings: string[] = [];
  const ids = Array.from(new Set(sourceIds.filter(Boolean).map(String)));
  if (!ids.length) return { handled: false, undone, warnings };
  const lista = sql.join(ids.map((i) => sql`${i}`), sql`, `);

  return await db.transaction(async (tx) => {
    const movs = rowsOf(await tx.execute(sql`
      SELECT * FROM inventory_movements
      WHERE source_type = 'invoice' AND source_id IN (${lista})
        AND movement_type IN ('consume', 'replenish')
        AND COALESCE(notes, '') NOT LIKE ${'%' + MARCA_ESTORNADO + '%'}
        AND COALESCE(notes, '') NOT LIKE ${'%' + MARCA_ESTORNO_TRF + '%'}
      ORDER BY created_at ASC
      FOR UPDATE`));

    if (!movs.length) {
      const ja = rowsOf(await tx.execute(sql`
        SELECT 1 FROM inventory_movements
        WHERE source_type = 'invoice' AND source_id IN (${lista})
          AND movement_type IN ('consume', 'replenish') LIMIT 1`));
      warnings.push(ja.length
        ? 'estoque ja estornado anteriormente — nada a fazer'
        : 'esta nota nao tinha baixado estoque — nada a devolver (nenhum estoque foi inventado)');
      return { handled: true, undone, warnings, nadaABaixar: !ja.length };
    }

    for (const mv of movs) {
      const lot = rowsOf(await tx.execute(sql`SELECT * FROM inventory_lots WHERE id = ${mv.lot_id} LIMIT 1 FOR UPDATE`))[0];
      if (!lot) { warnings.push(`lote ${mv.lot_number} do movimento ${mv.id} nao existe mais — nao estornado`); continue; }
      // consumeStock antigo gravava consume NEGATIVO; a direcao vem do tipo.
      const qty = Math.abs(Number(mv.quantity) || 0);
      if (qty <= 0) continue;
      const isConsume = String(mv.movement_type) === 'consume';
      const prev = Number(lot.quantity) || 0;
      const novo = Math.round((isConsume ? prev + qty : prev - qty) * 10000) / 10000;
      if (!isConsume && novo < 0) warnings.push(`lote ${lot.lot_number} no destino ja tinha saida (${prev} de ${qty}) — saldo ficou ${novo}; conferir estoque da filial`);
      await tx.execute(sql`
        UPDATE inventory_lots SET quantity = ${novo.toFixed(4)},
          is_active = ${novo > 0 ? true : (isConsume ? lot.is_active : false)},
          updated_at = now()
        WHERE id = ${lot.id}`);
      await tx.execute(sql`
        INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
        VALUES (gen_random_uuid()::varchar, ${lot.id}, ${lot.product_id}, ${lot.instance_id}, 'cancel_reversal', ${(isConsume ? qty : -qty).toFixed(4)}, ${prev.toFixed(4)}, ${novo.toFixed(4)},
                'invoice', ${opts.novoSourceId}, ${lot.lot_number},
                ${(isConsume ? 'Devolucao ao lote de origem' : 'Retirada da entrada espelho no destino') + ' — estorno ' + opts.rotulo + ' ' + MARCA_ESTORNADO}, ${opts.by}, now())`);
      await tx.execute(sql`UPDATE inventory_movements SET notes = COALESCE(notes, '') || ${' ' + MARCA_ESTORNADO} WHERE id = ${mv.id}`);
      undone.push(`${isConsume ? 'origem' : 'destino'} ${lot.lot_number}: ${isConsume ? '+' : '-'}${fmtQtd(qty)}`);
    }
    return { handled: true, undone, warnings };
  });
}

// Origens de baixa de uma NF: a propria NF e TODOS os cards do pedido (mesmo
// sales_card_id — ja houve card duplicado, INT-827b1148 — ou, no pedido interno
// sem card, a referencia "Pedido pipeline interno - <n>").
async function origensDaNf(invoice: any): Promise<string[]> {
  const ids: string[] = [String(invoice?.id || '')];
  const sc = invoice?.salesCardId || invoice?.sales_card_id || null;
  const ref = /^Pedido pipeline interno - (.+)$/.exec(String(invoice?.notes || ''))?.[1] || null;
  if (sc || ref) {
    const cards = rowsOf(await db.execute(sql`
      SELECT id FROM billing_pipeline
      WHERE (${sc}::varchar IS NOT NULL AND sales_card_id = ${sc})
         OR (${ref}::varchar IS NOT NULL AND order_number = ${ref})`));
    for (const c of cards) ids.push(String(c.id));
  }
  return ids.filter(Boolean);
}

// Cancelamento/devolucao de NF: substitui o estorno "generico" (quantidade da
// nota no primeiro lote em uso), que devolvia o que nunca tinha saido (+64 un na
// semana de 28/set) e no lote errado (78% das unidades).
export async function estornarEstoqueDaNfPorMovimentos(invoice: any, by: string | null): Promise<ResultadoEstornoMov> {
  const rotulo = `da ${invoice?.invoiceNumber ? 'NF-e ' + invoice.invoiceNumber : 'NF-e'}`;
  return estornarMovimentos(await origensDaNf(invoice), { by, rotulo, novoSourceId: String(invoice?.id) });
}

// Card mandado para a Lixeira depois de baixar o estoque, mas SEM NF autorizada:
// a mercadoria nao saiu — o estoque volta. Com NF autorizada (ou em transmissao)
// nada acontece aqui: quem estorna e o cancelamento/devolucao da nota.
export async function estornarBaixaDeCardSemNf(cardId: string, by: string | null): Promise<ResultadoEstornoMov | null> {
  const card = rowsOf(await db.execute(sql`SELECT id, sales_card_id, order_number FROM billing_pipeline WHERE id = ${cardId} LIMIT 1`))[0];
  if (!card) return null;
  const viva = rowsOf(await db.execute(sql`
    SELECT 1 FROM inventory_movements
    WHERE source_type = 'invoice' AND source_id = ${String(card.id)} AND movement_type = 'consume'
      AND COALESCE(notes, '') NOT LIKE ${'%' + MARCA_ESTORNADO + '%'}
      AND COALESCE(notes, '') NOT LIKE ${'%' + MARCA_ESTORNO_TRF + '%'} LIMIT 1`));
  if (!viva.length) return null;
  const ref = card.order_number ? 'Pedido pipeline interno - ' + card.order_number : null;
  const nfs = rowsOf(await db.execute(sql`
    SELECT id, status FROM fiscal_invoices
    WHERE (${card.sales_card_id || null}::varchar IS NOT NULL AND sales_card_id = ${card.sales_card_id || null})
       OR (${ref}::varchar IS NOT NULL AND sales_card_id IS NULL AND notes = ${ref})`));
  if (nfs.some((n: any) => ['authorized', 'processing'].includes(String(n.status)))) return null;
  // NF cancelada/devolvida ANTES desta correcao foi estornada pelo caminho
  // generico, que devolvia o estoque sem marcar a baixa. Estornar de novo aqui
  // contaria a mercadoria duas vezes.
  if (nfs.length) {
    const gen = rowsOf(await db.execute(sql`
      SELECT 1 FROM inventory_movements WHERE movement_type = 'cancel_reversal'
        AND source_id IN (${sql.join(nfs.map((n: any) => sql`${String(n.id)}`), sql`, `)}) LIMIT 1`));
    if (gen.length) return null;
  }
  const r = await estornarMovimentos([String(card.id)], { by, rotulo: `do pedido ${card.order_number || card.id} (lixeira sem NF autorizada)`, novoSourceId: String(card.id) });
  console.log(`🗑️ [ESTOQUE] ${card.order_number || card.id} foi para a Lixeira sem NF autorizada — baixa estornada: ${r.undone.join(', ') || 'nada'}`);
  return r;
}

// Filial de destino de uma transferencia: a da linha (pedido TRF) ou a do CNPJ do
// destinatario (transferencia GYN -> BSB feita como pedido comum, que nunca
// creditava o destino — NF 107377 e 107452).
export async function destinoDaTransferencia(item: any): Promise<{ id: string; name: string; display_name: string | null } | null> {
  const linhas = Array.isArray(item?.products) ? item.products : [];
  const explicito = linhas.find((p: any) => p?.transferToInstanceId)?.transferToInstanceId;
  const todas = rowsOf(await db.execute(sql`SELECT id, name, display_name, cnpj FROM omie_instances`));
  if (explicito) return todas.find((i: any) => i.id === explicito) || null;
  let doc = soDigitos(item?.customerDocument);
  if (doc.length < 14 && item?.customerId) {
    const c = rowsOf(await db.execute(sql`SELECT cnpj FROM customers WHERE id = ${String(item.customerId)} LIMIT 1`))[0];
    doc = soDigitos(c?.cnpj);
  }
  return todas.find((i: any) => doc.length >= 14 && soDigitos(i.cnpj) === doc) || null;
}

// ENTRADA ESPELHO DA TRANSFERENCIA pelos lotes que a baixa REALMENTE consumiu:
// mesmo numero de lote, mesmo CMV (regra 18/set), entrando como BLOQUEADO na
// filial (fila de reposicao — regra do PR #118). Idempotente: se ja existe entrada
// viva para o pedido, nao repete.
export async function espelharTransferenciaPelosMovimentos(item: any, user: any): Promise<{ creditado: string[]; avisos: string[] }> {
  const creditado: string[] = [];
  const avisos: string[] = [];
  if (String(item?.operationType || '').toLowerCase() !== 'transferencia') return { creditado, avisos };
  const destino = await destinoDaTransferencia(item);
  if (!destino) {
    avisos.push('destino da transferencia nao identificado (CNPJ do destinatario nao bate com nenhuma filial) — entrada no destino NAO feita');
    return { creditado, avisos };
  }
  if (destino.id === item?.omieInstanceId) { avisos.push('origem e destino sao a mesma filial — nada a espelhar'); return { creditado, avisos }; }
  const quem = user?.email || 'system';
  const rotulo = String(item.orderNumber || item.id);
  const origemNome = item.omieInstanceName || 'origem';
  const destNome = destino.display_name || destino.name;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'estoque-espelho:' + String(item.id)}))`);
    const ja = rowsOf(await tx.execute(sql`
      SELECT 1 FROM inventory_movements
      WHERE source_type = 'invoice' AND source_id = ${String(item.id)} AND movement_type = 'replenish'
        AND COALESCE(notes, '') NOT LIKE ${'%' + MARCA_ESTORNADO + '%'}
        AND COALESCE(notes, '') NOT LIKE ${'%' + MARCA_ESTORNO_TRF + '%'} LIMIT 1`));
    if (ja.length) { avisos.push('entrada no destino ja feita anteriormente'); return; }
    const baixas = rowsOf(await tx.execute(sql`
      SELECT m.*, l.unit_cost AS lot_unit_cost, l.production_order_id AS lot_op
      FROM inventory_movements m LEFT JOIN inventory_lots l ON l.id = m.lot_id
      WHERE m.source_type = 'invoice' AND m.source_id = ${String(item.id)} AND m.movement_type = 'consume'
        AND COALESCE(m.notes, '') NOT LIKE ${'%' + MARCA_ESTORNADO + '%'}
        AND COALESCE(m.notes, '') NOT LIKE ${'%' + MARCA_ESTORNO_TRF + '%'}
      ORDER BY m.created_at ASC`));
    if (!baixas.length) { avisos.push('transferencia sem baixa na origem — nada a creditar no destino'); return; }
    for (const b of baixas) {
      const qty = Math.abs(Number(b.quantity) || 0);
      if (qty <= 0) continue;
      const numLote = normalizarNumeroLote(b.lot_number) || 'SEM-LOTE';
      const unit = b.lot_unit_cost != null && Number(b.lot_unit_cost) > 0 ? Number(b.lot_unit_cost) : null;
      const exist = rowsOf(await tx.execute(sql`
        SELECT * FROM inventory_lots
        WHERE product_id = ${b.product_id} AND instance_id = ${destino.id} AND stock_type = 'blocked'
          AND UPPER(REPLACE(TRIM(lot_number), ' ', '')) = ${numLote}
        ORDER BY is_active DESC, created_at ASC LIMIT 1 FOR UPDATE`))[0];
      let lotId: string; let prev = 0;
      if (exist) {
        lotId = exist.id; prev = Number(exist.quantity) || 0;
        await tx.execute(sql`
          UPDATE inventory_lots SET quantity = ${(prev + qty).toFixed(4)}, is_active = true,
            unit_cost = COALESCE(${unit != null ? unit.toFixed(4) : null}, unit_cost), updated_at = now()
          WHERE id = ${lotId}`);
      } else {
        const ins = rowsOf(await tx.execute(sql`
          INSERT INTO inventory_lots (id, product_id, instance_id, stock_type, lot_number, quantity, min_quantity, unit_cost, total_cost, production_order_id, notes, is_active, created_at, updated_at)
          VALUES (gen_random_uuid()::varchar, ${b.product_id}, ${destino.id}, 'blocked', ${numLote}, ${qty.toFixed(4)}, '0',
                  ${unit != null ? unit.toFixed(4) : null}, ${unit != null ? (unit * qty).toFixed(2) : null}, ${b.lot_op || null},
                  ${`Recebido por transferencia ${rotulo} de ${origemNome}`}, true, now(), now())
          RETURNING id`));
        lotId = ins[0].id;
      }
      await tx.execute(sql`
        INSERT INTO inventory_movements (id, lot_id, product_id, instance_id, movement_type, quantity, previous_quantity, new_quantity, source_type, source_id, lot_number, notes, created_by, created_at)
        VALUES (gen_random_uuid()::varchar, ${lotId}, ${b.product_id}, ${destino.id}, 'replenish', ${qty.toFixed(4)}, ${prev.toFixed(4)}, ${(prev + qty).toFixed(4)},
                'invoice', ${String(item.id)}, ${numLote}, ${`Entrada por transferencia ${rotulo} (${origemNome} -> ${destNome})`}, ${quem}, now())`);
      creditado.push(`${numLote}: +${fmtQtd(qty)}`);
    }
  });
  if (creditado.length) console.log(`🔁 [TRANSFER] ${rotulo} -> ${destNome} (bloqueado): ${creditado.join(', ')}`);
  return { creditado, avisos };
}
