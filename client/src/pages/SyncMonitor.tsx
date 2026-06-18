import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, ArrowRightLeft, CheckCircle, XCircle, Clock } from "lucide-react";

interface SyncSetting {
  key: string;
  value: string;
  updatedAt: string;
}

interface SyncStatus {
  key: string;
  lastAt: string | null;
  label: string;
  direction: string;
  enabled: boolean;
}

function formatRelative(dateStr: string | null): string {
  if (!dateStr) return "Nunca executado";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Agora há pouco";
  if (diffMin < 60) return `Há ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Há ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  return `Há ${diffD} dia(s)`;
}

export default function SyncMonitor() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [runningSync, setRunningSync] = useState<string | null>(null);

  const { data: settings, isLoading, refetch } = useQuery<SyncSetting[]>({
    queryKey: ["/api/admin/sync-status"],
    refetchInterval: 30000,
  });

  const triggerMutation = useMutation({
    mutationFn: async (direction: "1to2" | "2to1") => {
      setRunningSync(direction);
      const res = await fetch(`/api/admin/sync/trigger-${direction}`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (data, direction) => {
      toast({ title: "Sync executado", description: `${data.totalRows || 0} linhas sincronizadas` });
      qc.invalidateQueries({ queryKey: ["/api/admin/sync-status"] });
    },
    onError: (err: any) => {
      toast({ title: "Erro no sync", description: err.message, variant: "destructive" });
    },
    onSettled: () => setRunningSync(null),
  });

  const syncs: SyncStatus[] = [
    {
      key: "sync_1_0_last_at",
      label: "Sync 1.0 → 2.0",
      direction: "1to2",
      lastAt: settings?.find(s => s.key === "sync_1_0_last_at")?.value ?? null,
      enabled: true,
    },
    {
      key: "sync_2_0_last_at",
      label: "Sync 2.0 → 1.0",
      direction: "2to1",
      lastAt: settings?.find(s => s.key === "sync_2_0_last_at")?.value ?? null,
      enabled: true,
    },
  ];

  const isRecent = (dateStr: string | null) => {
    if (!dateStr) return false;
    return Date.now() - new Date(dateStr).getTime() < 15 * 60 * 1000;
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Monitor de Sincronização</h1>
          <p className="text-gray-500 text-sm mt-1">Sincronização bidirecional Integra 1.0 ↔ 2.0</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {syncs.map(sync => (
          <Card key={sync.key} className="border">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <ArrowRightLeft className="h-4 w-4 text-green-600" />
                  {sync.label}
                </CardTitle>
                <Badge variant={isRecent(sync.lastAt) ? "default" : "secondary"}
                  className={isRecent(sync.lastAt) ? "bg-green-100 text-green-800" : ""}>
                  {isRecent(sync.lastAt) ? (
                    <><CheckCircle className="h-3 w-3 mr-1" /> Recente</>
                  ) : sync.lastAt ? (
                    <><Clock className="h-3 w-3 mr-1" /> Atrasado</>
                  ) : (
                    <><XCircle className="h-3 w-3 mr-1" /> Nunca</>
                  )}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-gray-600 mb-3">
                <div className="flex justify-between">
                  <span>Última execução:</span>
                  <span className="font-medium">{formatRelative(sync.lastAt)}</span>
                </div>
                {sync.lastAt && (
                  <div className="flex justify-between mt-1">
                    <span>Horário:</span>
                    <span className="text-xs text-gray-400">
                      {new Date(sync.lastAt).toLocaleString("pt-BR")}
                    </span>
                  </div>
                )}
              </div>
              <Button
                className="w-full"
                size="sm"
                variant="outline"
                disabled={runningSync !== null}
                onClick={() => triggerMutation.mutate(sync.direction as "1to2" | "2to1")}
              >
                {runningSync === sync.direction ? (
                  <><RefreshCw className="h-3 w-3 mr-2 animate-spin" /> Executando...</>
                ) : (
                  <><RefreshCw className="h-3 w-3 mr-2" /> Executar agora</>
                )}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuração</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="font-medium text-gray-700 mb-1">Variáveis de ambiente necessárias:</p>
              <ul className="space-y-1 text-gray-600">
                <li><code className="bg-gray-100 px-1 rounded text-xs">SYNC_ENABLED=true</code> — ativa sync 1.0→2.0</li>
                <li><code className="bg-gray-100 px-1 rounded text-xs">SYNC_20_ENABLED=true</code> — ativa sync 2.0→1.0</li>
                <li><code className="bg-gray-100 px-1 rounded text-xs">REPLIT_DATABASE_URL</code> — URL do Neon (1.0)</li>
                <li><code className="bg-gray-100 px-1 rounded text-xs">SYNC_INTERVAL_MINUTES</code> — intervalo (padrão: 5)</li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-gray-700 mb-1">Tabelas sincronizadas:</p>
              <ul className="space-y-1 text-gray-600 text-xs">
                <li>customers, products, users, routes</li>
                <li>sales_cards, leads, order_history</li>
                <li>visit_agenda, daily_routes</li>
                <li>delivery_routes, delivery_drivers</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
