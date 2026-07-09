// Ordenação e filtragem padrão de vendedores/canais.
// Regra de negócio: em toda pick-list/lista de vendedores, mostrar SOMENTE os ativos,
// classificados por tipo na ordem: Externo CLT, Externo PJ, Telemarketing, Canal
// (vendedores sem tipo aparecem por último). Ordenação secundária: alfabética por nome.

export interface SellerLike {
  id?: string;
  role?: string;
  isActive?: boolean;
  sellerType?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
}

// Ordem dos tipos exigida pela regra de negócio.
const TYPE_RANK: Record<string, number> = {
  vendedor_clt: 0,   // Externo CLT
  vendedor_pj: 1,    // Externo PJ
  telemarketing: 2,  // Telemarketing
  canal: 3,          // Canal
};

// Rank efetivo do vendedor: usa sellerType; se ausente, um usuário com papel
// 'telemarketing' cai no grupo Telemarketing; caso contrário, "sem tipo" (por último).
export function sellerTypeRank(s: SellerLike): number {
  const t = (s.sellerType || '') as string;
  if (t in TYPE_RANK) return TYPE_RANK[t];
  if (s.role === 'telemarketing') return TYPE_RANK['telemarketing'];
  return 99;
}

function sellerDisplayName(s: SellerLike): string {
  return (s.name || `${s.firstName || ''} ${s.lastName || ''}`).trim();
}

// Comparador para usar direto em .sort(...) dentro de encadeamentos.
export function compareSellersByType(a: SellerLike, b: SellerLike): number {
  const ra = sellerTypeRank(a);
  const rb = sellerTypeRank(b);
  if (ra !== rb) return ra - rb;
  return sellerDisplayName(a).localeCompare(sellerDisplayName(b), 'pt-BR');
}

// Ordena (sem filtrar) uma lista de vendedores por tipo e depois por nome.
export function sortSellersByType<T extends SellerLike>(list: T[]): T[] {
  return [...list].sort(compareSellersByType);
}

// Filtra apenas ATIVOS (opcionalmente por um predicado de papel/condição) e
// ordena por tipo. É o utilitário padrão para montar pick-lists de vendedores.
export function orderedActiveSellers<T extends SellerLike>(
  list: T[] | undefined | null,
  predicate?: (s: T) => boolean,
): T[] {
  const arr = Array.isArray(list) ? list : [];
  const filtered = arr.filter((s) => !!s.isActive && (predicate ? predicate(s) : true));
  return sortSellersByType(filtered);
}

// Para filtros baseados em NOME de vendedor (ex.: mapas/relatórios que derivam
// os nomes dos dados): ordena a lista de nomes usando um mapa nome->sellerType.
export function sortSellerNamesByType(
  names: string[],
  typeByName: Record<string, string | undefined | null>,
): string[] {
  const rank = (n: string) => {
    const t = (typeByName[n] || '') as string;
    return t in TYPE_RANK ? TYPE_RANK[t] : 99;
  };
  return [...names].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b, 'pt-BR');
  });
}
