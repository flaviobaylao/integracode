import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";

// Fase 3 — Alerta EM TELA para quem vendeu, quando uma entrega NAO e realizada.
// Vale para quem trabalha logado no sistema (telemarketing): o vendedor externo
// recebe o mesmo aviso por WhatsApp, decidido no servidor.
// O endpoint devolve so o que ainda nao foi visto e ja marca como visto — o aviso
// aparece uma vez, sem virar barulho a cada troca de tela.
export default function EntregaFalhaAlert() {
  const { toast } = useToast();
  const rodando = useRef(false);

  useEffect(() => {
    let vivo = true;

    const buscar = () => {
      if (rodando.current) return;
      rodando.current = true;
      fetch("/api/vendedor/avisos-entrega", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!vivo || !d || !d.count) return;
          for (const msg of (d.avisos || []).slice(0, 5)) {
            const linhas = String(msg).split("\n");
            toast({
              title: linhas[0] || "Entrega não realizada",
              description: linhas.slice(1).join(" · "),
              duration: 30000,
            });
          }
        })
        .catch(() => {})
        .finally(() => { rodando.current = false; });
    };

    buscar();                                   // ao abrir o app
    const t = setInterval(buscar, 5 * 60000);   // e a cada 5 min enquanto estiver logado
    return () => { vivo = false; clearInterval(t); };
  }, [toast]);

  return null;
}
