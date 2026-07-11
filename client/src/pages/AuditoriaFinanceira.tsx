import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ShieldAlert, FileWarning, Banknote, RefreshCw, CheckCircle2, DollarSign, Link2, Wallet,
} from "lucide-react";

const fmt = (v: any) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtD = (s?: string) =>
  s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "-";
const fmtDT = (s?: string) =>
  s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-";

function KpiCard({ title, value, sub, icon: Icon, tone }: any) {
  const tones: Record<string, string> = {
    green: "text-green-600 bg-green-50",
    red: "text-red-600 bg-red-50",
    amber: "text-amber-600 bg-amber-50",
    blue: "text-blue-600 bg-blue-50",
  };
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`rounded-lg p-2 ${tones[tone] || tones.blue}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">{title}</div>
          <div className="text-lg font-bold truncate">{value}</div>
          {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AuditoriaFinanceira() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<any>({
    queryKey: ["/api/admin/financial/auditoria-integridade"],
    queryFn: async () => {
      const r = await fetch("/api/admin/financial/auditoria-integridade", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error("Falha ao carregar a auditoria financeira");
      return r.json();
    },
    refetchInterval: 300000,
  });

  const semCob = data?.faturadoSemCobranca || { n: 0, valor: 0, itens: [] };
  const semLastro = data?.baixaSemLastroBancario || { n: 0, valor: 0, itens: [] };
  const ctx = data?.contexto || {};
  const semProblemas = !isLoading && !error && (semCob.n || 0) === 0 && (semLastro.n || 0) === 0;

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto space-y-5">
      <BackToDashboardButton />

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-rose-600" /> Auditoria Financeira — Antivazamento
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Detecção <b>somente leitura</b> de elos faltantes na cadeia de lastro: vendas faturadas sem cobrança
            e baixas sem movimento bancário conciliado. Nenhum dado é alterado por esta tela.
          </p>
          {data?.geradoEm && (
            <p className="text-xs text-muted-foreground mt-1">Gerado em {fmtDT(data.geradoEm)}</p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} /> Atualizar
        </Button>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Carregando auditoria…</div>}
      {error && (
        <Card><CardContent className="p-4 text-sm text-red-600">
          Não foi possível carregar a auditoria financeira. Tente atualizar.
        </CardContent></Card>
      )}

      {semProblemas && (
        <Card className="border-green-200">
          <CardContent className="p-4 flex items-center gap-3 text-green-700">
            <CheckCircle2 className="h-6 w-6" />
            <div><b>Nenhum vazamento detectado.</b> Todo faturamento tem cobrança e toda baixa tem lastro bancário.</div>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && (
        <>
          {/* KPIs principais */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <KpiCard tone="red" icon={FileWarning}
              title="Faturado sem cobrança"
              value={fmt(semCob.valor)}
              sub={`${semCob.n} título(s) de venda em aberto sem boleto/PIX vinculado`} />
            <KpiCard tone="amber" icon={Banknote}
              title="Baixa sem lastro bancário"
              value={fmt(semLastro.valor)}
              sub={`${semLastro.n} baixa(s) sem conta financeira / movimento conciliado`} />
          </div>

          {/* Contexto */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard tone="blue" icon={DollarSign} title="Recebíveis de venda" value={ctx.receb_venda ?? "-"} />
            <KpiCard tone="blue" icon={Link2} title="Boletos" value={ctx.boletos ?? "-"} />
            <KpiCard tone="blue" icon={Link2} title="PIX" value={ctx.pix ?? "-"} />
            <KpiCard tone="blue" icon={CheckCircle2} title="Pagamentos" value={ctx.pagamentos ?? "-"} />
            <KpiCard tone="blue" icon={Wallet} title="Movimentos" value={ctx.movimentos ?? "-"} />
            <KpiCard tone="blue" icon={Wallet} title="Itens de extrato" value={ctx.itens_extrato ?? "-"} />
          </div>

          {/* Tabela 1 — faturado sem cobrança */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <FileWarning className="h-4 w-4 text-red-600" />
                Faturado sem cobrança
                <Badge variant="secondary">{semCob.n}</Badge>
                <span className="text-sm font-normal text-muted-foreground">· {fmt(semCob.valor)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Título</TableHead>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Saldo</TableHead>
                      <TableHead>Vencimento</TableHead>
                      <TableHead>Forma</TableHead>
                      <TableHead>Instância</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(semCob.itens || []).length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Nenhum título de venda sem cobrança.</TableCell></TableRow>
                    )}
                    {(semCob.itens || []).map((it: any) => (
                      <TableRow key={it.id}>
                        <TableCell className="font-mono text-xs">{it.titulo || "-"}</TableCell>
                        <TableCell className="max-w-[280px] truncate">{it.cliente || "-"}</TableCell>
                        <TableCell className="text-right font-semibold">{fmt(it.saldo)}</TableCell>
                        <TableCell>{fmtD(it.vencimento)}</TableCell>
                        <TableCell>{it.forma || "-"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{it.instancia || "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {(semCob.itens || []).length >= 200 && (
                <div className="text-xs text-muted-foreground p-3">Exibindo os 200 maiores. Refine na origem para ver todos.</div>
              )}
            </CardContent>
          </Card>

          {/* Tabela 2 — baixa sem lastro */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Banknote className="h-4 w-4 text-amber-600" />
                Baixa sem lastro bancário
                <Badge variant="secondary">{semLastro.n}</Badge>
                <span className="text-sm font-normal text-muted-foreground">· {fmt(semLastro.valor)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recebível</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Pago em</TableHead>
                      <TableHead>Forma</TableHead>
                      <TableHead>Registrado por</TableHead>
                      <TableHead>Obs.</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(semLastro.itens || []).length === 0 && (
                      <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Nenhuma baixa sem lastro bancário.</TableCell></TableRow>
                    )}
                    {(semLastro.itens || []).map((it: any) => (
                      <TableRow key={it.id}>
                        <TableCell className="font-mono text-xs">{it.receivable_id || "-"}</TableCell>
                        <TableCell className="text-right font-semibold">{fmt(it.valor)}</TableCell>
                        <TableCell>{fmtDT(it.pago_em)}</TableCell>
                        <TableCell>{it.forma || "-"}</TableCell>
                        <TableCell className="text-xs">{it.created_by || <span className="text-red-600">— (não registrado)</span>}</TableCell>
                        <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground">{it.notes || "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {(semLastro.itens || []).length >= 200 && (
                <div className="text-xs text-muted-foreground p-3">Exibindo os 200 mais recentes.</div>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Fase 0 do plano de evolução financeiro — detecção somente leitura. As correções (garantia de cobrança,
            baixa só com lastro) entram nas fases seguintes, sempre de forma auditável e sem perder dados.
          </p>
        </>
      )}
    </div>
  );
}
