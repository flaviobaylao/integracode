// ============================================================================
// INTEGRA 2.0 — KILOMETRAGEM VENDEDORES (Ago/2026)
// Modulo de Administracao: historico de KM MENSAL de todos os vendedores que
// tem Rota do Dia. Fonte: soma de daily_routes.total_actual_distance por
// vendedor e por mes (km realizada). Enquanto o rastreamento GPS nao entra em
// producao, a km e a estimativa por check-in + rota por ruas (OSRM).
//
// Pagamento por km: tarifa R$/km editavel (global, admin), persistida em
// config_global. O valor a pagar = km do mes x tarifa. O mes so e considerado
// FECHADO (valor a pagar definitivo) no ultimo dia do mes apos as 20h (SP).
// Endpoints: GET /api/admin/km-vendedores | POST /api/admin/km-vendedores/rate
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { usePermissions } from "@/lib/permissions";
import { useToast } from "@/hooks/use-toast";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Route as RouteIcon, Search, DollarSign, Download, Send } from "lucide-react";
import { exportToExcel } from "@/lib/tableTools";

type SellerRow = {
  sellerId: string;
  sellerName: string;
  role: string | null;
  byMonth: Record<string, number>;
  diasByMonth: Record<string, number>;
  total: number;
  totalDias: number;
};
type Resp = { months: string[]; sellers: SellerRow[]; geradoEm?: string; ratePerKm?: number; mesAtual?: string; mesFechado?: boolean };

const MES_LABEL: Record<string, string> = { "01": "jan", "02": "fev", "03": "mar", "04": "abr", "05": "mai", "06": "jun", "07": "jul", "08": "ago", "09": "set", "10": "out", "11": "nov", "12": "dez" };
function fmtMes(iso: string): string { const [y, m] = iso.split("-"); return `${MES_LABEL[m] || m}/${(y || "").slice(2)}`; }
function fmtKm(n: number): string { return (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function fmtBRL(n: number): string { return (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }
function ultimoDiaDoMes(iso: string): number { if (!iso) return 0; const [y, m] = iso.split("-").map(Number); return new Date(y, m, 0).getDate(); }

const ROLE_LABEL: Record<string, string> = { vendedor: "Vendedor", telemarketing: "Telemarketing", coordinator: "Coordenacao", administrative: "Administrativo", admin: "Admin", motorista: "Motorista", industria: "Industria" };

export default function KmVendedores() {
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const { toast } = useToast();
  const [busca, setBusca] = useState<string>("");
  const [rate, setRate] = useState<string>("");
  const [rateLoaded, setRateLoaded] = useState<boolean>(false);

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
  const savedRate = Number(data?.ratePerKm || 0);

  useEffect(() => { if (data && !rateLoaded) { setRate(String(data.ratePerKm ?? 0)); setRateLoaded(true); } }, [data, rateLoaded]);

  const rateNum = (() => { const n = parseFloat((rate || "").replace(",", ".")); return isFinite(n) && n >= 0 ? n : 0; })();
  const dirty = rateLoaded && rateNum !== savedRate;

  const saveMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/km-vendedores/rate", { ratePerKm: rateNum }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/km-vendedores"] }); toast({ title: "Valor por km salvo", description: `${fmtBRL(rateNum)} por km.` }); },
    onError: () => toast({ title: "Erro ao salvar o valor por km", variant: "destructive" }),
  });

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
  const valorSeller = (r: SellerRow) => (r.byMonth[mesPagto] || 0) * rateNum;
  const totalPagar = rows.reduce((s, r) => s + valorSeller(r), 0);

  // Exporta TODAS as colunas visiveis (Vendedor, Funcao, meses 2026, R$ a pagar) para .xlsx.
  function exportarExcel() {
    const linhas = rows.map((r) => {
      const o: Record<string, any> = { Vendedor: r.sellerName, "Funcao": r.role ? (ROLE_LABEL[r.role] || r.role) : "" };
      for (const mo of months) o[fmtMes(mo)] = r.byMonth[mo] || 0;
      o[`R$ a pagar (${fmtMes(mesPagto)})`] = Number(valorSeller(r).toFixed(2));
      return o;
    });
    exportToExcel(linhas, `km-vendedores-${mesPagto || "geral"}`);
  }

  // Gera uma imagem PNG (canvas) da tabela compacta, com as colunas centralizadas.
  function gerarImagemTabela(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      try {
        const escala = 2;
        const pad = 16;
        const colW = [200, 110, 130];
        const tabelaW = colW.reduce((a, b) => a + b, 0);
        const W = tabelaW + pad * 2;
        const tituloH = 74;
        const headH = 34;
        const rowH = 30;
        const linhas = rows;
        const H = tituloH + headH + (linhas.length + 1) * rowH + pad;
        const canvas = document.createElement("canvas");
        canvas.width = W * escala; canvas.height = H * escala;
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.scale(escala, escala);
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillStyle = "#4f46e5"; ctx.font = "bold 17px Arial";
        ctx.fillText("Kilometragem - Valor a pagar", pad, 22);
        ctx.fillStyle = "#111827"; ctx.font = "12px Arial";
        ctx.fillText(`Mes ${fmtMes(mesPagto)}   |   R$/km: ${fmtBRL(rateNum)}`, pad, 44);
        ctx.fillStyle = mesFechado ? "#047857" : "#b45309"; ctx.font = "bold 11px Arial";
        ctx.fillText(mesFechado ? "FECHADO (valor definitivo)" : "PREVIA (fecha no ultimo dia as 20h)", pad, 61);
        let y = tituloH;
        ctx.fillStyle = "#4f46e5"; ctx.fillRect(pad, y, tabelaW, headH);
        ctx.fillStyle = "#ffffff"; ctx.font = "bold 12px Arial"; ctx.textAlign = "center";
        const heads = ["Vendedor", `Km ${fmtMes(mesPagto)}`, "R$ a pagar"];
        let cx = pad;
        for (let i = 0; i < 3; i++) { ctx.fillText(heads[i], cx + colW[i] / 2, y + headH / 2); cx += colW[i]; }
        y += headH;
        const desenharLinha = (cells: string[], bold: boolean, bg: string) => {
          ctx.fillStyle = bg; ctx.fillRect(pad, y, tabelaW, rowH);
          ctx.textAlign = "center";
          let cx2 = pad;
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = i === 2 ? (mesFechado ? "#047857" : "#b45309") : "#111827";
            ctx.font = (bold || i === 2) ? "bold 12px Arial" : "12px Arial";
            let txt = cells[i];
            const maxW = colW[i] - 10;
            while (ctx.measureText(txt).width > maxW && txt.length > 1) txt = txt.slice(0, -2) + "...";
            ctx.fillText(txt, cx2 + colW[i] / 2, y + rowH / 2);
            cx2 += colW[i];
          }
          y += rowH;
        };
        linhas.forEach((r, idx) => desenharLinha([r.sellerName, fmtKm(r.byMonth[mesPagto] || 0), fmtBRL(valorSeller(r))], false, idx % 2 ? "#f3f4f6" : "#ffffff"));
        desenharLinha(["Total", fmtKm(linhas.reduce((s, r) => s + (r.byMonth[mesPagto] || 0), 0)), fmtBRL(totalPagar)], true, "#eef2ff");
        ctx.strokeStyle = "#e5e7eb"; ctx.strokeRect(pad, tituloH, tabelaW, headH + (linhas.length + 1) * rowH);
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("toBlob null")), "image/png");
      } catch (e) { reject(e); }
    });
  }

  // Envia por WhatsApp: gera a imagem, copia para a area de transferencia (ou baixa como
  // alternativa) e abre o WhatsApp Web para colar (Ctrl+V) na conversa.
  async function enviarWhatsapp() {
    try {
      const blob = await gerarImagemTabela();
      let copiado = false;
      try {
        const CI = (window as any).ClipboardItem;
        if (navigator.clipboard && CI) {
          await navigator.clipboard.write([new CI({ "image/png": blob })]);
          copiado = true;
        }
      } catch (e) { copiado = false; }
      if (!copiado) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `km-a-pagar-${mesPagto || "geral"}.png`;
        document.body.appendChild(a); a.click(); a.remove();
      }
      window.open("https://web.whatsapp.com/", "_blank");
      toast({
        title: copiado ? "Imagem copiada" : "Imagem baixada",
        description: copiado ? "No WhatsApp Web, abra a conversa e cole com Ctrl+V." : "Anexe a imagem baixada na conversa do WhatsApp.",
      });
    } catch (e) {
      console.error("enviarWhatsapp:", e);
      alert("Falha ao gerar a imagem.");
    }
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><RouteIcon className="w-4 h-4" /> Historico mensal por vendedor</CardTitle>
          <div className="text-xs text-muted-foreground mt-1">Soma da km executada em cada mes. Hoje a km e medida pelos check-ins + rota por ruas (OSRM); passara a refletir o trajeto GPS quando o rastreamento continuo entrar no ar.</div>

          <div className="flex flex-col sm:flex-row sm:items-end gap-3 mt-3">
            <div className="sm:w-64">
              <label className="block text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1 flex items-center gap-1"><DollarSign className="w-3 h-3" /> Valor pago por km (R$)</label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">R$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={rate}
                  disabled={!isAdmin}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="0,00"
                  className="w-28 rounded-lg border bg-background px-3 py-2 text-sm disabled:opacity-60"
                />
                <span className="text-sm text-muted-foreground">/ km</span>
                {isAdmin ? (
                  <button
                    onClick={() => saveMut.mutate()}
                    disabled={!dirty || saveMut.isPending}
                    className="rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-semibold disabled:opacity-50"
                  >{saveMut.isPending ? "Salvando..." : "Salvar"}</button>
                ) : null}
              </div>
              {!isAdmin ? <div className="text-[11px] text-muted-foreground mt-1">Somente o admin pode alterar o valor por km.</div> : null}
            </div>

            <div className="flex-1">
              <div className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ${mesFechado ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                {mesFechado
                  ? `Mes ${fmtMes(mesPagto)} FECHADO — valor a pagar definitivo.`
                  : `Previa de ${fmtMes(mesPagto)} — fecha em ${ultimoDiaDoMes(mesPagto)}/${mesPagto.split("-")[1]} as 20h.`}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button type="button" onClick={enviarWhatsapp} className="inline-flex items-center gap-1 px-3 py-2 border rounded-md text-sm bg-green-600 text-white hover:bg-green-700"><Send className="w-4 h-4" /> Enviar por WhatsApp</button>
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
                    <th className="text-right font-bold py-2 px-3 bg-background border-b whitespace-nowrap text-green-700">R$ a pagar ({fmtMes(mesPagto)})</th>
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
                        <td key={mo} className={`py-2 px-3 text-right tabular-nums whitespace-nowrap ${mo === mesAtualCol ? "font-semibold" : ""}`} title={r.diasByMonth[mo] ? `${r.diasByMonth[mo]} dia(s) com rota` : ""}>
                          {r.byMonth[mo] ? fmtKm(r.byMonth[mo]) : <span className="text-gray-300">-</span>}
                        </td>
                      ))}
                      <td className={`py-2 px-3 text-right tabular-nums font-bold whitespace-nowrap ${mesFechado ? "text-green-700" : "text-amber-700"}`} title={`${fmtKm(r.byMonth[mesPagto] || 0)} km x ${fmtBRL(rateNum)}/km`}>{fmtBRL(valorSeller(r))}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 bg-muted/30 font-bold">
                    <td className="py-2 px-3 bg-muted/30 sticky left-0">Total ({rows.length})</td>
                    {months.map((mo) => (
                      <td key={mo} className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{fmtKm(totalPorMes[mo] || 0)}</td>
                    ))}
                    <td className={`py-2 px-3 text-right tabular-nums ${mesFechado ? "text-green-700" : "text-amber-700"}`}>{fmtBRL(totalPagar)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground mt-2">Valores em quilometros (km). "R$ a pagar" = km do mes de {fmtMes(mesPagto)} x {fmtBRL(rateNum)}/km. O valor so e definitivo no ultimo dia do mes apos as 20h (horario de Brasilia); antes disso e uma previa e pode mudar conforme novas rotas do mes. Passe o mouse na celula para ver o calculo.</div>
        </CardContent>
      </Card>
    </div>
  );
}
