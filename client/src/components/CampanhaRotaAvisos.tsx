// client/src/components/CampanhaRotaAvisos.tsx
// Rota do Dia: replica do admin sobre os cadastros de novos clientes da Campanha
// de Outubro (aprovado = conta como cliente novo; rejeitado = nao conta, com a
// justificativa). Mostra as decisoes dos ultimos 7 dias. Some quando nao ha aviso.
import { useQuery } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Trophy, CheckCircle2, XCircle } from "lucide-react";

type Aviso = { cliente: string; status: string; justificativa: string; quando: string };

export default function CampanhaRotaAvisos({ sellerId }: { sellerId?: string }) {
  const url = "/api/campanha/outubro/rota-avisos" + (sellerId ? "?sellerId=" + encodeURIComponent(sellerId) : "");
  const { data } = useQuery<{ rows: Aviso[] } | null>({
    queryKey: [url],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    retry: false,
    refetchInterval: 5 * 60_000,
  });
  const rows = data?.rows || [];
  if (!rows.length) return null;

  return (
    <Card className="border-emerald-200 bg-emerald-50/50 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4 text-emerald-600" />
        <div className="font-semibold text-sm">Campanha de Outubro — avisos dos seus cadastros</div>
      </div>
      <div className="space-y-1.5">
        {rows.map((a, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border bg-white px-3 py-2 text-sm">
            {a.status === "aprovado"
              ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
              : <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />}
            <div className="min-w-0">
              {a.status === "aprovado" ? (
                <span><b>{a.cliente}</b> foi <b className="text-emerald-700">aprovado</b> para a campanha — conta como seu cliente novo.</span>
              ) : (
                <span><b>{a.cliente}</b> <b className="text-red-700">não entrou</b> na campanha{a.justificativa ? " — " + a.justificativa : ""}. O cadastro e o pedido seguem na sua carteira.</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
