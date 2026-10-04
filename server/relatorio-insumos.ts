// ============================================================================
// RELATÓRIO PRD/PP/INSUMO — movimentação de insumos no período (Flavio 04/out/2026)
//
// Por insumo (matéria-prima): saldo inicial, entradas (compra NF, produção de
// OP, outras), consumo em ordens de produção, saídas manuais, perdas, ajustes,
// estornos e saldo final — com valores. Mais o consumo detalhado por OP e o
// extrato de movimentações do período.
//
// Fonte única: raw_material_movements (o mesmo histórico da aba Matéria-Prima).
//  - entrada_compra ............ Compras (NF de entrada, purchase-routes.ts)
//  - entrada COM OP ............ Produção (polpa/insumo gerado pela OP)
//  - entrada SEM OP, devolucao . Outras entradas
//  - saida_producao ............ Consumo em OP
//  - saida ..................... Saídas manuais
//  - perda ..................... Perdas
//  - ajuste .................... Ajustes de inventário (com sinal)
//  - qualquer movimento marcado '[estornado]' (o original E o estorno, que
//    se anulam) vai para a coluna Estornos — assim Consumo em OP mostra só o
//    consumo que vale, e a soma das colunas fecha com o saldo.
//
// Datas: created_at é gravado com now() do Postgres em UTC. O período é dado
// em dias de Brasília (UTC-3, sem horário de verão desde 2019).
//
// Auth: /api/industria já passa por authenticateUser + requireRole(['admin'])
// no index.ts (perfil industria é promovido a admin).
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";

const EST_MARK = '[estornado]';
const BR_OFFSET_MS = 3 * 3600 * 1000;

export type MovRow = {
  id: string;
  raw_material_id: string;
  movement_type: string;
  quantity: any;
  previous_quantity: any;
  new_quantity: any;
  production_order_id?: string | null;
  notes?: string | null;
  created_by?: string | null;
  epoch: any;                 // segundos desde 1970 (UTC)
  unit_cost?: any;
  order_number?: string | null;
  op_product_name?: string | null;
  op_lot_number?: string | null;
  op_status?: string | null;
  op_quantity?: any;
  op_production_date?: any;
};

export type MatRow = {
  id: string; name: string; code?: string | null; category?: string | null;
  unit?: string | null; quantity?: any; unit_cost?: any; is_active?: any;
};

const num = (v: any): number => { const x = Number(v); return isFinite(x) ? x : 0; };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Dia de Brasília (YYYY-MM-DD) de um instante em segundos UTC. */
export const diaBR = (epoch: number): string => new Date(epoch * 1000 - BR_OFFSET_MS).toISOString().slice(0, 10);
/** Data/hora de Brasília (YYYY-MM-DD HH:MM). */
export const dataHoraBR = (epoch: number): string => new Date(epoch * 1000 - BR_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');

const IN_TYPES = new Set(['entrada', 'entrada_compra', 'devolucao']);
const OUT_TYPES = new Set(['saida', 'saida_producao', 'perda']);

/** Variação com sinal do movimento (novo − anterior; cai no tipo se faltar). */
export function deltaDe(m: MovRow): number {
  const prev = m.previous_quantity, nw = m.new_quantity;
  if (prev != null && nw != null && prev !== '' && nw !== '') return num(nw) - num(prev);
  const q = Math.abs(num(m.quantity));
  if (IN_TYPES.has(m.movement_type)) return q;
  if (OUT_TYPES.has(m.movement_type)) return -q;
  return 0;
}

export type Coluna = 'compras' | 'producao' | 'outrasEntradas' | 'consumoOP' | 'saidas' | 'perdas' | 'ajustes' | 'estornos';

export function classificar(m: MovRow): Coluna {
  if (String(m.notes || '').includes(EST_MARK)) return 'estornos';
  switch (m.movement_type) {
    case 'entrada_compra': return 'compras';
    case 'entrada': return m.production_order_id ? 'producao' : 'outrasEntradas';
    case 'devolucao': return 'outrasEntradas';
    case 'saida_producao': return 'consumoOP';
    case 'saida': return 'saidas';
    case 'perda': return 'perdas';
    default: return 'ajustes';
  }
}

export const COLUNA_LABEL: Record<Coluna, string> = {
  compras: 'Entrada (Compra NF)', producao: 'Entrada (Produção OP)', outrasEntradas: 'Outras entradas',
  consumoOP: 'Consumo em OP', saidas: 'Saída manual', perdas: 'Perda', ajustes: 'Ajuste', estornos: 'Estorno',
};

export type Filtros = { de: string; ate: string };

export function montarRelatorioInsumos(materials: MatRow[], movimentosTodos: MovRow[], f: Filtros) {
  const porMat = new Map<string, MovRow[]>();
  for (const m of movimentosTodos) {
    const k = String(m.raw_material_id);
    (porMat.get(k) || porMat.set(k, []).get(k)!).push(m);
  }
  const ord = (a: MovRow, b: MovRow) => num(a.epoch) - num(b.epoch) || String(a.id).localeCompare(String(b.id));

  const linhas: any[] = [];
  const extrato: any[] = [];
  const opMap = new Map<string, any>();

  for (const mat of materials) {
    const movs = (porMat.get(String(mat.id)) || []).slice().sort(ord);
    const antes = movs.filter((m) => diaBR(num(m.epoch)) < f.de);
    const no = movs.filter((m) => { const d = diaBR(num(m.epoch)); return d >= f.de && d <= f.ate; });
    const depois = movs.filter((m) => diaBR(num(m.epoch)) > f.ate);

    // Saldo no início do período: o "anterior" do 1º movimento do período;
    // sem movimento no período, o "novo" do último antes; sem nenhum antes,
    // o "anterior" do 1º depois; sem histórico algum, o estoque atual.
    const saldoEm = (lista: MovRow[], campo: 'previous_quantity' | 'new_quantity', idx: number) =>
      lista.length ? num(lista[idx < 0 ? lista.length + idx : idx][campo]) : null;
    const saldoInicial =
      saldoEm(no, 'previous_quantity', 0) ??
      saldoEm(antes, 'new_quantity', -1) ??
      saldoEm(depois, 'previous_quantity', 0) ??
      num(mat.quantity);

    const col: Record<Coluna, number> = { compras: 0, producao: 0, outrasEntradas: 0, consumoOP: 0, saidas: 0, perdas: 0, ajustes: 0, estornos: 0 };
    let valorCompras = 0, valorConsumo = 0, valorPerdas = 0;
    let saldo = saldoInicial;
    for (const m of no) {
      const d = deltaDe(m);
      const c = classificar(m);
      col[c] += d;
      const custo = num(m.unit_cost ?? mat.unit_cost);
      if (c === 'compras') valorCompras += Math.abs(d) * custo;
      if (c === 'consumoOP') valorConsumo += Math.abs(d) * custo;
      if (c === 'perdas') valorPerdas += Math.abs(d) * custo;
      saldo += d;
      extrato.push({
        id: m.id,
        data: dataHoraBR(num(m.epoch)),
        epoch: num(m.epoch),
        material_id: mat.id,
        material: mat.name,
        codigo: mat.code || '',
        categoria: mat.category || 'outros',
        unidade: mat.unit || '',
        tipo: m.movement_type,
        coluna: c,
        coluna_label: COLUNA_LABEL[c],
        quantidade: r3(d),
        saldo_anterior: r3(num(m.previous_quantity)),
        saldo_novo: r3(num(m.new_quantity)),
        custo_unit: custo,
        valor: r2(Math.abs(d) * custo),
        op: m.order_number || '',
        op_produto: m.op_product_name || '',
        obs: m.notes || '',
        usuario: m.created_by || '',
      });

      // Consumo/geração por OP (só o que vale: estornados ficam de fora)
      if (m.production_order_id && (c === 'consumoOP' || c === 'producao' || c === 'perdas')) {
        const k = String(m.production_order_id);
        let op = opMap.get(k);
        if (!op) {
          op = {
            id: k, op: m.order_number || '(OP excluída)', produto: m.op_product_name || '', lote: m.op_lot_number || '',
            status: m.op_status || '', quantidade: num(m.op_quantity),
            data_producao: m.op_production_date ? String(m.op_production_date).slice(0, 10) : '',
            primeiro: num(m.epoch), insumos: [] as any[], perdas: [] as any[], gerados: [] as any[], custo_total: 0,
          };
          opMap.set(k, op);
        }
        op.primeiro = Math.min(op.primeiro, num(m.epoch));
        // perda/avaria na OP (PR #117) entra no custo da ordem, como no CMV
        const alvo = c === 'consumoOP' ? op.insumos : c === 'perdas' ? op.perdas : op.gerados;
        let it = alvo.find((x: any) => x.material_id === mat.id);
        if (!it) { it = { material_id: mat.id, material: mat.name, unidade: mat.unit || '', quantidade: 0, custo_unit: custo, valor: 0 }; alvo.push(it); }
        it.quantidade = r3(it.quantidade + Math.abs(d));
        it.valor = r2(it.valor + Math.abs(d) * custo);
        if (c === 'consumoOP' || c === 'perdas') op.custo_total = r2(op.custo_total + Math.abs(d) * custo);
      }
    }

    const saldoFinal = no.length ? num(no[no.length - 1].new_quantity) : saldoInicial;
    const entradas = col.compras + col.producao + col.outrasEntradas;
    const saidasTot = -(col.consumoOP + col.saidas + col.perdas);
    linhas.push({
      material_id: mat.id,
      material: mat.name,
      codigo: mat.code || '',
      categoria: mat.category || 'outros',
      unidade: mat.unit || '',
      ativo: mat.is_active !== false,
      movimentos: no.length,
      saldo_inicial: r3(saldoInicial),
      compras: r3(col.compras),
      producao: r3(col.producao),
      outras_entradas: r3(col.outrasEntradas),
      entradas: r3(entradas),
      consumo_op: r3(-col.consumoOP),
      saidas: r3(-col.saidas),
      perdas: r3(-col.perdas),
      total_saidas: r3(saidasTot),
      ajustes: r3(col.ajustes),
      estornos: r3(col.estornos),
      saldo_final: r3(saldoFinal),
      // Diferença ≠ 0 = histórico com quebra (estoque alterado fora de movimentação)
      divergencia: r3(saldoFinal - saldo),
      custo_unit_atual: num(mat.unit_cost),
      valor_compras: r2(valorCompras),
      valor_consumo_op: r2(valorConsumo),
      valor_perdas: r2(valorPerdas),
      valor_saldo_final: r2(saldoFinal * num(mat.unit_cost)),
    });
  }

  linhas.sort((a, b) => String(a.categoria).localeCompare(String(b.categoria)) || String(a.material).localeCompare(String(b.material)));
  extrato.sort((a, b) => a.epoch - b.epoch || String(a.id).localeCompare(String(b.id)));
  const ops = Array.from(opMap.values())
    .map((o) => ({ ...o, insumos: o.insumos.sort((a: any, b: any) => a.material.localeCompare(b.material)), perdas: o.perdas.sort((a: any, b: any) => a.material.localeCompare(b.material)), primeiro: dataHoraBR(o.primeiro) }))
    .sort((a, b) => String(a.op).localeCompare(String(b.op)));

  const soma = (k: string) => r2(linhas.reduce((s, l) => s + num(l[k]), 0));
  const totais = {
    insumos: linhas.length,
    insumos_movimentados: linhas.filter((l) => l.movimentos > 0).length,
    movimentos: extrato.length,
    ops: ops.length,
    valor_compras: soma('valor_compras'),
    valor_consumo_op: soma('valor_consumo_op'),
    valor_perdas: soma('valor_perdas'),
    valor_saldo_final: soma('valor_saldo_final'),
    com_divergencia: linhas.filter((l) => Math.abs(l.divergencia) > 0.0005).length,
  };
  return { periodo: { de: f.de, ate: f.ate }, totais, linhas, ops, extrato };
}

const ymd = (v: any): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

export function registerRelatorioInsumosRoutes(app: Express) {
  // GET /api/industria/relatorio-insumos?de=YYYY-MM-DD&ate=YYYY-MM-DD
  //   &categoria=polpa,fruta  &materiais=id1,id2
  app.get('/api/industria/relatorio-insumos', async (req: any, res) => {
    try {
      const hojeBR = diaBR(Date.now() / 1000);
      const de = ymd(req.query.de) || hojeBR.slice(0, 8) + '01';
      const ate = ymd(req.query.ate) || hojeBR;
      if (de > ate) return res.status(400).json({ error: 'data inicial maior que a final' });
      const cats = String(req.query.categoria || '').split(',').map((s) => s.trim()).filter(Boolean);
      const ids = String(req.query.materiais || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);

      const mr: any = await db.execute(sql`SELECT id, name, code, category, unit, quantity, unit_cost, is_active FROM raw_materials ORDER BY name`);
      let materials: MatRow[] = (mr.rows || []);
      if (cats.length) materials = materials.filter((m) => cats.includes(String(m.category || 'outros')));
      if (ids.length) materials = materials.filter((m) => ids.includes(String(m.id)));

      const mv: any = await db.execute(sql`
        SELECT m.id, m.raw_material_id, m.movement_type, m.quantity, m.previous_quantity, m.new_quantity,
               m.production_order_id, m.notes, m.created_by, m.unit_cost,
               EXTRACT(EPOCH FROM m.created_at)::float8 AS epoch,
               po.order_number, po.product_name AS op_product_name, po.lot_number AS op_lot_number,
               po.status AS op_status, po.quantity AS op_quantity, po.production_date AS op_production_date
        FROM raw_material_movements m
        LEFT JOIN production_orders po ON po.id = m.production_order_id
        WHERE m.created_at IS NOT NULL`);
      const rel = montarRelatorioInsumos(materials, (mv.rows || []) as MovRow[], { de, ate });
      res.json(rel);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });
}
