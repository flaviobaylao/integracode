// ============================================================================
// VALOR ENTREGUE POR SEMANA (segunda a domingo) — semana atual + 8 anteriores
// + COMISSÃO DE ENTREGA (regra de 17/10/2026, ver shared/comissao-entrega.ts)
// ----------------------------------------------------------------------------
// modo "motorista": tela Minhas Entregas — só as entregas do próprio entregador
//                   e a cota de comissão dele (se for participante).
// modo "gestao":    Dashboard — total por semana, abertura por entregador,
//                   comissão por semana e (admin) configuração dos participantes.
// Fonte: GET /api/delivery-routes/entregas-semanais (paradas 'efetuada').
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Truck, Settings2, Info, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

interface PorEntregador { nome: string; email: string; total: number; entregas: number }
interface Cota { chave: string; nome: string; peso: number; dias: number; pontos: number; entregue: number; valor: number }
interface ComissaoGestao { percentual: number; base: number; total: number; pontos: number; cotas: Cota[] }
interface ComissaoMotorista { percentual: number; participa: boolean; cota: Cota | null }
interface Semana {
  inicio: string; fim: string; atual: boolean; total: number; entregas: number;
  porEntregador: PorEntregador[];
  comissao?: ComissaoGestao | ComissaoMotorista;
}
interface Participante { chave: string; nome: string; peso: number }
interface Resposta {
  escopo: "meu" | "todos"; hoje: string; semanas: Semana[]; entregadores: PorEntregador[];
  comissaoConfig?: { percentual: number; participantes?: Participante[]; participa?: boolean };
}

const brl = (n: any) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const brlCurto = (n: number) => {
  const v = Number(n) || 0;
  if (v >= 1000) return "R$ " + (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil";
  return "R$ " + Math.round(v).toLocaleString("pt-BR");
};
const pctTxt = (p: number) => `${(Number(p) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const rotuloSemana = (s: Semana) => `${dm(s.inicio)} a ${dm(s.fim)}`;
const chaveDe = (e: { email?: string; nome?: string }) => String(e.email || "").trim().toLowerCase() || String(e.nome || "").trim().toLowerCase();
const pesoTxt = (p: number) => Number(p).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

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

// ---------------------------------------------------------------------------
// Configuração da comissão (somente administrador)
// ---------------------------------------------------------------------------
function ConfigComissao({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ config: { percentual: number; participantes: Participante[] }; entregadores: Array<{ chave: string; nome: string; ativo: boolean }> }>({
    queryKey: ["comissao-entrega-config"],
    queryFn: async () => {
      const r = await fetch("/api/delivery-routes/comissao-config", { credentials: "include" });
      if (!r.ok) throw new Error(`Erro ${r.status}`);
      return r.json();
    },
  });
  const [sel, setSel] = useState<Record<string, { on: boolean; peso: string; nome: string }>>({});
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (!data) return;
    const m: Record<string, { on: boolean; peso: string; nome: string }> = {};
    for (const e of data.entregadores) m[e.chave] = { on: false, peso: "1", nome: e.nome };
    for (const p of data.config.participantes) m[p.chave] = { on: true, peso: String(p.peso).replace(".", ","), nome: p.nome || m[p.chave]?.nome || p.chave };
    setSel(m);
  }, [data]);

  const salvar = async () => {
    const participantes: Participante[] = [];
    for (const [chave, v] of Object.entries(sel)) {
      if (!v.on) continue;
      const peso = Number(String(v.peso).replace(",", "."));
      if (!Number.isFinite(peso) || peso <= 0) {
        toast({ title: "Peso inválido", description: `Informe um peso maior que zero para ${v.nome}.`, variant: "destructive" });
        return;
      }
      participantes.push({ chave, nome: v.nome, peso });
    }
    setSalvando(true);
    try {
      const r = await fetch("/api/delivery-routes/comissao-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percentual: data?.config.percentual ?? 0.065, participantes }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.message || `Erro ${r.status}`);
      toast({ title: "Comissão de entrega salva", description: `${participantes.length} entregador(es) participando.` });
      queryClient.invalidateQueries({ queryKey: ["entregas-semanais"] });
      queryClient.invalidateQueries({ queryKey: ["comissao-entrega-config"] });
      onClose();
    } catch (e: any) {
      toast({ title: "Não foi possível salvar", description: e.message, variant: "destructive" });
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-3 space-y-2" data-testid="config-comissao-entrega">
      <div className="text-sm font-semibold text-amber-900">Configurar comissão de entrega</div>
      <p className="text-xs text-amber-900/80">
        Marque quem participa e o peso do dia de trabalho de cada um. A comissão da semana ({pctTxt(data?.config.percentual ?? 0.065)} sobre
        a soma das entregas dos participantes) é dividida por <strong>dias trabalhados × peso</strong>. Ex.: peso 2 para o Marcelo e 1 para o
        VIRSON → um dia do Marcelo vale dois dias do VIRSON.
      </p>
      {isLoading && <p className="text-xs text-gray-500">Carregando…</p>}
      <div className="divide-y rounded border bg-white">
        {Object.entries(sel).sort((a, b) => a[1].nome.localeCompare(b[1].nome, "pt-BR")).map(([chave, v]) => (
          <label key={chave} className="flex items-center gap-3 px-3 py-1.5 text-sm">
            <input
              type="checkbox"
              checked={v.on}
              onChange={(e) => setSel((prev) => ({ ...prev, [chave]: { ...prev[chave], on: e.target.checked } }))}
              data-testid={`comissao-participa-${chave}`}
            />
            <span className="flex-1">{v.nome} <span className="text-xs text-gray-400">{chave.includes("@") ? chave : ""}</span></span>
            <span className="text-xs text-gray-500">peso do dia</span>
            <Input
              value={v.peso}
              disabled={!v.on}
              onChange={(e) => setSel((prev) => ({ ...prev, [chave]: { ...prev[chave], peso: e.target.value } }))}
              className="w-16 h-7 text-right"
              inputMode="decimal"
              data-testid={`comissao-peso-${chave}`}
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancelar</Button>
        <Button type="button" size="sm" onClick={salvar} disabled={salvando || isLoading} data-testid="comissao-salvar">
          {salvando ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </div>
  );
}

export default function EntregasSemanais({ modo }: { modo: "motorista" | "gestao" }) {
  const { user } = useAuth();
  const isAdmin = (user as any)?.role === "admin";
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
  const [config, setConfig] = useState(false);
  // Recolher/expandir: recolhida mostra so o cabecalho e os indicadores. Sempre abre EXPANDIDA
  // (com o grafico e a planilha por entregador); o recolher vale so enquanto a tela esta aberta.
  const [aberto, setAberto] = useState(true);
  const alternarAberto = () => setAberto((v) => !v);
  const [info, setInfo] = useState(false);

  const semanas = data?.semanas || [];
  const [sel, setSel] = useState<number | null>(null);
  const idx = sel ?? Math.max(0, semanas.length - 1);
  const semana = semanas[idx];
  const atual = semanas.find((s) => s.atual);
  const anterior = semanas.length >= 2 ? semanas[semanas.length - 2] : undefined;
  const totalPeriodo = semanas.reduce((a, s) => a + s.total, 0);
  const anteriores = semanas.filter((s) => !s.atual);
  const mediaAnteriores = anteriores.length ? anteriores.reduce((a, s) => a + s.total, 0) / anteriores.length : 0;

  const percentual = data?.comissaoConfig?.percentual ?? 0.065;
  const participantes = data?.comissaoConfig?.participantes || [];
  const gestaoCom = (s?: Semana) => (s?.comissao && "cotas" in s.comissao ? (s.comissao as ComissaoGestao) : null);
  const motoCom = (s?: Semana) => (s?.comissao && "participa" in s.comissao ? (s.comissao as ComissaoMotorista) : null);
  const participaMotorista = modo === "motorista" && !!data?.comissaoConfig?.participa;
  const comissaoPeriodo = semanas.reduce((a, s) => a + (gestaoCom(s)?.total || 0), 0);
  const minhaComissaoPeriodo = semanas.reduce((a, s) => a + (motoCom(s)?.cota?.valor || 0), 0);

  const entregadores = useMemo(() => (data?.entregadores || []).slice(), [data]);
  const valorDe = (s: Semana, e: PorEntregador) => s.porEntregador.find((p) => chaveDe(p) === chaveDe(e));
  const cotaDe = (s: Semana, e: PorEntregador) => gestaoCom(s)?.cotas.find((c) => c.chave === chaveDe(e));
  const comissaoTotalDe = (e: PorEntregador) => semanas.reduce((a, s) => a + (cotaDe(s, e)?.valor || 0), 0);
  const ehParticipante = (e: PorEntregador) => participantes.some((p) => p.chave === chaveDe(e));

  return (
    <Card data-testid={`entregas-semanais-${modo}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Truck className="h-4 w-4 text-emerald-600" />
            {modo === "gestao" ? "Valor entregue por semana (seg a dom)" : "Valor entregue na semana"}
          </CardTitle>
          <div className="flex items-center gap-1.5 shrink-0">
            <button type="button" onClick={() => setInfo((v) => !v)} title="Como ler este quadro" aria-label="Como ler este quadro" aria-expanded={info}
              className={"h-7 w-7 inline-flex items-center justify-center rounded-md border " + (info ? "bg-sky-100 border-sky-300 text-sky-700" : "border-gray-200 text-gray-500 hover:bg-gray-50")} data-testid="botao-info-entregas">
              <Info className="h-4 w-4" />
            </button>
            {modo === "gestao" && isAdmin && (
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setConfig((c) => !c)} data-testid="botao-config-comissao">
                <Settings2 className="h-3.5 w-3.5 mr-1" /> Comissão
              </Button>
            )}
            <button type="button" onClick={alternarAberto} title={aberto ? "Recolher" : "Expandir"} aria-label={aberto ? "Recolher" : "Expandir"} aria-expanded={aberto}
              className="h-7 inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-50" data-testid="botao-recolher-entregas">
              {aberto ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {aberto ? "Recolher" : "Expandir"}
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Entregas concluídas (efetuadas), somando o valor dos pedidos. Semana de segunda a domingo; semana atual em verde e as 8 anteriores.
        </p>
        {info && (
          <div className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 space-y-1" data-testid="info-entregas">
            <div><b>O que é:</b> a soma do valor dos pedidos com entrega <b>concluída</b> em cada semana (segunda a domingo). Pedido faturado mas ainda não entregue não entra.</div>
            <div><b>Como ler:</b> a barra verde é a semana atual, ainda em andamento. Clique numa barra{modo === "gestao" ? " ou no cabeçalho de uma coluna da tabela" : ""} para ver os detalhes daquela semana.</div>
            <div><b>Comparação:</b> "Semana passada", "Média das 8 anteriores" e "Total das 9 semanas" mostram se o ritmo de entregas está acima ou abaixo do normal.</div>
            <div><b>Comissão de entrega:</b> {pctTxt(percentual)} sobre a soma das entregas dos entregadores participantes, dividida entre eles pelos dias com entrega × o peso de cada um{modo === "gestao" ? " (definidos no botão Comissão). Na tabela, o valor em laranja é a comissão de cada entregador" : ""}.</div>
          </div>
        )}
        {modo === "gestao" && isAdmin && config && <ConfigComissao onClose={() => setConfig(false)} />}
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

              {modo === "gestao" && participantes.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5">
                  <div className="text-xs text-amber-800">Comissão de entrega ({pctTxt(percentual)}) — semana atual</div>
                  <div className="text-xl font-bold text-amber-700" data-testid="comissao-semana-atual">{brl(gestaoCom(atual)?.total || 0)}</div>
                  <div className="text-[11px] text-amber-800/80">sobre {brl(gestaoCom(atual)?.base || 0)} dos participantes</div>
                </div>
              )}
              {modo === "motorista" && participaMotorista && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5">
                  <div className="text-xs text-amber-800">Sua comissão — semana atual</div>
                  <div className="text-xl font-bold text-amber-700" data-testid="comissao-semana-atual">{brl(motoCom(atual)?.cota?.valor || 0)}</div>
                  <div className="text-[11px] text-amber-800/80">{motoCom(atual)?.cota?.dias || 0} dia(s) de entrega na semana</div>
                </div>
              )}

              <div className="text-xs text-gray-600 space-y-0.5">
                <div>Semana passada: <strong>{brl(anterior?.total || 0)}</strong></div>
                <div>Média das 8 anteriores: <strong>{brl(mediaAnteriores)}</strong></div>
                <div>Total das 9 semanas: <strong>{brl(totalPeriodo)}</strong></div>
                {modo === "gestao" && participantes.length > 0 && <div className="text-amber-700">Comissão nas 9 semanas: <strong>{brl(comissaoPeriodo)}</strong></div>}
                {participaMotorista && <div className="text-amber-700">Sua comissão nas 9 semanas: <strong>{brl(minhaComissaoPeriodo)}</strong></div>}
              </div>
            </div>

            {aberto && (<>
            {modo === "gestao" && participantes.length === 0 && (
              <p className="mt-2 text-xs text-amber-700">
                Comissão de entrega: nenhum entregador participando.{isAdmin ? " Use o botão Comissão para escolher." : ""}
              </p>
            )}

            <Barras semanas={semanas} selecionada={idx} onSelect={setSel} />

            {semana && (
              <div className="mt-2 text-xs text-gray-600" data-testid="semana-selecionada">
                Selecionada: <strong>{rotuloSemana(semana)}</strong> — {brl(semana.total)} · {semana.entregas} entrega(s)
                {semana.atual ? " (semana atual, em andamento)" : ""}
                {participaMotorista && motoCom(semana)?.cota && (
                  <span className="text-amber-700"> · sua comissão {brl(motoCom(semana)!.cota!.valor)} ({motoCom(semana)!.cota!.dias} dia(s))</span>
                )}
              </div>
            )}

            {modo === "gestao" && gestaoCom(semana) && participantes.length > 0 && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs" data-testid="divisao-comissao">
                <div className="font-semibold text-amber-900">
                  Comissão da semana {rotuloSemana(semana!)}: {brl(gestaoCom(semana)!.total)} ({pctTxt(percentual)} de {brl(gestaoCom(semana)!.base)})
                </div>
                <div className="mt-1 grid gap-0.5">
                  {gestaoCom(semana)!.cotas.map((c) => (
                    <div key={c.chave} className="flex justify-between gap-3">
                      <span>{c.nome}: {c.dias} dia(s) × peso {pesoTxt(c.peso)} = {pesoTxt(c.pontos)} ponto(s){gestaoCom(semana)!.pontos > 0 ? ` (${Math.round((c.pontos / gestaoCom(semana)!.pontos) * 1000) / 10}%)` : ""}</span>
                      <strong className="text-amber-800">{brl(c.valor)}</strong>
                    </div>
                  ))}
                </div>
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
                      {participaMotorista && (
                        <span className="block text-xs text-amber-700">comissão {brl(motoCom(s)?.cota?.valor || 0)} · {motoCom(s)?.cota?.dias || 0} dia(s)</span>
                      )}
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
                      {entregadores.map((e) => {
                        const part = ehParticipante(e);
                        return (
                          <tr key={e.email || e.nome} className="border-b hover:bg-gray-50">
                            <td className="py-1.5 px-2 font-medium sticky left-0 bg-white whitespace-nowrap">
                              {e.nome}
                              {part && <span className="ml-1 text-[10px] text-amber-700">comissão</span>}
                            </td>
                            {semanas.map((s) => {
                              const v = valorDe(s, e);
                              const c = part ? cotaDe(s, e) : undefined;
                              return (
                                <td key={s.inicio} className={`text-right py-1.5 px-2 whitespace-nowrap ${s.atual ? "bg-emerald-50/60" : ""}`} title={v ? `${v.entregas} entrega(s)${c ? ` · ${c.dias} dia(s) · comissão ${brl(c.valor)}` : ""}` : ""}>
                                  {v ? <div>{brlCurto(v.total)}</div> : <div className="text-gray-300">—</div>}
                                  {c && c.valor > 0 && <div className="text-[10px] text-amber-700">{brl(c.valor)}</div>}
                                </td>
                              );
                            })}
                            <td className="text-right py-1.5 px-2 font-semibold whitespace-nowrap">
                              <div>{brl(e.total)}</div>
                              {part && <div className="text-[10px] text-amber-700">comissão {brl(comissaoTotalDe(e))}</div>}
                            </td>
                          </tr>
                        );
                      })}
                      <tr className="bg-gray-100 font-semibold">
                        <td className="py-1.5 px-2 sticky left-0 bg-gray-100">Total</td>
                        {semanas.map((s) => (
                          <td key={s.inicio} className={`text-right py-1.5 px-2 whitespace-nowrap ${s.atual ? "text-emerald-800" : ""}`}>
                            <div>{brlCurto(s.total)}</div>
                            {participantes.length > 0 && <div className="text-[10px] text-amber-700">{brl(gestaoCom(s)?.total || 0)}</div>}
                          </td>
                        ))}
                        <td className="text-right py-1.5 px-2 whitespace-nowrap">
                          <div>{brl(totalPeriodo)}</div>
                          {participantes.length > 0 && <div className="text-[10px] text-amber-700">comissão {brl(comissaoPeriodo)}</div>}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {participantes.length > 0 && (
                  <p className="mt-1 text-[11px] text-gray-500">
                    Em laranja: comissão de entrega ({pctTxt(percentual)} sobre a soma das entregas dos participantes, dividida por dias × peso).
                    Participantes: {participantes.map((p) => `${p.nome} (peso ${pesoTxt(p.peso)})`).join(", ")}.
                  </p>
                )}
              </div>
            )}
            </>)}
            {!aberto && <p className="mt-2 text-[11px] text-gray-400">Quadro recolhido — clique em Expandir para ver o gráfico por semana{modo === "gestao" ? " e a tabela por entregador" : ""}.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
