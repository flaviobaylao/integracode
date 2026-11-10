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
    // 🚫 10/nov/2026 — Cliente retirado da repescagem HOJE pelo Admin: avisa quem estava com ele.
    fetch("/api/repescagem/meus-retirados", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const itens = Array.isArray(d?.itens) ? d.itens : [];
        if (!itens.length) return;
        let vistos: string[] = [];
        try { vistos = JSON.parse(sessionStorage.getItem("rep-retirados-vistos") || "[]"); } catch {}
        const novos = itens.filter((i: any) => !vistos.includes(String(i.customerId)));
        if (!novos.length) return;
        for (const i of novos.slice(0, 5)) {
          toast({
            title: `🚫 ${i.cliente} saiu da repescagem hoje`,
            description: `Motivo: ${i.motivo}${i.por ? ` (Admin: ${i.por})` : ""}. Ele saiu da sua lista/rota de repescagem só por hoje.`,
            duration: 30000,
          });
        }
        try { sessionStorage.setItem("rep-retirados-vistos", JSON.stringify(vistos.concat(novos.map((i: any) => String(i.customerId))))); } catch {}
      })
      .catch(() => {});
  }, []);
  return null;
}
