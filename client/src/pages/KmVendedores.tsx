// ============================================================================
// INTEGRA 2.0 - KILOMETRAGEM VENDEDORES (Ago/2026)
// Modulo de Administracao: historico de KM MENSAL de todos os vendedores que
// tem Rota do Dia. Fonte: soma de daily_routes.total_actual_distance por
// vendedor e por mes (km realizada). Enquanto o rastreamento GPS nao entra em
// producao, a km e a estimativa por check-in + rota por ruas (OSRM).
//
// Pagamento por km: cada vendedor tem sua propria tarifa R$/km, editavel direto
// na linha (admin), persistida em config_global. Duas tarifas de referencia
// (GO e DF) ficam no topo e servem de atalho para preencher a linha. O valor a
// pagar = km do mes x tarifa do vendedor. O mes so e considerado FECHADO (valor
// definitivo) no ultimo dia do mes apos as 20h (SP).
// Endpoints: GET /api/admin/km-vendedores | POST /api/admin/km-vendedores/rate
//            POST /api/admin/km-vendedores/seller-rate
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { usePermissions } from "@/lib/permissions";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Route as RouteIcon, Search, DollarSign, Download, Info } from "lucide-react";
import * as XLSXStyle from "xlsx-js-style";

type SellerRow = {
  sellerId: string;
  sellerName: string;
  role: string | null;
  byMonth: Record<string, number>;
  diasByMonth: Record<string, number>;
  total: number;
  totalDias: number;
  sellerRate?: number;
};
type Resp = { months: string[]; sellers: SellerRow[]; geradoEm?: string; ratePerKm?: number; ratePerKmGO?: number; ratePerKmDF?: number; mesAtual?: string; mesFechado?: boolean };

const MES_LABEL: Record<string, string> = { "01": "jan", "02": "fev", "03": "mar", "04": "abr", "05": "mai", "06": "jun", "07": "jul", "08": "ago", "09": "set", "10": "out", "11": "nov", "12": "dez" };
function fmtMes(iso: string): string { const [y, m] = iso.split("-"); return `${MES_LABEL[m] || m}/${(y || "").slice(2)}`; }
function fmtKm(n: number): string { return (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function fmtBRL(n: number): string { return (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function ultimoDiaDoMes(iso: string): number { if (!iso) return 0; const [y, m] = iso.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function parseRate(s: string | number | undefined | null): number { const n = parseFloat(String(s ?? "").replace(",", ".")); return isFinite(n) && n >= 0 ? n : 0; }

const ROLE_LABEL: Record<string, string> = { vendedor: "Vendedor", telemarketing: "Telemarketing", coordinator: "Coordenacao", administrative: "Administrativo", admin: "Admin", motorista: "Motorista", industria: "Industria" };

export default function KmVendedores() {
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const { toast } = useToast();
  const [busca, setBusca] = useState<string>("");
  const [showInfo, setShowInfo] = useState<boolean>(false);
  // Tarifas de referencia (GO e DF) no topo
  const [rateGO, setRateGO] = useState<string>("");
  const [rateDF, setRateDF] = useState<string>("");
  const [ratesLoaded, setRatesLoaded] = useState<boolean>(false);
  // Tarifa R$/km por vendedor (editavel na linha)
  const [sellerRates, setSellerRates] = useState<Record<string, string>>({});
  const [sellerRatesLoaded, setSellerRatesLoaded] = useState<boolean>(false);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["/api/admin/km-vendedores"],
    queryFn: () => apiRequest("GET", "/api/admin/km-vendedores"),
    staleTime: 60_000,
    refetchOnMount: "always",
  });
  const months = (data?.months || []).filter((m) => m >= "2026-01");
  const sellers = data?.sellers || [];
  const mesAtualCol = months.length ? months[months.length - 1] : "";
  const mesPagto = data?.mesAtual || mesAtualCol;
  const mesFechado = !!data?.mesFechado;
  const savedGO = Number(data?.ratePerKmGO ?? data?.ratePerKm ?? 0);
  const savedDF = Number(data?.ratePerKmDF ?? data?.ratePerKm ?? 0);

  useEffect(() => {
    if (data && !ratesLoaded) {
      setRateGO(String(data.ratePerKmGO ?? data.ratePerKm ?? 0));
      setRateDF(String(data.ratePerKmDF ?? data.ratePerKm ?? 0));
      setRatesLoaded(true);
    }
  }, [data, ratesLoaded]);

  useEffect(() => {
    if (data && !sellerRatesLoaded) {
      const init: Record<string, string> = {};
      for (const s of data.sellers || []) init[s.sellerId] = String(s.sellerRate ?? 0);
      setSellerRates(init);
      setSellerRatesLoaded(true);
    }
  }, [data, sellerRatesLoaded]);

  const rateGONum = parseRate(rateGO);
  const rateDFNum = parseRate(rateDF);
  const ratesDirty = ratesLoaded && (rateGONum !== savedGO || rateDFNum !== savedDF);

  const saveRatesMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/km-vendedores/rate", { ratePerKmGO: rateGONum, ratePerKmDF: rateDFNum }),
    onSuccess: () => { toast({ title: "Tarifas de referencia salvas", description: `GO ${fmtBRL(rateGONum)}/km, DF ${fmtBRL(rateDFNum)}/km.` }); },
    onError: () => toast({ title: "Erro ao salvar as tarifas", variant: "destructive" }),
  });

  const sellerRateMut = useMutation({
    mutationFn: (p: { sellerId: string; rate: number }) => apiRequest("POST", "/api/admin/km-vendedores/seller-rate", p),
    onError: () => toast({ title: "Erro ao salvar a tarifa do vendedor", variant: "destructive" }),
  });

  // Tarifa efetiva de um vendedor (valor local editado; se vazio, cai no que veio do servidor).
  const rateOf = (r: SellerRow) => {
    const raw = sellerRates[r.sellerId];
    if (raw !== undefined && raw !== "") return parseRate(raw);
    return Number(r.sellerRate ?? 0) || 0;
  };
  // Salva a tarifa da linha (se mudou) no servidor.
  const commitSellerRate = (r: SellerRow) => {
    if (!isAdmin) return;
    const val = parseRate(sellerRates[r.sellerId]);
    if (Math.abs(val - (Number(r.sellerRate ?? 0) || 0)) < 1e-9) return; // nada mudou
    sellerRateMut.mutate({ sellerId: r.sellerId, rate: val });
    r.sellerRate = val; // reflete localmente para evitar re-save
  };
  // Preenche a linha com uma tarifa de referencia (GO/DF) e salva.
  const applyRef = (r: SellerRow, val: number) => {
    if (!isAdmin) return;
    setSellerRates((m) => ({ ...m, [r.sellerId]: String(val) }));
    sellerRateMut.mutate({ sellerId: r.sellerId, rate: val });
    r.sellerRate = val;
  };

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
  const valorSeller = (r: SellerRow) => (r.byMonth[mesPagto] || 0) * rateOf(r);
  const totalPagar = rows.reduce((s, r) => s + valorSeller(r), 0);

  // Exporta TODAS as colunas para .xlsx FORMATADO: cabecalho em negrito, faixas
  // alternadas, km com separador de milhar, coluna R$/km e coluna R$ a pagar em
  // moeda (traco para zero) e linha de Total.
  function exportarExcel() {
    const meses = months;
    const headers = ["Vendedor", "Funcao", ...meses.map(fmtMes), "R$/km", `R$ a pagar (${fmtMes(mesPagto)})`];
    const dataRows = rows.map((r) => [
      r.sellerName,
      r.role ? (ROLE_LABEL[r.role] || r.role) : "",
      ...meses.map((mo) => r.byMonth[mo] || 0),
      Number(rateOf(r).toFixed(2)),
      Number(valorSeller(r).toFixed(2)),
    ]);
    const totalRow: any[] = ["Total", "", ...meses.map(() => null), null, Number(totalPagar.toFixed(2))];
    const aoa: any[][] = [headers, ...dataRows, totalRow];
    const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
    const nCols = headers.length;
    const lastRow = aoa.length - 1;
    const KM_FMT = "#,##0";
    const BRL_FMT = '_-"R$" * #,##0.00_-;-"R$" * #,##0.00_-;_-"R$" * "-"??_-;_-@_-';
    const firstMonthCol = 2;
    const lastMonthCol = nCols - 3; // ultima coluna de mes
    const rateCol = nCols - 2;      // coluna R$/km
    const payCol = nCols - 1;       // coluna R$ a pagar
    const thin = { style: "thin", color: { rgb: "D0D5DD" } };
    const borderAll: any = { top: thin, bottom: thin, left: thin, right: thin };
    for (let R = 0; R <= lastRow; R++) {
      const isHeader = R === 0;
      const isTotal = R === lastRow;
      const band = !isHeader && !isTotal && R % 2 === 1;
      for (let C = 0; C < nCols; C++) {
        const addr = XLSXStyle.utils.encode_cell({ r: R, c: C });
        const cell: any = ws[addr] || (ws[addr] = { t: "s", v: "" });
        const s: any = { border: borderAll, alignment: { vertical: "center", horizontal: C <= 1 ? "left" : "right" } };
        if (isHeader) {
          s.font = { bold: true, color: { rgb: "1F2937" } };
          s.fill = { fgColor: { rgb: "E9EDF5" } };
          s.alignment.horizontal = C <= 1 ? "left" : "center";
        } else {
          if (C >= firstMonthCol && C <= lastMonthCol) { cell.z = KM_FMT; s.numFmt = KM_FMT; }
          if (C === rateCol || C === payCol) { cell.z = BRL_FMT; s.numFmt = BRL_FMT; }
          if (isTotal) { s.font = { bold: true }; s.fill = { fgColor: { rgb: "D9D9D9" } }; }
          else if (band) { s.fill = { fgColor: { rgb: "F3F5F9" } }; }
        }
        cell.s = s;
      }
    }
    ws["!cols"] = [{ wch: 18 }, { wch: 13 }, ...meses.map(() => ({ wch: 10 })), { wch: 11 }, { wch: 20 }];
    const wb = XLSXStyle.utils.book_new();
    XLSXStyle.utils.book_append_sheet(wb, ws, "Km Vendedores");
    XLSXStyle.writeFile(wb, `km-vendedores-${mesPagto || "geral"}.xlsx`);
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <BackToDashboardButton />

      <div className="flex items-center gap-3 mt-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
          <RouteIcon className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Kilometragem Vendedores</h1>
          <div className="text-xs text-muted-foreground">Historico de quilometragem mensal (km realizada) e o valor a pagar por km de todos os vendedores com Rota do Dia.</div>
        </div>
      </div>

      <Card className="relative">
        <button type="button" onClick={() => setShowInfo((v) => !v)} title="Como a km e calculada" aria-label="Como a km e calculada" className="absolute top-3 right-3 z-20 w-7 h-7 rounded-full border bg-background text-indigo-600 hover:bg-indigo-50 flex items-center justify-center">
          <Info className="w-4 h-4" />
        </button>
        {showInfo && (
          <div className="absolute top-11 right-3 z-30 w-[330px] max-w-[calc(100%-1.5rem)] rounded-lg border bg-background p-3 text-xs shadow-xl">
            <div className="font-semibold text-sm mb-1 flex items-center gap-1"><Info className="w-3.5 h-3.5 text-indigo-600" /> Como a quilometragem e calculada</div>
            <p className="text-muted-foreground mb-2">E a distancia executada, reconstruida a partir dos check-ins que o vendedor registra em cada visita.</p>
            <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
              <li>Liga ponto a ponto na ordem cronologica: casa, check-in 1, check-in 2, ... e a volta para casa (a volta entra na soma).</li>
              <li>Cada trecho e medido por rota de ruas (OSRM); se o OSRM falhar, usa linha reta (Haversine) como reserva.</li>
              <li>So entram visitas validadas (check-in cancelado nao conta; "fora da rota" so apos o admin validar).</li>
              <li>O total e recalculado a cada check-in. Sem check-in, a rota fica 0 km.</li>
              <li>Mede a distancia entre os pontos de check-in; desvios ou paradas sem registro nao entram, e casa em (0,0) e ignorada para nao inflar.</li>
            </ul>
            <p className="text-muted-foreground mt-2">O valor a pagar usa a tarifa R$/km de cada vendedor (coluna R$/km). As tarifas GO e DF no topo servem de atalho para preencher a linha.</p>
            <button type="button" onClick={() => setShowInfo(false)} className="mt-2 text-indigo-600 hover:underline">Fechar</button>
          </div>
        )}
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><RouteIcon className="w-4 h-4" /> Historico mensal por vendedor</CardTitle>
          <div className="text-xs text-muted-foreground mt-1">Soma da km executada em cada mes. Hoje a km e medida pelos check-ins + rota por ruas (OSRM); passara a refletir o trajeto GPS quando o rastreamento continuo entrar no ar.</div>

          <div className="flex flex-col sm:flex-row sm:items-end gap-3 mt-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1 flex items-center gap-1"><DollarSign className="w-3 h-3" /> Tarifas de referencia (R$/km)</label>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-semibold text-muted-foreground w-6">GO</span>
                  <span className="text-sm text-muted-foreground">R$</span>
                  <input type="text" inputMode="decimal" value={rateGO} disabled={!isAdmin} onChange={(e) => setRateGO(e.target.value)} placeholder="0,00" className="w-24 rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60" />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs font-semibold text-muted-foreground w-6">DF</span>
                  <span className="text-sm text-muted-foreground">R$</span>
                  <input type="text" inputMode="decimal" value={rateDF} disabled={!isAdmin} onChange={(e) => setRateDF(e.target.value)} placeholder="0,00" className="w-24 rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60" />
                </div>
                {isAdmin ? (
                  <button onClick={() => saveRatesMut.mutate()} disabled={!ratesDirty || saveRatesMut.isPending} className="rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">{saveRatesMut.isPending ? "Salvando..." : "Salvar"}</button>
                ) : null}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{isAdmin ? "GO e DF sao atalhos para preencher a coluna R$/km de cada vendedor. O calculo usa a tarifa da linha." : "Somente o admin pode alterar as tarifas."}</div>
            </div>

            <div className="flex-1">
              <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${mesFechado ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                {mesFechado
                  ? `Mes ${fmtMes(mesPagto)} FECHADO - valor a pagar definitivo.`
                  : `Previa de ${fmtMes(mesPagto)} - fecha em ${ultimoDiaDoMes(mesPagto)}/${mesPagto.split("-")[1]} as 20h.`}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button type="button" onClick={exportarExcel} className="inline-flex items-center gap-1 px-3 py-2 border rounded-md text-sm bg-emerald-600 text-white hover:bg-emerald-700"><Download className="w-4 h-4" /> Exportar Excel</button>
          </div>

          <div className="relative mt-3 sm:w-72">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar vendedor..." className="w-full rounded-lg border bg-background pl-9 pr-8 py-2 text-sm" />
            {busca ? <button onClick={() => setBusca("")} title="Limpar" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm">x</button> : null}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-6">Carregando...</div>
          ) : months.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6">Nenhuma rota com quilometragem registrada ainda.</div>
          ) : (
            <div className="overflow-auto max-h-[70vh] rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left font-bold py-2 px-3 bg-background border-b sticky left-0 z-20">Vendedor</th>
                    {months.map((mo) => (
                      <th key={mo} className={`text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap ${mo === mesAtualCol ? "text-indigo-600" : ""}`}>{fmtMes(mo)}</th>
                    ))}
                    <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">R$/km</th>
                    <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-green-700">R$ a pagar ({fmtMes(mesPagto)})</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={months.length + 3} className="text-center text-muted-foreground py-6 px-3">Nenhum vendedor encontrado.</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.sellerId} className="border-t align-top hover:bg-muted/40">
                      <td className="py-2 px-3 bg-background sticky left-0">
                        <div className="font-semibold whitespace-nowrap">{r.sellerName}</div>
                        {r.role ? <div className="text-[11px] text-muted-foreground">{ROLE_LABEL[r.role] || r.role}</div> : null}
                      </td>
                      {months.map((mo) => (
                        <td key={mo} className={`py-2 px-3 text-right tabular-nums whitespace-nowrap ${mo === mesAtualCol ? "font-semibold" : ""}`} title={r.diasByMonth[mo] ? `${r.diasByMonth[mo]} dia(s) com rota` : ""}>
                          {r.byMonth[mo] ? fmtKm(r.byMonth[mo]) : <span className="text-gray-300">-</span>}
                        </td>
                      ))}
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {isAdmin ? (
                          <div className="flex items-center justify-end gap-1">
                            <div className="flex flex-col gap-0.5">
                              <button type="button" title={`Usar tarifa GO (${fmtBRL(rateGONum)})`} onClick={() => applyRef(r, rateGONum)} className="text-[9px] leading-none px-1 py-0.5 rounded border text-indigo-600 hover:bg-indigo-50">GO</button>
                              <button type="button" title={`Usar tarifa DF (${fmtBRL(rateDFNum)})`} onClick={() => applyRef(r, rateDFNum)} className="text-[9px] leading-none px-1 py-0.5 rounded border text-indigo-600 hover:bg-indigo-50">DF</button>
                            </div>
                            <span className="text-xs text-muted-foreground">R$</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={sellerRates[r.sellerId] ?? ""}
                              onChange={(e) => setSellerRates((m) => ({ ...m, [r.sellerId]: e.target.value }))}
                              onBlur={() => commitSellerRate(r)}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              placeholder="0,00"
                              className="w-20 rounded-md border bg-background px-2 py-1 text-sm text-right"
                            />
                          </div>
                        ) : (
                          <span className="tabular-nums">{fmtBRL(rateOf(r))}</span>
                        )}
                      </td>
                      <td className={`py-2 px-3 text-right tabular-nums font-bold whitespace-nowrap ${mesFechado ? "text-green-700" : "text-amber-700"}`} title={`${fmtKm(r.byMonth[mesPagto] || 0)} km x ${fmtBRL(rateOf(r))}/km`}>{fmtBRL(valorSeller(r))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 bg-muted/30 font-bold">
                    <td className="py-2 px-3 bg-muted/30 sticky left-0">Total ({rows.length})</td>
                    {months.map((mo) => (
                      <td key={mo} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{fmtKm(totalPorMes[mo] || 0)}</td>
                    ))}
                    <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">-</td>
                    <td className={`py-2 px-3 text-right tabular-nums ${mesFechado ? "text-green-700" : "text-amber-700"}`}>{fmtBRL(totalPagar)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground mt-2">Valores em quilometros (km). "R$ a pagar" = km do mes de {fmtMes(mesPagto)} x a tarifa R$/km do vendedor (coluna R$/km). O valor so e definitivo no ultimo dia do mes apos as 20h (horario de Brasilia); antes disso e uma previa e pode mudar conforme novas rotas do mes. Passe o mouse na celula para ver o calculo.</div>
        </CardContent>
      </Card>
    </div>
  );
}
