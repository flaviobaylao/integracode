import { useQuery } from "@tanstack/react-query";

// FASE 5 - Modal de lançamentos de uma conta/linha (DRE e Fluxo de Caixa).
// drill: { accountId?|group?|special?, label, year }
const brl = (v: any) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dt = (v: any) => v ? new Date(v).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—";

export default function AccountEntriesModal({ drill, onClose }: { drill: any; onClose: () => void }) {
  const params = new URLSearchParams();
  if (drill.accountId) params.set("accountId", drill.accountId);
  if (drill.group) params.set("group", drill.group);
  if (drill.special) params.set("special", drill.special);
  params.set("year", String(drill.year || new Date().getFullYear()));
  const q = useQuery({
    queryKey: ["/api/financial/account-entries", params.toString()],
    queryFn: async () => (await fetch(`/api/financial/account-entries?${params.toString()}`, { credentials: "include" })).json(),
  });
  const d: any = q.data;
  const rows: any[] = Array.isArray(d?.rows) ? d.rows : [];
  const total = Number(d?.total || 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-background rounded-lg shadow-xl max-w-6xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <div className="font-bold">{drill.label}</div>
            <div className="text-xs text-muted-foreground">{rows.length} lançamento(s) em {drill.year} · Total {brl(total)}</div>
          </div>
          <button className="text-2xl leading-none px-2 hover:text-red-600" onClick={onClose}>×</button>
        </div>
        <div className="overflow-auto p-2">
          {q.isLoading ? <div className="text-center text-muted-foreground py-10">Carregando…</div> : rows.length === 0 ? (
            <div className="text-center text-muted-foreground py-10">Nenhum lançamento.</div>
          ) : (
            <table className="text-xs w-full">
              <thead>
                <tr className="border-b bg-muted/50 text-left">
                  <th className="px-2 py-1">Título</th><th className="px-2 py-1">Cliente/Fornecedor</th>
                  <th className="px-2 py-1">Emissão</th><th className="px-2 py-1">Vencimento</th>
                  <th className="px-2 py-1 text-right">Valor</th><th className="px-2 py-1 text-right">Pago</th>
                  <th className="px-2 py-1">Conta do título</th><th className="px-2 py-1">Lançado por</th>
                  <th className="px-2 py-1">Pagamentos / Recebimentos (data · valor · conta · baixado por)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={idx} className="border-b align-top hover:bg-accent/30">
                    <td className="px-2 py-1 whitespace-nowrap">{r.titulo || "—"}</td>
                    <td className="px-2 py-1 max-w-[200px] truncate" title={r.contraparte || ""}>{r.contraparte || "—"}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{dt(r.emissao)}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.vencimento ? dt(r.vencimento) : "—"}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{brl(r.valor)}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{r.valorPago != null ? brl(r.valorPago) : "—"}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.contaTitulo || "—"}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{r.lancadoPor || "—"}</td>
                    <td className="px-2 py-1">
                      {(r.pagamentos && r.pagamentos.length) ? (
                        <div className="space-y-0.5">
                          {r.pagamentos.map((p: any, j: number) => (
                            <div key={j} className="whitespace-nowrap">{dt(p.data)} · {brl(p.valor)} · {p.conta || "sem conta"} · {p.baixadoPor || "—"}</div>
                          ))}
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
