// ============================================================================
// HORÁRIOS PREFERENCIAIS DE ENTREGA — bloco do cadastro do cliente (18/out/2026)
// Mostra, ao lado do tempo de entrega medido, em que horários as entregas para
// este cliente realmente aconteceram (seg–sex e sábado), com o período
// sugerido e a distribuição por hora. Fonte: GET /api/customers/:id/horarios-preferenciais
// (calculado no servidor a partir das entregas efetuadas — server/horarios-preferenciais.ts).
// "Usar como horário de recebimento" copia o período sugerido para o formulário
// (só grava quando o usuário salvar o cadastro).
// ============================================================================
import { useQuery, queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Clock, RefreshCw } from "lucide-react";
import { useState } from "react";

interface PeriodoPref { ini: string; fim: string; entregas: number }
interface GrupoPref { amostras: number; mediana: string | null; primeira: string | null; ultima: string | null; periodos: PeriodoPref[]; porHora: number[] }
interface HorariosPref { semana: GrupoPref; sabado: GrupoPref; total: number; ultimaEntrega: string | null; calculadoEm: string }

const faixa = (p: PeriodoPref) => `${p.ini} às ${p.fim}`;

function Distribuicao({ porHora }: { porHora: number[] }) {
  const ini = 6, fim = 20;
  const horas = porHora.slice(ini, fim + 1);
  const max = Math.max(1, ...horas);
  return (
    <div className="mt-1.5" aria-label="Entregas por hora do dia">
      <div className="flex items-end gap-[2px] h-7">
        {horas.map((n, i) => (
          <div
            key={i}
            className={`flex-1 min-w-0 rounded-sm ${n ? "bg-indigo-500" : "bg-indigo-100"}`}
            style={{ height: n ? `${Math.max(4, Math.round((n / max) * 28))}px` : "2px" }}
            title={`${ini + i}h: ${n} entrega(s)`}
          />
        ))}
      </div>
      <div className="flex gap-[2px] mt-0.5">
        {horas.map((_, i) => (
          <span key={i} className="flex-1 min-w-0 text-center text-[9px] leading-none text-indigo-700">{(ini + i) % 2 === 0 ? ini + i : ""}</span>
        ))}
      </div>
    </div>
  );
}

function Grupo({ titulo, g, onUsar }: { titulo: string; g: GrupoPref; onUsar?: (slots: string[]) => void }) {
  return (
    <div className="rounded-md bg-white/70 border border-indigo-100 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-indigo-900">{titulo}</span>
        <span className="text-[11px] text-indigo-700">{g.amostras} entrega(s)</span>
      </div>
      {g.amostras === 0 ? (
        <p className="text-xs text-gray-500 mt-1">Sem entregas efetuadas neste período da semana.</p>
      ) : (
        <>
          <div className="text-sm text-indigo-950 mt-0.5">
            {g.periodos.length
              ? <b>{g.periodos.map(faixa).join(" e ")}</b>
              : <span className="text-gray-600">Poucas entregas para sugerir período (mínimo 3)</span>}
          </div>
          <div className="text-[11px] text-indigo-700">
            mais comum {g.mediana} · de {g.primeira} a {g.ultima}
          </div>
          <Distribuicao porHora={g.porHora || []} />
          {onUsar && g.periodos.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 mt-2 text-xs border-indigo-300 text-indigo-800 hover:bg-indigo-50"
              onClick={() => onUsar(g.periodos.slice(0, 2).map((p) => `${p.ini}-${p.fim}`))}
            >
              Usar como horário de recebimento
            </Button>
          )}
        </>
      )}
    </div>
  );
}

interface Props {
  customerId?: string | null;
  /** copia o período sugerido para o formulário (seg–sex) */
  onUsarSemana?: (slots: string[]) => void;
  /** copia o período sugerido para o formulário (sábado) */
  onUsarSabado?: (slots: string[]) => void;
}

export default function HorariosPreferenciaisCliente({ customerId, onUsarSemana, onUsarSabado }: Props) {
  const [recalculando, setRecalculando] = useState(false);
  const { data } = useQuery<HorariosPref | null>({
    queryKey: ["/api/customers", customerId, "horarios-preferenciais"],
    queryFn: () => apiRequest("GET", `/api/customers/${customerId}/horarios-preferenciais`),
    enabled: !!customerId,
    staleTime: 5 * 60 * 1000,
  });
  if (!customerId || !data || !data.total) return null;

  const recalcular = async () => {
    setRecalculando(true);
    try {
      const novo = await apiRequest("POST", `/api/customers/${customerId}/horarios-preferenciais/recalcular`);
      queryClient.setQueryData(["/api/customers", customerId, "horarios-preferenciais"], novo);
    } finally {
      setRecalculando(false);
    }
  };

  return (
    <div className="border border-indigo-200 bg-indigo-50 p-4 rounded-lg space-y-2" data-testid="bloco-horarios-preferenciais">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-indigo-900 flex items-center gap-2">
          <Clock className="h-4 w-4 text-indigo-700" />
          Horários preferenciais de entrega (pelas entregas anteriores)
        </div>
        <button type="button" onClick={recalcular} disabled={recalculando} className="text-indigo-700 hover:text-indigo-900 disabled:opacity-40" title="Recalcular agora">
          <RefreshCw className={`h-3.5 w-3.5 ${recalculando ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Grupo titulo="Segunda a sexta" g={data.semana} onUsar={onUsarSemana} />
        <Grupo titulo="Sábado" g={data.sabado} onUsar={onUsarSabado} />
      </div>
      <p className="text-xs text-indigo-700">
        Horário em que o entregador iniciou cada entrega efetuada (uma visita por dia; últimas 40 de cada grupo, último ano). Atualiza sozinho a cada entrega.
        {data.ultimaEntrega ? ` Última entrega: ${data.ultimaEntrega.slice(8, 10)}/${data.ultimaEntrega.slice(5, 7)}/${data.ultimaEntrega.slice(0, 4)} às ${data.ultimaEntrega.slice(11, 16)}.` : ""}
      </p>
    </div>
  );
}
