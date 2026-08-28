import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// TRAVA DE ESTOQUE + RASTRO DE LOTE NO FATURAMENTO
// Regras que estes testes protegem:
//   1) nao existe faturamento com estoque insuficiente/negativo;
//   2) estoque e sempre por INSTANCIA;
//   3) card sem instancia, produto nao identificado ou produto sem lote = BLOQUEIO
//      (antes eram bypasses silenciosos que deixavam faturar);
//   4) a baixa devolve o LOTE consumido, para ir em cada item da NF;
//   5) faltando saldo no meio da baixa, tudo que ja foi baixado e estornado.
// ---------------------------------------------------------------------------

const lotesDb: any[] = [];
const movimentos: any[] = [];
const produtos: any[] = [
  { id: 'p-suco', name: 'Suco Laranja 1L', omieCode: '1001' },
  { id: 'p-agua', name: 'Agua 500ml', omieCode: '1002' },
];

vi.mock('../db', () => ({ db: { execute: vi.fn(async () => ({ rowCount: 1 })) } }));
vi.mock('../ensure-lote-columns', () => ({ ensureLoteColumns: vi.fn(async () => {}) }));
vi.mock('../storage', () => ({
  storage: {
    getProducts: async () => produtos,
    getProduct: async (id: string) => produtos.find((p) => p.id === id),
    getProductByOmieCode: async (code: string) => produtos.find((p) => p.omieCode === code),
    getInventoryLots: async (f: any) =>
      lotesDb.filter(
        (l) =>
          l.productId === f.productId &&
          l.instanceId === f.instanceId &&
          l.stockType === f.stockType &&
          l.isActive === f.isActive,
      ),
    getInventoryLot: async (id: string) => lotesDb.find((l) => l.id === id),
    updateInventoryLot: async (id: string, data: any) => {
      const l = lotesDb.find((x) => x.id === id);
      Object.assign(l, data);
      return l;
    },
    createInventoryMovement: async (m: any) => {
      movimentos.push(m);
      return m;
    },
  },
}));

const { validateStockForBilling, deductStockForBilling } = await import('../billing-pipeline-routes');

const lote = (over: any) => ({
  id: `l-${lotesDb.length + 1}`,
  productId: 'p-suco',
  instanceId: 'GYN',
  stockType: 'in_use',
  lotNumber: 'L-2026-001',
  quantity: '100.0000',
  isActive: true,
  manufacturingDate: '2026-08-01',
  expiryDate: '2027-02-01',
  ...over,
});

beforeEach(() => {
  lotesDb.length = 0;
  movimentos.length = 0;
});

describe('validateStockForBilling — a trava', () => {
  it('bloqueia quando o saldo da instancia e menor que o pedido', async () => {
    lotesDb.push(lote({ quantity: '5' }));
    const r = await validateStockForBilling({
      omieInstanceId: 'GYN',
      products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 10 }],
    });
    expect(r.valid).toBe(false);
    expect(r.shortages[0]).toMatchObject({ required: 10, available: 5 });
  });

  it('libera quando ha saldo suficiente', async () => {
    lotesDb.push(lote({ quantity: '50' }));
    const r = await validateStockForBilling({
      omieInstanceId: 'GYN',
      products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 10 }],
    });
    expect(r.valid).toBe(true);
  });

  it('estoque e por INSTANCIA: saldo em outra instancia nao serve', async () => {
    lotesDb.push(lote({ instanceId: 'BSB', quantity: '999' }));
    const r = await validateStockForBilling({
      omieInstanceId: 'GYN',
      products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 10 }],
    });
    expect(r.valid).toBe(false);
    expect(r.shortages[0].available).toBe(0);
  });

  it('BLOQUEIA card sem instancia (antes passava direto)', async () => {
    const r = await validateStockForBilling({
      omieInstanceId: null,
      products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 1 }],
    });
    expect(r.valid).toBe(false);
    expect(r.shortages[0].reason).toMatch(/instancia/i);
  });

  it('BLOQUEIA produto nao identificado (antes passava direto)', async () => {
    const r = await validateStockForBilling({
      omieInstanceId: 'GYN',
      products: [{ name: 'Produto Fantasma', quantity: 1 }],
    });
    expect(r.valid).toBe(false);
    expect(r.shortages[0].reason).toMatch(/nao identificado/i);
  });

  it('resolve produto sem id pelo NOME e confere o estoque dele', async () => {
    lotesDb.push(lote({ quantity: '2' }));
    const r = await validateStockForBilling({
      omieInstanceId: 'GYN',
      products: [{ name: 'Suco Laranja 1L', quantity: 3 }],
    });
    expect(r.valid).toBe(false);
    expect(r.shortages[0]).toMatchObject({ productId: 'p-suco', required: 3, available: 2 });
  });

  it('BLOQUEIA produto sem lote cadastrado — item de NF precisa de lote', async () => {
    const r = await validateStockForBilling({
      omieInstanceId: 'GYN',
      products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 1 }],
    });
    expect(r.valid).toBe(false);
    expect(r.shortages[0].reason).toMatch(/lote/i);
  });
});

describe('deductStockForBilling — baixa e rastro', () => {
  it('devolve o lote consumido (numero, quantidade, fabricacao e validade)', async () => {
    lotesDb.push(lote({ quantity: '100' }));
    const map = await deductStockForBilling(
      { id: 'card-1', omieInstanceId: 'GYN', products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 12 }] },
      { email: 'teste@honest' },
    );
    expect(map['0'].productId).toBe('p-suco');
    expect(map['0'].lots).toEqual([
      { lotId: 'l-1', lotNumber: 'L-2026-001', quantity: 12, manufacturingDate: '2026-08-01', expiryDate: '2027-02-01' },
    ]);
    expect(lotesDb[0].quantity).toBe('88.0000');
  });

  it('consome varios lotes (FIFO) e devolve todos no rastro', async () => {
    lotesDb.push(lote({ quantity: '10', lotNumber: 'L-A' }));
    lotesDb.push(lote({ quantity: '10', lotNumber: 'L-B' }));
    const map = await deductStockForBilling(
      { id: 'card-2', omieInstanceId: 'GYN', products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 15 }] },
      {},
    );
    expect(map['0'].lots.map((l: any) => [l.lotNumber, l.quantity])).toEqual([
      ['L-A', 10],
      ['L-B', 5],
    ]);
  });

  it('LANCA erro faltando saldo — antes faturava assim mesmo', async () => {
    lotesDb.push(lote({ quantity: '3' }));
    await expect(
      deductStockForBilling(
        { id: 'card-3', omieInstanceId: 'GYN', products: [{ id: 'p-suco', name: 'Suco Laranja 1L', quantity: 10 }] },
        {},
      ),
    ).rejects.toThrow(/estoque insuficiente/i);
  });

  it('ESTORNA o que ja tinha baixado quando um item seguinte falta', async () => {
    lotesDb.push(lote({ quantity: '100' }));                                   // suco: sobra
    lotesDb.push(lote({ productId: 'p-agua', quantity: '1', lotNumber: 'L-AG' })); // agua: falta
    await expect(
      deductStockForBilling(
        {
          id: 'card-4',
          omieInstanceId: 'GYN',
          products: [
            { id: 'p-suco', name: 'Suco Laranja 1L', quantity: 10 },
            { id: 'p-agua', name: 'Agua 500ml', quantity: 5 },
          ],
        },
        {},
      ),
    ).rejects.toThrow(/estoque insuficiente/i);

    // saldo do suco de volta em 100 e a agua intacta em 1 — nada ficou baixado
    expect(parseFloat(lotesDb[0].quantity)).toBe(100);
    expect(parseFloat(lotesDb[1].quantity)).toBe(1);
    expect(movimentos.filter((m) => m.movementType === 'cancel_reversal').length).toBeGreaterThan(0);
  });

  it('BLOQUEIA baixa sem instancia definida', async () => {
    await expect(
      deductStockForBilling({ id: 'card-5', omieInstanceId: null, products: [{ id: 'p-suco', name: 'x', quantity: 1 }] }, {}),
    ).rejects.toThrow(/instancia/i);
  });
});
