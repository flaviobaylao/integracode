import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { MapPin, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface GeocodeStatus {
  running?: boolean;
  at?: string;
  candidates?: number;
  eligibleTotal?: number;
  remainingAfter?: number;
  processed?: number;
  pj?: number;
  pf?: number;
  updated?: number;
  dryOk?: number;
  unverified?: number;
  notFound?: number;
  errors?: number;
  none?: boolean;
}

interface GeocodeAllButtonProps {
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "secondary" | "ghost";
  className?: string;
  label?: string;
  // Se informado, geocodifica SOMENTE estes clientes (ex.: seleção da edição em massa).
  customerIds?: string[];
}

// Botao ADMIN: busca/recalcula latitude e longitude de TODOS os clientes.
// PJ -> endereco fiscal cadastrado (origem do CNPJ); PF -> endereco de cadastro. Nominatim/OSM em segundo plano.
export default function GeocodeAllButton({ size = "sm", variant = "default", className = "bg-teal-600 hover:bg-teal-700 text-white", label = "Buscar coordenadas", customerIds }: GeocodeAllButtonProps) {
  const scoped = Array.isArray(customerIds) && customerIds.length > 0;
  const { user } = useAuth();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<GeocodeStatus | null>(null);
  const startedAtRef = useRef<number>(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isAdmin = user?.role === "admin";

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  useEffect(() => () => stopPolling(), []);

  const poll = async () => {
    try {
      const s: GeocodeStatus = await apiRequest("GET", "/api/admin/customers/geocode-all/status");
      setStatus(s);
      const finished = s && s.running === false && s.at && new Date(s.at).getTime() >= startedAtRef.current - 5000;
      if (finished) {
        setRunning(false);
        stopPolling();
        toast({
          title: "Geocodificação concluída",
          description: `${s.updated || 0} clientes atualizados (PJ: ${s.pj || 0}, PF: ${s.pf || 0}).` + ((s.remainingAfter || 0) > 0 ? ` Restam ${s.remainingAfter} — clique novamente para continuar.` : ""),
        });
      }
    } catch (e) {
      // silencioso durante polling
    }
  };

  const start = async () => {
    setStarting(true);
    startedAtRef.current = Date.now();
    try {
      const r = await apiRequest("POST", "/api/admin/customers/geocode-all", scoped ? { apply: true, recalc: true, customerIds } : { apply: true, recalc: true });
      const total = r?.candidates || 0;
      const mins = Math.max(1, Math.round((total * 1.3) / 60));
      setRunning(true);
      setResultOpen(true);
      setStatus({ running: true, candidates: total, eligibleTotal: r?.eligibleTotal, remainingAfter: r?.remainingAfter, processed: 0 });
      toast({
        title: "Geocodificação iniciada",
        description: `${total} clientes nesta rodada. Tempo estimado ~${mins} min. Roda em segundo plano.`,
      });
      stopPolling();
      pollRef.current = setInterval(poll, 8000);
      setTimeout(poll, 4000);
    } catch (e: any) {
      toast({ title: "Falha ao iniciar", description: String(e?.message || e).slice(0, 160), variant: "destructive" });
    } finally {
      setStarting(false);
    }
  };

  if (!isAdmin) return null;

  const pct = status && status.candidates ? Math.min(100, Math.round(((status.processed || 0) / status.candidates) * 100)) : 0;

  return (
    <>
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        disabled={starting || running}
        onClick={() => (running ? setResultOpen(true) : setConfirmOpen(true))}
        data-testid="button-geocode-all"
      >
        {starting || running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <MapPin className="h-4 w-4 mr-1" />}
        {running ? "Geocodificando…" : label}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buscar coordenadas dos clientes</AlertDialogTitle>
            <AlertDialogDescription>
              Isso vai buscar e recalcular a latitude/longitude de <strong>{scoped ? `${customerIds!.length} cliente(s) selecionado(s)` : "todos os clientes"}</strong> (exceto os com coordenada travada).
              Clientes PJ usam o endereço fiscal cadastrado (origem do CNPJ) e clientes PF usam o endereço de cadastro no Integra.
              O processo roda em segundo plano e pode levar alguns minutos. Deseja continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={start}>Buscar coordenadas</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resultOpen} onOpenChange={setResultOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Geocodificação de clientes</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {running ? (
                  <div>
                    <div className="mb-1">Processando em segundo plano… {status?.processed || 0}/{status?.candidates || 0} ({pct}%)</div>
                    <div className="h-2 w-full rounded bg-gray-200 overflow-hidden">
                      <div className="h-2 bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-gray-500">Atualizados até agora: {status?.updated || 0}. Você pode fechar esta janela — o processo continua.</div>
                  </div>
                ) : status && !status.none ? (
                  <div className="space-y-1">
                    <div>Atualizados: <strong>{status.updated || 0}</strong> (PJ: {status.pj || 0}, PF: {status.pf || 0})</div>
                    <div className="text-xs text-gray-500">Não encontrados: {status.notFound || 0} · Cidade não confere: {status.unverified || 0} · Erros: {status.errors || 0}</div>
                    {(status.remainingAfter || 0) > 0 && (
                      <div className="text-amber-600">Ainda restam {status.remainingAfter} clientes. Clique em "Buscar coordenadas" novamente para continuar.</div>
                    )}
                  </div>
                ) : (
                  <div>Nenhuma geocodificação registrada ainda.</div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setResultOpen(false)}>Fechar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
