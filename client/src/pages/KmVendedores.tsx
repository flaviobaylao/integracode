// ============================================================================
// INTEGRA 2.0 - KILOMETRAGEM VENDEDORES (Ago/2026)
// Modulo de Administracao: historico de KM MENSAL de todos os vendedores que
// tem Rota do Dia. Fonte: soma de daily_routes.total_actual_distance por
// vendedor e por mes (km realizada). Enquanto o rastreamento GPS nao entra em
// producao, a km e a estimativa por check-in + rota por ruas (OSRM).
//
// Pagamento por km: 3 tarifas de referencia (GO, DF e PSN personalizada) no topo.
// Cada vendedor escolhe na coluna qual tarifa se aplica (GO | DF | PSN); o valor
// pago segue a tarifa de referencia da escolha (a celula da linha nao e editavel,
// so reflete). O valor a pagar = km do mes x tarifa escolhida do vendedor. O mes
// so e FECHADO (definitivo) no ultimo dia do mes apos as 20h (SP).
// Odometro (set/2026): leitura inicial/final do hodometro do carro por vendedor e
// mes. Preenchido, ele vira a km do mes usada no pagamento (km real rodada); o
// calculado por check-in segue visivel nas colunas de meses, para comparacao.
// Endpoints: GET /api/admin/km-vendedores | POST /api/admin/km-vendedores/rate
//            POST /api/admin/km-vendedores/region | POST /api/admin/km-vendedores/odometro
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { usePermissions } from "@/lib/permissions";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Route as RouteIcon, Search, DollarSign, Download, Info } from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";

type Region = "GO" | "DF" | "PSN";
type SellerRow = {
  sellerId: string;
  sellerName: string;
  role: string | null;
  byMonth: Record<string, number>;
  diasByMonth: Record<string, number>;
  total: number;
  totalDias: number;
  sellerRate?: number;
  region?: Region;
  // Odometro do carro por mes (leitura inicial/final). Quando existe, ELE e a km do mes.
  odoByMonth?: Record<string, { inicial: number; final: number; finalAuto: number; finalManual: number | null; automatica: boolean; km: number; kmCalc: number; inicialHerdada?: boolean }>;
};
type Resp = { months: string[]; sellers: SellerRow[]; geradoEm?: string; ratePerKm?: number; ratePerKmGO?: number; ratePerKmDF?: number; ratePerKmPSN?: number; mesAtual?: string; mesFechado?: boolean };
// Histórico DIÁRIO: por vendedor, cada dia com a km separada (Normal / Intermunicipal / Prospecção).
type DiaRow = { dia: string; total: number; intermunicipal: number; normal: number; prospeccao: number; mode: string };
type DiarioSeller = { sellerId: string; sellerName: string; dias: DiaRow[]; total: number; totalInter: number; totalNormal: number; totalProsp: number;
  odoByMonth?: Record<string, { inicial: number; final: number; finalAuto: number; finalManual: number | null; automatica: boolean; km: number; kmCalc: number; inicialHerdada?: boolean }>;
  calcByMonth?: Record<string, number> };
type DiarioResp = { sellers: DiarioSeller[]; geradoEm?: string };

const MES_LABEL: Record<string, string> = { "01": "jan", "02": "fev", "03": "mar", "04": "abr", "05": "mai", "06": "jun", "07": "jul", "08": "ago", "09": "set", "10": "out", "11": "nov", "12": "dez" };
function fmtMes(iso: string): string { const [y, m] = iso.split("-"); return `${MES_LABEL[m] || m}/${(y || "").slice(2)}`; }
function fmtDia(iso: string): string { const [y, m, d] = (iso || "").split("-"); return d ? `${d}/${m}/${(y || "").slice(2)}` : iso; }
function fmtKm(n: number): string { return (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function fmtBRL(n: number): string { return (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function ultimoDiaDoMes(iso: string): number { if (!iso) return 0; const [y, m] = iso.split("-").map(Number); return new Date(y, m, 0).getDate(); }
function parseRate(s: string | number | undefined | null): number { const n = parseFloat(String(s ?? "").replace(",", ".")); return isFinite(n) && n >= 0 ? n : 0; }
function normRegion(x: any): Region { const u = String(x || "").toUpperCase(); return u === "DF" || u === "PSN" ? (u as Region) : "GO"; }

const ROLE_LABEL: Record<string, string> = { vendedor: "Vendedor", telemarketing: "Telemarketing", coordinator: "Coordenacao", administrative: "Administrativo", admin: "Admin", motorista: "Motorista", industria: "Industria" };
const REGION_LABEL: Record<Region, string> = { GO: "GO", DF: "DF", PSN: "PSN" };

export default function KmVendedores() {
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const { toast } = useToast();
  const [busca, setBusca] = useState<string>("");
  const [showInfo, setShowInfo] = useState<boolean>(false);
  // Tarifas de referencia (GO, DF e PSN personalizada) no topo
  const [rateGO, setRateGO] = useState<string>("");
  const [rateDF, setRateDF] = useState<string>("");
  const [ratePSN, setRatePSN] = useState<string>("");
  const [ratesLoaded, setRatesLoaded] = useState<boolean>(false);
  // Escolha de tarifa por vendedor (GO | DF | PSN) editada na coluna
  const [regions, setRegions] = useState<Record<string, Region>>({});
  const [regionsLoaded, setRegionsLoaded] = useState<boolean>(false);

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["/api/admin/km-vendedores"],
    queryFn: () => apiRequest("GET", "/api/admin/km-vendedores"),
    staleTime: 60_000,
    refetchOnMount: "always",
  });

  // Abas: "mensal" (padrão) e "diario" (histórico por dia com sub-abas por vendedor).
  const [aba, setAba] = useState<"mensal" | "pagamento" | "diario">("mensal");
  const [diarioSeller, setDiarioSeller] = useState<string>("");
  const { data: diario, isLoading: diarioLoading } = useQuery<DiarioResp>({
    queryKey: ["/api/admin/km-vendedores/diario"],
    queryFn: () => apiRequest("GET", "/api/admin/km-vendedores/diario"),
    enabled: aba === "diario",
    staleTime: 60_000,
  });
  const diarioSellers = diario?.sellers || [];
  const selDiarioRaw = diarioSellers.find((s) => s.sellerId === diarioSeller) || diarioSellers[0];

  const months = (data?.months || []).filter((m) => m >= "2026-01");
  const sellers = data?.sellers || [];
  const mesAtualCol = months.length ? months[months.length - 1] : "";
  const mesPagto = data?.mesAtual || mesAtualCol;
  const mesFechado = !!data?.mesFechado;

  // MARCACAO DIARIA = so o MES VIGENTE (dinamica): a cada virada de mes a tabela zera e
  // recomeca. O historico fixo por mes fica no quadro do odometro (abaixo) e na aba
  // "Km e pagamento por mes". (out/2026)
  const selDiario = useMemo(() => {
    if (!selDiarioRaw) return undefined;
    const dias = (selDiarioRaw.dias || []).filter((d) => d.dia.slice(0, 7) === mesPagto);
    const soma = (f: (d: DiaRow) => number) => Math.round(dias.reduce((a, d) => a + f(d), 0) * 10) / 10;
    return {
      ...selDiarioRaw,
      dias,
      total: soma((d) => d.total),
      totalInter: soma((d) => d.intermunicipal),
      totalNormal: soma((d) => d.normal),
      totalProsp: soma((d) => d.prospeccao),
    };
  }, [selDiarioRaw, mesPagto]);
  const savedGO = Number(data?.ratePerKmGO ?? data?.ratePerKm ?? 0);
  const savedDF = Number(data?.ratePerKmDF ?? data?.ratePerKm ?? 0);
  const savedPSN = Number(data?.ratePerKmPSN ?? 0);

  useEffect(() => {
    if (data && !ratesLoaded) {
      setRateGO(String(data.ratePerKmGO ?? data.ratePerKm ?? 0));
      setRateDF(String(data.ratePerKmDF ?? data.ratePerKm ?? 0));
      setRatePSN(String(data.ratePerKmPSN ?? 0));
      setRatesLoaded(true);
    }
  }, [data, ratesLoaded]);

  useEffect(() => {
    if (data && !regionsLoaded) {
      const init: Record<string, Region> = {};
      for (const s of data.sellers || []) init[s.sellerId] = normRegion(s.region);
      setRegions(init);
      setRegionsLoaded(true);
    }
  }, [data, regionsLoaded]);

  const rateGONum = parseRate(rateGO);
  const rateDFNum = parseRate(rateDF);
  const ratePSNNum = parseRate(ratePSN);
  const ratesDirty = ratesLoaded && (rateGONum !== savedGO || rateDFNum !== savedDF || ratePSNNum !== savedPSN);

  const saveRatesMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/km-vendedores/rate", { ratePerKmGO: rateGONum, ratePerKmDF: rateDFNum, ratePerKmPSN: ratePSNNum }),
    onSuccess: () => { toast({ title: "Tarifas de referencia salvas", description: `GO ${fmtBRL(rateGONum)} | DF ${fmtBRL(rateDFNum)} | PSN ${fmtBRL(ratePSNNum)} (por km).` }); },
    onError: () => toast({ title: "Erro ao salvar as tarifas", variant: "destructive" }),
  });

  const regionMut = useMutation({
    mutationFn: (p: { sellerId: string; region: Region }) => apiRequest("POST", "/api/admin/km-vendedores/region", p),
    onError: () => toast({ title: "Erro ao salvar a tarifa do vendedor", variant: "destructive" }),
  });

  // ODOMETRO do mes de pagamento: leitura inicial/final do hodometro do carro.
  // Quando as duas estao preenchidas, a km paga do mes passa a ser final - inicial
  // (km real rodada); o calculado por check-in continua na tabela para comparacao.
  const [odo, setOdo] = useState<Record<string, { inicial: string; final: string }>>({});
  const [odoLoaded, setOdoLoaded] = useState<boolean>(false);
  useEffect(() => {
    if (data && !odoLoaded) {
      const init: Record<string, { inicial: string; final: string }> = {};
      for (const sl of data.sellers || []) {
        const it = sl.odoByMonth?.[mesPagto];
        init[sl.sellerId] = { inicial: it ? String(it.inicial) : "", final: it && it.finalManual !== null ? String(it.finalManual) : "" };
      }
      setOdo(init);
      setOdoLoaded(true);
    }
  }, [data, odoLoaded, mesPagto]);

  const odoMut = useMutation({
    mutationFn: (p: { sellerId: string; mes: string; inicial: string | null; final: string | null }) => apiRequest("POST", "/api/admin/km-vendedores/odometro", p),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/km-vendedores"] }); },
    onError: (e: any) => toast({ title: "Erro ao salvar o odometro", description: String(e?.message || ""), variant: "destructive" }),
  });

  // Km do odometro no mes de pagamento (null quando nao ha leitura valida).
  const odoKm = (r: SellerRow): number | null => {
    const it = r.odoByMonth?.[mesPagto];
    const v = odo[r.sellerId];
    // Final informada na mao (conferencia com o painel do carro) manda no numero.
    if (v && v.inicial.trim() !== "" && v.final.trim() !== "") {
      const i = parseRate(v.inicial), f = parseRate(v.final);
      if (isFinite(i) && isFinite(f) && f >= i) return Math.round((f - i) * 10) / 10;
    }
    return it ? it.km : null;
  };
  // Km que MANDA no pagamento do mes: odometro quando houver; senao o calculado.
  const kmPagto = (r: SellerRow): number => { const o = odoKm(r); return o !== null ? o : (r.byMonth[mesPagto] || 0); };
  const fontePagto = (r: SellerRow): string => (odoKm(r) !== null ? "odometro" : "calculado");
  // Salva (ou limpa) a leitura do vendedor no mes de pagamento.
  const commitOdo = (r: SellerRow) => {
    if (!isAdmin) return;
    const v = odo[r.sellerId] || { inicial: "", final: "" };
    const vazio = v.inicial.trim() === "" && v.final.trim() === "";
    if (!vazio && v.inicial.trim() === "") return; // a inicial abre a marcacao; a final e opcional (roda sozinha)
    if (!vazio && v.inicial.trim() !== "" && v.final.trim() !== "" && parseRate(v.final) < parseRate(v.inicial)) {
      toast({ title: "Leitura final menor que a inicial", variant: "destructive" });
      return;
    }
    odoMut.mutate({ sellerId: r.sellerId, mes: mesPagto, inicial: vazio ? null : v.inicial, final: vazio || v.final.trim() === "" ? null : v.final });
  };

  // Regiao/tarifa escolhida do vendedor e a tarifa efetiva (valor da referencia escolhida).
  const regionOf = (r: SellerRow): Region => regions[r.sellerId] ?? normRegion(r.region);
  const rateForRegion = (rg: Region) => (rg === "DF" ? rateDFNum : rg === "PSN" ? ratePSNNum : rateGONum);
  const rateOf = (r: SellerRow) => rateForRegion(regionOf(r));
  // Salva a escolha da linha (GO/DF/PSN) no servidor.
  const commitRegion = (r: SellerRow, rg: Region) => {
    if (!isAdmin) return;
    setRegions((m) => ({ ...m, [r.sellerId]: rg }));
    r.region = rg;
    regionMut.mutate({ sellerId: r.sellerId, region: rg });
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
  const valorSeller = (r: SellerRow) => kmPagto(r) * rateOf(r);

  // Aba "Km e pagamento por mes": HISTORICO FIXO, uma linha por vendedor e mes, com a
  // km que vale no pagamento (odometro quando o mes tem leitura; senao a calculada), a
  // tarifa da referencia atual do vendedor e o valor pago. Mes mais recente primeiro.
  const linhasMes = useMemo(() => {
    const out: Array<{ mes: string; sellerId: string; sellerName: string; km: number; calc: number; odo: boolean; region: Region; rate: number; valor: number }> = [];
    for (const r of rows) {
      for (const mo of months) {
        const calc = r.byMonth[mo] || 0;
        const o = r.odoByMonth?.[mo];
        const km = o ? o.km : calc;
        if (!km && !calc) continue;
        const rg = regionOf(r);
        const rate = rateForRegion(rg);
        out.push({ mes: mo, sellerId: r.sellerId, sellerName: r.sellerName, km, calc, odo: !!o, region: rg, rate, valor: km * rate });
      }
    }
    return out.sort((a, b) => (a.mes === b.mes ? b.valor - a.valor : b.mes.localeCompare(a.mes)));
  }, [rows, months, regions, rateGONum, rateDFNum, ratePSNNum]);

  // Tarifa R$/km de um vendedor da aba diaria (mesma referencia escolhida na aba mensal).
  const rateDoVendedor = (sellerId: string): number => {
    const r = sellers.find((x) => x.sellerId === sellerId);
    return r ? rateForRegion(regionOf(r)) : rateGONum;
  };
  const totalPagar = rows.reduce((s, r) => s + valorSeller(r), 0);

  // Exporta TODAS as colunas para .xlsx no padrao unico do INTEGRA
  // (lib/excelExport): km com separador de milhar, coluna Ref (GO/DF/PSN),
  // R$/km e R$ a pagar em moeda contabil, e linha de Total em negrito.
  function exportarExcel() {
    const meses = months;
    const headers = ["Vendedor", "Funcao", ...meses.map(fmtMes), "Odometro inicial", "Odometro final", `Km paga (${fmtMes(mesPagto)})`, "Fonte", "Ref", "R$/km", `R$ a pagar (${fmtMes(mesPagto)})`];
    const dataRows = rows.map((r) => [
      r.sellerName,
      r.role ? (ROLE_LABEL[r.role] || r.role) : "",
      ...meses.map((mo) => r.byMonth[mo] || 0),
      parseRate((odo[r.sellerId]?.inicial ?? "")) || null,
      parseRate((odo[r.sellerId]?.final ?? "")) || null,
      Number(kmPagto(r).toFixed(1)),
      fontePagto(r),
      REGION_LABEL[regionOf(r)],
      Number(rateOf(r).toFixed(2)),
      Number(valorSeller(r).toFixed(2)),
    ]);
    const totalRow: any[] = ["Total", "", ...meses.map(() => null), null, null, Number(rows.reduce((a, r) => a + kmPagto(r), 0).toFixed(1)), "", "", null, Number(totalPagar.toFixed(2))];
    // Padrao unico de planilha do INTEGRA: cabecalho congelado/negrito, larguras
    // ajustadas, R$ contabil, sem faixas nem bordas (fica a grade do Excel).
    const linhas = [...dataRows, totalRow].map((linha) =>
      Object.fromEntries(headers.map((h, i) => [h, linha[i]])) as Record<string, any>,
    );
    exportToExcel(linhas, `km-vendedores-${mesPagto || "geral"}`, {
      aba: "Km Vendedores",
      negritoUltimaLinha: true,
    });
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

      {/* Abas: Histórico mensal | Histórico por dia */}
      <div className="flex items-center gap-1 mb-3 border-b">
        {([["mensal", "Histórico mensal"], ["pagamento", "Km e pagamento por mês"], ["diario", "Mês vigente por dia"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setAba(id)}
            className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 ${aba === id ? "border-indigo-600 text-indigo-700" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {aba === "mensal" && (
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
            <p className="text-muted-foreground mt-2">O valor a pagar usa a tarifa da referencia escolhida na coluna de cada vendedor (GO, DF ou PSN). As tarifas GO, DF e PSN sao definidas no topo; a celula da linha so reflete o valor da escolha.</p>
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
                  <span className="text-xs font-semibold text-muted-foreground w-8">GO</span>
                  <span className="text-sm text-muted-foreground">R$</span>
                  <input type="text" inputMode="decimal" value={rateGO} disabled={!isAdmin} onChange={(e) => setRateGO(e.target.value)} placeholder="0,00" className="w-24 rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60" />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs font-semibold text-muted-foreground w-8">DF</span>
                  <span className="text-sm text-muted-foreground">R$</span>
                  <input type="text" inputMode="decimal" value={rateDF} disabled={!isAdmin} onChange={(e) => setRateDF(e.target.value)} placeholder="0,00" className="w-24 rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60" />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs font-semibold text-muted-foreground w-8" title="Tarifa personalizada">PSN</span>
                  <span className="text-sm text-muted-foreground">R$</span>
                  <input type="text" inputMode="decimal" value={ratePSN} disabled={!isAdmin} onChange={(e) => setRatePSN(e.target.value)} placeholder="0,00" className="w-24 rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60" />
                </div>
                {isAdmin ? (
                  <button onClick={() => saveRatesMut.mutate()} disabled={!ratesDirty || saveRatesMut.isPending} className="rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50">{saveRatesMut.isPending ? "Salvando..." : "Salvar"}</button>
                ) : null}
              </div>
              <div className="text-[11px] text-muted-foreground mt-1">{isAdmin ? "PSN = tarifa personalizada. Na coluna, escolha GO, DF ou PSN para cada vendedor; o valor pago segue a tarifa escolhida." : "Somente o admin pode alterar as tarifas."}</div>
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
                    <th className="text-center font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Odometro ({fmtMes(mesPagto)})</th>
                    <th className="text-center font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Tarifa de Referencia</th>
                    <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-green-700">R$ a pagar ({fmtMes(mesPagto)})</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={months.length + 4} className="text-center text-muted-foreground py-6 px-3">Nenhum vendedor encontrado.</td></tr>
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
                      <td className="py-2 px-3 whitespace-nowrap">
                        {isAdmin ? (
                          <div className="flex items-center justify-center gap-1">
                            <input type="number" inputMode="numeric" value={odo[r.sellerId]?.inicial ?? ""}
                              onChange={(e) => setOdo((m) => ({ ...m, [r.sellerId]: { inicial: e.target.value, final: m[r.sellerId]?.final ?? "" } }))}
                              onBlur={() => commitOdo(r)} placeholder={r.odoByMonth?.[mesPagto]?.inicialHerdada ? "herdada" : "inicial"}
                              className="w-24 rounded-md border bg-background px-2 py-1 text-sm text-right tabular-nums"
                              title={r.odoByMonth?.[mesPagto]?.inicialHerdada ? "Herdada da leitura final do mes anterior" : "Leitura do hodometro no inicio do mes"} />
                            <span className="text-muted-foreground">-</span>
                            <input type="number" inputMode="numeric" value={odo[r.sellerId]?.final ?? ""}
                              onChange={(e) => setOdo((m) => ({ ...m, [r.sellerId]: { inicial: m[r.sellerId]?.inicial ?? "", final: e.target.value } }))}
                              onBlur={() => commitOdo(r)} placeholder={r.odoByMonth?.[mesPagto] ? fmtKm(r.odoByMonth[mesPagto].finalAuto) : "final"}
                              className="w-24 rounded-md border bg-background px-2 py-1 text-sm text-right tabular-nums"
                              title="Leitura final do carro (opcional). Em branco, o sistema roda a final sozinho: inicial + km do mes." />
                          </div>
                        ) : (
                          <div className="text-center text-sm tabular-nums">{odoKm(r) !== null ? fmtKm(odoKm(r) as number) : <span className="text-gray-300">-</span>}</div>
                        )}
                        <div className="text-[11px] text-center text-muted-foreground mt-1">
                          {odoKm(r) !== null
                            ? `${fmtKm(odoKm(r) as number)} km${r.odoByMonth?.[mesPagto]?.automatica ? " · final automatica" : " · final informada"}${r.odoByMonth?.[mesPagto]?.inicialHerdada ? " · inicial herdada" : ""}`
                            : "sem leitura inicial - usa o calculado"}
                        </div>
                      </td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <div className="flex items-center justify-center gap-2">
                          {isAdmin ? (
                            <select
                              value={regionOf(r)}
                              onChange={(e) => commitRegion(r, normRegion(e.target.value))}
                              className="rounded-md border bg-background px-2 py-1 text-sm font-semibold"
                              title="Escolha a tarifa de referencia deste vendedor"
                            >
                              <option value="GO">GO</option>
                              <option value="DF">DF</option>
                              <option value="PSN">PSN</option>
                            </select>
                          ) : (
                            <span className="text-sm font-semibold">{REGION_LABEL[regionOf(r)]}</span>
                          )}
                          <span className="text-sm tabular-nums text-muted-foreground min-w-[64px] text-right" title="Valor da tarifa escolhida (nao editavel)">{fmtBRL(rateOf(r))}</span>
                        </div>
                      </td>
                      <td className={`py-2 px-3 text-right tabular-nums font-bold whitespace-nowrap ${mesFechado ? "text-green-700" : "text-amber-700"}`} title={`${fmtKm(kmPagto(r))} km (${fontePagto(r)}) x ${fmtBRL(rateOf(r))}/km (${REGION_LABEL[regionOf(r)]})`}>{fmtBRL(valorSeller(r))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 bg-muted/30 font-bold">
                    <td className="py-2 px-3 bg-muted/30 sticky left-0">Total ({rows.length})</td>
                    {months.map((mo) => (
                      <td key={mo} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{fmtKm(totalPorMes[mo] || 0)}</td>
                    ))}
                    <td className="py-2 px-3 text-center tabular-nums whitespace-nowrap">{fmtKm(rows.reduce((a, r) => a + kmPagto(r), 0))}</td>
                    <td className="py-2 px-3 text-center tabular-nums text-muted-foreground">-</td>
                    <td className={`py-2 px-3 text-right tabular-nums ${mesFechado ? "text-green-700" : "text-amber-700"}`}>{fmtBRL(totalPagar)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground mt-2">Valores em quilometros (km). Quando o odometro do mes esta preenchido (leitura inicial e final do carro), a km paga e a diferenca entre as duas leituras; sem leitura, vale a km calculada por check-in. A leitura INICIAL abre a marcacao do mes e e informada na mao; a FINAL roda sozinha (inicial + km do mes pelas regras de check-in), entao fim de semana e uso pessoal do carro nao entram. Informar a final na mao (conferencia com o painel do carro) sobrepoe a automatica. A final de um mes vale como inicial do mes seguinte ate voce informar uma nova. "R$ a pagar" = km paga do mes de {fmtMes(mesPagto)} x a tarifa da referencia escolhida do vendedor (GO, DF ou PSN). O valor so e definitivo no ultimo dia do mes apos as 20h (horario de Brasilia); antes disso e uma previa e pode mudar conforme novas rotas do mes. Passe o mouse na celula para ver o calculo.</div>
        </CardContent>
      </Card>
      )}

      {aba === "pagamento" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><DollarSign className="w-4 h-4" /> Km e pagamento por mês</CardTitle>
            <div className="text-xs text-muted-foreground mt-1">Histórico fixo: uma linha por vendedor e mês, com a km que vale no pagamento, a origem do número (odômetro ou calculado) e o valor pago.</div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-6">Carregando...</div>
            ) : linhasMes.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6">Nenhuma rota com quilometragem registrada ainda.</div>
            ) : (
              <>
                <div className="overflow-auto max-h-[70vh] rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10">
                      <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="text-left font-bold py-2 px-3 bg-background border-b">Mês</th>
                        <th className="text-left font-bold py-2 px-3 bg-background border-b">Vendedor</th>
                        <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Km rodada</th>
                        <th className="text-center font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Origem</th>
                        <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Km calculada</th>
                        <th className="text-center font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Ref</th>
                        <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">R$/km</th>
                        <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-green-700">Valor pago</th>
                      </tr>
                    </thead>
                    <tbody>
                      {linhasMes.map((l) => (
                        <tr key={l.mes + l.sellerId} className="border-t hover:bg-muted/40">
                          <td className="py-2 px-3 whitespace-nowrap font-medium">{fmtMes(l.mes)}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{l.sellerName}</td>
                          <td className="py-2 px-3 text-right tabular-nums font-semibold">{fmtKm(l.km)}</td>
                          <td className="py-2 px-3 text-center text-[11px] whitespace-nowrap">
                            <span className={`px-2 py-0.5 rounded-full border ${l.odo ? "text-emerald-700 border-emerald-200 bg-emerald-50" : "text-slate-600 border-slate-200 bg-slate-50"}`}>{l.odo ? "odômetro" : "calculado"}</span>
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{fmtKm(l.calc)}</td>
                          <td className="py-2 px-3 text-center font-semibold">{REGION_LABEL[l.region]}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{fmtBRL(l.rate)}</td>
                          <td className="py-2 px-3 text-right tabular-nums font-bold text-green-700">{fmtBRL(l.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 bg-muted/30 font-bold">
                        <td className="py-2 px-3" colSpan={2}>Total ({linhasMes.length} linha(s))</td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtKm(linhasMes.reduce((a, l) => a + l.km, 0))}</td>
                        <td className="py-2 px-3"></td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtKm(linhasMes.reduce((a, l) => a + l.calc, 0))}</td>
                        <td className="py-2 px-3" colSpan={2}></td>
                        <td className="py-2 px-3 text-right tabular-nums text-green-700">{fmtBRL(linhasMes.reduce((a, l) => a + l.valor, 0))}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="text-[11px] text-muted-foreground mt-2">"Km rodada" é o que vale no pagamento: a leitura do odômetro quando o mês tem leitura, senão a km calculada por check-in. A tarifa é a referência atual do vendedor (GO, DF ou PSN), então trocar a referência recalcula todos os meses desta tela. A busca por nome do topo também filtra aqui.</div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {aba === "diario" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><RouteIcon className="w-4 h-4" /> Mês vigente por dia</CardTitle>
            <div className="text-xs text-muted-foreground mt-1">A marcação diária mostra <b>apenas o mês vigente</b> e recomeça a cada virada de mês. O quadro do odômetro, logo abaixo, guarda o histórico fixo de todos os meses. Só vendedores externos ativos; escolha o vendedor nas abas abaixo.</div>
          </CardHeader>
          <CardContent>
            {diarioLoading ? (
              <div className="text-sm text-muted-foreground py-6">Carregando...</div>
            ) : diarioSellers.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6">Nenhuma rota com quilometragem registrada ainda.</div>
            ) : (
              <>
                <div className="flex gap-1 overflow-x-auto pb-2 mb-3 border-b">
                  {diarioSellers.map((s) => (
                    <button
                      key={s.sellerId}
                      type="button"
                      onClick={() => setDiarioSeller(s.sellerId)}
                      className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-semibold border ${selDiario?.sellerId === s.sellerId ? "bg-indigo-600 border-indigo-600 text-white" : "bg-background border-gray-200 text-muted-foreground hover:text-foreground"}`}
                    >
                      {s.sellerName}
                    </button>
                  ))}
                </div>
                {selDiario && Object.keys(selDiario.odoByMonth || {}).length > 0 && (
                  <div className="mb-4 rounded-lg border overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="text-left font-bold py-2 px-3 bg-background border-b">Odômetro · mês</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Leitura inicial</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Leitura final</th>
                          <th className="text-center font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Origem</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Km odômetro</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Km calculada</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Diferença</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.keys(selDiario.odoByMonth || {}).sort().map((mo) => {
                          const o = (selDiario.odoByMonth || {})[mo];
                          const calc = (selDiario.calcByMonth || {})[mo] || 0;
                          const dif = Math.round((o.km - calc) * 10) / 10;
                          return (
                            <tr key={mo} className="border-t hover:bg-muted/40">
                              <td className="py-2 px-3 whitespace-nowrap font-medium">{fmtMes(mo)}</td>
                              <td className="py-2 px-3 text-right tabular-nums" title={o.inicialHerdada ? "Herdada da leitura final do mes anterior" : "Leitura informada"}>
                                {fmtKm(o.inicial)}{o.inicialHerdada ? <span className="text-[11px] text-muted-foreground"> (herdada)</span> : null}
                              </td>
                              <td className="py-2 px-3 text-right tabular-nums">{fmtKm(o.final)}</td>
                              <td className="py-2 px-3 text-center text-[11px] whitespace-nowrap">
                                <span className={`px-2 py-0.5 rounded-full border ${o.automatica ? "text-indigo-700 border-indigo-200 bg-indigo-50" : "text-emerald-700 border-emerald-200 bg-emerald-50"}`}>{o.automatica ? "automatica" : "informada"}</span>
                              </td>
                              <td className="py-2 px-3 text-right tabular-nums font-bold">{fmtKm(o.km)}</td>
                              <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">{fmtKm(calc)}</td>
                              <td className={`py-2 px-3 text-right tabular-nums ${dif > 0 ? "text-amber-700" : dif < 0 ? "text-rose-700" : "text-muted-foreground"}`} title="Km do odometro menos a km calculada por check-in">
                                {dif > 0 ? "+" : ""}{fmtKm(dif)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {selDiario && (
                  <div className="overflow-auto max-h-[65vh] rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10">
                        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className="text-left font-bold py-2 px-3 bg-background border-b">Dia</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Normal · dia</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-amber-700">Intermunicipal · dia</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-violet-700">Prospecção</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b">Total</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap">Odômetro no fim do dia</th>
                          <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-green-700">R$ a pagar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selDiario.dias.length === 0 ? (
                          <tr><td colSpan={7} className="text-center text-muted-foreground py-6 px-3">Sem dias com km no mês vigente.</td></tr>
                        ) : selDiario.dias.map((d) => {
                          const mo = d.dia.slice(0, 7);
                          const o = (selDiario.odoByMonth || {})[mo];
                          // Odometro ao fim do dia = inicial do mes + km dos dias do mes ate aqui.
                          const doMes = selDiario.dias.filter((x) => x.dia.slice(0, 7) === mo);
                          const ateAqui = doMes.filter((x) => x.dia <= d.dia).reduce((a, x) => a + x.total, 0);
                          const odoDia = o ? Math.round((o.inicial + ateAqui) * 10) / 10 : null;
                          // Valor do dia = km do dia x a tarifa da referencia do vendedor.
                          const valorDia = d.total * rateDoVendedor(selDiario.sellerId);
                          return (
                          <tr key={d.dia} className="border-t hover:bg-muted/40">
                            <td className="py-2 px-3 whitespace-nowrap font-medium">{fmtDia(d.dia)}</td>
                            <td className="py-2 px-3 text-right tabular-nums">{d.normal ? fmtKm(d.normal) : <span className="text-gray-300">-</span>}</td>
                            <td className="py-2 px-3 text-right tabular-nums text-amber-700">{d.intermunicipal ? fmtKm(d.intermunicipal) : <span className="text-gray-300">-</span>}</td>
                            <td className="py-2 px-3 text-right tabular-nums text-violet-700">{d.prospeccao ? fmtKm(d.prospeccao) : <span className="text-gray-300">-</span>}</td>
                            <td className="py-2 px-3 text-right tabular-nums font-bold">{fmtKm(d.total)}</td>
                            <td className="py-2 px-3 text-right tabular-nums text-muted-foreground" title={odoDia !== null ? "Leitura inicial do mes + a km dos dias ate este" : "Sem leitura inicial no mes"}>
                              {odoDia !== null ? fmtKm(odoDia) : <span className="text-gray-300">-</span>}
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums font-semibold text-green-700" title="Km do dia x a tarifa da referencia do vendedor">{fmtBRL(valorDia)}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 bg-muted/30 font-bold">
                          <td className="py-2 px-3 whitespace-nowrap">Total ({selDiario.dias.length} dia(s))</td>
                          <td className="py-2 px-3 text-right tabular-nums">{fmtKm(selDiario.totalNormal)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-amber-700">{fmtKm(selDiario.totalInter)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-violet-700">{fmtKm(selDiario.totalProsp)}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{fmtKm(selDiario.total)}</td>
                          <td className="py-2 px-3 text-right tabular-nums text-muted-foreground">-</td>
                          <td className="py-2 px-3 text-right tabular-nums text-green-700">{fmtBRL(selDiario.total * rateDoVendedor(selDiario.sellerId))}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground mt-2">O quadro do odômetro mostra as leituras do mês. A inicial é informada na mão e a final roda sozinha, somando a km de cada dia de rota; quando você informa a final na mão, ela é marcada como "informada" e passa a valer. A coluna "Odômetro no fim do dia" mostra a marcação acumulada dia a dia, e "R$ a pagar" é a km do dia pela tarifa do vendedor (prévia: o que vale no fechamento é a km do mês). "Intermunicipal · dia" conta do portão de saída da cidade → pontos fora → casa. "Normal · dia" é o restante (trecho urbano). A soma dos três = km total do dia. Os valores de Intermunicipal aparecem conforme as rotas são recalculadas.</div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
