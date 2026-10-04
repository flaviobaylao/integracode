import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
vi.mock('../db', () => ({ db: {} }));
import { montarRelatorioInsumos, diaBR } from '../relatorio-insumos';

// epoch de um horario de Brasilia
const br = (s: string) => (Date.parse(s + 'Z') + 3 * 3600 * 1000) / 1000;
const mv = (id: string, mat: string, type: string, prev: number, nw: number, when: string, extra: any = {}) => ({
  id, raw_material_id: mat, movement_type: type, quantity: Math.abs(nw - prev), previous_quantity: prev, new_quantity: nw,
  epoch: br(when), unit_cost: 2, ...extra,
});

describe('RELATORIO PRD/PP/INSUMO', () => {
  const mats = [
    { id: 'A', name: 'ACUCAR', category: 'insumo', unit: 'kg', quantity: 75, unit_cost: 2 },
    { id: 'P', name: 'POLPA', category: 'polpa', unit: 'kg', quantity: 10, unit_cost: 5 },
    { id: 'Z', name: 'PARADO', category: 'insumo', unit: 'kg', quantity: 7, unit_cost: 1 },
  ];
  const movs = [
    mv('1', 'A', 'entrada_compra', 0, 100, '2026-09-20T10:00:00'),            // antes
    mv('2', 'A', 'saida_producao', 100, 80, '2026-10-01T00:30:00', { production_order_id: 'op1', order_number: 'OP-1', op_product_name: 'SUCO' }),
    mv('3', 'A', 'saida_producao', 80, 70, '2026-10-02T09:00:00', { production_order_id: 'op2', order_number: 'OP-2', notes: 'Consumo [estornado]' }),
    mv('4', 'A', 'entrada', 70, 80, '2026-10-02T10:00:00', { production_order_id: 'op2', notes: 'Estorno da finalizacao [estornado]' }),
    mv('5', 'A', 'perda', 80, 78, '2026-10-03T10:00:00'),
    mv('6', 'A', 'ajuste', 78, 75, '2026-10-03T11:00:00'),
    mv('9', 'A', 'perda', 75, 74, '2026-10-03T12:00:00', { production_order_id: 'op1', order_number: 'OP-1' }),
    mv('8', 'P', 'entrada', 0, 10, '2026-10-02T12:00:00', { production_order_id: 'op1', order_number: 'OP-1' }),
  ];
  const rel = montarRelatorioInsumos(mats as any, movs as any, { de: '2026-10-01', ate: '2026-10-31' });
  const A = rel.linhas.find((l: any) => l.material_id === 'A');

  it('dia de Brasilia', () => {
    expect(diaBR(Date.parse('2026-10-02T02:30:00Z') / 1000)).toBe('2026-10-01');
  });
  it('saldo inicial e final', () => {
    expect(A.saldo_inicial).toBe(100);
    expect(A.saldo_final).toBe(74);
  });
  it('colunas', () => {
    expect(A.consumo_op).toBe(20);   // estornado fora
    expect(A.estornos).toBe(0);      // par se anula
    expect(A.perdas).toBe(3);   // 2 manual + 1 na OP
    expect(A.ajustes).toBe(-3);
    expect(A.divergencia).toBe(0);
    expect(A.valor_consumo_op).toBe(40);
  });
  it('fecha: inicial + entradas - saidas + ajustes + estornos = final', () => {
    for (const l of rel.linhas) {
      expect(+(l.saldo_inicial + l.entradas - l.total_saidas + l.ajustes + l.estornos).toFixed(3)).toBe(l.saldo_final);
    }
  });
  it('consumo por OP e producao', () => {
    const op1 = rel.ops.find((o: any) => o.op === 'OP-1');
    expect(op1.insumos[0]).toMatchObject({ material: 'ACUCAR', quantidade: 20 });
    expect(op1.perdas[0]).toMatchObject({ material: 'ACUCAR', quantidade: 1 });
    expect(op1.custo_total).toBe(42); // (20 consumo + 1 perda) x R$ 2
    expect(op1.gerados[0]).toMatchObject({ material: 'POLPA', quantidade: 10 });
    expect(rel.ops.find((o: any) => o.op === 'OP-2')).toBeUndefined();
    const P = rel.linhas.find((l: any) => l.material_id === 'P');
    expect(P.producao).toBe(10);
  });
  it('sem movimento usa estoque atual', () => {
    const Z = rel.linhas.find((l: any) => l.material_id === 'Z');
    expect(Z.saldo_inicial).toBe(7); expect(Z.saldo_final).toBe(7); expect(Z.movimentos).toBe(0);
  });
  it('periodo anterior: saldo vem do 1o movimento depois', () => {
    const r = montarRelatorioInsumos(mats as any, movs as any, { de: '2026-09-01', ate: '2026-09-10' });
    const a = r.linhas.find((l: any) => l.material_id === 'A');
    expect(a.saldo_inicial).toBe(0); expect(a.saldo_final).toBe(0);
  });
});
