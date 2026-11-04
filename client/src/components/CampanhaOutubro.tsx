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
// Premissa da campanha no mês: o bloco de planejamento e a coluna da tabela
// nascem daqui. Vem do servidor (catálogo + o que foi gravado para o mês).
export type Premissa = {
  chave: string; label: string; descricao: string;
  gatilhoLabel: string; gatilhoSufixo: string; base: string;
  ativa: boolean; modo: "valor" | "percentual"; valor: number; gatilho: number;
  // Segundo parâmetro, só nas premissas que o declaram. Na positivação é o
  // pedido mínimo para o cliente PJ contar como positivado; 0 = sem mínimo.
  pedidoMin?: number; pedidoMinLabel?: string;
};

type Resp = {
  asOf: string; ym: string; ativo: boolean; meses?: string[]; admin?: boolean;
  premissas: Premissa[];
  sellers: Seller[];
  totais: { novosAptos: number; emValidacao: number; bonusNovos: number; bonusPos: number; bonusMeta: number; bonusTotal: number; comPositivacao: number; comMeta: number; vendedores: number };
};

function brl(n: number): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// O pedido mínimo saiu daqui: virou o gatilho editável da premissa e já entra
// na lista pelo valor do mês. Mantê-lo fixo mostrava "Pedido mín." duas vezes.
const REGRAS = [
  "Só em regiões já atendidas",
  "Dentro do raio logístico",
  "Cliente consistente e validado",
  "Bônus após boleto pago (7 dias)",
];

function Check() {
  return <svg className="h-3 w-3 shrink-0 text-emerald-600" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function NovosModal({ seller, ym, onClose }: { seller: string; ym: string; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    apiRequest("GET", "/api/campanha/outubro/novos?ym=" + ym + "&seller=" + encodeURIComponent(seller))
      .then((r) => { if (alive) setRows(r.rows || []); })
      .catch((e) => { if (alive) setErr(e?.message || "Erro ao carregar"); });
    return () => { alive = false; };
  }, [seller, ym]);
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

// Mes no fuso de Brasilia — o mes do servidor, nao o do navegador de quem olha.
function mesCorrente(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
}
function nomeDoMes(ym: string): string {
  const [a, m] = String(ym).split("-").map(Number);
  const nome = new Date(Date.UTC(a, (m || 1) - 1, 1))
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  return nome.charAt(0).toUpperCase() + nome.slice(1);
}
function ultimoDia(ym: string): number {
  const [a, m] = String(ym).split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

export default function CampanhaOutubro() {
  const [ym, setYm] = useState(mesCorrente);
  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useQuery<Resp>({
    queryKey: ["/api/campanha/outubro", ym],
    // queryFn explicita: a padrao junta a chave com "/" e viraria .../2026-11.
    queryFn: () => apiRequest("GET", "/api/campanha/outubro?ym=" + ym),
    refetchInterval: 5 * 60_000,
  });
  const [modalSeller, setModalSeller] = useState<string | null>(null);
  const meses = data?.meses?.length ? data.meses : [ym];

  const sellers = data?.sellers || [];
  const t = data?.totais;
  const premissas: Premissa[] = Array.isArray(data?.premissas) ? data!.premissas : [];
  const acha = (c: string) => premissas.find((p) => p.chave === c);
  const pNovos = acha("novos"), pPos = acha("positivacao"), pMeta = acha("meta");
  const posMeta = pPos?.gatilho ?? 90;
  const metaPct = pMeta?.gatilho ?? 100;
  const multi = sellers.length > 1;
  const admin = data?.admin === true;
  // Quantas colunas a tabela tem de fato — muda com as premissas ligadas.
  const nCols = 2 + (pNovos?.ativa ? 2 : 0) + (pPos?.ativa ? 2 : 0) + (pMeta?.ativa ? 2 : 0);

  const salvarPremissa = async (p: Premissa, mudanca: Partial<Premissa>) => {
    const novo = { ...p, ...mudanca };
    await apiRequest("POST", "/api/campanha/outubro/premissa", {
      ym, chave: p.chave, ativa: novo.ativa, modo: novo.modo, valor: novo.valor, gatilho: novo.gatilho,
      // Vai só quando a premissa tem o parâmetro: ausente, o servidor mantém o
      // que está gravado em vez de zerar.
      ...(novo.pedidoMin === undefined ? {} : { pedidoMin: novo.pedidoMin }),
    });
    refetch();
  };

  return (
    <div className="space-y-5">
      {/* HERO */}
      <div className="rounded-xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">honest · campanha de vendas</div>
            <h2 className="mt-1 text-2xl font-bold tracking-tight text-gray-800">Campanha de {nomeDoMes(ym)}</h2>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">Bonificação por novos clientes, positivação e meta de faturamento — por vendedor.</p>
          </div>
          <div className="flex flex-col items-end gap-1.5 text-xs">
            {/* Mês considerado na apuração: tudo nesta aba segue este seletor. */}
            <select value={ym} onChange={(e) => setYm(e.target.value)}
              className="rounded-md border border-emerald-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-emerald-800"
              data-testid="campanha-mes">
              {meses.map((m) => <option key={m} value={m}>{nomeDoMes(m)}</option>)}
            </select>
            <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-gray-600">
              Período: <b className="text-gray-800">01–{ultimoDia(ym)}/{ym.slice(5)}</b>
            </span>
            <span className="flex items-center gap-2 text-[11px] text-gray-500">
              {dataUpdatedAt ? "Atualizado às " + new Date(dataUpdatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}
              <button type="button" onClick={() => refetch()} disabled={isFetching} className="rounded-full border border-emerald-200 bg-white px-2.5 py-1 font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-60" data-testid="campanha-atualizar">{isFetching ? "Atualizando…" : "Atualizar"}</button>
            </span>
            {data && !data.ativo && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-700">Mês encerrado — retrato do período</span>}
          </div>
        </div>
      </div>

      {/* PLANEJAMENTO — um bloco por premissa, direto do catálogo do servidor.
          Premissa nova aparece aqui sozinha, com liga/desliga e edição. */}
      <div>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-base font-semibold text-gray-800">Planejamento</h3>
          <span className="text-xs text-gray-400">
            {admin ? "ligue, desligue e edite o que vale neste mês" : "as formas de ganhar no mês"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {premissas.map((p) => (
            <div key={p.chave}
              className={`rounded-xl border p-4 ${p.ativa ? "border-gray-200 bg-white" : "border-dashed border-gray-300 bg-gray-50"}`}
              data-testid={`premissa-${p.chave}`}>
              <div className="flex items-start justify-between gap-2">
                <div className={`text-xl font-extrabold tracking-tight ${p.ativa ? "text-gray-800" : "text-gray-400 line-through"}`}>
                  {p.modo === "percentual" ? `${String(p.valor).replace(".", ",")}%` : brl(p.valor)}
                </div>
                {admin && (
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-gray-500">
                    <input type="checkbox" checked={p.ativa} className="h-3.5 w-3.5 accent-emerald-600"
                      onChange={(e) => salvarPremissa(p, { ativa: e.target.checked })}
                      data-testid={`premissa-ativa-${p.chave}`} />
                    {p.ativa ? "no mês" : "fora"}
                  </label>
                )}
              </div>
              <div className={`text-sm font-semibold ${p.ativa ? "text-gray-700" : "text-gray-400"}`}>
                {p.chave === "positivacao" ? `positivação de ${p.gatilho}%` : p.label}
              </div>
              <div className="text-xs text-gray-500">
                {p.modo === "percentual" ? <>sobre o {p.base}.</> : p.descricao}
              </div>

              {admin && (
                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-dashed border-gray-200 pt-3">
                  <label className="text-[11px] text-gray-500">
                    Prêmio
                    <input type="text" inputMode="decimal" defaultValue={String(p.valor).replace(".", ",")}
                      key={`v-${p.chave}-${p.valor}`}
                      onBlur={(e) => {
                        const v = Number(e.target.value.replace(",", ".")) || 0;
                        if (v !== p.valor) salvarPremissa(p, { valor: v });
                      }}
                      className="mt-0.5 w-full rounded border border-gray-200 px-2 py-1 text-sm text-gray-800"
                      data-testid={`premissa-valor-${p.chave}`} />
                  </label>
                  <label className="text-[11px] text-gray-500">
                    Em
                    <select value={p.modo} onChange={(e) => salvarPremissa(p, { modo: e.target.value as any })}
                      className="mt-0.5 w-full rounded border border-gray-200 px-2 py-1 text-sm text-gray-800"
                      data-testid={`premissa-modo-${p.chave}`}>
                      <option value="valor">R$ (valor real)</option>
                      <option value="percentual">% (percentual)</option>
                    </select>
                  </label>
                  <label className="col-span-2 text-[11px] text-gray-500">
                    {p.gatilhoLabel} ({p.gatilhoSufixo})
                    <input type="text" inputMode="decimal" defaultValue={String(p.gatilho).replace(".", ",")}
                      key={`g-${p.chave}-${p.gatilho}`}
                      onBlur={(e) => {
                        const v = Number(e.target.value.replace(",", ".")) || 0;
                        if (v !== p.gatilho) salvarPremissa(p, { gatilho: v });
                      }}
                      className="mt-0.5 w-full rounded border border-gray-200 px-2 py-1 text-sm text-gray-800"
                      data-testid={`premissa-gatilho-${p.chave}`} />
                  </label>
                  {p.pedidoMin !== undefined && (
                    <label className="col-span-2 text-[11px] text-gray-500">
                      {p.pedidoMinLabel || "Pedido mínimo"} (R$)
                      <input type="text" inputMode="decimal" defaultValue={String(p.pedidoMin).replace(".", ",")}
                        key={`pm-${p.chave}-${p.pedidoMin}`}
                        onBlur={(e) => {
                          const v = Number(e.target.value.replace(",", ".")) || 0;
                          if (v !== p.pedidoMin) salvarPremissa(p, { pedidoMin: v });
                        }}
                        className="mt-0.5 w-full rounded border border-gray-200 px-2 py-1 text-sm text-gray-800"
                        data-testid={`premissa-pedidomin-${p.chave}`} />
                      <span className="mt-0.5 block text-[10px] leading-relaxed text-gray-400">
                        {(p.pedidoMin || 0) > 0
                          ? <>Compra de cliente <b>PJ</b> abaixo de {brl(p.pedidoMin)} no dia não positiva.
                              Cliente <b>PF</b> positiva com qualquer valor.</>
                          : <>Sem mínimo: qualquer compra positiva o cliente.</>}
                      </span>
                    </label>
                  )}
                  <p className="col-span-2 text-[10px] leading-relaxed text-gray-400">
                    Em <b>%</b>, o prêmio é calculado sobre o {p.base}. Vale só para{" "}
                    <b>{nomeDoMes(ym)}</b> — os outros meses ficam como estão.
                  </p>
                </div>
              )}

              {p.chave === "novos" && p.ativa && (
                <div className="mt-3 border-t border-dashed border-gray-200 pt-3">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Regras do novo cliente</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[`Pedido mín. ${brl(p.gatilho)}`, ...REGRAS].map((r) => (
                      <span key={r} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-[11px] text-gray-600"><Check />{r}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {!premissas.some((p) => p.ativa) && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
            Nenhuma premissa está valendo em {nomeDoMes(ym)}: a campanha não paga nada no mês e a
            tabela fica só com os nomes.
          </p>
        )}
      </div>

      {/* TABELA */}
      <div>
        <div className="mb-2 flex items-baseline gap-2"><h3 className="text-base font-semibold text-gray-800">Acompanhamento {multi ? "por vendedor" : "— seu desempenho"}</h3><span className="text-xs text-gray-400">progresso nas premissas do mês e bônus previsto</span></div>
        <Card>
          <CardContent className="overflow-x-auto p-0">
            {isLoading ? <div className="p-6 text-sm text-gray-500">Carregando…</div> : (
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                    {/* Premissa desligada no mês não tem coluna. */}
                    <th className="px-3 py-2.5 font-semibold">Vendedor</th>
                    {pNovos?.ativa && <th className="px-3 py-2.5 text-center font-semibold">Novos (aptos / validação)</th>}
                    {pNovos?.ativa && <th className="px-3 py-2.5 text-center font-semibold">Bônus novos</th>}
                    {pPos?.ativa && (
                      <th className="px-3 py-2.5 font-semibold"
                        title={(pPos.pedidoMin || 0) > 0
                          ? `Clientes da carteira que compraram no mês, sobre o total da carteira ativa. Cliente PJ só conta com pedido de ${brl(pPos.pedidoMin || 0)} ou mais no dia; cliente PF conta com qualquer valor.`
                          : "Clientes da carteira que compraram no mês, sobre o total da carteira ativa. Qualquer valor de compra positiva."}>
                        Positivação (meta {posMeta}%)
                        {(pPos.pedidoMin || 0) > 0 && (
                          <span className="ml-1 font-normal text-[10px] text-gray-400">
                            pedido ≥ {brl(pPos.pedidoMin || 0)} (PJ)
                          </span>
                        )}
                      </th>
                    )}
                    {pMeta?.ativa && <th className="px-3 py-2.5 font-semibold">Faturamento (realizado / meta)</th>}
                    {pPos?.ativa && <th className="px-3 py-2.5 text-center font-semibold">Bônus positiv.</th>}
                    {pMeta?.ativa && <th className="px-3 py-2.5 text-center font-semibold">Bônus meta</th>}
                    <th className="px-3 py-2.5 text-center font-semibold">Bônus previsto</th>
                  </tr>
                </thead>
                <tbody>
                  {sellers.map((s) => {
                    const metaOk = s.meta > 0 && s.faturamento >= (s.meta * metaPct) / 100;
                    const fatPct = s.meta > 0 ? Math.round((s.faturamento / s.meta) * 100) : 0;
                    const posOk = s.positivacao >= posMeta;
                    return (
                      <tr key={s.seller} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2.5 font-medium text-gray-800 whitespace-nowrap">{s.seller}</td>
                        {pNovos?.ativa && (
                          <td className="px-3 py-2.5 text-center">
                            <button onClick={() => setModalSeller(s.seller)} className="font-bold text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:decoration-emerald-600" title="Ver lista dos novos clientes">{s.novosAptos}</button>
                            <span className="text-gray-400"> / {s.emValidacao} em validação</span>
                          </td>
                        )}
                        {pNovos?.ativa && <td className="px-3 py-2.5 text-center font-semibold tabular-nums">{brl(s.bonusNovos)}</td>}
                        {pPos?.ativa && (
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{s.positivacao}%</span>{posOk && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">+{brl(s.bonusPos)}</span>}</div>
                            <Bar pct={s.positivacao} ok={posOk} />
                          </td>
                        )}
                        {pMeta?.ativa && (
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2"><span className="font-medium tabular-nums">{fatPct}%</span><span className="text-[11px] tabular-nums text-gray-400">{brl(s.faturamento)} / {s.meta > 0 ? brl(s.meta) : "—"}</span></div>
                            <Bar pct={fatPct} ok={metaOk} />
                          </td>
                        )}
                        {pPos?.ativa && <td className="px-3 py-2.5 text-center">{s.bonusPos ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{brl(s.bonusPos)}</span> : <span className="text-gray-300">—</span>}</td>}
                        {pMeta?.ativa && <td className="px-3 py-2.5 text-center">{s.bonusMeta ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">{brl(s.bonusMeta)}</span> : <span className="text-gray-300">—</span>}</td>}
                        <td className="px-3 py-2.5 text-center font-bold tabular-nums text-emerald-700">{brl(s.bonusTotal)}</td>
                      </tr>
                    );
                  })}
                  {!sellers.length && <tr><td colSpan={nCols} className="px-3 py-6 text-center text-sm text-gray-500">Sem dados da campanha ainda.</td></tr>}
                </tbody>
                {multi && t && (
                  <tfoot>
                    <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                      <td className="px-3 py-2.5">Equipe ({t.vendedores})</td>
                      {pNovos?.ativa && <td className="px-3 py-2.5 text-center tabular-nums">{t.novosAptos} / {t.emValidacao}</td>}
                      {pNovos?.ativa && <td className="px-3 py-2.5 text-center tabular-nums">{brl(t.bonusNovos)}</td>}
                      {pPos?.ativa && <td className="px-3 py-2.5 text-gray-500">{t.comPositivacao} de {t.vendedores} com {posMeta}%</td>}
                      {pMeta?.ativa && <td className="px-3 py-2.5 text-gray-500">{t.comMeta} de {t.vendedores} na meta</td>}
                      {pPos?.ativa && <td className="px-3 py-2.5 text-center tabular-nums">{brl(t.bonusPos)}</td>}
                      {pMeta?.ativa && <td className="px-3 py-2.5 text-center tabular-nums">{brl(t.bonusMeta)}</td>}
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
                    {t.bonusNovos > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />Novos clientes</span>}
                    {t.bonusPos > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-emerald-700" />Positivação</span>}
                    {t.bonusMeta > 0 && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-violet-500" />Meta</span>}
                  </div>
                </>
              ) : <p className="mt-2 text-sm text-gray-500">Ainda sem bônus previsto no mês.</p>}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="pt-1 text-center text-xs text-gray-400">Dados do faturamento (NF-e), da carteira e dos pedidos do mês. Os novos clientes são validados no Inbox para contarem na campanha.</p>

      {modalSeller && <NovosModal seller={modalSeller} ym={ym} onClose={() => setModalSeller(null)} />}
    </div>
  );
}
