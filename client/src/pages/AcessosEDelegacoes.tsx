// =============================================================================
//  INTEGRA 2.0 — Página Acessos e Delegações  (somente admin)
//  Salve como client/src/pages/AcessosEDelegacoes.tsx
//  Segue o padrão do projeto: wouter, @/components/ui (shadcn), queryClient,
//  use-toast. Consome /api/users, /api/delegations, /api/delegations/preview
//  e /api/user-permissions.
//
//  Abas:
//   1) Acessos por Usuário  — permissões granulares Módulo>Card>flags por usuário
//   2) Delegar Carteira     — transferir/ratear carteira por período
//   3) Delegar Acessos      — delegar acessos de uma função por período
//   4) Delegações Ativas
// =============================================================================
import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { User } from "@shared/schema";
import { ACCESS_MATRIX, ROLE_LABEL, acessosDaFuncao, CAPS, capsAplicaveis, flagsPadrao } from "@/lib/permissions";
import type { Acc, CapKey, Flags } from "@/lib/permissions";

const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style:"currency", currency:"BRL", maximumFractionDigits:0 });

// ---- rótulos / helpers da aba "Delegações Ativas" ----------------------------
const TIPO_LABEL: Record<string,string> = {
  carteira_transferencia: "Transferência de carteira",
  carteira_rateio: "Rateio de carteira",
  acesso_funcao: "Delegação de acessos",
};
const STATUS_META: Record<string,{label:string,cls:string}> = {
  ativa:    { label:"Ativa",    cls:"bg-green-100 text-green-700" },
  agendada: { label:"Agendada", cls:"bg-blue-100 text-blue-700" },
  expirada: { label:"Expirada", cls:"bg-gray-100 text-gray-500" },
  revogada: { label:"Revogada", cls:"bg-red-100 text-red-600" },
};
function restanteStr(endsAt: string) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "encerrada";
  const d = Math.floor(ms/86400000), h = Math.floor((ms%86400000)/3600000), mi = Math.floor((ms%3600000)/60000);
  if (d > 0) return `faltam ${d}d ${h}h`;
  if (h > 0) return `faltam ${h}h ${mi}min`;
  return `faltam ${mi}min`;
}
// rótulo do recorte usado na delegação (carteira inteira ou por cliente/cidade/bairro)
const ESCOPO_LABEL: Record<string,string> = { clientes: "clientes específicos", cidades: "cidade(s)", bairros: "bairro(s)", dias: "dia(s) de rota" };
// bucket dos clientes sem dia de rota cadastrado (espelha SEM_DIA do backend)
const SEM_DIA = "__sem_dia__";
// dimensões combináveis do recorte
type Dim = "clientes" | "cidades" | "bairros" | "dias";
type Opc = { value: string; label: string; qtd: number };
const DIMS: Dim[] = ["clientes", "cidades", "bairros", "dias"];
const DIM_BOTAO: Record<Dim, string> = { clientes: "Clientes", cidades: "Cidades", bairros: "Bairros", dias: "Dia de rota" };
const DIM_BUSCA: Record<Dim, string> = { clientes: "Buscar cliente…", cidades: "Buscar cidade…", bairros: "Buscar bairro…", dias: "" };
function escopoLabel(d: any) {
  const f = d?.scopeFilters;
  if (f) {
    const partes = (["clientes","cidades","bairros","dias"] as const)
      .filter(k => Array.isArray(f[k]) && f[k].length)
      .map(k => `${f[k].length} ${ESCOPO_LABEL[k]}`);
    if (!partes.length) return null;
    return <> · <span className="text-indigo-600">recorte: {partes.join(" + ")}</span></>;
  }
  const t = d?.scopeType || "todos";
  if (t === "todos") return null;
  const n = Array.isArray(d?.scopeValues) ? d.scopeValues.length : 0;
  return <> · <span className="text-indigo-600">recorte por {ESCOPO_LABEL[t] || t}{n ? ` (${n})` : ""}</span></>;
}

function fmtDT(s: string){
  return new Date(s).toLocaleString("pt-BR",{ day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
}


export default function AcessosEDelegacoes() {
  const { toast } = useToast();
  const { data: users = [] } = useQuery<User[]>({ queryKey: ["/api/users"] });
  const { data: delegs = [] } = useQuery<any[]>({ queryKey: ["/api/delegations"] });
  const { data: sobDelegacao = [] } = useQuery<any[]>({ queryKey: ["/api/delegations/clientes-sob-delegacao"] });
  const [buscaSob, setBuscaSob] = useState("");
  const [buscaUser, setBuscaUser] = useState("");

  // Somente usuários ATIVOS (status "Ativo" em Gerenciamento de Usuários)
  const activeUsers = useMemo(() => users.filter(u => u.isActive), [users]);
  const sellers = useMemo(
    () => activeUsers.filter(u => ["vendedor","telemarketing"].includes(u.role || "")),
    [activeUsers]
  );

  // nome legível por id de usuário (para a aba Delegações Ativas)
  const nameById = useMemo(() => {
    const m: Record<string,string> = {};
    users.forEach(u => { m[u.id] = `${u.firstName||""} ${u.lastName||""}`.trim() || u.id; });
    return m;
  }, [users]);
  const nomeUsuario = (id?: string) => (id && nameById[id]) || id || "—";
  // ticker: atualiza a contagem regressiva a cada minuto
  const [, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setNowTick(x => x + 1), 60000); return () => clearInterval(t); }, []);

  // ---- estado da aba Carteira ----
  const [modo, setModo] = useState<"transferencia"|"rateio">("transferencia");
  const [fromUserId, setFromUserId] = useState<string>("");
  const [targets, setTargets] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string>("segmento_faturamento");
  const [ini, setIni] = useState(""); const [fim, setFim] = useState("");

  // ---- escopo da carteira: dimensões COMBINÁVEIS ----
  // Regra: clientes + cidades + bairros SOMAM entre si; o dia de rota CRUZA com
  // esse conjunto. Nenhuma dimensão ativa = carteira inteira.
  const [dimsAtivas, setDimsAtivas] = useState<Dim[]>([]);
  const [escopoSel, setEscopoSel] = useState<Record<Dim, string[]>>({ clientes: [], cidades: [], bairros: [], dias: [] });
  const [buscaEscopo, setBuscaEscopo] = useState<Record<Dim, string>>({ clientes: "", cidades: "", bairros: "", dias: "" });

  // carteira do titular (alimenta os seletores de escopo)
  const { data: carteira } = useQuery<any>({
    queryKey: ["/api/delegations/carteira", fromUserId],
    enabled: !!fromUserId,
    queryFn: () => apiRequest("GET", `/api/delegations/carteira/${fromUserId}`),
  });

  // trocar o titular invalida o recorte anterior (ids/cidades são de outra carteira)
  useEffect(() => {
    setDimsAtivas([]);
    setEscopoSel({ clientes: [], cidades: [], bairros: [], dias: [] });
    setBuscaEscopo({ clientes: "", cidades: "", bairros: "", dias: "" });
  }, [fromUserId]);

  // opções de cada dimensão, já filtradas pela busca daquela dimensão
  const opcoesDim = (dim: Dim): Opc[] => {
    if (!carteira) return [];
    const q = (buscaEscopo[dim] || "").trim().toLowerCase();
    const hit = (t: string) => !q || t.toLowerCase().includes(q);
    if (dim === "clientes")
      return (carteira.clientes || [])
        .filter((c: any) => hit(`${c.nome} ${c.cidade} ${c.bairro}`))
        .map((c: any) => ({ value: c.id, label: `${c.nome}${c.cidade ? ` · ${c.cidade}` : ""}${c.bairro ? ` / ${c.bairro}` : ""}`, qtd: 1 }));
    if (dim === "cidades")
      return (carteira.cidades || []).filter((c: any) => hit(c.cidade))
        .map((c: any) => ({ value: c.key, label: c.cidade, qtd: c.qtd }));
    if (dim === "bairros")
      return (carteira.bairros || []).filter((b: any) => hit(`${b.bairro} ${b.cidade}`))
        .map((b: any) => ({ value: b.key, label: `${b.bairro} · ${b.cidade}`, qtd: b.qtd }));
    return (carteira.dias || []).map((d: any) => ({ value: d.key, label: d.dia, qtd: d.qtd }));
  };

  // só conta o que está numa dimensão ATIVA (desligar a dimensão não deve deixar
  // resíduo marcado influenciando o recorte)
  const sel = (dim: Dim): string[] => (dimsAtivas.includes(dim) ? escopoSel[dim] : []);
  const filtrosAtivos = () => {
    const f: Record<string, string[]> = {};
    for (const d of DIMS) if (sel(d).length) f[d] = sel(d);
    return f;
  };
  const dimVaziaAtiva = dimsAtivas.find(d => !escopoSel[d].length);

  // quantos clientes o recorte atual alcança — MESMA regra do backend:
  // (clientes ∪ cidades ∪ bairros) ∩ (dias)
  const clientesNoEscopo = useMemo(() => {
    if (!carteira) return 0;
    // dimensão ligada e sem nada marcado = recorte incompleto: mostrar o total da
    // carteira aqui daria a impressão de que tudo seria delegado.
    if (dimsAtivas.some(d => !escopoSel[d].length)) return 0;
    const cli = new Set(sel("clientes")), cid = new Set(sel("cidades")), bai = new Set(sel("bairros"));
    const dias = new Set(sel("dias"));
    const temQuem = cli.size || cid.size || bai.size;
    if (!temQuem && !dias.size) return carteira.total || 0;
    return (carteira.clientes || []).filter((c: any) => {
      if (temQuem && !(cli.has(c.id) || cid.has(c.cidadeKey) || bai.has(c.bairroKey))) return false;
      if (dias.size) {
        const ds: string[] = c.dias || [];
        return ds.length ? ds.some((d) => dias.has(d)) : dias.has(SEM_DIA);
      }
      return true;
    }).length;
  }, [carteira, dimsAtivas, escopoSel]);

  // sem nenhuma dimensão ativa não mandamos "filtros": o backend trata objeto
  // presente e vazio como recorte inválido (não como carteira inteira).
  const escopoBody = () => (dimsAtivas.length ? { filtros: filtrosAtivos() } : {});
  const toggleEscopo = (dim: Dim, v: string) =>
    setEscopoSel(prev => ({ ...prev, [dim]: prev[dim].includes(v) ? prev[dim].filter(x => x !== v) : [...prev[dim], v] }));
  const toggleDim = (dim: Dim) =>
    setDimsAtivas(prev => prev.includes(dim) ? prev.filter(d => d !== dim) : [...prev, dim]);

  const { data: preview = [] } = useQuery<any[]>({
    queryKey: ["/api/delegations/preview", fromUserId, targets, criteria, modo, dimsAtivas, escopoSel],
    enabled: !!fromUserId && targets.length > 0 && !dimVaziaAtiva,
    queryFn: () => apiRequest("POST", "/api/delegations/preview", {
      fromUserId, targets, criteria: modo === "transferencia" ? "nenhum" : criteria,
      escopo: escopoBody(),
    }),
  });

  const createMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/delegations", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/delegations"] });
      toast({ title: "Delegação criada", description: "Carteira/acessos delegados com sucesso." });
    },
    onError: () => toast({ title: "Erro", description: "Não foi possível criar a delegação.", variant: "destructive" }),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/delegations/${id}/revoke`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/delegations"] });
      toast({ title: "Delegação revogada", description: "Carteira/acessos devolvidos ao titular." }); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/delegations/${id}`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/delegations"] });
      toast({ title: "Delegação excluída", description: "Registro removido definitivamente." }); },
  });

  const criarCarteira = () => {
    if (!fromUserId || !targets.length || !ini || !fim)
      return toast({ title: "Campos incompletos", variant: "destructive" });
    if (dimVaziaAtiva)
      return toast({ title: "Recorte incompleto", description: `Selecione ao menos um item em "${ESCOPO_LABEL[dimVaziaAtiva]}" ou desligue essa dimensão.`, variant: "destructive" });
    createMut.mutate({
      type: modo === "transferencia" ? "carteira_transferencia" : "carteira_rateio",
      fromUserId, targets, criteria: modo === "transferencia" ? "nenhum" : criteria,
      startsAt: new Date(ini), endsAt: new Date(fim), autoReturn: true,
      escopo: escopoBody(),
    }, {
      // limpa o formulário. Cuidado: um erro aqui dentro faz o TanStack Query cair
      // no onError da mutation e mostrar "não foi possível criar" para uma delegação
      // que JÁ foi criada — foi exatamente o que aconteceu ao trocar o estado do escopo.
      onSuccess: () => {
        setFromUserId(""); setTargets([]); setIni(""); setFim("");
        setDimsAtivas([]);
        setEscopoSel({ clientes: [], cidades: [], bairros: [], dias: [] });
        setBuscaEscopo({ clientes: "", cidades: "", bairros: "", dias: "" });
      },
    });
  };

  // ---- estado da aba Acessos ----
  const [role, setRole] = useState("coordinator");
  const [accSel, setAccSel] = useState<string[]>([]);
  const [toUserAc, setToUserAc] = useState("");
  const [acIni, setAcIni] = useState(""); const [acFim, setAcFim] = useState("");
  const acessos = acessosDaFuncao(role);

  const criarAcesso = () => {
    if (!accSel.length || !toUserAc || !acIni || !acFim)
      return toast({ title: "Campos incompletos", variant: "destructive" });
    createMut.mutate({
      type: "acesso_funcao", originRole: role, accesses: accSel, targets: [toUserAc],
      criteria: "nenhum", startsAt: new Date(acIni), endsAt: new Date(acFim), autoReturn: true,
    }, {
      onSuccess: () => { setAccSel([]); setToUserAc(""); setAcIni(""); setAcFim(""); }, // limpa o formulário
    });
  };

  // ---- estado da aba Acessos por Usuário ----
  const [selUserId, setSelUserId] = useState<string>("");
  const selUser = users.find(u => u.id === selUserId) || users[0];
  // permissões efetivas do usuário: { [cardLabel]: Flags }
  const [permMap, setPermMap] = useState<Record<string, Flags>>({});

  // carrega permissões salvas + pré-marca pelo padrão da função ao trocar de usuário.
  // refetchOnWindowFocus:false evita que um refetch em segundo plano dispare a
  // reinicialização abaixo e apague edições ainda não salvas.
  const { data: savedPerms } = useQuery<Record<string, Flags>>({
    queryKey: ["/api/user-permissions", selUser?.id],
    enabled: !!selUser?.id,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  // Reinicializa o permMap APENAS ao trocar de usuário (ou quando o salvo daquele
  // usuário chega pela 1ª vez). NÃO reinicializa a cada refetch do mesmo usuário —
  // era isso que apagava as alterações do admin antes de ele clicar em "Salvar acessos".
  const permInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selUser?.id) return;
    if (savedPerms === undefined) return;            // ainda carregando o salvo
    if (permInitRef.current === selUser.id) return;  // já inicializado p/ este usuário
    const base: Record<string, Flags> = {};
    ACCESS_MATRIX.forEach(c => { base[c[1]] = flagsPadrao(c, selUser.role || ""); });
    setPermMap({ ...base, ...(savedPerms || {}) }); // override do salvo sobre o padrão
    permInitRef.current = selUser.id;
  }, [selUser?.id, selUser?.role, savedPerms]);

  // popups de confirmação (antes) e sucesso (depois) ao salvar acessos
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const savePermsMut = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/user-permissions/${selUser!.id}`, { permissions: permMap }),
    onSuccess: () => {
      setConfirmSaveOpen(false);
      setSuccessOpen(true); // popup de sucesso
      // recarrega o salvo do servidor para a tela refletir exatamente o que persistiu
      queryClient.invalidateQueries({ queryKey: ["/api/user-permissions", selUser?.id] });
      toast({ title: "Acessos atualizados", description: `As novas configurações de ${selUser?.firstName} estão vigentes.` });
    },
    onError: () => {
      setConfirmSaveOpen(false);
      toast({ title: "Erro ao salvar", description: "Não foi possível salvar os acessos. Tente novamente.", variant: "destructive" });
    },
  });
  // "Voltar ao papel padrão": remove TODAS as personalizações salvas (limpa os
  // overrides) — o usuário retorna exatamente às funções originais do papel, e os
  // acessos extras que o admin havia concedido são desmarcados automaticamente.
  const resetRoleMut = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/user-permissions/${selUser!.id}`, { permissions: {} }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/user-permissions", selUser?.id] });
      if (selUser) {
        const base: Record<string, Flags> = {};
        ACCESS_MATRIX.forEach(c => { base[c[1]] = flagsPadrao(c, selUser.role || ""); });
        setPermMap(base); // reflete na tela: flags voltam ao padrão do papel
      }
      toast({ title: "Acessos restaurados ao papel", description: `${selUser?.firstName} voltou aos acessos padrão de ${ROLE_LABEL[selUser?.role||""]}. Personalizações removidas.` });
    },
    onError: () => toast({ title: "Erro", description: "Não foi possível restaurar ao papel.", variant: "destructive" }),
  });
  const toggleFlag = (label: string, cap: CapKey, val: boolean) => {
    setPermMap(prev => {
      const f = { ...(prev[label] || { ver:false,criar:false,editar:false,excluir:false,exportar:false }) };
      f[cap] = val;
      if (cap === "ver" && !val) (Object.keys(f) as CapKey[]).forEach(k => (f[k] = false));
      if (cap !== "ver" && val) f.ver = true;
      return { ...prev, [label]: f };
    });
  };
  const resetPadrao = () => {
    if (!selUser) return;
    const base: Record<string, Flags> = {};
    ACCESS_MATRIX.forEach(c => { base[c[1]] = flagsPadrao(c, selUser.role || ""); });
    setPermMap(base);
  };
  // tudo/nada por AÇÃO (coluna): aplica a todos os cards aplicáveis
  const bulkCap = (cap: CapKey, on: boolean) => {
    setPermMap(prev => {
      const next = { ...prev };
      ACCESS_MATRIX.forEach(c => {
        const label = c[1]; if (!capsAplicaveis(label).includes(cap)) return;
        const f = { ...(next[label] || { ver:false,criar:false,editar:false,excluir:false,exportar:false }) };
        f[cap] = on;
        if (cap === "ver" && !on) (Object.keys(f) as CapKey[]).forEach(k => (f[k] = false));
        if (cap !== "ver" && on) f.ver = true;
        next[label] = f;
      });
      return next;
    });
  };
  // agrupa cards por módulo p/ a árvore
  const modulos = useMemo(() => {
    const g: Record<string, Acc[]> = {};
    ACCESS_MATRIX.forEach(c => (g[c[0]] = g[c[0]] || []).push(c));
    return g;
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-lg bg-indigo-500 text-white flex items-center justify-center">
          <i className="fas fa-user-shield text-lg" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Acessos e Delegações</h1>
          <p className="text-sm text-gray-500">Administre acessos individuais e delegue carteiras/funções por tempo determinado</p>
        </div>
        <span className="ml-auto text-[11px] bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full font-semibold">
          <i className="fas fa-lock mr-1" />Somente administradores
        </span>
      </div>

      <Tabs defaultValue="usuarios">
        <TabsList>
          <TabsTrigger value="usuarios"><i className="fas fa-user-lock mr-2" />Acessos por Usuário</TabsTrigger>
          <TabsTrigger value="carteira"><i className="fas fa-briefcase mr-2" />Delegar Carteira</TabsTrigger>
          <TabsTrigger value="acessos"><i className="fas fa-key mr-2" />Delegar Acessos &amp; Funções</TabsTrigger>
          <TabsTrigger value="ativas"><i className="fas fa-list-check mr-2" />Delegações Ativas</TabsTrigger>
          <TabsTrigger value="sob-delegacao"><i className="fas fa-tag mr-2" />Clientes sob delegação</TabsTrigger>
        </TabsList>

        {/* ============ ACESSOS POR USUÁRIO ============ */}
        <TabsContent value="usuarios" className="grid lg:grid-cols-[300px_1fr] gap-6 mt-4">
          <Card className="p-4">
            <h3 className="font-bold mb-2">Usuários ativos</h3>
            <input
              value={buscaUser}
              onChange={(e) => setBuscaUser(e.target.value)}
              placeholder="Buscar usuário…"
              className="w-full border rounded px-3 py-1.5 text-sm mb-2"
            />
            {(() => {
              const q = buscaUser.trim().toLowerCase();
              // Lista apenas usuários ATIVOS que são Vendedores (mesmos papéis da tela
              // "Vendedores": vendedor + telemarketing).
              const lista = activeUsers
                .filter(u => ["vendedor", "telemarketing"].includes(u.role || ""))
                .filter(u =>
                  !q || `${u.firstName || ""} ${u.lastName || ""} ${ROLE_LABEL[u.role || ""] || ""}`.toLowerCase().includes(q)
                );
              return (
                <div className="space-y-1 max-h-[560px] overflow-y-auto">
                  {lista.length === 0 && <p className="text-xs text-gray-400 px-1 py-2">Nenhum usuário encontrado.</p>}
                  {lista.map(u => (
                    <button key={u.id} onClick={() => setSelUserId(u.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg border ${selUser?.id===u.id?"border-indigo-400 bg-indigo-50":"border-transparent hover:bg-gray-50"}`}>
                      <div className="text-sm font-semibold text-gray-800">{u.firstName} {u.lastName}</div>
                      <div className="text-[11px] text-gray-500">{ROLE_LABEL[u.role||""]}</div>
                    </button>
                  ))}
                </div>
              );
            })()}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-bold">{selUser?.firstName} {selUser?.lastName}</h3>
                <p className="text-xs text-gray-500">Função base: <b>{ROLE_LABEL[selUser?.role||""]}</b> · flags pré-marcados pela função</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={resetPadrao} title="Reverte as marcações na tela para o padrão do papel (ainda é preciso Salvar)">Restaurar padrão</Button>
                <Button size="sm" variant="outline" className="text-amber-700 border-amber-300 hover:bg-amber-50" disabled={resetRoleMut.isPending} title="Remove todas as personalizações salvas e volta o usuário às funções originais do papel"
                  onClick={() => { if (selUser && window.confirm(`Voltar ${selUser.firstName} às funções ORIGINAIS do papel (${ROLE_LABEL[selUser.role||""]}) e remover todos os acessos extras concedidos?`)) resetRoleMut.mutate(); }}>
                  {resetRoleMut.isPending ? "Voltando…" : "Voltar ao papel padrão"}
                </Button>
                <Button size="sm" onClick={() => setConfirmSaveOpen(true)} disabled={savePermsMut.isPending}>Salvar acessos</Button>
              </div>
            </div>
            <div className="hidden md:grid w-fit grid-cols-[260px_repeat(5,58px)] items-end gap-0 py-2 bg-gray-50 rounded">
              <div className="flex items-end justify-between px-3">
                <span className="text-[11px] font-bold text-gray-500 uppercase">Card</span>
                <span className="text-[10px] font-semibold text-indigo-300 uppercase">Possibilidades →</span>
              </div>
              {CAPS.map(c => (
                <div key={c.k} className={`flex flex-col items-center ${c.k === "criar" ? "border-l-2 border-indigo-200" : "border-l border-gray-100"}`}>
                  <span className="text-[11px] font-bold text-gray-500 uppercase">{c.label}</span>
                  <span className="text-[10px]">
                    <button className="text-indigo-600 font-semibold" onClick={() => bulkCap(c.k, true)}>tudo</button>
                    <span className="text-gray-300">·</span>
                    <button className="text-gray-400 font-semibold" onClick={() => bulkCap(c.k, false)}>nada</button>
                  </span>
                </div>
              ))}
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              {Object.entries(modulos).map(([grupo, cards]) => (
                <details key={grupo} open className="mb-2 border border-gray-100 rounded-lg overflow-hidden">
                  <summary className="cursor-pointer px-3 py-2 bg-gray-50 font-semibold text-sm">{grupo}</summary>
                  {cards.map(card => {
                    const label = card[1]; const f = permMap[label] || {} as Flags; const aplic = capsAplicaveis(label);
                    return (
                      <div key={label} className="grid w-fit grid-cols-[260px_repeat(5,58px)] items-stretch gap-0 mb-1 rounded-lg border border-gray-200 bg-gray-50/70 overflow-hidden hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors">
                        <span className="text-sm text-gray-700 flex items-center font-medium px-3 py-2 truncate" title={label}>{label}</span>
                        {CAPS.map(c => {
                          const on = !!f[c.k]; const applicable = aplic.includes(c.k);
                          const sep = c.k === "criar" ? "border-l-2 border-indigo-100" : "border-l border-gray-100";
                          const cellOn = applicable && on ? "bg-indigo-100/70" : "";
                          return (
                            <span key={c.k} className={`flex items-center justify-center ${sep} ${cellOn} transition-colors`}>
                              {applicable
                                ? <input type="checkbox" className="accent-indigo-500 w-4 h-4 cursor-pointer"
                                    checked={on} onChange={e => toggleFlag(label, c.k, e.target.checked)} />
                                : <span className="text-gray-300 text-xs">—</span>}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
                </details>
              ))}
            </div>
          </Card>
        </TabsContent>

        {/* ============ CARTEIRA ============ */}
        <TabsContent value="carteira" className="grid lg:grid-cols-2 gap-6 mt-4">
          <Card className="p-5 space-y-5">
            <div className="grid grid-cols-2 gap-2">
              <Button variant={modo==="transferencia"?"default":"outline"} onClick={() => setModo("transferencia")}>Transferir 1→1</Button>
              <Button variant={modo==="rateio"?"default":"outline"} onClick={() => setModo("rateio")}>Dividir 1→2/3</Button>
            </div>

            <label className="block text-xs font-semibold text-gray-500 uppercase">Carteira de origem
              <select className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={fromUserId} onChange={e => setFromUserId(e.target.value)}>
                <option value="">Selecione…</option>
                {sellers.map(s => <option key={s.id} value={s.id}>{s.firstName} {s.lastName} · {ROLE_LABEL[s.role||""]}</option>)}
              </select>
            </label>

            {/* ---- Escopo: dimensões combináveis (clientes/cidades/bairros somam; dia cruza) ---- */}
            <div className="space-y-2">
              <span className="block text-xs font-semibold text-gray-500 uppercase">O que delegar</span>
              <div className="grid grid-cols-5 gap-1">
                <Button size="sm" className="text-xs px-1"
                  variant={dimsAtivas.length ? "outline" : "default"}
                  onClick={() => { setDimsAtivas([]); setEscopoSel({ clientes: [], cidades: [], bairros: [], dias: [] }); }}>
                  Carteira inteira
                </Button>
                {DIMS.map((d) => (
                  <Button key={d} size="sm" className="text-xs px-1"
                    variant={dimsAtivas.includes(d) ? "default" : "outline"}
                    onClick={() => toggleDim(d)}>{DIM_BOTAO[d]}</Button>
                ))}
              </div>

              {dimsAtivas.length > 1 && (
                <p className="text-xs text-gray-500">
                  Clientes, cidades e bairros <strong>somam</strong> entre si; o dia de rota <strong>cruza</strong> com essa seleção.
                </p>
              )}

              {!fromUserId && dimsAtivas.length > 0 && (
                <p className="text-xs text-gray-400">Selecione a carteira de origem para listar as opções.</p>
              )}

              {fromUserId && dimsAtivas.map((dim) => {
                const opcoes = opcoesDim(dim);
                return (
                  <div key={dim} className="border rounded-lg">
                    <div className="flex items-center gap-2 p-2 border-b">
                      <span className="text-xs font-semibold text-gray-600 whitespace-nowrap">{DIM_BOTAO[dim]}</span>
                      {dim === "dias"
                        ? <span className="flex-1 text-xs text-gray-500">Dias em que a rota do titular será atendida pelo delegado (dentro do período abaixo).</span>
                        : <input
                            className="flex-1 border rounded px-2 py-1 text-sm"
                            placeholder={DIM_BUSCA[dim]}
                            value={buscaEscopo[dim]}
                            onChange={e => setBuscaEscopo(prev => ({ ...prev, [dim]: e.target.value }))} />}
                      <button type="button" className="text-xs text-indigo-600 hover:underline whitespace-nowrap"
                        onClick={() => setEscopoSel(prev => ({ ...prev, [dim]: opcoes.map(o => o.value) }))}>Todos</button>
                      <button type="button" className="text-xs text-gray-500 hover:underline whitespace-nowrap"
                        onClick={() => setEscopoSel(prev => ({ ...prev, [dim]: [] }))}>Limpar</button>
                    </div>
                    <div className="max-h-52 overflow-auto p-1">
                      {opcoes.length === 0 && (
                        <p className="text-xs text-gray-400 p-2">Nenhum resultado nesta carteira.</p>
                      )}
                      {opcoes.map((o) => (
                        <label key={o.value} className="flex items-center gap-2 px-2 py-1 text-sm hover:bg-gray-50 rounded cursor-pointer">
                          <input type="checkbox" checked={escopoSel[dim].includes(o.value)} onChange={() => toggleEscopo(dim, o.value)} />
                          <span className="flex-1 truncate">{o.label}</span>
                          {dim !== "clientes" && <span className="text-xs text-gray-400">{o.qtd}</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}

              {fromUserId && (
                <p className="text-xs text-gray-500">
                  {!dimsAtivas.length
                    ? <>Carteira inteira · <strong>{carteira?.total ?? 0}</strong> cliente{(carteira?.total ?? 0) !== 1 ? "s" : ""}</>
                    : <>Recorte: {dimsAtivas.map(d => `${escopoSel[d].length} ${ESCOPO_LABEL[d]}`).join(" + ")} · {dimVaziaAtiva
                        ? <span className="text-amber-600">falta escolher {ESCOPO_LABEL[dimVaziaAtiva]}</span>
                        : <>alcança <strong>{clientesNoEscopo}</strong> de {carteira?.total ?? 0} cliente(s)</>}</>}
                </p>
              )}
            </div>

            <label className="block text-xs font-semibold text-gray-500 uppercase">
              {modo === "transferencia" ? "Delegar para (1)" : "Dividir entre (2 ou 3)"}
              <select multiple={modo==="rateio"} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
                value={modo==="transferencia" ? (targets[0]||"") : targets}
                onChange={e => {
                  const vals = Array.from(e.target.selectedOptions).map(o => o.value);
                  setTargets(modo==="transferencia" ? [vals[0]] : vals.slice(0,3));
                }}>
                {sellers.filter(s => s.id !== fromUserId).map(s => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
              </select>
            </label>

            {modo === "rateio" && (
              <label className="block text-xs font-semibold text-gray-500 uppercase">Critério de rateio
                <select className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={criteria} onChange={e => setCriteria(e.target.value)}>
                  <option value="segmento_faturamento">Segmento + faturamento (recomendado)</option>
                  <option value="segmento">Somente segmento</option>
                  <option value="faturamento">Somente faturamento médio (3m)</option>
                  <option value="quantidade">Somente quantidade de clientes</option>
                </select>
              </label>
            )}

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-500">Início<input type="date" className="w-full border rounded-lg px-2 py-1.5 text-sm" value={ini} onChange={e => setIni(e.target.value)} /></label>
              <label className="text-xs text-gray-500">Fim<input type="date" className="w-full border rounded-lg px-2 py-1.5 text-sm" value={fim} onChange={e => setFim(e.target.value)} /></label>
            </div>

            <Button className="w-full" onClick={criarCarteira} disabled={createMut.isPending}>Confirmar delegação</Button>
          </Card>

          <Card className="p-5">
            <h3 className="font-bold mb-3">Pré-visualização do rateio</h3>
            {preview.length === 0 && (
              <p className="text-sm text-gray-400">
                {fromUserId && dimVaziaAtiva
                  ? `Selecione ao menos um item em "${ESCOPO_LABEL[dimVaziaAtiva]}" para ver a prévia.`
                  : "Selecione origem e destinatários."}
              </p>
            )}
            {preview.map((r: any, i: number) => {
              const total = preview.reduce((s: number, x: any) => s + x.fat, 0) || 1;
              const u = users.find(x => x.id === r.toUserId);
              const pct = Math.round(r.fat / total * 100);
              return (
                <div key={i} className="mb-3 border rounded-lg p-3">
                  <div className="flex justify-between text-sm font-semibold">
                    <span>{u?.firstName} {u?.lastName}</span><span>{r.cs.length} clientes</span>
                  </div>
                  <div className="text-xs text-gray-600">{fmtBRL(r.fat)}/mês · {pct}% do faturamento</div>
                  <div className="h-2 bg-gray-100 rounded-full mt-1"><div className="h-full bg-indigo-500 rounded-full" style={{ width: pct+"%" }} /></div>
                </div>
              );
            })}
          </Card>
        </TabsContent>

        {/* ============ ACESSOS ============ */}
        <TabsContent value="acessos" className="grid lg:grid-cols-2 gap-6 mt-4">
          <Card className="p-5 space-y-4">
            <label className="block text-xs font-semibold text-gray-500 uppercase">Função (perfil de acessos)
              <select className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={role} onChange={e => { setRole(e.target.value); setAccSel([]); }}>
                {Object.entries(ROLE_LABEL).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <div className="max-h-72 overflow-y-auto border rounded-lg p-2 space-y-1">
              {acessos.map((a, i) => (
                <label key={i} className="flex items-center gap-2 text-sm py-1">
                  <input type="checkbox" checked={accSel.includes(a[1])}
                    onChange={e => setAccSel(s => e.target.checked ? [...s, a[1]] : s.filter(x => x !== a[1]))} />
                  <span className="text-gray-400 text-xs w-24">{a[0]}</span>{a[1]}
                </label>
              ))}
            </div>
            <label className="block text-xs font-semibold text-gray-500 uppercase">Delegar para
              <select className="mt-1 w-full border rounded-lg px-3 py-2 text-sm" value={toUserAc} onChange={e => setToUserAc(e.target.value)}>
                <option value="">Selecione…</option>
                {activeUsers.map(u => <option key={u.id} value={u.id}>{u.firstName} {u.lastName} · {ROLE_LABEL[u.role||""]}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-500">Início<input type="date" className="w-full border rounded-lg px-2 py-1.5 text-sm" value={acIni} onChange={e => setAcIni(e.target.value)} /></label>
              <label className="text-xs text-gray-500">Fim<input type="date" className="w-full border rounded-lg px-2 py-1.5 text-sm" value={acFim} onChange={e => setAcFim(e.target.value)} /></label>
            </div>
            <Button className="w-full" onClick={criarAcesso} disabled={createMut.isPending}>Confirmar delegação de acessos</Button>
          </Card>

          <Card className="p-5">
            <h3 className="font-bold mb-3">Matriz de acessos por função</h3>
            {Object.keys(ROLE_LABEL).map(r => (
              <details key={r} className="border rounded-lg mb-2">
                <summary className="px-3 py-2 bg-gray-50 cursor-pointer flex justify-between">
                  <span className="font-semibold text-sm">{ROLE_LABEL[r]}</span>
                  <span className="text-xs text-gray-500">{acessosDaFuncao(r).length} acessos</span>
                </summary>
                <div className="p-3 flex flex-wrap gap-1">
                  {acessosDaFuncao(r).map((a,i) => <Badge key={i} variant="secondary">{a[1]}</Badge>)}
                </div>
              </details>
            ))}
          </Card>
        </TabsContent>

        {/* ============ ATIVAS ============ */}
        <TabsContent value="ativas" className="mt-4 space-y-6">
          {(() => {
            // Registros de reversão/auto-devolução (titular -> titular) não representam
            // um rateio real; são apenas o marcador de retorno da carteira. Ocultamos da
            // exibição para não confundir — o dado permanece no banco, só não é listado.
            const isReversao = (d: any) => {
              if (typeof d.reason === "string" && d.reason.trim().toLowerCase().startsWith("reversão automática")) return true;
              const tgts = d.targets || [];
              return d.type !== "acesso_funcao" && tgts.length > 0 && tgts.every((t: any) => t.toUserId === d.fromUserId);
            };
            const ativas = delegs.filter((d: any) => (d.status === "ativa" || d.status === "agendada") && !isReversao(d));
            const historico = delegs.filter((d: any) => d.status === "expirada" || d.status === "revogada");
            const card = (d: any) => {
              const total = (d.targets || []).reduce((s: number, t: any) => s + (t.customerCount || 0), 0);
              const isCarteira = d.type !== "acesso_funcao";
              const st = STATUS_META[d.status] || { label: d.status, cls: "bg-gray-100 text-gray-600" };
              const borda = d.status === "ativa" ? "#16a34a" : d.status === "agendada" ? "#2563eb" : "#9ca3af";
              return (
                <Card key={d.id} className="p-4 border-l-4" style={{ borderLeftColor: borda }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.cls}`}>{st.label}</span>
                        <span className="text-sm font-semibold">{TIPO_LABEL[d.type] || d.type}</span>
                      </div>
                      {isCarteira
                        ? <div className="text-sm text-gray-600 mt-1">Titular: <strong>{nomeUsuario(d.fromUserId)}</strong> · {total} cliente{total !== 1 ? "s" : ""}{escopoLabel(d)}</div>
                        : <div className="text-sm text-gray-600 mt-1">Função: <strong>{ROLE_LABEL[d.originRole || ""] || d.originRole || "—"}</strong> · {(d.accesses || []).length} acesso(s)</div>}
                    </div>
                    <div className="text-right shrink-0">
                      {(d.status === "ativa" || d.status === "agendada") &&
                        <div className="text-xs font-semibold text-amber-600 whitespace-nowrap"><i className="fas fa-hourglass-half mr-1" />{d.status === "agendada" ? "inicia em breve · " : ""}{restanteStr(d.endsAt)}</div>}
                      <div className="flex gap-1 justify-end mt-1">
                        <Button size="sm" variant="ghost" className="text-red-500" onClick={() => revokeMut.mutate(d.id)} disabled={revokeMut.isPending} title="Devolve a carteira ao titular">Revogar</Button>
                        <Button size="sm" variant="ghost" className="text-gray-400" onClick={() => { if (confirm("Excluir este registro de delegação definitivamente? (não devolve carteira)")) deleteMut.mutate(d.id); }} disabled={deleteMut.isPending} title="Excluir registro">Excluir</Button>
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-2">
                    <i className="far fa-calendar mr-1" />{fmtDT(d.startsAt)} → {fmtDT(d.endsAt)}
                    {d.autoReturn && <span className="ml-2 text-gray-400">· na devolução, todos voltam ao titular</span>}
                  </div>
                  {isCarteira && (d.targets || []).length > 0 && (
                    <div className="mt-3 border-t pt-2">
                      <div className="text-xs text-gray-400 mb-1">Distribuição atual entre destinatários:</div>
                      <div className="flex flex-wrap gap-1.5">
                        {(d.targets || []).slice().sort((a: any, b: any) => (b.customerCount || 0) - (a.customerCount || 0)).map((t: any) => (
                          <span key={t.id || t.toUserId} className="text-xs bg-gray-100 rounded px-2 py-0.5">
                            {nomeUsuario(t.toUserId)}: <strong>{t.customerCount}</strong>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {d.reason && <div className="text-xs text-gray-400 mt-2 italic">{d.reason}</div>}
                </Card>
              );
            };
            return (
              <>
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Delegações vigentes ({ativas.length})</h3>
                  {ativas.length === 0 && <p className="text-sm text-gray-400">Nenhuma delegação vigente no momento.</p>}
                  <div className="space-y-3">{ativas.map(card)}</div>
                </div>
                {historico.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-500 mb-2">Histórico ({historico.length})</h3>
                    <div className="space-y-2">
                      {historico.map((d: any) => (
                        <div key={d.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-3 py-2">
                          <span><span className="text-gray-400">{STATUS_META[d.status]?.label || d.status}</span> · {TIPO_LABEL[d.type] || d.type} · {nomeUsuario(d.fromUserId)}</span>
                          <span className="flex items-center gap-3">
                            <span className="text-gray-400">{fmtDT(d.endsAt)}</span>
                            <button className="text-gray-400 hover:text-red-500" title="Excluir registro"
                              onClick={() => { if (confirm("Excluir este registro do histórico definitivamente?")) deleteMut.mutate(d.id); }}>
                              <i className="fas fa-trash-can" />
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </TabsContent>

        {/* ============ CLIENTES SOB DELEGAÇÃO (lista filtrável, somente leitura) ============ */}
        <TabsContent value="sob-delegacao" className="mt-4">
          {(() => {
            const termo = buscaSob.trim().toLowerCase();
            const linhas = (sobDelegacao as any[])
              .map((c) => ({ ...c, delegado: nomeUsuario(c.sellerAtualId || c.toUserId), titular: nomeUsuario(c.fromUserId) }))
              .filter((c) =>
                !termo ||
                (c.customerName || "").toLowerCase().includes(termo) ||
                (c.delegado || "").toLowerCase().includes(termo) ||
                (c.titular || "").toLowerCase().includes(termo)
              )
              .sort((a, b) => (a.customerName || "").localeCompare(b.customerName || ""));
            return (
              <div>
                <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                  <h3 className="text-sm font-semibold text-gray-700">
                    Clientes sob delegação <span className="text-gray-400">({linhas.length})</span>
                  </h3>
                  <input
                    value={buscaSob}
                    onChange={(e) => setBuscaSob(e.target.value)}
                    placeholder="Filtrar por cliente, delegado ou titular…"
                    className="border rounded px-3 py-1.5 text-sm w-72 max-w-full"
                  />
                </div>
                <p className="text-xs text-gray-400 mb-3">
                  Marcação automática: o cliente aparece aqui enquanto está numa delegação vigente e sai sozinho quando ela encerra. Somente leitura.
                </p>
                {linhas.length === 0 && (
                  <p className="text-sm text-gray-400">
                    {sobDelegacao.length === 0 ? "Nenhum cliente sob delegação vigente no momento." : "Nenhum resultado para o filtro."}
                  </p>
                )}
                {linhas.length > 0 && (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-500 text-xs">
                        <tr>
                          <th className="text-left font-medium px-3 py-2">Cliente</th>
                          <th className="text-left font-medium px-3 py-2">Delegado (carteira atual)</th>
                          <th className="text-left font-medium px-3 py-2">Titular</th>
                          <th className="text-left font-medium px-3 py-2">Devolve em</th>
                          <th className="text-left font-medium px-3 py-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {linhas.map((c, i) => (
                          <tr key={c.customerId + i} className="border-t">
                            <td className="px-3 py-2">{c.customerName}</td>
                            <td className="px-3 py-2">{c.delegado}</td>
                            <td className="px-3 py-2 text-gray-500">{c.titular}</td>
                            <td className="px-3 py-2 text-gray-500">{c.endsAt ? fmtDT(c.endsAt) : "—"}</td>
                            <td className="px-3 py-2">
                              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap">sob delegação</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })()}
        </TabsContent>
      </Tabs>

      {/* Popup 1: confirmação antes de salvar */}
      <AlertDialog open={confirmSaveOpen} onOpenChange={setConfirmSaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar alterações de acesso</AlertDialogTitle>
            <AlertDialogDescription>
              As permissões marcadas para <strong>{selUser?.firstName} {selUser?.lastName}</strong> ({ROLE_LABEL[selUser?.role||""]})
              serão salvas e passarão a valer <strong>imediatamente</strong>. Deseja continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); savePermsMut.mutate(); }} disabled={savePermsMut.isPending}>
              {savePermsMut.isPending ? "Salvando…" : "Confirmar e salvar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Popup 2: sucesso — configurações vigentes */}
      <AlertDialog open={successOpen} onOpenChange={setSuccessOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle><i className="fas fa-circle-check text-green-500 mr-2" />Acessos atualizados</AlertDialogTitle>
            <AlertDialogDescription>
              As novas configurações de acesso de <strong>{selUser?.firstName} {selUser?.lastName}</strong> foram salvas e já estão <strong>vigentes</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setSuccessOpen(false)}>Entendi</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
