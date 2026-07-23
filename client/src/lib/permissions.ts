// =============================================================================
//  Modelo de permissões granulares por usuário (fonte única da verdade).
//  Antes vivia dentro de AcessosEDelegacoes.tsx; foi extraído para cá para que a
//  tela de EDIÇÃO e a APLICAÇÃO (menu, botões, guardas) usem exatamente a mesma
//  matriz e as mesmas regras de padrão por função.
// =============================================================================
import { useMemo } from "react";
import { useQuery } from "@/lib/queryClient";

// ---- Matriz de acessos por função (catálogo completo — mesma base do Layout) ----
const REPORTS = ["admin", "coordinator", "administrative"];
const A = "admin", C = "coordinator", D = "administrative", V = "vendedor", T = "telemarketing", M = "motorista", I = "industria";
export type Acc = [group: string, label: string, roles: string[]];

export const ACCESS_MATRIX: Acc[] = [
  ["Geral", "Dashboard", [A, C, D, V, T, I]],
  ["Vendas", "Cards de Venda", [A, C, D, V, T]],
  ["Vendas", "Agenda de Vendas", [A, C, D, V, T]],
  ["Vendas", "Metas de Vendas", [A, C, D, V]],
  ["Vendas", "Rota de Visitas", [A, C, D, V, T]],
  ["Vendas", "Rota do Dia", [A, C, D, V]],
  ["Vendas", "Vendedores", REPORTS],
  ["Vendas", "Vendas Digitais", REPORTS],
  ["Vendas", "SDR Digital", [A, C, D, V, T]],
  ["Clientes", "Clientes / Carteira", [A, C, D, V, T]],
  ["Clientes", "Clientes Ativos", [A, C, D, V, T]],
  ["Clientes", "Clientes Virtuais do Dia", [A, C, D, V, T]],
  ["Clientes", "LEADs", [A, C, D, V, T]],
  ["Clientes", "Localizações", REPORTS],
  ["Clientes", "Tabela de Preços", REPORTS],
  ["Clientes", "Preços (Grade)", REPORTS],
  ["Logística", "Minhas Entregas", [M]],
  ["Logística", "Entregas do Dia", [A, C, D, V, T, M, I]],
  ["Logística", "Validação de Rotas", [A, C]],
  ["Logística", "Auditoria de Check-ins", [A, C, D, V]],
  ["Logística", "Dashboard de Entregas", [A, C, D, V]],
  ["Logística", "Gestão de Entregas", [A, C, D, V]],
  ["Logística", "Resumo das Rotas", REPORTS],
  ["Logística", "Mapa de Clientes", [A, C, D, V, T]],
  ["Logística", "Motoristas", REPORTS],
  ["Logística", "Relatórios de Entregas", REPORTS],
  ["Produtos & Estoque", "Produtos", REPORTS],
  ["Produtos & Estoque", "Tabela de Preços Hotsite", REPORTS],
  ["Produtos & Estoque", "Pedidos do Site", [A, C, D, T]],
  ["Produtos & Estoque", "Gestão de Estoque", REPORTS],
  ["Produtos & Estoque", "Cupons de Desconto", REPORTS],
  ["Produtos & Estoque", "Fornecedores", REPORTS],
  ["Faturamento", "Faturamentos", [A, C, D, V]],
  ["Faturamento", "Faturamento NF-e", REPORTS],
  ["Faturamento", "Pipeline Faturamento", REPORTS],
  ["Faturamento", "Pedido de Venda", REPORTS],
  ["Faturamento", "Faturar / Faturado", REPORTS],
  ["Faturamento", "Recuperação de Faturamento", REPORTS],
  ["Financeiro", "Contas a Receber", REPORTS],
  ["Financeiro", "Contas a Pagar", REPORTS],
  ["Financeiro", "Débitos Vencidos", [A, C, D, V, T]],
  ["Financeiro", "Pedidos Bloqueados", [A, C, D, V, T]],
  ["Financeiro", "Plano de Contas / DRE", REPORTS],
  ["Financeiro", "Contas Financeiras", REPORTS],
  ["Financeiro", "XMLs / SPED Fiscal", REPORTS],
  ["Financeiro", "Fluxo de Caixa", REPORTS],
  ["Financeiro", "Conciliação Bancária", REPORTS],
  ["Financeiro", "Conferência de Pagamentos", REPORTS],
  ["Financeiro", "Auditoria de Cobranças", REPORTS],
  ["Financeiro", "Radar de Compras", REPORTS],
  ["Comunicação", "WhatsApp", REPORTS],
  ["Comunicação", "Telefones de Clientes", REPORTS],
  ["Comunicação", "Central de Atendimento", [T]],
  ["Comunicação", "Central de Telemarketing", REPORTS],
  ["Comunicação", "Dashboard de Conversas", REPORTS],
  ["Comunicação", "Disparo em Massa", REPORTS],
  ["Comunicação", "Automações de Comunicação", REPORTS],
  ["Indústria", "Módulo Indústria", [A, I]],
  ["Indústria", "Matéria-Prima e Receitas", [A, I]],
  ["Relatórios", "Relatórios Dinâmicos", REPORTS],
  ["Relatórios", "Relatórios IA", REPORTS],
  ["Administração", "Integração Omie", REPORTS],
  ["Administração", "Instâncias Omie", [A]],
  ["Administração", "Ambiente Fiscal", REPORTS],
  ["Administração", "Agentes IA", REPORTS],
  ["Administração", "Logs Etapas Omie", REPORTS],
  ["Administração", "RH / Métricas", [A, C, D, V, T, M, I]],
  ["Administração", "Usuários", [A]],
  ["Administração", "Administração do Sistema", [A]],
  ["Administração", "Cenários Fiscais", REPORTS],
  ["Administração", "Cielo (PIX/Cartão)", REPORTS],
  ["Administração", "Acessos e Delegações", [A]],
];

export const ROLE_LABEL: Record<string, string> = {
  admin: "Administrador", coordinator: "Coordenador", administrative: "Administrativo",
  vendedor: "Vendedor", telemarketing: "Telemarketing", motorista: "Motorista", industria: "Indústria",
};

export const acessosDaFuncao = (role: string) => ACCESS_MATRIX.filter(a => a[2].includes(role));

// ---- Capacidades (flags) por card --------------------------------------------
export type CapKey = "ver" | "criar" | "editar" | "excluir" | "exportar";
export const CAPS: { k: CapKey; label: string }[] = [
  { k: "ver", label: "Visão" }, { k: "criar", label: "Criar" }, { k: "editar", label: "Editar" },
  { k: "excluir", label: "Excluir" }, { k: "exportar", label: "Exportar" },
];
export type Flags = Record<CapKey, boolean>;

// cards essencialmente de leitura (só Visão + Exportar)
const VIEW_ONLY = new Set<string>([
  "Dashboard", "Vendedores", "Localizações", "Mapa de Clientes", "Resumo das Rotas", "Relatórios de Entregas",
  "Dashboard de Entregas", "Relatórios Dinâmicos", "Relatórios IA", "Plano de Contas / DRE", "Fluxo de Caixa",
  "Radar de Compras", "Ambiente Fiscal", "Logs Etapas Omie", "RH / Métricas", "Auditoria de Check-ins",
  "Auditoria de Cobranças", "Conferência de Pagamentos", "Dashboard de Conversas", "Débitos Vencidos", "Pedidos Bloqueados",
]);
const GRUPOS_VENDAS = new Set(["Vendas", "Clientes", "Faturamento"]);

export const capsAplicaveis = (label: string): CapKey[] =>
  VIEW_ONLY.has(label) ? ["ver", "exportar"] : ["ver", "criar", "editar", "excluir", "exportar"];

function nivelFuncao(role: string): Record<Exclude<CapKey, "ver">, boolean | string> {
  switch (role) {
    case "admin":          return { criar: true, editar: true, excluir: true, exportar: true };
    case "coordinator":    return { criar: true, editar: true, excluir: false, exportar: true };
    case "administrative": return { criar: true, editar: true, excluir: false, exportar: true };
    case "vendedor":       return { criar: "vendas", editar: "vendas", excluir: false, exportar: false };
    case "telemarketing":  return { criar: "tele", editar: "tele", excluir: false, exportar: false };
    case "motorista":      return { criar: false, editar: "logistica", excluir: false, exportar: false };
    case "industria":      return { criar: "industria", editar: "industria", excluir: false, exportar: false };
    default:               return { criar: false, editar: false, excluir: false, exportar: false };
  }
}

/** Flags padrão de um card p/ uma função (pré-marca a matriz). */
export function flagsPadrao(card: Acc, role: string): Flags {
  const [grupo, label, roles] = card;
  const f: Flags = { ver: false, criar: false, editar: false, excluir: false, exportar: false };
  if (!roles.includes(role)) return f;
  f.ver = true;
  const nv = nivelFuncao(role);
  const aplic = capsAplicaveis(label);
  const resolve = (v: boolean | string) =>
    v === true ? true
    : v === "vendas" ? GRUPOS_VENDAS.has(grupo)
    : v === "tele" ? ["Comunicação", "Clientes", "Vendas"].includes(grupo)
    : v === "logistica" ? grupo === "Logística"
    : v === "industria" ? grupo === "Indústria" : false;
  (["criar", "editar", "excluir", "exportar"] as const).forEach(c => { if (aplic.includes(c)) f[c] = resolve(nv[c]); });
  return f;
}

// ---- APLICAÇÃO: mapa efetivo + checagem --------------------------------------
const EMPTY: Flags = { ver: false, criar: false, editar: false, excluir: false, exportar: false };

/** Mapa efetivo por card = padrão da função + overrides salvos (override vence). */
export function effectivePermissions(
  role: string,
  overrides?: Record<string, Partial<Flags>> | null,
): Record<string, Flags> {
  const map: Record<string, Flags> = {};
  ACCESS_MATRIX.forEach(card => { map[card[1]] = flagsPadrao(card, role); });
  if (overrides) {
    for (const [label, f] of Object.entries(overrides)) {
      map[label] = { ...(map[label] || EMPTY), ...(f || {}) };
    }
  }
  return map;
}

/**
 * Pode executar `cap` no card `label`?
 * FAIL-OPEN proposital: se o mapa ainda não carregou (undefined) ou o card não
 * existe na matriz, retorna true — nunca esconde/bloqueia por falta de dado.
 */
export function canDo(map: Record<string, Flags> | undefined, label: string, cap: CapKey = "ver"): boolean {
  if (!map) return true;
  const f = map[label];
  if (!f) return true;
  return !!f[cap];
}

// ---- Hook de consumo (usuário logado) ----------------------------------------
export interface UsePermissionsResult {
  ready: boolean;
  role: string;
  map: Record<string, Flags> | undefined;
  can: (label: string, cap?: CapKey) => boolean;
}

/**
 * Carrega as permissões EFETIVAS do usuário logado (padrão da função + overrides
 * salvos em /api/user-permissions/me) e expõe `can(card, cap)`.
 * Enquanto carrega, `can` é fail-open (não esconde nada).
 */
export function usePermissions(): UsePermissionsResult {
  const { data } = useQuery<{ role: string; permissions: Record<string, Partial<Flags>> }>({
    queryKey: ["/api/user-permissions/me"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const map = useMemo(
    () => (data ? effectivePermissions(data.role || "", data.permissions || {}) : undefined),
    [data],
  );
  return {
    ready: !!data,
    role: data?.role || "",
    map,
    can: (label: string, cap: CapKey = "ver") => canDo(map, label, cap),
  };
}
