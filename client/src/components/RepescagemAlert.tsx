import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";

// Fase 2 — Alerta EM TELA para atendentes de TELEMARKETING assim que logam:
// avisa quantos clientes cairam em repescagem para eles. O endpoint /meu-alerta
// so retorna contagem > 0 quando o usuario tem papel 'telemarketing'.
export default function RepescagemAlert() {
  const { toast } = useToast();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    fetch("/api/repescagem/meu-alerta", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.count > 0 && !shown.current) {
          shown.current = true;
          const nomes = (d.clientes || []).slice(0, 5).join(", ");
          toast({
            title: `⚠️ ${d.count} cliente(s) em repescagem para você`,
            description: `Revise a periodicidade do cliente e atenda imediatamente${nomes ? ": " + nomes : ""}${d.count > 5 ? "…" : ""}`,
            duration: 20000,
          });
        }
      })
      .catch(() => {});
  }, []);
  return null;
}
