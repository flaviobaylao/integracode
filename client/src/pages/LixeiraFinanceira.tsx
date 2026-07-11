import { useState } from "react";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, RotateCcw, RefreshCw, ArrowDownCircle, ArrowUpCircle, CheckCircle2 } from "lucide-react";

const fmt = (v: any) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtD = (s?: string) =>
  s ? new Date(s).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "-";
const fmtDT = (s?: string) =>
  s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "-";

export default function LixeiraFinanceira() {
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery<any>({
    queryKey: ["/api/financial/lixeira"],
    queryFn: async () => {
      const r = await fetch("/api/financial/lixeira", { credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error("Falha ao carregar a lixeira financeira");
      return r.json();
    },
  });

  const restore = useMutation({
    mutationFn: async ({ kind, id }: { kind: "payables" | "receivables"; id: string }) => {
      const r = await fetch(`/api/financial/${kind}/${id}/restore`, { method: "POST", credentials: "include" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || "Falha ao restaurar");
      }
      return r.json();
    },
    onMutate: ({ id }) => setRestoring(id),
    onSuccess: (row: any) => {
      setOkMsg(`Conta "${row.titleNumber || row.title || row.supplierName || row.customerName || row.id}" restaurada com sucesso.`);
      setTimeout(() => setOkMsg(null), 6000);
      qc.invalidateQueries({ queryKey: ["/api/financial/lixeira"] });
      qc.invalidateQueries({ queryKey: ["/api/financial/payables"] });
      qc.invalidateQueries({ queryKey: ["/api/financial/receivables"] });
    },
    onSettled: () => setRestoring(null),
  });

  const pays: any[] = data?.payables || [];
  const recs: any[] = data?.receivables || [];
  const vazio = !isLoading && !error && pays.length === 0 && recs.length === 0;

  const Tabela = ({ itens, kind }: { itens: any[]; kind: "payables" | "receivables" }) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Título</TableHead>
          <TableHead>{kind === "payables" ? "Fornecedor" : "Cliente"}</TableHead>
          <TableHead className="text-right">Valor</TableHead>
          <TableHead>Vencimento</TableHead>
          <TableHead>Excluído por</TableHead>
          <TableHead>Excluído em</TableHead>
          <TableHead className="text-right">Ação</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {itens.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="font-medium">{p.titleNumber || "-"}</TableCell>
            <TableCell className="max-w-[220px] truncate">{kind === "payables" ? (p.supplierName || "-") : (p.customerName || "-")}</TableCell>
            <TableCell className="text-right">{fmt(p.amount)}</TableCell>
            <TableCell>{fmtD(p.dueDate)}</TableCell>
            <TableCell className="max-w-[200px] truncate">{p.deletedBy || "-"}</TableCell>
            <TableCell>{fmtDT(p.deletedAt)}</TableCell>
            <TableCell className="text-right">
              <Button
                size="sm"
                variant="outline"
                disabled={restoring === p.id}
                onClick={() => restore.mutate({ kind, id: p.id })}
              >
                <RotateCcw className={`h-4 w-4 mr-1 ${restoring === p.id ? "animate-spin" : ""}`} />
                {restoring === p.id ? "Restaurando..." : "Restaurar"}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto space-y-5">
      <BackToDashboardButton />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg p-2 text-red-600 bg-red-50">
            <Trash2 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Lixeira Financeira</h1>
            <p className="text-sm text-muted-foreground">
              Contas excluídas ficam guardadas aqui (nada é apagado de verdade) e podem ser restauradas.
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </div>

      {okMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 text-green-700 px-4 py-3 text-sm">
          <CheckCircle2 className="h-4 w-4" /> {okMsg}
        </div>
      )}
      {restore.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
          {(restore.error as any)?.message || "Falha ao restaurar"}
        </div>
      )}

      {isLoading && <div className="text-sm text-muted-foreground">Carregando lixeira...</div>}
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
          {(error as any)?.message || "Erro ao carregar"}
        </div>
      ) : null}

      {vazio && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-600" />
            A lixeira está vazia — nenhuma conta excluída.
          </CardContent>
        </Card>
      )}

      {pays.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowDownCircle className="h-4 w-4 text-red-600" />
              Contas a Pagar excluídas
              <Badge variant="secondary">{pays.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Tabela itens={pays} kind="payables" />
          </CardContent>
        </Card>
      )}

      {recs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowUpCircle className="h-4 w-4 text-green-600" />
              Contas a Receber excluídas
              <Badge variant="secondary">{recs.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Tabela itens={recs} kind="receivables" />
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Cada exclusão e restauração fica registrada na trilha de auditoria com usuário, data e hora.
      </p>
    </div>
  );
}
