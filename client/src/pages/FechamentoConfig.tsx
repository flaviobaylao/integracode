// ============================================================================
// INTEGRA 2.0 — REGRAS DO FECHAMENTO DE ROTA (Ago/2026)
// Configuracao (somente admin) das regras do Fechamento de Rota:
//   - Trava obrigatoria para fechar o dia
//   - Bloqueio da rota do dia seguinte se o dia anterior nao for fechado
//   - Fecho automatico em horario de corte (opcional)
//   - Tipos de cliente incluidos no fechamento (Presencial/Virtual/Lead; Repescagem fora)
// Persistencia: config_global (chave 'fechamento_config') via /api/admin/fechamento/config.
// ============================================================================
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@/lib/queryClient";
import { queryClient, apiRequest } from "@/lib/queryClient";
import BackToDashboardButton from "@/components/BackToDashboardButton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ClipboardCheck, Lock } from "lucide-react";

type Cfg = {
  travaObrigatoria: boolean;
  bloqueioDiaSeguinte: boolean;
  fechoAutomatico: boolean;
  fechoHorario: string;
  tipos: string[];
};
const DEFAULTS: Cfg = { travaObrigatoria: true, bloqueioDiaSeguinte: true, fechoAutomatico: false, fechoHorario: "19:00", tipos: ["presencial", "virtual", "lead"] };
const TIPOS: [string, string][] = [["presencial", "Presencial"], ["virtual", "Virtual"], ["lead", "Lead"]];

function RuleRow(props: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-t first:border-t-0">
      <div>
        <div className="font-semibold text-sm">{props.title}</div>
        <div className="text-xs text-muted-foreground mt-1 max-w-2xl">{props.desc}</div>
      </div>
      <Switch checked={props.checked} onCheckedChange={props.onChange} disabled={props.disabled} />
    </div>
  );
}

export default function FechamentoConfig() {
  const { toast } = useToast();
  const { data } = useQuery<any>({ queryKey: ["/api/admin/fechamento/config"] });
  const cfg: Cfg = { ...DEFAULTS, ...((data && data.config) || {}) };

  const [hora, setHora] = useState<string>(cfg.fechoHorario);
  useEffect(() => { if (data && data.config) setHora(data.config.fechoHorario || "19:00"); }, [data]);

  const salvar = useMutation({
    mutationFn: async (body: any) => apiRequest("POST", "/api/admin/fechamento/config", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/fechamento/config"] });
      toast({ title: "Regra atualizada", description: "As mudancas valem para os proximos fechamentos." });
    },
    onError: () => toast({ title: "Erro ao salvar", description: "Tente novamente.", variant: "destructive" }),
  });

  const toggleTipo = (t: string) => {
    const has = cfg.tipos.includes(t);
    const tipos = has ? cfg.tipos.filter((x) => x !== t) : [...cfg.tipos, t];
    if (!tipos.length) { toast({ title: "Selecione ao menos um tipo", variant: "destructive" }); return; }
    salvar.mutate({ tipos });
  };
  const salvarHora = () => {
    if (!/^\d{2}:\d{2}$/.test(hora)) { toast({ title: "Horario invalido", description: "Use o formato HH:MM.", variant: "destructive" }); return; }
    if (hora !== cfg.fechoHorario) salvar.mutate({ fechoHorario: hora });
  };

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <BackToDashboardButton />

      <div className="flex items-center gap-3 mt-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
          <ClipboardCheck className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">Regras do Fechamento de Rota</h1>
          <div className="text-xs text-muted-foreground flex items-center gap-1"><Lock className="w-3 h-3" /> Somente o admin edita. No celular, o vendedor apenas vê o efeito.</div>
        </div>
      </div>

      <Card className="mt-5">
        <CardHeader className="pb-2"><CardTitle className="text-base">Regras</CardTitle></CardHeader>
        <CardContent>
          <RuleRow
            title="Trava obrigatória para fechar o dia"
            desc="O vendedor só fecha a rota quando todos os clientes estiverem atendidos (check-in) ou justificados. Sem cliente “esquecido”."
            checked={cfg.travaObrigatoria}
            onChange={(v) => salvar.mutate({ travaObrigatoria: v })}
            disabled={salvar.isPending}
          />
          <RuleRow
            title="Bloquear a rota do dia seguinte se o dia anterior não for fechado"
            desc="Se o vendedor esquecer de fechar, a rota do próximo dia abre bloqueada e só libera ao fechar a anterior — ou com liberação do admin."
            checked={cfg.bloqueioDiaSeguinte}
            onChange={(v) => salvar.mutate({ bloqueioDiaSeguinte: v })}
            disabled={salvar.isPending}
          />
          <RuleRow
            title="Fecho automático em horário de corte (opcional)"
            desc="No horário definido, o dia é fechado automaticamente e os clientes ainda sem justificativa entram no painel como “sem justificativa”."
            checked={cfg.fechoAutomatico}
            onChange={(v) => salvar.mutate({ fechoAutomatico: v })}
            disabled={salvar.isPending}
          />
          <div className="flex items-center gap-3 pl-1 pb-2">
            <span className="text-xs text-muted-foreground">Horário do fecho automático</span>
            <Input
              type="time"
              value={hora}
              onChange={(e) => setHora(e.target.value)}
              onBlur={salvarHora}
              disabled={!cfg.fechoAutomatico || salvar.isPending}
              className="w-32"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader className="pb-2"><CardTitle className="text-base">Tipos de cliente incluídos no fechamento</CardTitle></CardHeader>
        <CardContent>
          <div className="text-xs text-muted-foreground mb-3">Quais cards exigem justificativa se ficarem sem atendimento. Repescagem fica sempre de fora.</div>
          <div className="flex flex-wrap gap-2">
            {TIPOS.map(([id, label]) => {
              const on = cfg.tipos.includes(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTipo(id)}
                  disabled={salvar.isPending}
                  className={`px-3 py-2 rounded-full text-sm font-semibold border transition ${on ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-200 text-gray-600"}`}
                >
                  {label} {on ? "✓" : ""}
                </button>
              );
            })}
            <span className="px-3 py-2 rounded-full text-sm font-semibold bg-gray-100 text-gray-500">Repescagem — fora</span>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground mt-4">
        As telas do vendedor (botão “Fechar rota do dia”) e as ações do admin (liberar rota, reabrir dia) entram nas próximas etapas da implantação.
      </div>
    </div>
  );
}
