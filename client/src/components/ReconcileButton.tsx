import { useState } from "react";
import { Button } from "@/components/ui/button";

// Atalho de reconciliação financeira com o 1.0.
// Compara os totais (1.0 x 2.0) e traz do 1.0 as contas que faltam no 2.0
// (backfill aditivo, ON CONFLICT DO NOTHING — não apaga nem altera nada existente).

const money = (n: number) =>
  (n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function ReconcileButton({
  table,
}: {
  table: "receivables" | "payables";
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [erro, setErro] = useState(false);

  const run = async () => {
    setBusy(true);
    setErro(false);
    setMsg("Comparando e reconciliando com o 1.0...");
    try {
      const post = (url: string, body: any) =>
        fetch(url, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      // 1) traz do 1.0 o que falta (aditivo)
      const rec = await post("/api/admin/financial/reconcile", { backfill: true });
      const brought = (rec.backfilled && rec.backfilled[table]) || 0;
      // 2) lê os totais finais dos dois bancos
      const tot = await post("/api/admin/financial/totals", {});
      const t = tot[table];
      const src = t.src.total;
      const tgt = t.tgt.total;
      const diff = Math.round((tgt.amount - src.amount) * 100) / 100;
      const ok = Math.abs(diff) < 0.01 && src.n === tgt.n;
      setMsg(
        `1.0: ${src.n} contas / ${money(src.amount)}  ·  2.0: ${tgt.n} / ${money(tgt.amount)}` +
          (brought ? `  ·  trazidas do 1.0: ${brought}` : "") +
          (ok ? "  ·  ✓ idêntico" : `  ·  diferença: ${money(diff)} (resíduo nativo do 2.0)`)
      );
    } catch (e: any) {
      setErro(true);
      setMsg("Erro: " + (e?.message || "falha ao reconciliar"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 flex-wrap mb-3">
      <Button variant="outline" size="sm" onClick={run} disabled={busy}>
        <i className="fas fa-rotate mr-2" />
        {busy ? "Reconciliando..." : "Reconciliar com 1.0"}
      </Button>
      {msg && (
        <span className={"text-xs " + (erro ? "text-red-600" : "text-muted-foreground")}>
          {msg}
        </span>
      )}
    </div>
  );
}
