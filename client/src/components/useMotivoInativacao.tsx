import { useCallback, useRef, useState } from "react";
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
import { AlertTriangle } from "lucide-react";

/**
 * Popup REUTILIZÁVEL de motivo da inativação (out/2026).
 * Padroniza TODOS os botões "Inativar" do Integra: ao acionar, abre este popup pedindo o motivo
 * (mín. 5 caracteres). O motivo confirmado é gravado no backend (status_reason) e aparece na coluna
 * "Motivo" da Gestão de Clientes.
 *
 * Uso:
 *   const { pedirMotivo, MotivoModal } = useMotivoInativacao();
 *   // no handler do botão:
 *   const motivo = await pedirMotivo({ titulo: "Inativar 3 clientes" });
 *   if (!motivo) return;                 // cancelou
 *   minhaMutation.mutate(motivo);        // envia { ids, motivo }
 *   // no JSX do componente, uma vez: {MotivoModal}
 */
export function useMotivoInativacao() {
  const [open, setOpen] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [cfg, setCfg] = useState<{ titulo?: string; descricao?: string; textoBotao?: string; valorInicial?: string }>({});
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const pedirMotivo = useCallback(
    (opts?: { titulo?: string; descricao?: string; textoBotao?: string; valorInicial?: string }) => {
      setCfg(opts || {});
      setMotivo(opts?.valorInicial ? String(opts.valorInicial) : "");
      setOpen(true);
      return new Promise<string | null>((res) => {
        resolver.current = res;
      });
    },
    [],
  );

  const fechar = useCallback((valor: string | null) => {
    setOpen(false);
    const r = resolver.current;
    resolver.current = null;
    if (r) r(valor);
  }, []);

  const valido = motivo.trim().length >= 5;

  const MotivoModal = (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) fechar(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            <span>{cfg.titulo || "Motivo da inativação"}</span>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {cfg.descricao || "Informe o motivo da inativação (mínimo 5 caracteres). Ele ficará registrado no histórico do cliente e aparece na coluna Motivo da Gestão de Clientes."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            rows={3}
            placeholder="Ex.: cliente sem compras há 90 dias; manter em quarentena; fechou a loja…"
            className="w-full rounded-md border px-2.5 py-1.5 text-sm bg-background"
            data-testid="input-motivo-inativacao"
            onKeyDown={(e) => {
              // Ctrl/Cmd + Enter confirma rapidamente.
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && valido) { e.preventDefault(); fechar(motivo.trim()); }
            }}
          />
          {!valido && <p className="text-xs text-muted-foreground">Mínimo de 5 caracteres.</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => fechar(null)} data-testid="button-cancel-motivo-inativacao">Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); if (valido) fechar(motivo.trim()); }}
            disabled={!valido}
            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            data-testid="button-confirm-motivo-inativacao"
          >
            {cfg.textoBotao || "Inativar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { pedirMotivo, MotivoModal };
}
