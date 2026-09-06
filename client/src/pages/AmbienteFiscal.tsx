import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

// Ambiente Fiscal (E6, set/2026): a tela era o "Monitor de Sincronizacao" 1.0 <-> 2.0.
// Com o Integra 1.0 desligado, sobra o unico controle vivo: o ambiente de emissao de NF-e
// (homologacao x producao) por empresa do grupo.
export default function AmbienteFiscal() {
  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-2">
        <h1 className="text-2xl font-bold text-gray-900">Ambiente Fiscal</h1>
        <p className="text-gray-500 text-sm mt-1">Ambiente de emissao de NF-e por empresa do grupo</p>
      </div>
      <FiscalEnvCard />
    </div>
  );
}

function FiscalEnvCard() {
  const { data: envs = [], refetch, isLoading } = useQuery<any[]>({ queryKey: ['/api/admin/fiscal/environments'] });
  const { toast } = useToast();
  const setMut = useMutation({
    mutationFn: async (v: { instanceId: string; environment: string }) => {
      const r = await fetch('/api/admin/fiscal/environment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(v) });
      if (!r.ok) throw new Error(((await r.json()) || {}).error || 'falha');
      return r.json();
    },
    onSuccess: (_d: any, v: any) => { toast({ title: 'Ambiente atualizado', description: v.environment }); refetch(); },
    onError: (e: any) => toast({ title: 'Erro', description: e.message, variant: 'destructive' }),
  });
  return (
    <Card className="mt-6">
      <CardHeader className="border-b border-gray-200">
        <CardTitle className="text-lg font-semibold text-gray-800">Ambiente de Faturamento (NF-e)</CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        <p className="text-sm text-gray-600">Controle o ambiente de emissao por empresa/instancia. Mantenha em HOMOLOGACAO ate o cutover; vire para PRODUCAO ao emitir notas reais.</p>
        {isLoading ? <p className="text-sm text-gray-500">Carregando...</p> : (envs as any[]).map((row: any) => (
          <div key={row.instanceId} className="flex items-center justify-between border rounded-lg p-3">
            <div>
              <p className="font-semibold text-gray-800">{row.name}</p>
              <Badge className={row.environment === 'producao' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}>{row.environment === 'producao' ? 'PRODUCAO' : 'HOMOLOGACAO'}</Badge>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant={row.environment === 'homologacao' ? 'default' : 'outline'} disabled={setMut.isPending} onClick={() => setMut.mutate({ instanceId: row.instanceId, environment: 'homologacao' })}>Homologacao</Button>
              <Button size="sm" className={row.environment === 'producao' ? 'bg-green-600 hover:bg-green-700 text-white' : ''} variant={row.environment === 'producao' ? 'default' : 'outline'} disabled={setMut.isPending} onClick={() => { if (window.confirm('Virar PRODUCAO para ' + row.name + '? As proximas notas serao emitidas de verdade na SEFAZ.')) setMut.mutate({ instanceId: row.instanceId, environment: 'producao' }); }}>Producao</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
