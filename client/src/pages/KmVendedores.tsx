// ============================================================================
// INTEGRA 2.0 — KILOMETRAGEM VENDEDORES (Ago/2026)
// Módulo de Administração: histórico de KM MENSAL de todos os vendedores que
// têm Rota do Dia. Fonte: soma de daily_routes.total_actual_distance por
// vendedor e por mês (km realizada). Enquanto o rastreamento GPS não entra em
// produção, a km é a estimativa por check-in + rota por ruas (OSRM).
// Endpoint: GET /api/admin/km-vendedores
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Route as RouteIcon, Search } from "lucide-react";

type SellerRow = {
  sellerId: string;
  sellerName: string;
  role: string | null;
  byMonth: Record<string, number>;
  diasByMonth: Record<string, number>;
  total: number;
  totalDias: number;
};
type Resp = { months: string[]; sellers: SellerRow[]; geradoEm?: string };

const MES_LABEL: Record<string, string> = { "01": "jan", "02": "fev", "03": "mar", "04": "abr", "05": "mai", "06": "jun", "07": "jul", "08": "ago", "09": "set", "10": "out", "11": "nov", "12": "dez" };
function fmtMes(iso: string): string { const [y, m] = iso.split("-"); return `${MES_LABEL[m] || m}/${(y || "").slice(2)}`; }
function fmtKm(n: number): string { return (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

const ROLE_LABEL: Record<string, string> = { vendedor: "Vendedor", telemarketing: "Telemarketing", coordinator: "Coordenação", administrative: "Administrativo", admin: "Admin", motorista: "Motorista", industria: "Indústria" };

export default function KmVendedores() {
  const [busca, setBusca] = useState<string>("");
  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["/api/admin/km-vendedores"],
    queryFn: () => apiRequest("GET", "/api/admin/km-vendedores"),
    staleTime: 60_000,
    refetchOnMount: "always",
  });
  const months = data?.months || [];
  const sellers = data?.sellers || [];
  const mesAtual = months.length ? months[months.length - 1] : "";

  const rows = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const list = q ? sellers.filter((s) => (s.sellerName || "").toLowerCase().includes(q)) : sellers;
    return [...list].sort((a, b) => b.total - a.total);
  }, [sellers, busca]);

  const totalPorMes = useMemo(() => {
    const t: Record<string, number> = {};
    for (const mo of months) t[mo] = rows.reduce((s, r) => s + (r.byMonth[mo] || 0), 0);
    return t;
  }, [months, rows]);
  const totalGeral = rows.reduce((s, r) => s + (r.total || 0), 0);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <BackToDashboardButton />

      <div className="flex items-center gap-3 mt-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
          <RouteIcon className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Kilometragem Vendedores</h1>
          <div className="text-xs text-muted-foreground">Histórico de quilometragem mensal (km realizada) de todos os vendedores com Rota do Dia.</div>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><RouteIcon className="w-4 h-4" /> Histórico mensal por vendedor</CardTitle>
          <div className="text-xs text-muted-foreground mt-1">Soma da km executada em cada mês. Hoje a km é medida pelos check-ins + rota por ruas (OSRM); passará a refletir o trajeto GPS quando o rastreamento contínuo entrar no ar.</div>
          <div className="relative mt-3 sm:w-72">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar vendedor…" className="w-full rounded-lg border bg-background pl-9 pr-8 py-2 text-sm" />
            {busca ? <button onClick={() => setBusca("")} title="Limpar" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">✕</button> : null}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-6">Carregando…</div>
          ) : months.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6">Nenhuma rota com quilometragem registrada ainda.</div>
          ) : (
            <div className="overflow-auto max-h-[70vh] rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-bold py-2 px-3 bg-background border-b sticky left-0 z-20">Vendedor</th>
                    {months.map((mo) => (
                      <th key={mo} className={`text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap ${mo === mesAtual ? "text-indigo-600" : ""}`}>{fmtMes(mo)}</th>
                    ))}
                    <th className="text-right font-bold py-2 px-3 bg-background border-b">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={months.length + 2} className="text-center text-muted-foreground py-6 px-3">Nenhum vendedor encontrado.</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.sellerId} className="border-t align-top hover:bg-muted/40">
                      <td className="py-2 px-3 bg-background sticky left-0">
                        <div className="font-semibold whitespace-nowrap">{r.sellerName}</div>
                        {r.role ? <div className="text-[11px] text-muted-foreground">{ROLE_LABEL[r.role] || r.role}</div> : null}
                      </td>
                      {months.map((mo) => (
                        <td key={mo} className={`py-2 px-3 text-right tabular-nums whitespace-nowrap ${mo === mesAtual ? "font-semibold" : ""}`} title={r.diasByMonth[mo] ? `${r.diasByMonth[mo]} dia(s) com rota` : ""}>
                          {r.byMonth[mo] ? fmtKm(r.byMonth[mo]) : <span className="text-gray-300">—</span>}
                        </td>
                      ))}
                      <td className="py-2 px-3 text-right tabular-nums font-bold whitespace-nowrap">{fmtKm(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 bg-muted/30 font-bold">
                    <td className="py-2 px-3 bg-muted/30 sticky left-0">Total ({rows.length})</td>
                    {months.map((mo) => (
                      <td key={mo} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{fmtKm(totalPorMes[mo] || 0)}</td>
                    ))}
                    <td className="py-2 px-3 text-right tabular-nums">{fmtKm(totalGeral)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground mt-2">Valores em quilômetros (km). "Total" soma todos os meses exibidos. Passe o mouse sobre a célula para ver os dias com rota. O mês atual aparece destacado.</div>
        </CardContent>
      </Card>
    </div>
  );
}
