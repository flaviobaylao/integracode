import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

// Contabilidade: relatórios gravados no Integra para o contador (snapshots).
export default function Contabilidade() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const lista = useQuery<any[]>({
    queryKey: ["/api/contabilidade/relatorios"],
    queryFn: async () => {
      const r = await fetch("/api/contabilidade/relatorios", { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
      return r.json();
    },
  });
  const gerar = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/contabilidade/relatorios/nf-a-inutilizar", { method: "POST", credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      return j;
    },
    onSuccess: (j: any) => { toast({ title: "Relatório gravado", description: j?.nome_arquivo }); qc.invalidateQueries({ queryKey: ["/api/contabilidade/relatorios"] }); },
    onError: (e: any) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Contabilidade</h1>
        <p className="text-sm text-gray-500 mt-1">Relatórios gravados no Integra para envio ao contador. Cada arquivo fica congelado na data em que foi gerado.</p>
      </div>

      <Card>
        <CardHeader className="border-b py-3"><CardTitle className="text-base">Gerar relatório</CardTitle></CardHeader>
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-gray-800">Números de NF a inutilizar — por empresa</p>
            <p className="text-xs text-gray-500">Planilha com resumo, uma aba por empresa/modelo/série (faixas, ano, prazo legal) e os pedidos já enviados à SEFAZ.</p>
          </div>
          <Button onClick={() => gerar.mutate()} disabled={gerar.isPending}>{gerar.isPending ? "Gerando..." : "Gerar e gravar"}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b py-3"><CardTitle className="text-base">Relatórios gravados</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr><th className="text-left p-2">Data</th><th className="text-left p-2">Relatório</th><th className="text-left p-2">Categoria</th><th className="text-left p-2">Resumo</th><th className="text-left p-2">Gerado por</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {(lista.data || []).map((r: any) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 text-xs whitespace-nowrap">{new Date(r.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</td>
                  <td className="p-2"><div className="font-medium">{r.titulo}</div><div className="text-xs text-gray-500">{r.nome_arquivo} · {Math.round((r.tamanho || 0) / 1024)} KB</div></td>
                  <td className="p-2"><Badge className="bg-slate-100 text-slate-700">{r.categoria}</Badge></td>
                  <td className="p-2 text-xs">{r.descricao}</td>
                  <td className="p-2 text-xs">{r.created_by || "—"}</td>
                  <td className="p-2 text-right"><a className="text-blue-600 underline text-sm" href={`/api/contabilidade/relatorios/${r.id}/arquivo`}>Baixar</a></td>
                </tr>
              ))}
              {lista.isLoading && <tr><td colSpan={6} className="p-3 text-sm text-gray-500">Carregando...</td></tr>}
              {!lista.isLoading && !lista.data?.length && <tr><td colSpan={6} className="p-3 text-sm text-gray-500">Nenhum relatório gravado ainda.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
