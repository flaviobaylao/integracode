// ============================================================================
// INTEGRA 2.0 — PAINEL MENSAL DO FECHAMENTO DE ROTA (Ago/2026) — Fase 5
// Acompanhamento mensal (admin/gestao): total de nao-visitas, motivos,
// relacao de clientes nao visitados no mes e desempenho por vendedor.
// Fonte: /api/admin/fechamento/mensal (visit_justifications + route_closures).
// Renova por mes (seletor); meses anteriores ficam no historico.
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Ban, CheckCircle2, ClipboardList } from "lucide-react";

const MOTIVO_LABEL: Record<string, string> = {
  sem_tempo: "Não deu tempo / rota grande",
  remarcou: "Cliente avisou / remarcou",
  fechado: "Cliente fechado ou de férias",
  rota_inviavel: "Rota/distância inviável",
  imprevisto: "Imprevisto (veículo/pessoal)",
  cancelou: "Cliente cancelou fornecimento",
  ausente: "Responsável ausente",
  ja_comprou: "Já comprou / não precisa",
  endereco: "Endereço errado",
  sem_interesse: "Sem interesse",
  outro: "Outro",
};

function nowMonthISO(): string {
  const d = new Date().toLocaleString("en-CA", { timeZone: "America/Sao_Paulo" });
  return d.slice(0, 7);
}
function monthOptions(): string[] {
  const out: string[] = [];
  const base = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function mesLabel(m: string): string {
  const [y, mm] = m.split("-");
  const nomes = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${nomes[Number(mm) - 1]}/${y}`;
}

export default function FechamentoPainel({ embedded = false }: { embedded?: boolean }) {
  const [mes, setMes] = useState<string>(nowMonthISO());
  const { data } = useQuery<any>({
    queryKey: ["/api/admin/fechamento/mensal", mes],
    queryFn: () => apiRequest("GET", `/api/admin/fechamento/mensal?mes=${mes}`),
  });

  const porMotivo = (data?.porMotivo || []) as any[];
  const clientes = (data?.clientes || []) as any[];
  const porVendedor = (data?.porVendedor || []) as any[];
  const totalNV = data?.totalNaoVisitados || 0;
  const totalJust = useMemo(() => porVendedor.reduce((s, v) => s + (v.justificados || 0), 0), [porVendedor]);
  const totalPend = useMemo(() => porVendedor.reduce((s, v) => s + (v.pendentes || 0), 0), [porVendedor]);
  const maxMotivo = Math.max(1, ...porMotivo.map((m) => m.n));

  const streakCls = (n: number) => (n >= 3 ? "bg-red-50 text-red-600" : n === 2 ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-500");

  return (
    <div className={embedded ? "" : "p-4 md:p-6 max-w-6xl mx-auto"}>
      {!embedded && <BackToDashboardButton />}
      <div className="flex items-center justify-between gap-3 mt-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><BarChart3 className="w-5 h-5" /></div>
          <div>
            <h1 className="text-xl font-bold">Painel do Fechamento — mensal</h1>
            <div className="text-xs text-muted-foreground">Renova por mês · meses anteriores ficam no histórico</div>
          </div>
        </div>
        <select className="border rounded-lg px-3 py-2 text-sm font-semibold" value={mes} onChange={(e) => setMes(e.target.value)}>
          {monthOptions().map((m) => (<option key={m} value={m}>{mesLabel(m)}</option>))}
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <div className="rounded-xl bg-white border p-4"><div className="text-xs text-muted-foreground flex items-center gap-2"><Ban className="w-4 h-4 text-red-500" /> Não visitados (mês)</div><div className="text-3xl font-extrabold text-red-600 mt-1">{totalNV}</div><div className="text-[11px] text-muted-foreground mt-1">clientes justificados no mês</div></div>
        <div className="rounded-xl bg-white border p-4"><div className="text-xs text-muted-foreground flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-600" /> Justificados (fechos)</div><div className="text-3xl font-extrabold text-green-700 mt-1">{totalJust}</div><div className="text-[11px] text-muted-foreground mt-1">somados nos dias fechados</div></div>
        <div className="rounded-xl bg-white border p-4"><div className="text-xs text-muted-foreground flex items-center gap-2"><ClipboardList className="w-4 h-4 text-amber-600" /> Sem justificativa</div><div className="text-3xl font-extrabold text-amber-600 mt-1">{totalPend}</div><div className="text-[11px] text-muted-foreground mt-1">pendências nos fechos</div></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Por que não foram visitados</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground mb-3">Motivos informados pelos vendedores em {mesLabel(mes)}.</div>
            {porMotivo.length === 0 ? <div className="text-sm text-muted-foreground">Sem justificativas neste mês.</div> : (
              <div className="flex flex-col gap-3">
                {porMotivo.map((m) => (
                  <div key={m.motivo} className="grid grid-cols-[150px_1fr_36px] items-center gap-3">
                    <div className="text-xs text-gray-600 font-semibold text-right truncate" title={MOTIVO_LABEL[m.motivo] || m.motivo}>{MOTIVO_LABEL[m.motivo] || m.motivo}</div>
                    <div className="bg-gray-100 rounded h-4 overflow-hidden"><div className="h-full bg-blue-600 rounded" style={{ width: `${Math.round((m.n / maxMotivo) * 100)}%` }} /></div>
                    <div className="text-xs font-bold text-gray-800 tabular-nums">{m.n}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Clientes não visitados no mês</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xs text-muted-foreground mb-3">Ordenado por recorrência · 🔴 3+ rever periodicidade · 🟡 2 atenção · ⚪ 1 ocasional.</div>
            <div className="flex flex-col gap-2 max-h-[360px] overflow-y-auto pr-1">
              {clientes.length === 0 ? <div className="text-sm text-muted-foreground">Sem registros neste mês.</div> : clientes.map((c, i) => (
                <div key={c.customerId + i} className="flex items-center justify-between gap-2 border rounded-xl px-3 py-2">
                  <div><div className="font-semibold text-sm">{c.nome} {c.cidade ? <span className="text-[10px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 ml-1">{c.cidade}</span> : null}</div><div className="text-[11px] text-muted-foreground">{c.vendedor || "—"} · último motivo: "{MOTIVO_LABEL[c.motivo] || c.motivo}"</div></div>
                  <span className={`text-[11px] font-bold px-2 py-1 rounded-full whitespace-nowrap ${streakCls(c.n)}`}>{c.n}x no mês</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Desempenho por vendedor — {mesLabel(mes)}</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground mb-3">Dias fechados, não visitados, justificados e pendências acumuladas no mês.</div>
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-bold pb-2 px-2">Vendedor</th>
              <th className="text-right font-bold pb-2 px-2">Dias fechados</th>
              <th className="text-right font-bold pb-2 px-2">Não visitados</th>
              <th className="text-right font-bold pb-2 px-2">Justificados</th>
              <th className="text-right font-bold pb-2 px-2">Sem justif.</th>
            </tr></thead>
            <tbody>
              {porVendedor.length === 0 ? (<tr><td colSpan={5} className="text-sm text-muted-foreground py-4 px-2">Nenhum fechamento registrado neste mês.</td></tr>) : porVendedor.map((v) => (
                <tr key={v.sellerId} className="border-t">
                  <td className="py-2 px-2 font-semibold">{v.vendedor}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.dias}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.naoVisitados}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.justificados}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{v.pendentes > 0 ? <span className="text-amber-600 font-bold">{v.pendentes}</span> : v.pendentes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-muted-foreground mt-3">Motivo estruturado é o que permite somar e comparar — texto livre não escala.</div>
        </CardContent>
      </Card>
    </div>
  );
}
