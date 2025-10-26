import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

interface VersionInfo {
  version: string;
  buildDate: string;
  name: string;
  history: Array<{
    version: string;
    date: string;
    changes: string;
  }>;
}

export function VersionDisplay() {
  const { data: versionInfo } = useQuery<VersionInfo>({
    queryKey: ['/api/version'],
    staleTime: 1000 * 60 * 60, // 1 hora - versão não muda com frequência
  });

  if (!versionInfo) return null;

  const buildDate = new Date(versionInfo.buildDate);
  const formattedDate = format(buildDate, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 cursor-help">
            <Badge 
              variant="outline" 
              className="font-mono text-xs bg-honest-blue/10 text-honest-blue border-honest-blue/30 hover:bg-honest-blue/20"
              data-testid="badge-version"
            >
              v{versionInfo.version}
            </Badge>
            <Info className="h-3 w-3 text-gray-400" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-sm p-4">
          <div className="space-y-3">
            <div>
              <p className="font-semibold text-sm mb-1">{versionInfo.name}</p>
              <p className="text-xs text-gray-500">
                Build: {formattedDate}
              </p>
            </div>
            
            {versionInfo.history && versionInfo.history.length > 0 && (
              <div>
                <p className="font-semibold text-xs mb-2">Histórico Recente:</p>
                <div className="space-y-2 text-xs">
                  {versionInfo.history.map((item, idx) => (
                    <div key={idx} className="border-l-2 border-honest-blue/30 pl-2">
                      <p className="font-mono font-semibold">v{item.version}</p>
                      <p className="text-gray-500">{item.changes}</p>
                      <p className="text-gray-400 text-[10px]">{item.date}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
