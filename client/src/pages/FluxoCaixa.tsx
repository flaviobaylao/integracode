import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportToExcel, ExportExcelButton } from "@/lib/tableTools";

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const ZERO12 = () => new Array(12).fill(0);

// FASE 3.3 - Fluxo de caixa em regime de caixa: realizado = pagamentos efetivos
// (data em que o dinheiro entrou/saiu); previsto = titulos abertos por vencimento.
// Cancelados e apagados nao entram. Quebra por conta bancaria.
export default function FluxoCaixa() {
  const hoje = new Date();
  const [year, setYear] = useState(hoje.getFullYear());
  const [conta, setConta] = useState("todas");
  const q = useQuery({
    queryKey: ["/api/financial/cashflow", year],
    queryFn: async () => (await fetch(`/api/financial/cashflow?year=${year}`, { credentials: "include" })).json(),
  });
  const d: any = q.data;
  const accounts: any[] = Array.isArray(d?.accounts) ? d.accounts : [];

  const pick = (bucket: any): number[] => {
    if (!bucket) return ZERO12();
    if (conta === "todas") return bucket.total || ZERO12();
    return bucket[conta] || ZERO12();
  };
  const pickScalar = (bucket: any): number => {
    if (!bucket) return 0;
    if (conta === "todas") return Number(bucket.total || 0);
    return Number(bucket[conta] || 0);
  };

  const saldoBase = useMemo(() => {
    if (conta === "todas") return accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
    if (conta === "sem_conta") return 0;
    return Number(accounts.find((a) => a.id === conta)?.balance || 0);
  }, [accounts, conta]);

  const rows = useMemo(() => {
    const re = pick(d?.realizado?.entradas), rs = pick(d?.realizado?.saidas);
    const pe = pick(d?.previsto?.entradas), ps = pick(d?.previsto?.saidas);
    const anoAtual = year === hoje.getFullYear();
    const mesAtual = hoje.getMonth();
    let saldo = saldoBase;
    return MESES.map((mes, i) => {
      const projetavel = anoAtual && i >= mesAtual;
      if (projetavel) saldo += pe[i] - ps[i];
      return {
        mes: `${mes}/${year}`,
        recebido: re[i], pago: rs[i], resultado: re[i] - rs[i],
        aReceber: pe[i], aPagar: ps[i],
        saldoProj: projetavel ? saldo : null,
      };
    });
  }, [d, conta, year, saldoBase]);

  const tot = useMemo(() => rows.reduce((t, r) => ({
    recebido: t.recebido + r.recebido, pago: t.pago + r.pago,
    aReceber: t.aReceber + r.aReceber, aPagar: t.aPagar + r.aPagar,
  }), { recebido: 0, pago: 0, aReceber: 0, aPagar: 0 }), [rows]);

  const atrEnt = pickScalar(d?.atrasados?.entradas);
  const atrSai = pickScalar(d?.atrasados?.saidas);
  const thCls = "sticky top-0 bg-background z-10 px-2 py-2 text-left whitespace-nowrap";

  return (
    <div className="p-6">
      <BackToDashboardButton />
      <h1 className="text-2xl font-bold mb-1">Fluxo de Caixa</h1>
      <p className="text-sm text-gray-500 mb-3">
        Regime de caixa: Recebido/Pago pela data real do pagamento; A receber/A pagar pelos titulos abertos (vencimento).
        Cancelados nao entram. Saldo projetado parte do saldo atual da(s) conta(s) e so e exibido do mes corrente em diante.
      </p>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1">
          <button data-testid="fluxo-ano-prev" className="border rounded px-2 py-1 text-sm" onClick={() => setYear((y) => y - 1)}>◀</button>
          <span className="font-semibold w-14 text-center">{year}</span>
          <button data-testid="fluxo-ano-next" className="border rounded px-2 py-1 text-sm" onClick={() => setYear((y) => y + 1)}>▶</button>
        </div>
        <select data-testid="fluxo-conta" className="border rounded px-2 py-1 text-sm bg-background" value={conta} onChange={(e) => setConta(e.target.value)}>
          <option value="todas">Todas as contas</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          <option value="sem_conta">Sem conta vinculada</option>
        </select>
        <ExportExcelButton testId="export-fluxo" onClick={() => exportToExcel(rows.map((r) => ({
          Mes: r.mes, Recebido: r.recebido, Pago: r.pago, Resultado: r.resultado,
          "A Receber": r.aReceber, "A Pagar": r.aPagar, "Saldo Projetado": r.saldoProj ?? "",
        })), "fluxo-de-caixa")} />
      </div>
      {(atrEnt > 0 || atrSai > 0) && (
        <div className="text-sm mb-3 border border-amber-300 bg-amber-50 text-amber-900 rounded px-3 py-2">
          Em atraso de anos anteriores (nao incluso na tabela): a receber {brl(atrEnt)} · a pagar {brl(atrSai)}
        </div>
      )}
      <div className="border rounded-lg overflow-auto max-h-[75vh]">
        <Table>
          <TableHeader><TableRow>
            <TableHead className={thCls}>Mes</TableHead>
            <TableHead className={thCls}>Recebido</TableHead>
            <TableHead className={thCls}>Pago</TableHead>
            <TableHead className={thCls}>Resultado</TableHead>
            <TableHead className={thCls}>A Receber (prev.)</TableHead>
            <TableHead className={thCls}>A Pagar (prev.)</TableHead>
            <TableHead className={thCls}>Saldo Projetado</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.mes}>
                <TableCell className="font-medium">{r.mes}</TableCell>
                <TableCell className="text-green-700">{r.recebido ? brl(r.recebido) : "—"}</TableCell>
                <TableCell className="text-red-700">{r.pago ? brl(r.pago) : "—"}</TableCell>
                <TableCell className={r.resultado >= 0 ? "text-green-700 font-semibold" : "text-red-700 font-semibold"}>{r.recebido || r.pago ? brl(r.resultado) : "—"}</TableCell>
                <TableCell className="text-green-700/80">{r.aReceber ? brl(r.aReceber) : "—"}</TableCell>
                <TableCell className="text-red-700/80">{r.aPagar ? brl(r.aPagar) : "—"}</TableCell>
                <TableCell className={r.saldoProj == null ? "text-gray-400" : (r.saldoProj >= 0 ? "text-green-700 font-semibold" : "text-red-700 font-semibold")}>{r.saldoProj == null ? "—" : brl(r.saldoProj)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="bg-muted/50 font-semibold">
              <TableCell>Total {year}</TableCell>
              <TableCell className="text-green-700">{brl(tot.recebido)}</TableCell>
              <TableCell className="text-red-700">{brl(tot.pago)}</TableCell>
              <TableCell className={tot.recebido - tot.pago >= 0 ? "text-green-700" : "text-red-700"}>{brl(tot.recebido - tot.pago)}</TableCell>
              <TableCell className="text-green-700/80">{brl(tot.aReceber)}</TableCell>
              <TableCell className="text-red-700/80">{brl(tot.aPagar)}</TableCell>
              <TableCell></TableCell>
            </TableRow>
            {q.isLoading && <TableRow><TableCell colSpan={7} className="text-center text-gray-400 py-8">Carregando…</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Saldo atual da(s) conta(s) selecionada(s): {brl(saldoBase)}. Titulos sem conta vinculada aparecem no filtro "Sem conta vinculada".
      </p>
    </div>
  );
}
