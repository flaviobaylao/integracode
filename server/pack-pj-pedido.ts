// ============================================================================
// PACK FECHADO PARA CNPJ — ponte entre o pedido e a regra (nov/2026)
// ----------------------------------------------------------------------------
// A regra em si mora em shared/pack-pj.ts (pura, roda no navegador também).
// Aqui só carregamos o tamanho do fardo do cadastro e montamos a chamada, para
// que os três caminhos que criam pedido na loja usem exatamente o mesmo código:
//
//   • POST /api/public/orders ....... boleto e a criação final de todos
//   • /api/public/orders/pix/init ... ANTES de gerar a cobrança PIX
//   • cartão e Google Pay ........... ANTES de autorizar
//
// Barrar antes da cobrança é o ponto: no PIX e no cartão o dinheiro entra antes
// de o pedido nascer, então recusar só na criação cobraria por um pedido que
// não vamos montar.
//
// FALHA ABERTA de propósito: se a leitura do cadastro falhar, o pedido passa.
// A regra existe para organizar a expedição, não para derrubar venda quando o
// banco engasga.
// ============================================================================
import { db } from './db';
import { inArray } from 'drizzle-orm';
import { products } from '@shared/schema';
import { barrarPackPJ, unidadesPorFardo, type ItemForaDoPack } from '@shared/pack-pj';

export interface ItemDoPedido {
  productId?: any;
  productName?: any;
  quantity?: any;
}

/**
 * `null` = pode seguir (cliente não é PJ, está tudo em pack, ou não deu para ler).
 * Quando barra, devolve o corpo pronto para o `res.status(400).json(...)`.
 */
export async function barrarPackPJDoPedido(
  documento: any,
  customerType: any,
  itens: ItemDoPedido[],
): Promise<null | { message: string; code: string; itens: ItemForaDoPack[] }> {
  try {
    const lista = Array.isArray(itens) ? itens : [];
    const ids = lista.map((i) => String(i?.productId || '')).filter(Boolean);
    if (!ids.length) return null;

    // ⚠️ Consulta pelo construtor do drizzle (inArray), NAO por sql`id = ANY(${ids})`:
    // uma lista JS interpolada no template chega ao Postgres como texto e estoura
    // "malformed array literal". Como este modulo FALHA ABERTA, o erro nao aparecia
    // em lugar nenhum — a trava simplesmente nao barrava (visto em producao, 17/nov).
    const rows = await db
      .select({ id: products.id, name: products.name, filas: products.fardoFilas, porFila: products.fardoPorFila })
      .from(products)
      .where(inArray(products.id, ids));
    const porId = new Map<string, any>(rows.map((p: any) => [String(p.id), p]));

    const paraRegra = lista.map((i) => {
      const p = porId.get(String(i?.productId || ''));
      return {
        nome: String(p?.name || i?.productName || 'produto'),
        quantidade: Number(i?.quantity) || 0,
        unidadesPorFardo: unidadesPorFardo(p?.filas, p?.porFila),
      };
    });

    const barrado = barrarPackPJ(documento, customerType, paraRegra);
    if (barrado) {
      console.warn('📦 [PACK-PJ] recusado:', barrado.itens.map((x) => `${x.nome}=${x.quantidade}`).join(', '));
    }
    return barrado;
  } catch (e: any) {
    console.warn('[PACK-PJ] leitura do fardo falhou (segue sem a regra):', e?.message || e);
    return null;
  }
}
