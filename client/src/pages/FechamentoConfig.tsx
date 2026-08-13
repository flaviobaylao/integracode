// ============================================================================
// INTEGRA 2.0 — FECHAMENTO DE ROTAS (Ago/2026)
// Hub do Fechamento de Rota, com abas:
//   - Painel de Gestão: acompanhamento mensal (admin + coordenação/administrativo)
//   - Regras (somente admin): trava, bloqueio do dia seguinte, fecho automático,
//     tipos de cliente e ações do admin (liberar rota / reabrir dia)
// Persistencia: config_global (chave 'fechamento_config') via /api/admin/fechamento/config.
// ============================================================================
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { usePermissions } from "@/lib/permissions";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import FechamentoPainel from "@/pages/FechamentoPainel";
import FecharRota from "@/pages/FecharRota";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ClipboardCheck, Lock, BarChart3, Flag, History, Search } from "lucide-react";

type Cfg = {
  travaObrigatoria: boolean;
  bloqueioDiaSeguinte: boolean;
  fechoAutomatico: boolean;
  fechoHorario: string;
  tipos: string[];
  exigirDebito: boolean;
};
const DEFAULTS: Cfg = { travaObrigatoria: true, bloqueioDiaSeguinte: true, fechoAutomatico: false, fechoHorario: "19:00", tipos: ["presencial", "virtual", "lead"], exigirDebito: false };
const TIPOS: [string, string][] = [["presencial", "Presencial"], ["virtual", "Virtual"], ["lead", "Lead"]];

function RuleRow(props: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-t first:border-t-0">
      <div>
        <div className="font-semibold text-sm">{props.title}</div>
        <div className="text-xs text-muted-foreground mt-1 max-w-2xl">{props.desc}</div>
      </div>
      <Switch checked={props.checked} onCheckedChange={props.onChange} disabled={props.disabled} />
    </div>
  );
}

function RegrasTab() {
  const { toast } = useToast();
  const { data } = useQuery<any>({ queryKey: ["/api/admin/fechamento/config"] });
  const cfg: Cfg = { ...DEFAULTS, ...((data && data.config) || {}) };

  const [hora, setHora] = useState<string>(cfg.fechoHorario);
  useEffect(() => { if (data && data.config) setHora(data.config.fechoHorario || "19:00"); }, [data]);

  const salvar = useMutation({
    mutationFn: async (body: any) => apiRequest("POST", "/api/admin/fechamento/config", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fechamento/config"] });
      toast({ title: "Regra atualizada", description: "As mudancas valem para os proximos fechamentos." });
    },
    onError: () => toast({ title: "Erro ao salvar", description: "Tente novamente.", variant: "destructive" }),
  });

  const toggleTipo = (t: string) => {
    const has = cfg.tipos.includes(t);
    const tipos = has ? cfg.tipos.filter((x) => x !== t) : [...cfg.tipos, t];
    if (!tipos.length) { toast({ title: "Selecione ao menos um tipo", variant: "destructive" }); return; }
    salvar.mutate({ tipos });
  };
  const salvarHora = () => {
    if (!/^\d{2}:\d{2}$/.test(hora)) { toast({ title: "Horario invalido", description: "Use o formato HH:MM.", variant: "destructive" }); return; }
    if (hora !== cfg.fechoHorario) salvar.mutate({ fechoHorario: hora });
  };

  // Ações do admin (Fase 4): liberar rota bloqueada / reabrir um dia fechado.
  const { data: usersData } = useQuery<any>({ queryKey: ["/api/users"] });
  const sellers = (Array.isArray(usersData) ? usersData : []).filter((u: any) => ["vendedor", "telemarketing"].includes(u?.role) && u?.isActive);
  const [admSeller, setAdmSeller] = useState<string>("");
  const [admDate, setAdmDate] = useState<string>("");
  const admOk = !!admSeller && /^\d{4}-\d{2}-\d{2}$/.test(admDate);
  const liberar = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/fechamento/liberar", { sellerId: admSeller, date: admDate }),
    onSuccess: () => toast({ title: "Rota liberada", description: "O vendedor pode abrir a rota normalmente." }),
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Verifique os campos.", variant: "destructive" }),
  });
  const reabrir = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/admin/fechamento/reabrir", { sellerId: admSeller, date: admDate }),
    onSuccess: () => toast({ title: "Dia reaberto", description: "O fechamento daquele dia foi removido." }),
    onError: (e: any) => toast({ title: "Erro", description: e?.message || "Verifique os campos.", variant: "destructive" }),
  });

  return (
    <>
      <div className="text-xs text-muted-foreground flex items-center gap-1 mb-4"><Lock className="w-3 h-3" /> Somente o admin edita. No celular, o vendedor apenas vê o efeito.</div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Regras</CardTitle></CardHeader>
        <CardContent>
          <RuleRow
            title="Trava obrigatória para fechar o dia"
            desc="O vendedor só fecha a rota quando todos os clientes estiverem atendidos (check-in) ou justificados. Sem cliente “esquecido”."
            checked={cfg.travaObrigatoria}
            onChange={(v) => salvar.mutate({ travaObrigatoria: v })}
            disabled={salvar.isPending}
          />
          <RuleRow
            title="Bloquear a rota do dia seguinte se o dia anterior não for fechado"
            desc="Se o vendedor esquecer de fechar, a rota do próximo dia abre bloqueada e só libera ao fechar a anterior — ou com liberação do admin."
            checked={cfg.bloqueioDiaSeguinte}
            onChange={(v) => salvar.mutate({ bloqueioDiaSeguinte: v })}
            disabled={salvar.isPending}
          />
          <RuleRow
            title="Exigir explicação de débito no fechamento"
            desc="Quando LIGADO, clientes com débito vencido entram na lista para o vendedor explicar a cobrança. Atualmente DESLIGADO (suspenso até segunda ordem): o fechamento segue somente com as justificativas das não-visitas."
            checked={cfg.exigirDebito}
            onChange={(v) => salvar.mutate({ exigirDebito: v })}
            disabled={salvar.isPending}
          />
          <RuleRow
            title="Fecho automático em horário de corte (opcional)"
            desc="No horário definido, o dia é fechado automaticamente e os clientes ainda sem justificativa entram no painel como “sem justificativa”."
            checked={cfg.fechoAutomatico}
            onChange={(v) => salvar.mutate({ fechoAutomatico: v })}
            disabled={salvar.isPending}
          />
          <div className="flex items-center gap-3 pl-1 pb-2">
            <span className="text-xs text-muted-foreground">Horário do fecho automático</span>
            <Input
              type="time"
              value={hora}
              onChange={(e) => setHora(e.target.value)}
              onBlur={salvarHora}
              disabled={!cfg.fechoAutomatico || salvar.isPending}
              className="w-32"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="pb-2"><CardTitle className="text-base">Tipos de cliente incluídos no fechamento</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground mb-3">Quais cards exigem justificativa se ficarem sem atendimento. Repescagem fica sempre de fora.</div>
          <div className="flex flex-wrap gap-2">
            {TIPOS.map(([id, label]) => {
              const on = cfg.tipos.includes(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTipo(id)}
                  disabled={salvar.isPending}
                  className={`px-3 py-2 rounded-full text-sm font-semibold border transition ${on ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-200 text-gray-600"}`}
                >
                  {label} {on ? "✓" : ""}
                </button>
              );
            })}
            <span className="px-3 py-2 rounded-full text-sm font-semibold bg-gray-100 text-gray-500">Repescagem — fora</span>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="pb-2"><CardTitle className="text-base">Ações do admin</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground mb-3"><b>Liberar rota</b>: desbloqueia a rota de um vendedor sem exigir o fechamento do dia anterior. <b>Reabrir dia</b>: remove um fechamento já feito (para correção). Escolha o vendedor e a data.</div>
          <div className="flex flex-wrap gap-2 items-center">
            <select className="border rounded-lg px-3 py-2 text-sm font-medium min-w-[220px]" value={admSeller} onChange={(e) => setAdmSeller(e.target.value)}>
              <option value="">Vendedor…</option>
              {sellers.map((s: any) => (<option key={s.id} value={s.id}>{(s.firstName || "") + " " + (s.lastName || "")}{s.role === "telemarketing" ? " (TMK)" : ""}</option>))}
            </select>
            <Input type="date" value={admDate} onChange={(e) => setAdmDate(e.target.value)} className="w-40" />
            <button onClick={() => liberar.mutate()} disabled={!admOk || liberar.isPending} className="px-3 py-2 rounded-lg text-sm font-semibold border bg-white text-gray-700 disabled:opacity-50">🔓 Liberar rota</button>
            <button onClick={() => reabrir.mutate()} disabled={!admOk || reabrir.isPending} className="px-3 py-2 rounded-lg text-sm font-semibold border bg-white text-gray-700 disabled:opacity-50">↺ Reabrir dia</button>
          </div>
          <div className="text-[11px] text-muted-foreground mt-3">A “Liberar rota” usa a data do dia pendente que aparece para o vendedor na tela de bloqueio.</div>
        </CardContent>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// HISTORICO DE JUSTIFICATIVAS — lista cada justificativa (um registro por linha)
// com data, cliente, vendedor, motivo e a observacao da caixa de texto.
// Filtro por vendedor + busca por cliente. Fonte: /api/admin/fechamento/historico.
// ---------------------------------------------------------------------------
const HIST_MOTIVO_LABEL: Record<string, string> = {
  sem_tempo: "Não deu tempo / rota grande",
  remarcou: "Cliente avisou / remarcou",
  fechado: "Cliente fechado temporariamente",
  rota_inviavel: "Rota/distância inviável",
  imprevisto: "Imprevisto (veículo/pessoal)",
  cancelou: "Cliente cancelou fornecimento",
  debito: "Débito",
  ausente: "Responsável ausente",
  ja_comprou: "Já comprou / não precisa",
  endereco: "Endereço errado",
  sem_interesse: "Sem interesse",
  outro: "Outro",
};
function fmtDataBR(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function HistoricoTab() {
  const [sellerId, setSellerId] = useState<string>("__all__");
  const [busca, setBusca] = useState<string>("");
  const [buscaAtiva, setBuscaAtiva] = useState<string>("");
  // Debounce simples da busca por cliente para nao consultar a cada tecla.
  useEffect(() => { const t = setTimeout(() => setBuscaAtiva(busca.trim()), 350); return () => clearTimeout(t); }, [busca]);
  const params = new URLSearchParams();
  if (sellerId && sellerId !== "__all__") params.set("sellerId", sellerId);
  if (buscaAtiva) params.set("busca", buscaAtiva);
  const qs = params.toString();
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/fechamento/historico", sellerId, buscaAtiva],
    queryFn: () => apiRequest("GET", `/api/admin/fechamento/historico${qs ? "?" + qs : ""}`),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const registros = (data?.registros || []) as any[];
  const vendedores = (data?.vendedores || []) as any[];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" /> Histórico de justificativas</CardTitle>
          <div className="text-xs text-muted-foreground mt-1">Cada linha é uma justificativa registrada pelo vendedor no fechamento da rota: a data, o motivo e a observação escrita na caixa de texto. Use o filtro por vendedor e a busca por cliente.</div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="sm:w-64">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Vendedor</label>
              <select value={sellerId} onChange={(e) => setSellerId(e.target.value)} className="w-full rounded-lg border bg-background px-3 py-2 text-sm">
                <option value="__all__">Todos os vendedores</option>
                {vendedores.map((v: any) => (<option key={v.sellerId} value={v.sellerId}>{v.vendedor}</option>))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Buscar cliente</label>
              <div className="relative">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Nome do cliente…" className="w-full rounded-lg border bg-background pl-9 pr-8 py-2 text-sm" />
                {busca ? <button onClick={() => setBusca("")} title="Limpar" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">✕</button> : null}
              </div>
            </div>
          </div>

          <div className="text-xs text-muted-foreground mb-2">{isLoading ? "Carregando…" : `${registros.length} justificativa(s)${registros.length >= 500 ? " (exibindo as 500 mais recentes)" : ""}.`}</div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                  <th className="text-left font-bold pb-2 px-2 whitespace-nowrap">Data</th>
                  <th className="text-left font-bold pb-2 px-2">Cliente</th>
                  <th className="text-left font-bold pb-2 px-2">Vendedor</th>
                  <th className="text-left font-bold pb-2 px-2">Motivo</th>
                  <th className="text-left font-bold pb-2 px-2">Observações</th>
                </tr>
              </thead>
              <tbody>
                {(!isLoading && registros.length === 0) ? (
                  <tr><td colSpan={5} className="text-sm text-muted-foreground py-6 px-2 text-center">Nenhuma justificativa encontrada com os filtros atuais.</td></tr>
                ) : registros.map((r: any, i: number) => (
                  <tr key={`${r.customerId}-${r.sellerId}-${r.data}-${i}`} className="border-t align-top">
                    <td className="py-2 px-2 whitespace-nowrap tabular-nums">{fmtDataBR(r.data)}</td>
                    <td className="py-2 px-2">
                      <div className="font-semibold">{r.cliente}</div>
                      {r.cidade ? <div className="text-[11px] text-muted-foreground">{r.cidade}</div> : null}
                    </td>
                    <td className="py-2 px-2">{r.vendedor || "—"}</td>
                    <td className="py-2 px-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.motivo === "debito" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}`}>{HIST_MOTIVO_LABEL[r.motivo] || r.motivo}</span>
                    </td>
                    <td className="py-2 px-2 text-muted-foreground whitespace-pre-wrap max-w-md">{r.obs ? r.obs : <span className="italic text-gray-300">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type Tab = "fechar" | "painel" | "regras" | "historico";

export default function FechamentoConfig() {
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const isReports = ["admin", "coordinator", "administrative"].includes(role);
  const [tab, setTab] = useState<Tab | null>(null);
  const allowed = (t: Tab) => t === "fechar" || (t === "painel" && isReports) || (t === "historico" && isReports) || (t === "regras" && isAdmin);
  const defaultTab: Tab = isReports ? "painel" : "fechar";
  const active: Tab = tab && allowed(tab) ? tab : defaultTab;

  const tabCls = (on: boolean) => `flex items-center gap-2 px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition ${on ? "border-blue-600 text-blue-600" : "border-transparent text-muted-foreground hover:text-gray-700"}`;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <BackToDashboardButton />

      <div className="flex items-center gap-3 mt-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
          <ClipboardCheck className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Fechamento de Rotas</h1>
          <div className="text-xs text-muted-foreground">Gestão do fechamento diário das rotas e as regras que valem para todos.</div>
        </div>
      </div>

      <div className="flex gap-1 border-b mb-5 flex-wrap">
        <button onClick={() => setTab("fechar")} className={tabCls(active === "fechar")}>
          <Flag className="w-4 h-4" /> Fechar Rota
        </button>
        {isReports && (
          <button onClick={() => setTab("painel")} className={tabCls(active === "painel")}>
            <BarChart3 className="w-4 h-4" /> Painel de Gestão
          </button>
        )}
        {isReports && (
          <button onClick={() => setTab("historico")} className={tabCls(active === "historico")}>
            <History className="w-4 h-4" /> Histórico
          </button>
        )}
        {isAdmin && (
          <button onClick={() => setTab("regras")} className={tabCls(active === "regras")}>
            <Lock className="w-4 h-4" /> Regras
          </button>
        )}
      </div>

      {active === "fechar" ? <FecharRota embedded /> : active === "painel" ? <FechamentoPainel embedded /> : active === "historico" ? <HistoricoTab /> : <RegrasTab />}
    </div>
  );
}
