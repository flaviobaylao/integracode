// client/src/pages/ConferenciaRecebimentos.tsx
// -----------------------------------------------------------------------------
// GESTAO — CONFERENCIA DE RECEBIMENTOS  (tela /conferencia-recebimentos)
//
// Controle permanente do recebimento das vendas. Tres perguntas:
//   1. Toda venda virou recebivel?  (cobertura)
//   2. Tem prazo e conta prevista?  (qualidade do titulo)
//   3. Foi recebido, em que conta e bateu no banco?  (recebimento efetivo)
//
// Fonte unica: GET /api/gestao/conferencia-recebimentos?dias=30
// (server/conferencia-recebimentos-routes.ts). Tudo o que aparece aqui vem da
// base real, com a MESMA regua de "venda" das telas de Gestao/Carteiras.
// -----------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Wallet, CalendarClock, Landmark,
} from "lucide-react";

const brl = (v: any) => {
  const n = Number(v);
  return isNaN(n) ? "R$ 0,00" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
};
const dt = (v: any) => {
  if (!v) return "-";
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
};
const num = (v: any) => {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
};

const GRAV: Record<string, { label: string; cls: string }> = {
  alta: { label: "Alta", cls: "bg-red-100 text-red-800 border-red-200" },
  media: { label: "Média", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  baixa: { label: "Baixa", cls: "bg-slate-100 text-slate-700 border-slate-200" },
};

const OPCOES_DIAS = [7, 15, 30, 60, 90];

export default function ConferenciaRecebimentos() {
  const [dias, setDias] = useState(30);
  const [abertos, setAbertos] = useState<Record<string, boolean>>({});

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["/api/gestao/conferencia-recebimentos", dias],
    queryFn: async () => {
      const r = await fetch(`/api/gestao/conferencia-recebimentos?dias=${dias}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  const resumo = data?.resumo || {};
  const furos: any[] = Array.isArray(data?.furos) ? data.furos : [];
  const porCanal: any[] = Array.isArray(data?.porCanal) ? data.porCanal : [];
  const porConta: any[] = Array.isArray(data?.porConta) ? data.porConta : [];

  const totalFuros = useMemo(() => furos.reduce((s, f) => s + num(f.qtd), 0), [furos]);
  const valorFuros = useMemo(() => furos.reduce((s, f) => s + num(f.valor), 0), [furos]);

  const valor = num(resumo.valor);
  const recebido = num(resumo.recebido);
  const pctRecebido = valor > 0 ? (recebido / valor) * 100 : 0;
  const titRec = num(resumo.titulos_recebidos);
  const titConc = num(resumo.titulos_conciliados);
  const pctConc = titRec > 0 ? (titConc / titRec) * 100 : 0;

  const toggle = (k: string) => setAbertos((a) => ({ ...a, [k]: !a[k] }));

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
      <BackToDashboardButton />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h1 className="text-2xl font-bold">Conferência de Recebimentos</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border overflow-hidden">
            {OPCOES_DIAS.map((d) => (
              <button
                key={d}
                onClick={() => setDias(d)}
                className={`px-3 py-1.5 text-sm ${dias === d ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Vendas emitidas de {dt(data?.janela?.de)} a {dt(data?.janela?.ate)} — toda venda está sendo recebida, com que prazo e em que conta.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 text-slate-500 py-16 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Montando a conferência…
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 p-4 text-sm">
          Não foi possível carregar: {String((error as any)?.message || error)}
        </div>
      )}

      {!isLoading && !error && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs text-slate-500 flex items-center gap-1"><Wallet className="h-3.5 w-3.5" /> Vendas no período</div>
                <div className="text-xl font-bold">{brl(valor)}</div>
                <div className="text-xs text-slate-400">{num(resumo.titulos)} títulos</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs text-slate-500 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Recebido</div>
                <div className="text-xl font-bold text-emerald-700">{brl(recebido)}</div>
                <div className="text-xs text-slate-400">{pctRecebido.toFixed(1)}% do emitido</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs text-slate-500 flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" /> Vencido em aberto</div>
                <div className="text-xl font-bold text-red-700">{brl(resumo.vencido)}</div>
                <div className="text-xs text-slate-400">a receber: {brl(resumo.em_aberto)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs text-slate-500 flex items-center gap-1"><Landmark className="h-3.5 w-3.5" /> Confirmado no banco</div>
                <div className={`text-xl font-bold ${pctConc >= 80 ? "text-emerald-700" : "text-amber-700"}`}>{pctConc.toFixed(1)}%</div>
                <div className="text-xs text-slate-400">{titConc} de {titRec} recebidos</div>
              </CardContent>
            </Card>
          </div>

          {/* Barra de pendências */}
          <Card className={`mb-5 border-l-4 ${totalFuros > 0 ? "border-l-red-500" : "border-l-emerald-500"}`}>
            <CardContent className="pt-4 flex items-center gap-3">
              {totalFuros > 0 ? <AlertTriangle className="h-6 w-6 text-red-500" /> : <CheckCircle2 className="h-6 w-6 text-emerald-500" />}
              <div>
                <div className="font-semibold">
                  {totalFuros > 0
                    ? `${totalFuros} pendências de conferência (${brl(valorFuros)})`
                    : "Nenhuma pendência — recebimento em dia"}
                </div>
                <div className="text-xs text-slate-500">Expanda cada bloco abaixo para ver e tratar os títulos.</div>
              </div>
            </CardContent>
          </Card>

          {/* Furos */}
          <div className="space-y-2 mb-6">
            {furos.map((f) => {
              const g = GRAV[f.gravidade] || GRAV.baixa;
              const aberto = !!abertos[f.chave];
              const ok = num(f.qtd) === 0;
              return (
                <Card key={f.chave} className={ok ? "opacity-70" : ""}>
                  <button className="w-full text-left" onClick={() => !ok && toggle(f.chave)}>
                    <CardHeader className="py-3">
                      <div className="flex items-center gap-3">
                        {ok ? <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
                          : aberto ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                            {f.titulo}
                            {!ok && <Badge variant="outline" className={g.cls}>{g.label}</Badge>}
                          </CardTitle>
                          <div className="text-xs text-slate-500 mt-0.5">{f.descricao}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className={`font-bold ${ok ? "text-emerald-600" : "text-red-600"}`}>{num(f.qtd)}</div>
                          <div className="text-xs text-slate-400">{brl(f.valor)}</div>
                        </div>
                      </div>
                    </CardHeader>
                  </button>
                  {aberto && !ok && (
                    <CardContent className="pt-0">
                      <div className="border rounded-lg overflow-auto max-h-[50vh]">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Título/Doc</TableHead>
                              <TableHead>Cliente</TableHead>
                              <TableHead>Forma</TableHead>
                              <TableHead>Emissão</TableHead>
                              <TableHead>Vencimento</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Valor</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(f.lista || []).map((x: any, i: number) => (
                              <TableRow key={i}>
                                <TableCell className="font-mono text-xs">{x.titulo ?? x.documento ?? "-"}</TableCell>
                                <TableCell className="max-w-[220px] truncate">{x.cliente || "-"}</TableCell>
                                <TableCell>{x.forma || "-"}</TableCell>
                                <TableCell>{dt(x.emissao)}</TableCell>
                                <TableCell>{dt(x.vencimento)}</TableCell>
                                <TableCell>{x.status || "-"}</TableCell>
                                <TableCell className="text-right">{brl(x.valor)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {num(f.qtd) > (f.lista?.length || 0) && (
                        <div className="text-xs text-slate-400 mt-1">
                          Mostrando os {f.lista?.length} maiores de {num(f.qtd)}.
                        </div>
                      )}
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Panorama por canal e por conta */}
          <div className="grid lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="py-3"><CardTitle className="text-sm">Por canal (forma de pagamento)</CardTitle></CardHeader>
              <CardContent>
                <div className="border rounded-lg overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Forma</TableHead>
                        <TableHead className="text-right">Títulos</TableHead>
                        <TableHead className="text-right">Valor</TableHead>
                        <TableHead className="text-right">Prazo médio</TableHead>
                        <TableHead className="text-right">% Receb.</TableHead>
                        <TableHead className="text-right">% Concil.</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {porCanal.map((c, i) => (
                        <TableRow key={i}>
                          <TableCell className="capitalize">{c.forma}</TableCell>
                          <TableCell className="text-right">{num(c.titulos)}</TableCell>
                          <TableCell className="text-right">{brl(c.valor)}</TableCell>
                          <TableCell className="text-right">{c.prazo_medio_dias != null ? `${c.prazo_medio_dias}d` : "-"}</TableCell>
                          <TableCell className="text-right">{c.pct_recebido != null ? `${c.pct_recebido}%` : "-"}</TableCell>
                          <TableCell className="text-right">{c.pct_conciliado != null ? `${c.pct_conciliado}%` : "-"}</TableCell>
                        </TableRow>
                      ))}
                      {porCanal.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-slate-400 py-6">Sem dados</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="py-3"><CardTitle className="text-sm">Onde o dinheiro caiu (recebidos)</CardTitle></CardHeader>
              <CardContent>
                <div className="border rounded-lg overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Conta</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead className="text-right">Títulos</TableHead>
                        <TableHead className="text-right">Valor</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {porConta.map((c, i) => {
                        const semConta = c.conta === "(não informada)";
                        return (
                          <TableRow key={i} className={semConta ? "bg-amber-50" : ""}>
                            <TableCell className={semConta ? "text-amber-800 font-medium" : ""}>{c.conta}</TableCell>
                            <TableCell className="capitalize text-slate-500">{c.tipo}</TableCell>
                            <TableCell className="text-right">{num(c.titulos)}</TableCell>
                            <TableCell className="text-right">{brl(c.valor)}</TableCell>
                          </TableRow>
                        );
                      })}
                      {porConta.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-slate-400 py-6">Sem dados</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-slate-400 mt-4">{data?.contexto}</p>
        </>
      )}
    </div>
  );
}
