// client/src/components/CampanhaOutubro.tsx
// Aba "Campanha de Outubro": planejamento (premissas + regras do novo cliente),
// acompanhamento por vendedor (novos aptos, positivacao, faturamento x meta e
// bonus previsto) e composicao do bonus. Escopo por papel vem do backend
// (admin ve todos; vendedor ve apenas o seu). Consome GET /api/campanha/outubro.
import { useState, useEffect } from "react";
import { useQuery, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";

type Seller = {
  seller: string; novosAptos: number; emValidacao: number; carteira: number; positivados: number;
  positivacao: number; faturamento: number; meta: number;
  bonusNovos: number; bonusPos: number; bonusMeta: number; bonusTotal: number;
};
type Resp = {
  asOf: string; ym: string; ativo: boolean;
  premissas: { bonusNovo: number; posMeta: number; bonusPos: number; bonusMeta: number; pedidoMin: number };
  sellers: Seller[];
  totais: { novosAptos: number; emValidacao: number; bonusNovos: number; bonusPos: number; bonusMeta: number; bonusTotal: number; comPositivacao: number; comMeta: number; vendedores: number };
};

function brl(n: number): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const REGRAS = [
  "Pedido mín. R$ 300,00",
  "Só em regiões já atendidas",
  "Dentro do raio logístico",
  "Cliente consistente e validado",
  "Bônus após boleto pago (7 dias)",
];

function Check() {
  return <svg className="h-3 w-3 shrink-0 text-emerald-600" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function NovosModal({ seller, onClose }: { seller: string; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    apiRequest("GET", "/api/campanha/outubro/novos?seller=" + encodeURIComponent(seller))
      .then((r) => { if (alive) setRows(r.rows || []); })
      .catch((e) => { if (alive) setErr(e?.message || "Erro ao carregar"); });
    return () => { alive = false; };
  }, [seller]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[82vh] overflow-auto rounded-xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-800">Novos clientes da campanha — {seller}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{rows ? rows.length : "…"} cliente(s) apto(s) · R$ 30 de bônus cada</p>
          </div>
          <button onClick={onClose} className="h-8 w-8 shrink-0 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50" aria-label="Fechar">×</button>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        {!rows && !err && <p className="text-sm text-gray-500">Carregando…</p>}
        {rows && rows.length === 0 && <p className="text-sm text-gray-500">Nenhum cliente novo apto ainda.</p>}
        <div className="flex flex-col gap-2">
          {(rows || []).map((c, i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 truncate">{c.cliente}</div>
                <div className="text-[11px] text-gray-500">{[c.regiao, c.data].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="text-right whitespace-nowrap">
                <div className="text-sm font-semibold tabular-nums text-gray-800">{brl(c.pedido)}</div>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"><Check />apto</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Bar({ pct, ok }: { pct: number; ok: boolean }) {
  return (
    <div className="mt-1 h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-gray-200">
      <div className={"h-full rounded-full " + (ok ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-red-500")} style={{ width: Math.min(100, Math.max(0, pct)) + "%" }} />
    </div>
  );
}

export default function CampanhaOutubro() {
  const { data, isLoading } = useQuery<Resp>({ queryKey: ["/api/campanha/outubro"] });
  const [modalSeller, setModalSeller] = useState<string | null>(null);

  const sellers = data?.sellers || [];
  const t = data?.totais;
  const posMeta = data?.premissas?.posMeta ?? 90;
  const multi = sellers.length > 1;

  return (
    <div className="space-y-5">
      {/* HERO */}
      <div className="rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">honest · campanha de vendas</div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-gray-800">Campanha de Outubro</h2>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">Bonificação por novos clientes, positivação e meta de faturamento — por vendedor.</p>
          </div>
          <div className="flex flex-col items-end gap-1.5 text-xs">
            <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600">Período: <b className="text-gray-800">01–31/out</b></span>
            {data && !data.ativo && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-700">Fora do mês da campanha</span>}
          </div>
        </div>
      </div>

      {/* PLANEJAMENTO */}
      <div>
        <div className="mb-2 flex items-baseline gap-2"><h3 className="text-base font-semibold text-gray-800">Planejamento</h3><span className="text-xs text-gray-400">as três formas de ganhar no mês</span></div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-gray-200 bg-white p-4 lg:row-span-2">
            <div className="text-xl font-extrabold tracking-tight text-gray-800">{brl(30)}</div>
            <div className="text-sm font-semibold text-gray-700">por novo cliente</div>
            <div className="text-xs text-gray-500">Venda faturada e recebida.</div>
            <div className="mt-3 border-t border-dashed border-gray-200 pt-3">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Regras do novo cliente</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {REGRAS.map((r) => (
                  <span key={r} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] text-gray-600"><Check />{r}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-xl font-extrabold tracking-tight text-gray-800">{brl(500)}</div>
            <div className="text-sm font-semibold text-gray-700">positivação de {posMeta}%</div>
            <div className="text-xs text-gray-500">{posMeta}% da carteira positivada no mês.</div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="text-xl font-extrabold tracking-tight text-gray-800">{brl(500)}</div>
            <div className="text-sm font-semibold text-gray-700">meta de faturamento</div>
            <div className="text-xs text-gray-500">Meta do mês cumprida.</div>
          </div>
        </div>
      </div>

      {/* TABELA */}
      <div>
        <div className="mb-2 flex items-baseline gap-2"><h3 className="text-base font-semibold text-gray-800">Acompanhamento {multi ? "por vendedor" : "— seu desempenho"}</h3><span className="text-xs text-gray-400">progresso nas três premissas e bônus previsto</span></div>
        <Card>
          <CardContent className="overflow-x-auto p-0">
            {isLoading ? <div className="p-6 text-sm text-gray-500">Carregando…</div> : (
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2.5 font-semibold">Vendedor</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Novos (aptos / validação)</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Bônus novos</th>
                    <th className="px-3 py-2.5 font-semibold">Positivação (meta {posMeta}%)</th>
                    <th className="px-3 py-2.5 font-semibold">Faturamento (realizado / meta)</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Bônus positiv.</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Bônus meta</th>
                    <th className="px-3 py-2.5 text-center font-semibold">Bônus previsto</th>
                  </tr>
                </thead>
                <tbody>
                  {sellers.map((s) => {
                    const metaOk = s.meta > 0 && s.faturamento >= s.meta;
                    const fatPct = s.meta > 0 ? Math.round((s.faturamento / s.meta) * 100) : 0;
                    const posOk = s.positivacao >= posMeta;
                    return (
                      <tr key={s.seller} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">{s.seller}</td>
                        <td className="px-3 py-2.5 text-center">
                          <button onClick={() => setModalSeller(s.seller)} className="font-bold text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:decoration-emerald-600" title="Ver lista dos novos clientes">{s.novosAptos}</button>
                          <span className="text-gray-400"> / {s.emValidacao} em validação</span>
                        </td>
                        <td className="px-3 py-2.5 text-center font-semibold tabular-nums">{brl(s.bonusNovos)}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{s.positivacao}%</span>{posOk && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">+R$500</span>}</div>
                          <Bar pct={s.positivacao} ok={posOk} />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{fatPct}%</span><span className="text-[11px] tabular-nums text-gray-400">{brl(s.faturamento)} / {s.meta > 0 ? brl(s.meta) : "—"}</span></div>
                          <Bar pct={fatPct} ok={metaOk} />
                        </td>
                        <td className="px-3 py-2.5 text-center">{s.bonusPos ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">R$ 500</span> : <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2.5 text-center">{s.bonusMeta ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">R$ 500</span> : <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2.5 text-center font-bold tabular-nums text-emerald-700">{brl(s.bonusTotal)}</td>
                      </tr>
                    );
                  })}
                  {!sellers.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500">Sem dados da campanha ainda.</td></tr>}
                </tbody>
                {multi && t && (
                  <tfoot>
                    <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                      <td className="px-3 py-2.5">Equipe ({t.vendedores})</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{t.novosAptos} / {t.emValidacao}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{brl(t.bonusNovos)}</td>
                      <td className="px-3 py-2.5 text-gray-500">{t.comPositivacao} de {t.vendedores} com {posMeta}%</td>
                      <td className="px-3 py-2.5 text-gray-500">{t.comMeta} de {t.vendedores} na meta</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{brl(t.bonusPos)}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums">{brl(t.bonusMeta)}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-emerald-700">{brl(t.bonusTotal)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* COMPOSIÇÃO DO BÔNUS */}
      {t && (
        <div>
          <div className="mb-2 flex items-baseline gap-2"><h3 className="text-base font-semibold text-gray-800">Composição do bônus previsto</h3><span className="text-xs text-gray-400">{multi ? "de onde vem o bônus da equipe no mês" : "de onde vem o seu bônus no mês"}</span></div>
          <Card>
            <CardContent className="p-4">
              <div className="text-sm font-bold text-gray-800">Total previsto: {brl(t.bonusTotal)}</div>
              {t.bonusTotal > 0 ? (
                <>
                  <div className="mt-3 flex h-8 w-full overflow-hidden rounded-lg">
                    {t.bonusNovos > 0 && <div className="flex items-center justify-center bg-emerald-500 text-[11px] font-semibold text-white" style={{ width: (t.bonusNovos / t.bonusTotal * 100) + "%" }}>{t.bonusNovos / t.bonusTotal > 0.12 ? brl(t.bonusNovos) : ""}</div>}
                    {t.bonusPos > 0 && <div className="flex items-center justify-center bg-emerald-700 text-[11px] font-semibold text-white" style={{ width: (t.bonusPos / t.bonusTotal * 100) + "%" }}>{t.bonusPos / t.bonusTotal > 0.12 ? brl(t.bonusPos) : ""}</div>}
                    {t.bonusMeta > 0 && <div className="flex items-center justify-center bg-violet-500 text-[11px] font-semibold text-white" style={{ width: (t.bonusMeta / t.bonusTotal * 100) + "%" }}>{t.bonusMeta / t.bonusTotal > 0.12 ? brl(t.bonusMeta) : ""}</div>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-600">
                    <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />Novos clientes</span>
                    <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-700" />Positivação</span>
                    <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-violet-500" />Meta</span>
                  </div>
                </>
              ) : <p className="mt-2 text-sm text-gray-500">Ainda sem bônus previsto no mês.</p>}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="pt-1 text-center text-xs text-gray-400">Dados do faturamento (NF-e), da carteira e dos pedidos do mês. Os novos clientes são validados no Inbox para contarem na campanha.</p>

      {modalSeller && <NovosModal seller={modalSeller} onClose={() => setModalSeller(null)} />}
    </div>
  );
}
