// ============================================================================
// RESUMO RECEBÍVEIS COLABORADOR — 18/out/2026 · revisado 25/out/2026
// ---------------------------------------------------------------------------
// Planilha mensal do que cada colaborador tem a receber. Uma linha de valores
// por colaborador. As colunas de campanha são dinâmicas: vêm do cadastro de
// campanhas vigentes no mês.
//
// Rubrica não habilitada para o colaborador vem null do servidor e aparece
// como "—". Nunca um R$ 0,00 que pareça apurado.
//
// Backend: server/resumo-recebiveis-routes.ts
// ============================================================================
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Wallet, Settings2, Plus, Trash2, Download, Loader2, AlertTriangle, Info, Megaphone,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";

const PAPEL_LABEL: Record<string, string> = {
  vendedor: "Externo",
  telemarketing: "Interno",
  administrative: "Administrativo",
  motorista: "Motorista",
};
const PAPEL_COR: Record<string, string> = {
  vendedor: "bg-purple-100 text-purple-800",
  telemarketing: "bg-amber-100 text-amber-800",
  administrative: "bg-blue-100 text-blue-800",
  motorista: "bg-orange-100 text-orange-800",
};

const brl = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const kmTxt = (v: number) =>
  `${(Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;

function mesesDisponiveis(): string[] {
  const out: string[] = [];
  const hoje = new Date();
  for (let i = -2; i < 18; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return Array.from(new Set(out)).sort().reverse();
}
const nomeDoMes = (ym: string) => {
  if (!ym) return "—";
  const [a, m] = ym.split("-").map(Number);
  return new Date(a, m - 1, 1)
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());
};

interface Campanha { id: string; nome: string; origem: string; ym_inicio: string; ym_fim: string | null; observacao?: string; }
interface Colab {
  id: string; nome: string; role: string; sellerType: string | null;
  config: any;
  fixoMensal: number | null; meta: number | null; faturamento: number | null;
  atingimentoPct: number; comissao: number | null;
  campanhas: Record<string, number | null>;
  bonus: number | null;
  lancamentos: Array<{ id: string; descricao: string; valor: number }>;
  kmRodado: number; kmTarifa: number; kmValor: number | null; totalMes: number;
}

export default function ResumoRecebiveis() {
  const [ym, setYm] = useState(() => new Date().toISOString().slice(0, 7));
  const [abrirGestor, setAbrirGestor] = useState(false);

  const { data, isLoading } = useQuery<{ ym: string; admin: boolean; campanhas: Campanha[]; colaboradores: Colab[]; totais: any }>({
    queryKey: ["/api/resumo-recebiveis", ym],
    queryFn: () => apiRequest("GET", `/api/resumo-recebiveis?ym=${ym}`),
  });

  const admin = data?.admin === true;
  const colabs = data?.colaboradores || [];
  const campanhas = data?.campanhas || [];
  const totais = data?.totais;
  const semFixo = colabs.filter((c) => c.config?.usaFixo !== false && !c.fixoMensal).length;

  const exportarCsv = () => {
    const sep = ";";
    const cab = ["Colaborador", "Função", "Fixo Mensal", "Meta", "Faturamento", "Comissão Mês",
      ...campanhas.map((c) => c.nome), "Bônus", "Km rodado", "Km R$", "Total Mês"];
    const num = (v: number | null) => (v === null ? "" : v.toFixed(2));
    const linhas = [cab.join(sep)];
    for (const c of colabs) {
      linhas.push([
        c.nome, PAPEL_LABEL[c.role] || c.role,
        num(c.fixoMensal), num(c.meta), num(c.faturamento), num(c.comissao),
        ...campanhas.map((k) => num(c.campanhas?.[k.id] ?? null)),
        num(c.bonus), c.kmRodado.toFixed(1), num(c.kmValor), c.totalMes.toFixed(2),
      ].join(sep));
    }
    const blob = new Blob(["﻿" + linhas.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `resumo-recebiveis-${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="h-6 w-6 text-emerald-600" />
            Resumo Recebíveis Colaborador
          </h1>
          <p className="text-sm text-muted-foreground">
            {admin
              ? "Tudo que cada colaborador tem a receber no mês."
              : "O que você tem a receber neste mês."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={ym} onValueChange={setYm}>
            <SelectTrigger className="w-48" data-testid="select-mes-recebiveis"><SelectValue /></SelectTrigger>
            <SelectContent>
              {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
            </SelectContent>
          </Select>
          {admin && (
            <Button variant="outline" size="sm" onClick={() => setAbrirGestor(true)} data-testid="button-gestor">
              <Settings2 className="h-4 w-4 mr-1" /> Configurações
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportarCsv} disabled={!colabs.length}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <BackToDashboardButton />
        </div>
      </div>

      {admin && semFixo > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            {semFixo} colaborador{semFixo > 1 ? "es estão" : " está"} com Fixo Mensal zerado. O sistema
            nunca guardou salário ou ajuda de custo, então nada foi presumido — preencha em{" "}
            <button className="underline font-medium" onClick={() => setAbrirGestor(true)}>Configurações</button>.
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between flex-wrap gap-2">
            <span>{nomeDoMes(ym)}</span>
            {totais && (
              <span className="text-sm font-normal text-muted-foreground">
                Total a pagar: <strong className="text-foreground">{brl(totais.totalMes)}</strong>
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
              Apurando o mês…
            </div>
          ) : !colabs.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Nenhum colaborador ativo para este mês.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-muted/60">
                    <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-muted/60 min-w-[190px]">Colaborador</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Fixo Mensal</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Meta</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Faturamento</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Comissão Mês</th>
                    {campanhas.map((c) => (
                      <th key={c.id} className="text-right px-3 py-2 font-semibold whitespace-nowrap" title={c.observacao || ""}>
                        {c.nome}
                      </th>
                    ))}
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Bônus</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Km</th>
                    <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Total Mês</th>
                  </tr>
                </thead>
                <tbody>
                  {colabs.map((c) => (
                    <tr key={c.id} className="border-t hover:bg-muted/30" data-testid={`linha-${c.id}`}>
                      <td className="px-3 py-2 sticky left-0 bg-background">
                        <div className="font-medium leading-tight">{c.nome}</div>
                        <Badge className={`${PAPEL_COR[c.role] || "bg-gray-100 text-gray-800"} mt-0.5`}>
                          {PAPEL_LABEL[c.role] || c.role}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">{brl(c.fixoMensal)}</td>
                      <td className="px-3 py-2 text-right">{brl(c.meta)}</td>
                      <td className="px-3 py-2 text-right"
                        title={c.meta ? `Atingimento ${c.atingimentoPct.toFixed(1)}% da meta` : ""}>
                        {brl(c.faturamento)}
                      </td>
                      <td className="px-3 py-2 text-right"
                        title={c.config?.comissaoTipo === "faixa"
                          ? "Faixa por atingimento"
                          : c.config?.comissaoTipo === "fixo"
                            ? `${c.config.comissaoPct}%${c.config.comissaoDescontoFixo > 0 ? ` − ${brl(c.config.comissaoDescontoFixo)}` : ""}${c.config.comissaoProporcionalMeta ? " proporcional à meta" : ""}`
                            : "Sem regra de comissão"}>
                        {brl(c.comissao)}
                      </td>
                      {campanhas.map((k) => (
                        <td key={k.id} className="px-3 py-2 text-right">{brl(c.campanhas?.[k.id] ?? null)}</td>
                      ))}
                      <td className="px-3 py-2 text-right"
                        title={c.lancamentos?.length ? c.lancamentos.map((l) => `${l.descricao}: ${brl(l.valor)}`).join(" · ") : ""}>
                        {brl(c.bonus)}
                      </td>
                      <td className="px-3 py-2 text-right"
                        title={`${kmTxt(c.kmRodado)} a ${brl(c.kmTarifa)}/km`}>
                        {brl(c.kmValor)}
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-emerald-700">{brl(c.totalMes)}</td>
                    </tr>
                  ))}
                  {totais && colabs.length > 1 && (
                    <tr className="bg-emerald-50 font-bold border-t-2">
                      <td className="px-3 py-2 sticky left-0 bg-emerald-50">TOTAL</td>
                      <td className="px-3 py-2 text-right">{brl(totais.fixoMensal)}</td>
                      <td className="px-3 py-2 text-right">{brl(totais.meta)}</td>
                      <td className="px-3 py-2 text-right">{brl(totais.faturamento)}</td>
                      <td className="px-3 py-2 text-right">{brl(totais.comissao)}</td>
                      {campanhas.map((k) => (
                        <td key={k.id} className="px-3 py-2 text-right">{brl(totais.campanhas?.[k.id] || 0)}</td>
                      ))}
                      <td className="px-3 py-2 text-right">{brl(totais.bonus)}</td>
                      <td className="px-3 py-2 text-right">{brl(totais.kmValor)}</td>
                      <td className="px-3 py-2 text-right text-emerald-700">{brl(totais.totalMes)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Cada rubrica é buscada no módulo que a calcula: Meta nas Metas de Vendas, Faturamento na mesma
          fonte do Dashboard (NF-e de venda autorizada, atribuída a quem implantou o pedido), Km na
          Kilometragem Vendedores e as campanhas no módulo da campanha. Fixo Mensal e Bônus são valores de
          cadastro, informados em Configurações. Uma célula com <strong>—</strong> significa que a rubrica
          não está habilitada para aquele colaborador, e por isso não entra no total.
        </span>
      </div>

      {admin && <DialogGestor open={abrirGestor} onOpenChange={setAbrirGestor} ym={ym} colabs={colabs} campanhas={campanhas} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GESTOR — três abas: colaboradores (flags + remuneração), campanhas e bônus.
// ---------------------------------------------------------------------------
const FLAGS: Array<{ k: string; label: string; ajuda: string }> = [
  { k: "usaFixo", label: "Fixo mensal", ajuda: "Valor de cadastro, informado abaixo" },
  { k: "usaMeta", label: "Meta", ajuda: "Buscada em Metas de Vendas" },
  { k: "usaFaturamento", label: "Faturamento", ajuda: "Buscado na fonte oficial de faturamento" },
  { k: "usaComissao", label: "Comissão mês", ajuda: "Calculada pela regra do colaborador" },
  { k: "usaKm", label: "Km", ajuda: "Buscado na Kilometragem Vendedores" },
  { k: "usaCampanhas", label: "Campanhas", ajuda: "Buscadas nos módulos de campanha" },
  { k: "usaBonus", label: "Bônus manual", ajuda: "Abre o lançamento avulso para este colaborador" },
];

function DialogGestor({ open, onOpenChange, ym, colabs, campanhas }: {
  open: boolean; onOpenChange: (o: boolean) => void; ym: string; colabs: Colab[]; campanhas: Campanha[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const vazio: any = {
    userId: "", vigenciaYm: ym, fixoMensal: "", comissaoTipo: "nenhum",
    comissaoPct: "", comissaoDescontoFixo: "", comissaoProporcionalMeta: false,
    faixaTipo: "telemarketing", incluirNoResumo: true,
    usaFixo: true, usaMeta: true, usaFaturamento: true, usaComissao: true,
    usaKm: true, usaCampanhas: true, usaBonus: false, observacao: "",
  };
  const [form, setForm] = useState<any>(vazio);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const { data: cfgData } = useQuery<{ configs: any[]; colaboradores: any[] }>({
    queryKey: ["/api/resumo-recebiveis/config"],
    queryFn: () => apiRequest("GET", "/api/resumo-recebiveis/config"),
    enabled: open,
  });
  const { data: campData } = useQuery<{ campanhas: any[] }>({
    queryKey: ["/api/resumo-recebiveis/campanhas"],
    queryFn: () => apiRequest("GET", "/api/resumo-recebiveis/campanhas"),
    enabled: open,
  });

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/config"] });
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/campanhas"] });
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis"] });
  };
  const num = (v: any) => Number(String(v).replace(",", ".")) || 0;

  const salvarCfg = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/config", {
      userId: form.userId, vigenciaYm: form.vigenciaYm,
      fixoMensal: num(form.fixoMensal), comissaoTipo: form.comissaoTipo,
      comissaoPct: num(form.comissaoPct), comissaoDescontoFixo: num(form.comissaoDescontoFixo),
      comissaoProporcionalMeta: form.comissaoProporcionalMeta, faixaTipo: form.faixaTipo,
      incluirNoResumo: form.incluirNoResumo,
      usaFixo: form.usaFixo, usaMeta: form.usaMeta, usaFaturamento: form.usaFaturamento,
      usaComissao: form.usaComissao, usaKm: form.usaKm, usaCampanhas: form.usaCampanhas,
      usaBonus: form.usaBonus, observacao: form.observacao,
    }),
    onSuccess: () => { toast({ title: "Configuração salva" }); setForm(vazio); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao salvar", description: e?.message, variant: "destructive" }),
  });
  const removerCfg = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/config/${id}`),
    onSuccess: () => { toast({ title: "Vigência removida" }); invalidar(); },
  });

  // --- campanhas
  const campVazia: any = { id: "", nome: "", origem: "manual", ymInicio: ym, ymFim: "", ativa: true, ordem: 0, observacao: "" };
  const [campForm, setCampForm] = useState<any>(campVazia);
  const setC = (k: string, v: any) => setCampForm((f: any) => ({ ...f, [k]: v }));
  const salvarCamp = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/campanhas", {
      id: campForm.id || undefined, nome: campForm.nome, origem: campForm.origem,
      ymInicio: campForm.ymInicio, ymFim: campForm.ymFim || null,
      ativa: campForm.ativa, ordem: Number(campForm.ordem) || 0, observacao: campForm.observacao,
    }),
    onSuccess: () => { toast({ title: "Campanha salva" }); setCampForm(campVazia); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao salvar", description: e?.message, variant: "destructive" }),
  });
  const removerCamp = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/campanhas/${id}`),
    onSuccess: () => { toast({ title: "Campanha removida" }); invalidar(); },
  });

  // --- valores manuais de campanha
  const [valCamp, setValCamp] = useState<any>({ campanhaId: "", userId: "", valor: "" });
  const lancarValor = useMutation({
    mutationFn: () => apiRequest("POST", `/api/resumo-recebiveis/campanhas/${valCamp.campanhaId}/valor`, {
      userId: valCamp.userId, ym, valor: num(valCamp.valor),
    }),
    onSuccess: () => { toast({ title: "Valor lançado" }); setValCamp({ ...valCamp, valor: "" }); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao lançar", description: e?.message, variant: "destructive" }),
  });

  // --- bônus avulso
  const [bon, setBon] = useState<any>({ userId: "", descricao: "", valor: "" });
  const lancarBonus = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/bonus", {
      userId: bon.userId, ym, descricao: bon.descricao, valor: num(bon.valor),
    }),
    onSuccess: () => { toast({ title: "Bônus lançado" }); setBon({ ...bon, descricao: "", valor: "" }); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao lançar", description: e?.message, variant: "destructive" }),
  });
  const removerBonus = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/bonus/${id}`),
    onSuccess: () => { toast({ title: "Lançamento removido" }); invalidar(); },
  });

  const comBonus = colabs.filter((c) => c.config?.usaBonus === true);
  const campanhasManuais = campanhas.filter((c) => c.origem === "manual");
  const lancamentos = colabs.flatMap((c) => (c.lancamentos || []).map((l) => ({ ...l, colaborador: c.nome })));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader><DialogTitle>Configurações do Resumo Recebíveis</DialogTitle></DialogHeader>

        <Tabs defaultValue="colaboradores">
          <TabsList>
            <TabsTrigger value="colaboradores">Colaboradores</TabsTrigger>
            <TabsTrigger value="campanhas">Campanhas</TabsTrigger>
            <TabsTrigger value="bonus">Bônus e lançamentos</TabsTrigger>
          </TabsList>

          {/* ---------------- COLABORADORES ---------------- */}
          <TabsContent value="colaboradores" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Marque quais rubricas entram para cada colaborador. O que é marcado é <strong>buscado no
              módulo que calcula</strong> aquela informação. Fixo mensal é valor de cadastro, e Bônus
              manual abre o lançamento avulso. Cada linha vale <strong>a partir do mês de vigência</strong>
              — para dar um aumento, crie uma nova vigência e os meses já apurados ficam como estavam.
            </p>

            <div className="rounded-lg border bg-muted/30 p-3 space-y-3 min-w-0">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                <div className="min-w-0 md:col-span-2">
                  <Label className="text-xs">Colaborador</Label>
                  <Select value={form.userId} onValueChange={(v) => set("userId", v)}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {(cfgData?.colaboradores || []).map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.nome} · {PAPEL_LABEL[c.role] || c.role}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Vigência (a partir de)</Label>
                  <Select value={form.vigenciaYm} onValueChange={(v) => set("vigenciaYm", v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 flex items-end gap-2 pb-1">
                  <Switch checked={form.incluirNoResumo} onCheckedChange={(v) => set("incluirNoResumo", v)} />
                  <span className="text-xs">Aparece no resumo</span>
                </div>
              </div>

              <div>
                <Label className="text-xs">Rubricas deste colaborador</Label>
                <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-2">
                  {FLAGS.map((f) => (
                    <label key={f.k} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 cursor-pointer min-w-0"
                      title={f.ajuda}>
                      <Switch checked={!!form[f.k]} onCheckedChange={(v) => set(f.k, v)} />
                      <span className="text-xs truncate">{f.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                <div className="min-w-0">
                  <Label className="text-xs">Fixo mensal (R$)</Label>
                  <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                    value={form.fixoMensal} onChange={(e) => set("fixoMensal", e.target.value)} />
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Comissão</Label>
                  <Select value={form.comissaoTipo} onValueChange={(v) => set("comissaoTipo", v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nenhum">Sem comissão</SelectItem>
                      <SelectItem value="fixo">Percentual fixo</SelectItem>
                      <SelectItem value="faixa">Faixa por atingimento</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.comissaoTipo === "fixo" && (
                  <>
                    <div className="min-w-0">
                      <Label className="text-xs">Percentual (%)</Label>
                      <Input className="mt-1" inputMode="decimal" placeholder="8"
                        value={form.comissaoPct} onChange={(e) => set("comissaoPct", e.target.value)} />
                    </div>
                    <div className="min-w-0">
                      <Label className="text-xs">Desconto fixo (R$)</Label>
                      <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                        value={form.comissaoDescontoFixo} onChange={(e) => set("comissaoDescontoFixo", e.target.value)} />
                    </div>
                    <div className="min-w-0 flex items-end gap-2 pb-1">
                      <Switch checked={form.comissaoProporcionalMeta} onCheckedChange={(v) => set("comissaoProporcionalMeta", v)} />
                      <span className="text-xs">Proporcional à meta</span>
                    </div>
                  </>
                )}
                {form.comissaoTipo === "faixa" && (
                  <div className="min-w-0">
                    <Label className="text-xs">Tabela de faixas</Label>
                    <Select value={form.faixaTipo} onValueChange={(v) => set("faixaTipo", v)}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="telemarketing">Vendas internas</SelectItem>
                        <SelectItem value="vendedor_pj">Externo PJ</SelectItem>
                        <SelectItem value="vendedor_clt">Externo CLT</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="min-w-0 md:col-span-2">
                  <Label className="text-xs">Observação</Label>
                  <Input className="mt-1" maxLength={500} value={form.observacao}
                    onChange={(e) => set("observacao", e.target.value)} placeholder="Ex.: reajuste aprovado em reunião" />
                </div>
              </div>

              <div className="flex justify-end">
                <Button size="sm" disabled={!form.userId || salvarCfg.isPending} onClick={() => salvarCfg.mutate()}>
                  {salvarCfg.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                  Salvar vigência
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60">
                    <th className="text-left px-2 py-1.5">Colaborador</th>
                    <th className="text-left px-2 py-1.5">Vigência</th>
                    <th className="text-right px-2 py-1.5">Fixo</th>
                    <th className="text-left px-2 py-1.5">Comissão</th>
                    <th className="text-left px-2 py-1.5">Rubricas</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {(cfgData?.configs || []).map((c: any) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-2 py-1.5">
                        {c.nome}
                        {c.incluir_no_resumo === false && (
                          <Badge className="ml-1 bg-gray-200 text-gray-700">fora do resumo</Badge>
                        )}
                      </td>
                      <td className="px-2 py-1.5">{nomeDoMes(c.vigencia_ym)}</td>
                      <td className="px-2 py-1.5 text-right">{brl(Number(c.fixo_mensal))}</td>
                      <td className="px-2 py-1.5">
                        {c.comissao_tipo === "faixa" ? "Faixa"
                          : c.comissao_tipo === "fixo"
                            ? `${Number(c.comissao_pct)}%${Number(c.comissao_desconto_fixo) > 0 ? ` − ${brl(Number(c.comissao_desconto_fixo))}` : ""}${c.comissao_proporcional_meta ? " prop." : ""}`
                            : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
                        {[c.usa_fixo && "fixo", c.usa_meta && "meta", c.usa_faturamento && "fat.",
                          c.usa_comissao && "com.", c.usa_km && "km", c.usa_campanhas && "camp.",
                          c.usa_bonus && "bônus"].filter(Boolean).join(" · ") || "nenhuma"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-600"
                          onClick={() => removerCfg.mutate(c.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* ---------------- CAMPANHAS ---------------- */}
          <TabsContent value="campanhas" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Toda campanha vigente vira uma <strong>coluna</strong> na planilha, nos meses dentro da
              vigência. Origem <strong>Módulo da campanha</strong> puxa o bônus que o próprio módulo apura;
              origem <strong>Manual</strong> abre o lançamento por colaborador na aba ao lado.
            </p>

            <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
              <div className="min-w-0 md:col-span-2">
                <Label className="text-xs">Nome da campanha</Label>
                <Input className="mt-1" maxLength={120} value={campForm.nome}
                  onChange={(e) => setC("nome", e.target.value)} placeholder="Ex.: Desafio de Novembro" />
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Origem do valor</Label>
                <Select value={campForm.origem} onValueChange={(v) => setC("origem", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual (admin informa)</SelectItem>
                    <SelectItem value="campanha">Módulo da campanha</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 flex items-end gap-2 pb-1">
                <Switch checked={campForm.ativa} onCheckedChange={(v) => setC("ativa", v)} />
                <span className="text-xs">Ativa</span>
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Início</Label>
                <Select value={campForm.ymInicio} onValueChange={(v) => setC("ymInicio", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Fim (vazio = sem prazo)</Label>
                <Select value={campForm.ymFim || "sem-prazo"} onValueChange={(v) => setC("ymFim", v === "sem-prazo" ? "" : v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sem-prazo">Sem prazo</SelectItem>
                    {mesesDisponiveis().map((m) => <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0">
                <Label className="text-xs">Ordem da coluna</Label>
                <Input className="mt-1" inputMode="numeric" value={campForm.ordem}
                  onChange={(e) => setC("ordem", e.target.value)} />
              </div>
              <div className="min-w-0 flex items-end">
                <Button size="sm" className="w-full" disabled={!campForm.nome.trim() || salvarCamp.isPending}
                  onClick={() => salvarCamp.mutate()}>
                  {salvarCamp.isPending ? <Loader2 className="h-4 w-4 animate-spin" />
                    : campForm.id ? "Atualizar" : "Criar campanha"}
                </Button>
              </div>
              <div className="min-w-0 md:col-span-4">
                <Label className="text-xs">Observação</Label>
                <Input className="mt-1" maxLength={500} value={campForm.observacao}
                  onChange={(e) => setC("observacao", e.target.value)} placeholder="Aparece ao passar o mouse no cabeçalho da coluna" />
              </div>
            </div>

            <div className="space-y-1">
              {(campData?.campanhas || []).map((c: any) => (
                <div key={c.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm min-w-0">
                  <Megaphone className={`h-4 w-4 shrink-0 ${c.ativa ? "text-emerald-600" : "text-muted-foreground"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {c.nome}
                      {!c.ativa && <Badge className="ml-2 bg-gray-200 text-gray-700">inativa</Badge>}
                      <Badge className="ml-2 bg-blue-100 text-blue-800">
                        {c.origem === "campanha" ? "módulo" : "manual"}
                      </Badge>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {nomeDoMes(c.ym_inicio)} {c.ym_fim ? `até ${nomeDoMes(c.ym_fim)}` : "— sem prazo"}
                      {c.observacao ? ` · ${c.observacao}` : ""}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs"
                    onClick={() => setCampForm({
                      id: c.id, nome: c.nome, origem: c.origem, ymInicio: c.ym_inicio,
                      ymFim: c.ym_fim || "", ativa: c.ativa, ordem: c.ordem, observacao: c.observacao || "",
                    })}>
                    editar
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 text-red-600"
                    onClick={() => removerCamp.mutate(c.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </TabsContent>

          {/* ---------------- BÔNUS E LANÇAMENTOS ---------------- */}
          <TabsContent value="bonus" className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold mb-1">Valor de campanha manual — {nomeDoMes(ym)}</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Para as campanhas de origem Manual. O valor vale apenas para o mês selecionado na planilha.
              </p>
              {campanhasManuais.length === 0 ? (
                <div className="rounded-md border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
                  Nenhuma campanha manual vigente neste mês. Crie uma na aba Campanhas.
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                  <div className="min-w-0">
                    <Label className="text-xs">Campanha</Label>
                    <Select value={valCamp.campanhaId} onValueChange={(v) => setValCamp({ ...valCamp, campanhaId: v })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                      <SelectContent>
                        {campanhasManuais.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0">
                    <Label className="text-xs">Colaborador</Label>
                    <Select value={valCamp.userId} onValueChange={(v) => setValCamp({ ...valCamp, userId: v })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                      <SelectContent>
                        {colabs.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0">
                    <Label className="text-xs">Valor (R$)</Label>
                    <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                      value={valCamp.valor} onChange={(e) => setValCamp({ ...valCamp, valor: e.target.value })} />
                  </div>
                  <div className="min-w-0 flex items-end">
                    <Button size="sm" className="w-full"
                      disabled={!valCamp.campanhaId || !valCamp.userId || lancarValor.isPending}
                      onClick={() => lancarValor.mutate()}>
                      {lancarValor.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lançar"}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-1">Bônus avulso — {nomeDoMes(ym)}</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Só aparece para quem está com <strong>Bônus manual</strong> marcado na aba Colaboradores.
                {comBonus.length === 0 && " Nenhum colaborador está marcado hoje."}
              </p>
              <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
                <div className="min-w-0">
                  <Label className="text-xs">Colaborador</Label>
                  <Select value={bon.userId} onValueChange={(v) => setBon({ ...bon, userId: v })}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {comBonus.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 md:col-span-2">
                  <Label className="text-xs">Descrição</Label>
                  <Input className="mt-1" maxLength={300} value={bon.descricao}
                    onChange={(e) => setBon({ ...bon, descricao: e.target.value })}
                    placeholder="Ex.: prêmio da campanha de reativação" />
                </div>
                <div className="min-w-0">
                  <Label className="text-xs">Valor (R$)</Label>
                  <Input className="mt-1" inputMode="decimal" placeholder="0,00"
                    value={bon.valor} onChange={(e) => setBon({ ...bon, valor: e.target.value })} />
                </div>
                <div className="md:col-span-4 flex justify-end">
                  <Button size="sm" disabled={!bon.userId || !bon.descricao.trim() || lancarBonus.isPending}
                    onClick={() => lancarBonus.mutate()}>
                    {lancarBonus.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                    Lançar bônus
                  </Button>
                </div>
              </div>

              {lancamentos.length > 0 && (
                <div className="space-y-1 mt-2">
                  {lancamentos.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm min-w-0">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{l.colaborador}</div>
                        <div className="truncate text-xs text-muted-foreground">{l.descricao}</div>
                      </div>
                      <span className="shrink-0 font-medium">{brl(l.valor)}</span>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 text-red-600"
                        onClick={() => removerBonus.mutate(l.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
