// ============================================================================
// RESUMO RECEBÍVEIS COLABORADOR — 18/out/2026
// ---------------------------------------------------------------------------
// Planilha mensal do que cada colaborador tem a receber. Três linhas por
// colaborador: nome, % de composição da remuneração dele, e o valor em R$.
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
import {
  Wallet, Settings2, Plus, Trash2, Download, Loader2, AlertTriangle, Info,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
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

const brl = (v: number) =>
  (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pct = (v: number) =>
  `${(Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const km = (v: number) =>
  `${(Number(v) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;

function mesesDisponiveis(): string[] {
  const out: string[] = [];
  const hoje = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
const nomeDoMes = (ym: string) => {
  const [a, m] = ym.split("-").map(Number);
  return new Date(a, m - 1, 1)
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());
};

interface Colab {
  id: string; nome: string; role: string; sellerType: string | null;
  config: any;
  fixoMensal: number; meta: number; faturamento: number; atingimentoPct: number;
  comissao: number; comissaoBruta?: number; descontoTroca?: number; bonus: number;
  bonusDetalhe: { campanha: number; desafio: number; manual: number; lancamentos: Array<{ id: string; descricao: string; valor: number }> };
  kmRodado: number; kmTarifa: number; kmValor: number; totalMes: number;
  percentuais: { fixoMensal: number; comissao: number; bonus: number; km: number; totalMes: number };
}

export default function ResumoRecebiveis() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [ym, setYm] = useState(() => new Date().toISOString().slice(0, 7));
  const [abrirConfig, setAbrirConfig] = useState(false);
  const [abrirBonus, setAbrirBonus] = useState(false);

  const { data, isLoading } = useQuery<{ ym: string; admin: boolean; colaboradores: Colab[]; totais: any }>({
    queryKey: ["/api/resumo-recebiveis", ym],
    queryFn: () => apiRequest("GET", `/api/resumo-recebiveis?ym=${ym}`),
  });

  const admin = data?.admin === true;
  const colabs = data?.colaboradores || [];
  const totais = data?.totais;
  const semFixo = colabs.filter((c) => c.fixoMensal === 0).length;

  const exportarCsv = () => {
    const sep = ";";
    const linhas: string[] = [
      ["Colaborador", "Função", "Fixo Mensal", "Meta", "Faturamento", "Comissão Mês", "Bônus", "Km", "Valor Km", "Total Mês"].join(sep),
    ];
    for (const c of colabs) {
      linhas.push([
        c.nome, PAPEL_LABEL[c.role] || c.role,
        c.fixoMensal.toFixed(2), c.meta.toFixed(2), c.faturamento.toFixed(2),
        c.comissao.toFixed(2), c.bonus.toFixed(2),
        c.kmRodado.toFixed(1), c.kmValor.toFixed(2), c.totalMes.toFixed(2),
      ].join(sep));
    }
    const blob = new Blob(["﻿" + linhas.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `resumo-recebiveis-${ym}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const COLS = [
    { k: "fixoMensal", label: "Fixo Mensal" },
    { k: "meta", label: "Meta" },
    { k: "faturamento", label: "Faturamento" },
    { k: "comissao", label: "Comissão Mês" },
    { k: "bonus", label: "Bônus" },
    { k: "km", label: "Km" },
    { k: "totalMes", label: "Total Mês" },
  ];

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
              ? "Tudo que cada colaborador tem a receber no mês: fixo, comissão, bônus e km."
              : "O que você tem a receber neste mês."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={ym} onValueChange={setYm}>
            <SelectTrigger className="w-48" data-testid="select-mes-recebiveis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {mesesDisponiveis().map((m) => (
                <SelectItem key={m} value={m}>{nomeDoMes(m)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {admin && (
            <>
              <Button variant="outline" size="sm" onClick={() => setAbrirBonus(true)} data-testid="button-lancar-bonus">
                <Plus className="h-4 w-4 mr-1" /> Bônus
              </Button>
              <Button variant="outline" size="sm" onClick={() => setAbrirConfig(true)} data-testid="button-config-remuneracao">
                <Settings2 className="h-4 w-4 mr-1" /> Configuração
              </Button>
            </>
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
            <button className="underline font-medium" onClick={() => setAbrirConfig(true)}>Configuração</button>.
          </span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
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
              Nenhum colaborador para este mês.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-muted/60">
                    <th className="text-left px-3 py-2 font-semibold sticky left-0 bg-muted/60 min-w-[200px]">Colaborador</th>
                    {COLS.map((c) => (
                      <th key={c.k} className="text-right px-3 py-2 font-semibold whitespace-nowrap">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                {colabs.map((c) => (
                  <tbody key={c.id} className="border-t-4 border-background">
                      {/* Linha 1 — nome */}
                      <tr className="bg-muted/30">
                        <td className="px-3 py-2 sticky left-0 bg-muted/30" colSpan={1}>
                          <div className="font-semibold">{c.nome}</div>
                          <Badge className={`${PAPEL_COR[c.role] || "bg-gray-100 text-gray-800"} mt-0.5`}>
                            {PAPEL_LABEL[c.role] || c.role}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground" colSpan={COLS.length}>
                          {c.config?.comissaoTipo === "faixa"
                            ? "Comissão por faixa de atingimento"
                            : c.config?.comissaoTipo === "fixo"
                              ? `Comissão ${c.config.comissaoPct}%${c.config.comissaoDescontoFixo > 0 ? ` − ${brl(c.config.comissaoDescontoFixo)}` : ""}${c.config.comissaoProporcionalMeta ? " (proporcional à meta)" : ""}`
                              : "Sem regra de comissão"}
                          {c.kmRodado > 0 && ` · Km a ${brl(c.kmTarifa)}/km`}
                        </td>
                      </tr>
                      {/* Linha 2 — % do total do mês */}
                      <tr className="text-xs text-muted-foreground">
                        <td className="px-3 py-1 sticky left-0 bg-background">% Total do Mês</td>
                        <td className="px-3 py-1 text-right">{pct(c.percentuais.fixoMensal)}</td>
                        <td className="px-3 py-1 text-right">—</td>
                        <td className="px-3 py-1 text-right" title="Atingimento da meta">
                          {c.meta > 0 ? pct(c.atingimentoPct) : "—"}
                        </td>
                        <td className="px-3 py-1 text-right">{pct(c.percentuais.comissao)}</td>
                        <td className="px-3 py-1 text-right">{pct(c.percentuais.bonus)}</td>
                        <td className="px-3 py-1 text-right">{pct(c.percentuais.km)}</td>
                        <td className="px-3 py-1 text-right font-medium">{pct(c.percentuais.totalMes)}</td>
                      </tr>
                      {/* Linha 3 — R$ */}
                      <tr className="font-medium">
                        <td className="px-3 py-1 sticky left-0 bg-background text-muted-foreground font-normal">R$ Valor</td>
                        <td className="px-3 py-1 text-right">{brl(c.fixoMensal)}</td>
                        <td className="px-3 py-1 text-right">{c.meta > 0 ? brl(c.meta) : "—"}</td>
                        <td className="px-3 py-1 text-right">{brl(c.faturamento)}</td>
                        <td className="px-3 py-1 text-right" title={(c.descontoTroca || 0) > 0 ? `Comissão ${brl(c.comissaoBruta || 0)} − desconto por troca vencida ${brl(c.descontoTroca || 0)}` : undefined}>
                          {brl(c.comissao)}
                          {(c.descontoTroca || 0) > 0 && (
                            <div className="text-[11px] text-red-600">− {brl(c.descontoTroca || 0)} troca</div>
                          )}
                        </td>
                        <td className="px-3 py-1 text-right" title={`Campanha ${brl(c.bonusDetalhe.campanha)} · Desafio ${brl(c.bonusDetalhe.desafio)} · Manual ${brl(c.bonusDetalhe.manual)}`}>
                          {brl(c.bonus)}
                        </td>
                        <td className="px-3 py-1 text-right" title={km(c.kmRodado)}>{brl(c.kmValor)}</td>
                        <td className="px-3 py-1 text-right text-emerald-700 font-bold">{brl(c.totalMes)}</td>
                      </tr>
                    </tbody>
                ))}
                {totais && colabs.length > 1 && (
                  <tbody className="border-t-4 border-background">
                      <tr className="bg-emerald-50 font-bold">
                        <td className="px-3 py-2 sticky left-0 bg-emerald-50">TOTAL</td>
                        <td className="px-3 py-2 text-right">{brl(totais.fixoMensal)}</td>
                        <td className="px-3 py-2 text-right">{brl(totais.meta)}</td>
                        <td className="px-3 py-2 text-right">{brl(totais.faturamento)}</td>
                        <td className="px-3 py-2 text-right">{brl(totais.comissao)}</td>
                        <td className="px-3 py-2 text-right">{brl(totais.bonus)}</td>
                        <td className="px-3 py-2 text-right">{brl(totais.kmValor)}</td>
                        <td className="px-3 py-2 text-right text-emerald-700">{brl(totais.totalMes)}</td>
                      </tr>
                  </tbody>
                )}
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          A linha <strong>% Total do Mês</strong> mostra quanto cada rubrica representa da remuneração do
          colaborador (fixo + comissão + bônus + km = 100%). Nas colunas Meta e Faturamento ela não se
          aplica: em Faturamento o percentual exibido é o atingimento da meta. O faturamento vem da mesma
          fonte do Dashboard — NF-e de venda autorizada, atribuída a quem implantou o pedido.
        </span>
      </div>

      {admin && <DialogConfig open={abrirConfig} onOpenChange={setAbrirConfig} ym={ym} />}
      {admin && <DialogBonus open={abrirBonus} onOpenChange={setAbrirBonus} ym={ym} colabs={colabs} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuração de remuneração por colaborador, com vigência.
// ---------------------------------------------------------------------------
function DialogConfig({ open, onOpenChange, ym }: { open: boolean; onOpenChange: (o: boolean) => void; ym: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const vazio = {
    userId: "", vigenciaYm: ym, fixoMensal: "", comissaoTipo: "nenhum",
    comissaoPct: "", comissaoDescontoFixo: "", comissaoProporcionalMeta: false,
    faixaTipo: "telemarketing", pagaKm: true, observacao: "",
  };
  const [form, setForm] = useState<any>(vazio);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const { data } = useQuery<{ configs: any[]; colaboradores: any[] }>({
    queryKey: ["/api/resumo-recebiveis/config"],
    queryFn: () => apiRequest("GET", "/api/resumo-recebiveis/config"),
    enabled: open,
  });

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis/config"] });
    queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis"] });
  };

  const salvar = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/config", {
      userId: form.userId, vigenciaYm: form.vigenciaYm,
      fixoMensal: Number(String(form.fixoMensal).replace(",", ".")) || 0,
      comissaoTipo: form.comissaoTipo,
      comissaoPct: Number(String(form.comissaoPct).replace(",", ".")) || 0,
      comissaoDescontoFixo: Number(String(form.comissaoDescontoFixo).replace(",", ".")) || 0,
      comissaoProporcionalMeta: form.comissaoProporcionalMeta,
      faixaTipo: form.faixaTipo, pagaKm: form.pagaKm, observacao: form.observacao,
    }),
    onSuccess: () => { toast({ title: "Configuração salva" }); setForm(vazio); invalidar(); },
    onError: (e: any) => toast({ title: "Falha ao salvar", description: e?.message, variant: "destructive" }),
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/config/${id}`),
    onSuccess: () => { toast({ title: "Vigência removida" }); invalidar(); },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Configuração de remuneração</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Cada linha vale <strong>a partir do mês de vigência</strong>. Para dar um aumento, crie uma nova
          vigência — os meses já apurados continuam com o valor antigo.
        </p>

        <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-3 gap-3 min-w-0">
          <div className="min-w-0 md:col-span-2">
            <Label className="text-xs">Colaborador</Label>
            <Select value={form.userId} onValueChange={(v) => set("userId", v)}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                {(data?.colaboradores || []).map((c: any) => (
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
            <div className="min-w-0">
              <Label className="text-xs">Percentual (%)</Label>
              <Input className="mt-1" inputMode="decimal" placeholder="8"
                value={form.comissaoPct} onChange={(e) => set("comissaoPct", e.target.value)} />
            </div>
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
          {form.comissaoTipo === "fixo" && (
            <>
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
          <div className="min-w-0 flex items-end gap-2 pb-1">
            <Switch checked={form.pagaKm} onCheckedChange={(v) => set("pagaKm", v)} />
            <span className="text-xs">Recebe km</span>
          </div>
          <div className="min-w-0 md:col-span-3">
            <Label className="text-xs">Observação</Label>
            <Input className="mt-1" maxLength={500} value={form.observacao}
              onChange={(e) => set("observacao", e.target.value)} placeholder="Ex.: reajuste aprovado em reunião" />
          </div>
          <div className="md:col-span-3 flex justify-end">
            <Button size="sm" disabled={!form.userId || salvar.isPending} onClick={() => salvar.mutate()}>
              {salvar.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
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
                <th className="text-center px-2 py-1.5">Km</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {(data?.configs || []).map((c: any) => (
                <tr key={c.id} className="border-t">
                  <td className="px-2 py-1.5">{c.nome}</td>
                  <td className="px-2 py-1.5">{nomeDoMes(c.vigencia_ym)}</td>
                  <td className="px-2 py-1.5 text-right">{brl(Number(c.fixo_mensal))}</td>
                  <td className="px-2 py-1.5">
                    {c.comissao_tipo === "faixa" ? "Faixa"
                      : c.comissao_tipo === "fixo"
                        ? `${Number(c.comissao_pct)}%${Number(c.comissao_desconto_fixo) > 0 ? ` − ${brl(Number(c.comissao_desconto_fixo))}` : ""}${c.comissao_proporcional_meta ? " prop." : ""}`
                        : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center">{c.paga_km ? "sim" : "não"}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-600"
                      onClick={() => remover.mutate(c.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Lançamento avulso de bônus.
// ---------------------------------------------------------------------------
function DialogBonus({ open, onOpenChange, ym, colabs }: { open: boolean; onOpenChange: (o: boolean) => void; ym: string; colabs: Colab[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState("");
  const [descricao, setDescricao] = useState("");
  const [valor, setValor] = useState("");

  const invalidar = () => queryClient.invalidateQueries({ queryKey: ["/api/resumo-recebiveis"] });

  const lancar = useMutation({
    mutationFn: () => apiRequest("POST", "/api/resumo-recebiveis/bonus", {
      userId, ym, descricao, valor: Number(String(valor).replace(",", ".")) || 0,
    }),
    onSuccess: () => {
      toast({ title: "Bônus lançado" });
      setDescricao(""); setValor("");
      invalidar();
    },
    onError: (e: any) => toast({ title: "Falha ao lançar", description: e?.message, variant: "destructive" }),
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/resumo-recebiveis/bonus/${id}`),
    onSuccess: () => { toast({ title: "Lançamento removido" }); invalidar(); },
  });

  const lancamentos = colabs.flatMap((c) =>
    (c.bonusDetalhe?.lancamentos || []).map((l) => ({ ...l, colaborador: c.nome })));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Bônus avulso — {nomeDoMes(ym)}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Para o que não vem da Campanha nem do desafio da meta: premiação pontual, acerto, reembolso,
          ajuda de custo extra. Entra na coluna Bônus do mês selecionado.
        </p>

        <div className="rounded-lg border bg-muted/30 p-3 grid grid-cols-1 md:grid-cols-4 gap-3 min-w-0">
          <div className="min-w-0 md:col-span-2">
            <Label className="text-xs">Colaborador</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>
                {colabs.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-xs">Valor (R$)</Label>
            <Input className="mt-1" inputMode="decimal" placeholder="0,00"
              value={valor} onChange={(e) => setValor(e.target.value)} />
          </div>
          <div className="min-w-0 flex items-end">
            <Button size="sm" className="w-full" disabled={!userId || !descricao.trim() || lancar.isPending}
              onClick={() => lancar.mutate()}>
              {lancar.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lançar"}
            </Button>
          </div>
          <div className="min-w-0 md:col-span-4">
            <Label className="text-xs">Descrição</Label>
            <Input className="mt-1" maxLength={300} value={descricao}
              onChange={(e) => setDescricao(e.target.value)} placeholder="Ex.: prêmio da campanha de reativação" />
          </div>
        </div>

        {lancamentos.length > 0 && (
          <div className="space-y-1">
            {lancamentos.map((l) => (
              <div key={l.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm min-w-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{l.colaborador}</div>
                  <div className="truncate text-xs text-muted-foreground">{l.descricao}</div>
                </div>
                <span className="shrink-0 font-medium">{brl(l.valor)}</span>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0 text-red-600"
                  onClick={() => remover.mutate(l.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
