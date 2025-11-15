import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useQuery } from "@/lib/queryClient";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface SyncButtonProps {
  syncType: string;
  onSync: () => void;
  isLoading?: boolean;
  label?: string;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  "data-testid"?: string;
}

export function SyncButton({
  syncType,
  onSync,
  isLoading = false,
  label = "Sincronizar",
  variant = "outline",
  size = "default",
  className = "",
  "data-testid": testId
}: SyncButtonProps) {
  // Fetch sync status for this specific sync type
  const { data: syncStatuses } = useQuery<any[]>({
    queryKey: ['/api/sync-status'],
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const syncStatus = syncStatuses?.find(s => s.syncType === syncType);
  const lastSyncDate = syncStatus?.lastSyncAt ? new Date(syncStatus.lastSyncAt) : null;

  const formatLastSync = () => {
    if (!lastSyncDate) return null;
    
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - lastSyncDate.getTime()) / 60000);
    
    if (diffInMinutes < 1) {
      return "há menos de 1 minuto";
    } else if (diffInMinutes < 60) {
      return `há ${diffInMinutes} minuto${diffInMinutes > 1 ? 's' : ''}`;
    } else if (diffInMinutes < 1440) {
      const hours = Math.floor(diffInMinutes / 60);
      return `há ${hours} hora${hours > 1 ? 's' : ''}`;
    } else {
      return format(lastSyncDate, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        onClick={onSync}
        disabled={isLoading}
        variant={variant}
        size={size}
        className={className}
        data-testid={testId}
      >
        <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
        {label}
      </Button>
      {lastSyncDate && (
        <span className="text-xs text-muted-foreground ml-1">
          Última sincronização: {formatLastSync()}
        </span>
      )}
    </div>
  );
}
