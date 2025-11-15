import { useQuery } from "@/lib/queryClient";
import { Clock } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface SyncStatus {
  id: string;
  syncType: string;
  lastSyncAt: string;
  status: 'success' | 'error' | 'in_progress';
  message?: string;
  recordsProcessed?: number;
}

interface SyncStatusDisplayProps {
  syncType?: string;
  compact?: boolean;
}

export function SyncStatusDisplay({ syncType = 'omie_complete', compact = false }: SyncStatusDisplayProps) {
  const { data: statuses, isLoading } = useQuery<SyncStatus[]>({
    queryKey: ['/api/sync-status'],
    refetchInterval: 30000, // Atualiza a cada 30 segundos
  });

  const syncStatus = statuses?.find(s => s.syncType === syncType);

  // Mostrar loading enquanto carrega
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="sync-status-loading">
        <Clock className="h-4 w-4 animate-pulse" />
        <span>Carregando status...</span>
      </div>
    );
  }

  // Mostrar mensagem se não há dados
  if (!syncStatus) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="sync-status-empty">
        <Clock className="h-4 w-4" />
        <span>Nenhuma sincronização realizada ainda</span>
      </div>
    );
  }

  const formattedDate = format(new Date(syncStatus.lastSyncAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  
  const statusColors = {
    success: 'text-green-600',
    error: 'text-red-600',
    in_progress: 'text-yellow-600',
  };

  const statusLabels = {
    success: 'Sucesso',
    error: 'Erro',
    in_progress: 'Em progresso',
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="sync-status-compact">
        <Clock className="h-4 w-4" />
        <span>Última atualização: {formattedDate}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="sync-status-full">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Última sincronização:</span>
        <span className="font-medium">{formattedDate}</span>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <span className={`font-medium ${statusColors[syncStatus.status]}`}>
          {statusLabels[syncStatus.status]}
        </span>
        {syncStatus.recordsProcessed !== undefined && (
          <span className="text-muted-foreground">
            ({syncStatus.recordsProcessed} registros)
          </span>
        )}
      </div>
      {syncStatus.message && syncStatus.status === 'error' && (
        <div className="pl-6 text-xs text-red-600" data-testid="sync-error-message">
          {syncStatus.message}
        </div>
      )}
    </div>
  );
}
