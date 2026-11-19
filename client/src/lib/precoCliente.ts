// client/src/lib/precoCliente.ts
// (19/nov/2026) Preço unitário sugerido de um produto para um cliente.
// Regra: cliente marcado como DISTRIBUIDOR (customers.is_distribuidor, ex.: Amorix) usa a
// coluna "Preços Amorix" (products.distributor_price); se ela estiver vazia, cai no preço
// padrão. Todos os demais clientes seguem o preço padrão (PJ Goiânia), como sempre.
// O vendedor continua podendo ajustar o valor no item.
export function precoParaCliente(product: any, customer: any): number {
  const padrao = parseFloat(product?.price ?? '0') || 0;
  if (!customer?.isDistribuidor) return padrao;
  const dist = parseFloat(product?.distributorPrice ?? '');
  return Number.isFinite(dist) && dist > 0 ? dist : padrao;
}
