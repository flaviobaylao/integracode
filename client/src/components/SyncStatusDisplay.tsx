import { useQuery } from "@/lib/queryClient";
import { Clock, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Progress } from "@/components/ui/progress";

interface SyncStatus {
  id: string;
  syncType: string;
  lastSyncAt: string;
  status: 'success' | 'error' | 'in_progress';
  message?: string;
  recordsProcessed?: number;
  totalRecords?: number;
  currentProgress?: number;
  lastFinishedAt?: string;
}

interface SyncStatusDisplayProps {
  syncType?: string;
  compact?: boolean;
}

export function SyncStatusDisplay({ syncType = 'omie_complete', compact = false }: SyncStatusDisplayProps) {
  const { data: statuses, isLoading } = useQuery<SyncStatus[]>({
    queryKey: ['/api/sync-status'],
    refetchInterval: (query) => {
      // Atualiza mais rápido quando há sincronização em progresso
      const data = query.state.data;
      const hasInProgress = Array.isArray(data) && data.some((s: SyncStatus) => s.status === 'in_progress');
      return hasInProgress ? 2000 : 30000; // 2s em progresso, 30s normal
    },
  });

  const syncStatus = Array.isArray(statuses) ? statuses.find((s: SyncStatus) => s.syncType === syncType) : undefined;

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

  const finishedDate = syncStatus.lastFinishedAt 
    ? format(new Date(syncStatus.lastFinishedAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })
    : null;

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="sync-status-full">
      <div className="flex items-center gap-2">
        {syncStatus.status === 'in_progress' ? (
          <Loader2 className="h-4 w-4 text-yellow-600 animate-spin" />
        ) : (
          <Clock className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-muted-foreground">
          {syncStatus.status === 'in_progress' ? 'Sincronizando...' : 'Última sincronização:'}
        </span>
        <span className="font-medium">
          {syncStatus.status === 'in_progress' && finishedDate ? finishedDate : formattedDate}
        </span>
      </div>
      
      {syncStatus.status === 'in_progress' && syncStatus.currentProgress !== undefined && (
        <div className="pl-6 space-y-1" data-testid="sync-progress-bar">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Progresso: {syncStatus.currentProgress}%</span>
            {syncStatus.recordsProcessed !== undefined && syncStatus.totalRecords !== undefined && (
              <span>{syncStatus.recordsProcessed} / {syncStatus.totalRecords}</span>
            )}
          </div>
          <Progress value={syncStatus.currentProgress} className="h-2" />
        </div>
      )}
      
      {syncStatus.status !== 'in_progress' && (
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
      )}
      
      {syncStatus.message && syncStatus.status === 'error' && (
        <div className="pl-6 text-xs text-red-600" data-testid="sync-error-message">
          {syncStatus.message}
        </div>
      )}
    </div>
  );
}
