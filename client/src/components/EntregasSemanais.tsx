// ============================================================================
// VALOR ENTREGUE POR SEMANA (segunda a domingo) — semana atual + 8 anteriores
// ----------------------------------------------------------------------------
// modo "motorista": tela Minhas Entregas — só as entregas do próprio entregador.
// modo "gestao":    Dashboard — total por semana + abertura por entregador.
// Fonte: GET /api/delivery-routes/entregas-semanais (paradas 'efetuada').
// ============================================================================

import { useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Truck } from "lucide-react";

interface PorEntregador { nome: string; email: string; total: number; entregas: number }
interface Semana { inicio: string; fim: string; atual: boolean; total: number; entregas: number; porEntregador: PorEntregador[] }
interface Resposta { escopo: "meu" | "todos"; hoje: string; semanas: Semana[]; entregadores: PorEntregador[] }

const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const brlCurto = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1000) return "R$ " + (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil";
  return "R$ " + Math.round(v).toLocaleString("pt-BR");
};
// Percentual calculado sobre o valor entregue (pedido do Flavio, 17/10/2026).
export const PERCENTUAL_ENTREGA = 0.065;
const PERC_ROTULO = "6,5%";
const pct = (v: number) => Math.round((Number(v) || 0) * PERCENTUAL_ENTREGA * 100) / 100;
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const rotuloSemana = (s: Semana) => `${dm(s.inicio)} a ${dm(s.fim)}`;

function Barras({ semanas, selecionada, onSelect }: { semanas: Semana[]; selecionada: number; onSelect: (i: number) => void }) {
  const max = Math.max(1, ...semanas.map((s) => s.total));
  return (
    <div className="flex items-end gap-1.5 h-32 pt-4" role="list" aria-label="Valor entregue por semana">
      {semanas.map((s, i) => {
        const h = Math.max(2, Math.round((s.total / max) * 100));
        const sel = i === selecionada;
        return (
          <button
            key={s.inicio}
            type="button"
            role="listitem"
            onClick={() => onSelect(i)}
            title={`${rotuloSemana(s)}: ${brl(s.total)} · ${s.entregas} entrega(s)`}
            className="flex-1 min-w-0 h-full flex flex-col justify-end items-center group"
            data-testid={`barra-semana-${s.inicio}`}
          >
            <div
              className={`w-full rounded-t ${s.atual ? "bg-emerald-500" : "bg-sky-500"} ${sel ? "ring-2 ring-offset-1 ring-gray-800" : "opacity-80 group-hover:opacity-100"}`}
              style={{ height: `${h}%` }}
            />
            <span className={`mt-1 text-[10px] leading-none ${s.atual ? "font-semibold text-emerald-700" : "text-gray-500"}`}>{dm(s.inicio)}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function EntregasSemanais({ modo }: { modo: "motorista" | "gestao" }) {
  const escopo = modo === "gestao" ? "todos" : "meu";
  const { data, isLoading, error } = useQuery<Resposta>({
    queryKey: ["entregas-semanais", escopo],
    queryFn: async () => {
      const r = await fetch(`/api/delivery-routes/entregas-semanais?semanas=8&escopo=${escopo}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `Erro ${r.status}`);
      return r.json();
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const semanas = data?.semanas || [];
  const [sel, setSel] = useState<number | null>(null);
  const idx = sel ?? Math.max(0, semanas.length - 1);
  const semana = semanas[idx];
  const atual = semanas.find((s) => s.atual);
  const anterior = semanas.length >= 2 ? semanas[semanas.length - 2] : undefined;
  const totalPeriodo = semanas.reduce((a, s) => a + s.total, 0);
  const anteriores = semanas.filter((s) => !s.atual);
  const mediaAnteriores = anteriores.length ? anteriores.reduce((a, s) => a + s.total, 0) / anteriores.length : 0;

  // Gestão: entregadores × semanas
  const entregadores = useMemo(() => (data?.entregadores || []).slice(), [data]);
  const valorDe = (s: Semana, email: string, nome: string) =>
    s.porEntregador.find((p) => (p.email || p.nome).toLowerCase() === (email || nome).toLowerCase());

  return (
    <Card data-testid={`entregas-semanais-${modo}`}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Truck className="h-4 w-4 text-emerald-600" />
          {modo === "gestao" ? "Valor entregue por semana (seg a dom)" : "Valor entregue na semana"}
        </CardTitle>
        <p className="text-xs text-gray-500">
          Entregas concluídas (efetuadas), somando o valor dos pedidos. Semana de segunda a domingo; semana atual em verde e as 8 anteriores. Em laranja, {PERC_ROTULO} sobre o valor entregue.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-gray-500">Carregando…</p>}
        {error && <p className="text-sm text-red-600">Não foi possível carregar: {(error as any).message}</p>}
        {!isLoading && !error && semanas.length > 0 && (
          <>
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <div>
                <div className="text-xs text-gray-500">Semana atual ({atual ? rotuloSemana(atual) : "—"})</div>
                <div className="text-2xl font-bold text-emerald-700" data-testid="valor-semana-atual">{brl(atual?.total || 0)}</div>
                <div className="text-xs text-gray-500">{atual?.entregas || 0} entrega(s)</div>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5">
                <div className="text-xs text-amber-800">{PERC_ROTULO} da semana atual</div>
                <div className="text-xl font-bold text-amber-700" data-testid="percentual-semana-atual">{brl(pct(atual?.total || 0))}</div>
              </div>
              <div className="text-xs text-gray-600 space-y-0.5">
                <div>Semana passada: <strong>{brl(anterior?.total || 0)}</strong> <span className="text-amber-700">({PERC_ROTULO}: {brl(pct(anterior?.total || 0))})</span></div>
                <div>Média das 8 anteriores: <strong>{brl(mediaAnteriores)}</strong> <span className="text-amber-700">({PERC_ROTULO}: {brl(pct(mediaAnteriores))})</span></div>
                <div>Total das 9 semanas: <strong>{brl(totalPeriodo)}</strong> <span className="text-amber-700">({PERC_ROTULO}: {brl(pct(totalPeriodo))})</span></div>
              </div>
            </div>

            <Barras semanas={semanas} selecionada={idx} onSelect={setSel} />

            {semana && (
              <div className="mt-2 text-xs text-gray-600" data-testid="semana-selecionada">
                Selecionada: <strong>{rotuloSemana(semana)}</strong> — {brl(semana.total)} · {semana.entregas} entrega(s) · <span className="text-amber-700">{PERC_ROTULO}: {brl(pct(semana.total))}</span>
                {semana.atual ? " (semana atual, em andamento)" : ""}
              </div>
            )}

            {modo === "motorista" && (
              <div className="mt-3 divide-y border rounded-md">
                {semanas.slice().reverse().map((s) => (
                  <div key={s.inicio} className={`flex items-center justify-between px-3 py-1.5 text-sm ${s.atual ? "bg-emerald-50" : ""}`}>
                    <span className={s.atual ? "font-semibold text-emerald-800" : "text-gray-700"}>
                      {rotuloSemana(s)}{s.atual ? " · atual" : ""}
                    </span>
                    <span className="text-right">
                      <span className="font-semibold">{brl(s.total)}</span>
                      <span className="text-xs text-gray-500 ml-2">{s.entregas} ent.</span>
                      <span className="block text-xs text-amber-700">{PERC_ROTULO}: {brl(pct(s.total))}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {modo === "gestao" && (
              <div className="mt-4 overflow-x-auto">
                {entregadores.length === 0 ? (
                  <p className="text-sm text-gray-500">Nenhuma entrega concluída no período.</p>
                ) : (
                  <table className="w-full text-xs border-collapse" data-testid="tabela-entregas-por-entregador">
                    <thead>
                      <tr className="border-b bg-gray-50">
                        <th className="text-left py-1.5 px-2 sticky left-0 bg-gray-50">Entregador</th>
                        {semanas.map((s, i) => (
                          <th
                            key={s.inicio}
                            className={`text-right py-1.5 px-2 whitespace-nowrap cursor-pointer ${s.atual ? "text-emerald-700" : "text-gray-600"} ${i === idx ? "underline" : ""}`}
                            onClick={() => setSel(i)}
                            title={rotuloSemana(s)}
                          >
                            {dm(s.inicio)}{s.atual ? " (atual)" : ""}
                          </th>
                        ))}
                        <th className="text-right py-1.5 px-2">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entregadores.map((e) => (
                        <tr key={e.email || e.nome} className="border-b hover:bg-gray-50">
                          <td className="py-1.5 px-2 font-medium sticky left-0 bg-white whitespace-nowrap">{e.nome}</td>
                          {semanas.map((s) => {
                            const v = valorDe(s, e.email, e.nome);
                            return (
                              <td key={s.inicio} className={`text-right py-1.5 px-2 whitespace-nowrap ${s.atual ? "bg-emerald-50/60" : ""}`} title={v ? `${v.entregas} entrega(s) · ${PERC_ROTULO}: ${brl(pct(v.total))}` : ""}>
                                {v ? (
                                  <>
                                    <div>{brlCurto(v.total)}</div>
                                    <div className="text-[10px] text-amber-700">{brl(pct(v.total))}</div>
                                  </>
                                ) : <span className="text-gray-300">—</span>}
                              </td>
                            );
                          })}
                          <td className="text-right py-1.5 px-2 font-semibold whitespace-nowrap">
                            <div>{brl(e.total)}</div>
                            <div className="text-[10px] text-amber-700">{PERC_ROTULO}: {brl(pct(e.total))}</div>
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-gray-100 font-semibold">
                        <td className="py-1.5 px-2 sticky left-0 bg-gray-100">Total</td>
                        {semanas.map((s) => (
                          <td key={s.inicio} className={`text-right py-1.5 px-2 whitespace-nowrap ${s.atual ? "text-emerald-800" : ""}`}>
                            <div>{brlCurto(s.total)}</div>
                            <div className="text-[10px] text-amber-700">{brl(pct(s.total))}</div>
                          </td>
                        ))}
                        <td className="text-right py-1.5 px-2 whitespace-nowrap">
                          <div>{brl(totalPeriodo)}</div>
                          <div className="text-[10px] text-amber-700">{PERC_ROTULO}: {brl(pct(totalPeriodo))}</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
