// client/src/components/Termometro.tsx
// Termômetro de Alcance do Dia por vendedor. Consome GET /api/dashboard2/termometro.
// Potencial = clientes da carteira com padrão de compra no dia da semana de hoje
// (periodicidade + ticket médio ponderado por recência, NF-e de venda). Realizado =
// faturamento de hoje da carteira. Compartilhável como imagem (WhatsApp).
import { useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelect } from "@/lib/tableTools";

type Row = { seller: string; potencial: number; realizado: number; pct: number | null; expected: number; bought: number; clientes?: { nome: string; potencial: number; comprou: boolean; hoje: number; ultValor: number; ultData: string }[] };
type Resp = { asOf: string; weekday: number; periodicidades?: string[]; sellers: Row[] };

const DOWLBL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function brl(n: number): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function colorFor(pct: number | null): string {
  if (pct == null) return "#9ca3af";
  if (pct >= 90) return "#16a34a";
  if (pct >= 60) return "#f59e0b";
  return "#dc2626";
}
function statusFor(pct: number | null): string {
  if (pct == null) return "Sem meta hoje";
  if (pct >= 90) return "No alvo";
  if (pct >= 60) return "Chegando";
  return "Abaixo";
}
function emojiFor(pct: number | null): string {
  if (pct == null) return "";
  if (pct >= 90) return "🟢";
  if (pct >= 60) return "🟡";
  return "🔴";
}
function pctLabel(pct: number | null): string {
  return pct == null ? "s/ meta" : pct + "%";
}
function fmtDate(iso: string): string {
  return iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "";
}

// Termômetro vertical (SVG) para a tela.
function ThermoSVG({ pct }: { pct: number | null }) {
  const c = colorFor(pct);
  const H = 96; // altura útil da coluna
  const p = pct == null ? 0 : Math.min(pct, 100);
  const fill = Math.max(4, Math.round((p / 100) * H));
  const top = 12 + (H - fill);
  return (
    <svg width="46" height="150" viewBox="0 0 46 150" aria-hidden="true">
      <rect x="16" y="8" width="14" height={H + 8} rx="7" fill="#e5e7eb" />
      <rect x="16" y={top} width="14" height={fill} rx="7" fill={c} />
      <circle cx="23" cy="128" r="15" fill={c} />
      <rect x="18" y="112" width="10" height="18" fill={c} />
      <circle cx="23" cy="128" r="7" fill="#ffffff" opacity="0.35" />
    </svg>
  );
}

function buildShareSVG(rows: Row[], weekdayLabel: string, dateLbl: string): { svg: string; w: number; h: number } {
  const w = 760;
  const rowH = 52;
  const top = 104;
  const h = top + Math.max(1, rows.length) * rowH + 44;
  const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts: string[] = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">');
  parts.push('<rect width="' + w + '" height="' + h + '" fill="#ffffff"/>');
  parts.push('<rect x="0" y="0" width="' + w + '" height="72" fill="#0f172a"/>');
  parts.push('<text x="28" y="34" fill="#ffffff" font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="700">Termômetro de Alcance</text>');
  parts.push('<text x="28" y="58" fill="#93c5fd" font-family="Arial,Helvetica,sans-serif" font-size="15">' + esc(weekdayLabel) + " · " + esc(dateLbl) + "</text>");
  parts.push('<text x="' + (w - 28) + '" y="94" text-anchor="end" fill="#64748b" font-family="Arial,Helvetica,sans-serif" font-size="12">realizado / potencial do dia</text>');
  const barX = 250, barW = 340;
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const c = colorFor(r.pct);
    const fillW = r.pct == null ? 0 : Math.round((Math.min(r.pct, 100) / 100) * barW);
    parts.push('<text x="28" y="' + (y + 18) + '" fill="#0f172a" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="600">' + esc(r.seller) + "</text>");
    parts.push('<text x="28" y="' + (y + 37) + '" fill="#64748b" font-family="Arial,Helvetica,sans-serif" font-size="11">' + r.bought + "/" + r.expected + " clientes</text>");
    parts.push('<rect x="' + barX + '" y="' + (y + 8) + '" width="' + barW + '" height="18" rx="9" fill="#e5e7eb"/>');
    parts.push('<rect x="' + barX + '" y="' + (y + 8) + '" width="' + fillW + '" height="18" rx="9" fill="' + c + '"/>');
    parts.push('<text x="' + (barX + barW + 12) + '" y="' + (y + 22) + '" fill="' + c + '" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="700">' + pctLabel(r.pct) + "</text>");
    parts.push('<text x="' + (w - 28) + '" y="' + (y + 40) + '" text-anchor="end" fill="#475569" font-family="Arial,Helvetica,sans-serif" font-size="12">' + esc(brl(r.realizado)) + " / " + esc(brl(r.potencial)) + "</text>");
  });
  parts.push('<text x="28" y="' + (h - 16) + '" fill="#94a3b8" font-family="Arial,Helvetica,sans-serif" font-size="11">Integra 2.0 · potencial por carteira (periodicidade + dia de rota)</text>');
  parts.push("</svg>");
  return { svg: parts.join(""), w, h };
}

function svgToPng(svg: string, w: number, h: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * 2; c.height = h * 2;
      const ctx = c.getContext("2d");
      if (!ctx) { reject(new Error("sem canvas")); return; }
      ctx.scale(2, 2);
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("sem blob"))), "image/png");
    };
    img.onerror = () => reject(new Error("falha ao renderizar"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

function buildText(rows: Row[], weekdayLabel: string, dateLbl: string): string {
  const head = "*Termômetro de Alcance* — " + weekdayLabel + " " + dateLbl;
  const lines = rows.map((r) => emojiFor(r.pct) + " " + r.seller + ": " + pctLabel(r.pct) + " (" + brl(r.realizado) + " / " + brl(r.potencial) + ")");
  return head + "\n" + lines.join("\n");
}

export default function Termometro() {
  const [fPer, setFPer] = useState<string[]>([]);
  const qs = fPer.length ? "?per=" + encodeURIComponent(fPer.join(",")) : "";
  const { data, isLoading } = useQuery<Resp>({ queryKey: ["/api/dashboard2/termometro" + qs] });
  const rows: Row[] = (data && data.sellers) || [];
  const pers: string[] = (data && data.periodicidades) || [];
  const asOf = (data && data.asOf) || "";
  const wd = data && typeof data.weekday === "number" ? data.weekday : new Date().getDay();
  const weekdayLabel = DOWLBL[wd] || "";
  const dateLbl = fmtDate(asOf);
  const [sharing, setSharing] = useState(false);
  const [openMap, setOpen] = useState<Record<string, boolean>>({});
  const [showInfo, setShowInfo] = useState(false);

  async function share() {
    if (!rows.length) return;
    setSharing(true);
    try {
      const built = buildShareSVG(rows, weekdayLabel, dateLbl);
      const blob = await svgToPng(built.svg, built.w, built.h);
      const file = new File([blob], "termometro_" + (asOf || "hoje") + ".png", { type: "image/png" });
      const text = buildText(rows, weekdayLabel, dateLbl);
      const nav: any = navigator;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: "Termômetro de Alcance", text });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank");
      }
    } catch (e: any) {
      alert("Não foi possível gerar a imagem: " + ((e && e.message) || e));
    } finally {
      setSharing(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <span>Termômetro de Alcance — {weekdayLabel}</span>
            <button type="button" onClick={() => setShowInfo((v) => !v)} className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-400 text-gray-500 text-[10px] font-bold leading-none hover:bg-gray-100" title="Como ler o termômetro" aria-label="Como ler o termômetro">i</button>
          </CardTitle>
          <div className="text-xs text-gray-500 mt-1">
            Realizado de hoje x potencial médio dos clientes da carteira com rota/compra em {weekdayLabel.toLowerCase()} ({dateLbl}).
          </div>
          {showInfo && (
            <div className="mt-2 text-[11px] text-gray-700 bg-blue-50 border border-blue-100 rounded-md p-2 leading-snug max-w-xl">
              <b>Como ler:</b> cada card é um vendedor. O termômetro mostra <b>quanto do potencial de hoje já foi realizado</b>.<br />
              • <b>Potencial</b> = soma do ticket médio dos clientes da carteira que costumam comprar <b>neste dia da semana</b>, dentro da periodicidade de cada um.<br />
              • <b>Realizado</b> = quanto esses mesmos clientes previstos já compraram hoje.<br />
              • <b>%</b> = realizado ÷ potencial. 🟢 ≥90% no alvo · 🟡 60–89% chegando · 🔴 abaixo de 60% · cinza = sem clientes previstos hoje.<br />
              • <b>x/y clientes</b> = quantos dos previstos para hoje já compraram.
            </div>
          )}
          {pers.length > 0 && (
            <div className="mt-3">
              <MultiSelect label="Periodicidade" options={pers} selected={fPer} onChange={setFPer} />
            </div>
          )}
        </div>
        <button
          onClick={share}
          disabled={sharing || !rows.length}
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
        >
          {sharing ? "Gerando..." : "Compartilhar no WhatsApp"}
        </button>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-gray-500 py-8 text-center">Carregando...</div>}
        {!isLoading && !rows.length && (
          <div className="text-sm text-gray-500 py-8 text-center">Nenhum cliente previsto para hoje.</div>
        )}
        {!isLoading && rows.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 items-start">
            {rows.map((r) => (
              <div key={r.seller} className="flex flex-col items-center rounded-xl border border-gray-200 bg-white p-3">
                <div className="text-sm font-semibold text-gray-800 text-center truncate w-full" title={r.seller}>{r.seller}</div>
                <ThermoSVG pct={r.pct} />
                <div className="text-lg font-bold" style={{ color: colorFor(r.pct) }}>{r.pct == null ? "-" : r.pct + "%"}</div>
                <div className="text-[11px] font-medium mb-1" style={{ color: colorFor(r.pct) }}>{statusFor(r.pct)}</div>
                <div className="text-[11px] text-gray-600 text-center leading-tight">
                  {brl(r.realizado)}<span className="text-gray-600"> / {brl(r.potencial)}</span>
                </div>
                <div className="text-[10px] text-gray-700 mt-0.5">{r.bought}/{r.expected} clientes</div>
                {r.clientes && r.clientes.length > 0 && (
                  <button type="button" onClick={() => setOpen((o) => ({ ...o, [r.seller]: !o[r.seller] }))} className="mt-2 text-[11px] text-indigo-600 hover:underline">
                    {openMap[r.seller] ? "Ocultar clientes" : "Ver clientes (" + r.clientes.length + ")"}
                  </button>
                )}
                {openMap[r.seller] && r.clientes && (
                  <div className="mt-2 w-full border-t border-gray-100 pt-2 space-y-1 text-left">
                    {[...r.clientes].sort((a, b) => (a.comprou === b.comprou ? b.potencial - a.potencial : a.comprou ? 1 : -1)).map((cl, ci) => (
                      <div key={ci} className="text-[10px] border-b border-gray-50 pb-1">
                        <div className="flex items-start justify-between gap-1">
                          <span className="truncate text-gray-900 flex-1" title={cl.nome}>{cl.nome}</span>
                          <span className={cl.comprou ? "text-emerald-600 font-medium whitespace-nowrap" : "text-red-500 whitespace-nowrap"}>{cl.comprou ? "hoje " + brl(cl.hoje) : "ainda não comprou"}</span>
                        </div>
                        <div className="text-gray-500">última: {cl.ultValor > 0 ? brl(cl.ultValor) + " em " + cl.ultData.slice(8, 10) + "/" + cl.ultData.slice(5, 7) : "-"}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
