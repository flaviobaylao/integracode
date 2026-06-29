import { useState, useRef } from "react";
import * as XLSX from "xlsx";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

type RowResult = {
  idx: number;
  nr: number;
  payerName: string;
  document: string;
  nossoNumero: string;
  situacao: string;
  dataSituacao: string | null;
  valor: number;
  valorLiquidacao: number;
  tipoLiquidacao: string;
  status: "nao_baixado" | "ja_baixado" | "nao_encontrado";
  receivable: null | {
    id: string;
    customerName: string;
    customerDocument: string;
    amount: number;
    amountPaid: number;
    status: string;
    dueDate: string | null;
  };
  financialAccountId: string | null;
  invoiceNumber: string | null;
  matchSource: string | null;
  boletoId: string | null;
};

type Analysis = {
  total: number;
  summary: { nao_baixado: number; ja_baixado: number; nao_encontrado: number };
  rows: RowResult[];
};

const norm = (s: string) =>
  (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

// pega uma célula tentando vários nomes de coluna (sem acento/case)
function cf(obj: Record<string, any>, keysNorm: Record<string, any>, ...names: string[]) {
  for (const n of names) {
    const k = norm(n);
    if (keysNorm[k] !== undefined && keysNorm[k] !== null && keysNorm[k] !== "") return keysNorm[k];
  }
  return "";
}

const fmtMoney = (n: number) =>
  (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (d: string | null) => {
  if (!d) return "-";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("pt-BR");
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  nao_baixado: { label: "A baixar", cls: "bg-amber-100 text-amber-800" },
  ja_baixado: { label: "Já baixado", cls: "bg-green-100 text-green-800" },
  nao_encontrado: { label: "Não encontrado", cls: "bg-gray-100 text-gray-600" },
};

export default function PagamentoClientes() {
  const { toast } = useToast();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState("");
  const [tab, setTab] = useState<"nao_baixado" | "ja_baixado" | "nao_encontrado">("nao_baixado");
  const [settling, setSettling] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setLoading(true);
    setAnalysis(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
      const rows = raw
        .map((r) => {
          const kn: Record<string, any> = {};
          for (const k of Object.keys(r)) kn[norm(k)] = r[k];
          return {
            emissao: cf(r, kn, "Emissão", "Emissao", "Data Emissão"),
            vencimento: cf(r, kn, "Vencimento", "Data Vencimento"),
            nossoNumero: String(cf(r, kn, "Nosso Número", "Nosso Numero", "NossoNumero") || "").trim(),
            situacao: String(cf(r, kn, "Situação", "Situacao", "Status") || "").trim(),
            dataSituacao: cf(r, kn, "Data Situação", "Data Situacao", "Data Liquidação", "Data Liquidacao", "Data Crédito", "Data Credito"),
            valor: cf(r, kn, "Valor", "Valor Título", "Valor Titulo", "Valor Documento"),
            valorLiquidacao: cf(r, kn, "Valor Liquidação", "Valor Liquidacao", "Valor Pago", "Valor Recebido"),
            tipoLiquidacao: String(cf(r, kn, "Tipo Liquidação", "Tipo Liquidacao", "Forma", "Forma Pagamento") || "").trim(),
            documento: String(cf(r, kn, "Documento", "CPF/CNPJ", "CNPJ", "CPF", "Pagador Documento") || "").trim(),
            payerName: String(cf(r, kn, "Pagador", "Nome", "Cliente", "Sacado") || "").trim(),
          };
        })
        .filter((r) => r.nossoNumero || r.documento);

      if (!rows.length) {
        toast({ title: "Planilha vazia", description: "Não encontrei linhas válidas (verifique a coluna Nosso Número).", variant: "destructive" });
        setLoading(false);
        return;
      }

      const resp = await fetch("/api/financial/payment-verification/analyze", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Erro ao analisar");
      setAnalysis(data);
      setTab("nao_baixado");
    } catch (e: any) {
      toast({ title: "Erro", description: e.message || "Falha ao ler a planilha", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const settle = async (row: RowResult) => {
    if (!row.receivable) return;
    if (!confirm(`Dar baixa em ${row.receivable.customerName || row.payerName} — ${fmtMoney(row.valorLiquidacao || row.valor)}?`)) return;
    setSettling(row.receivable.id);
    try {
      const amount = row.valorLiquidacao || row.valor || (row.receivable.amount - row.receivable.amountPaid);
      const resp = await fetch(`/api/financial/payment-verification/settle/${row.receivable.id}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          paidAt: row.dataSituacao || undefined,
          financialAccountId: row.financialAccountId || undefined,
          paymentMethod: row.tipoLiquidacao || "boleto",
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || "Erro ao dar baixa");
      toast({ title: "Baixa registrada", description: `${row.receivable.customerName || row.payerName} — ${fmtMoney(amount)}` });
      // marca a linha como baixada localmente
      setAnalysis((prev) => {
        if (!prev) return prev;
        const rows = prev.rows.map((r) => (r.idx === row.idx ? { ...r, status: "ja_baixado" as const } : r));
        const summary = { nao_baixado: 0, ja_baixado: 0, nao_encontrado: 0 };
        rows.forEach((r) => (summary[r.status] = (summary[r.status] || 0) + 1));
        return { ...prev, rows, summary };
      });
    } catch (e: any) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    } finally {
      setSettling(null);
    }
  };

  const shown = analysis ? analysis.rows.filter((r) => r.status === tab) : [];

  return (
    <div className="p-6 space-y-6">
      <BackToDashboardButton />
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <i className="fas fa-credit-card text-primary" /> Pagamento Clientes
        </h1>
        <p className="text-muted-foreground text-sm">
          Importe a planilha de boletos do banco (XLSX). O sistema concilia cada linha pelo Nosso
          Número (ou documento) com os recebíveis e permite dar baixa nos pagos.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <i className="fas fa-file-excel text-muted-foreground" /> Importar planilha
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={() => fileRef.current?.click()} disabled={loading}>
              <i className="fas fa-upload mr-2" /> {loading ? "Analisando..." : "Selecionar planilha"}
            </Button>
            {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            Colunas reconhecidas: Nosso Número, Situação/Status, Data Situação/Liquidação, Valor,
            Tipo Liquidação/Forma, Documento, Pagador.
          </p>
        </CardContent>
      </Card>

      {analysis && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              <i className="fas fa-list-check text-muted-foreground" /> Resultado
              <span className="text-sm font-normal text-muted-foreground">({analysis.total} linhas)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(["nao_baixado", "ja_baixado", "nao_encontrado"] as const).map((k) => (
                <Button key={k} variant={tab === k ? "default" : "outline"} size="sm" onClick={() => setTab(k)}>
                  {STATUS_META[k].label} <Badge className="ml-2" variant="secondary">{analysis.summary[k] || 0}</Badge>
                </Button>
              ))}
            </div>

            <div className="overflow-auto max-h-[70vh] border rounded-md">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background z-10">
                  <tr className="text-left border-b">
                    <th className="p-2">Cliente</th>
                    <th className="p-2">Documento</th>
                    <th className="p-2">Nosso Número</th>
                    <th className="p-2">NF</th>
                    <th className="p-2 text-right">Valor</th>
                    <th className="p-2">Pago em</th>
                    <th className="p-2">Vínculo</th>
                    <th className="p-2">Situação</th>
                    <th className="p-2 text-right">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={9} className="p-4 text-center text-muted-foreground">Nenhuma linha nesta categoria.</td></tr>
                  )}
                  {shown.map((row) => (
                    <tr key={row.idx} className="border-b hover:bg-muted/30">
                      <td className="p-2">{row.receivable?.customerName || row.payerName || "-"}</td>
                      <td className="p-2">{row.receivable?.customerDocument || row.document || "-"}</td>
                      <td className="p-2 font-mono text-xs">{row.nossoNumero || "-"}</td>
                      <td className="p-2">{row.invoiceNumber || "-"}</td>
                      <td className="p-2 text-right">{fmtMoney(row.valorLiquidacao || row.valor)}</td>
                      <td className="p-2">{fmtDate(row.dataSituacao)}</td>
                      <td className="p-2">
                        {row.matchSource ? (
                          <Badge variant="outline" className="text-[10px]">{row.matchSource === "nossoNumero" ? "Nosso Número" : "Documento"}</Badge>
                        ) : "-"}
                      </td>
                      <td className="p-2">
                        <Badge className={STATUS_META[row.status].cls}>{STATUS_META[row.status].label}</Badge>
                      </td>
                      <td className="p-2 text-right">
                        {row.status === "nao_baixado" && row.receivable ? (
                          <Button size="sm" onClick={() => settle(row)} disabled={settling === row.receivable.id}>
                            {settling === row.receivable.id ? "..." : "Dar baixa"}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
