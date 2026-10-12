import { useState, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  History, Loader2, Clock, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Plus, CalendarClock, Flag,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

type Ocorrencia = {
  data: string | null;
  categoria: string;
  titulo: string;
  detalhe: string;
  por: string | null;
};

type Resumo = {
  id: string;
  fantasyName: string;
  status: string;
  responsavel: string | null;
  createdAt: string | null;
  nextContactDate: string | null;
  originalReturnDate: string | null;
  postponementCount: number;
  diasAtraso: number;
  atrasado: boolean;
  naoConvertido: boolean;
  nonConversionReason: string | null;
};

function fmtData(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function iconePara(titulo: string) {
  if (/não convertido/i.test(titulo)) return <XCircle className="h-4 w-4 text-gray-500" />;
  if (/prorrog/i.test(titulo)) return <CalendarClock className="h-4 w-4 text-amber-600" />;
  if (/resgat/i.test(titulo)) return <RefreshCw className="h-4 w-4 text-emerald-600" />;
  if (/gravado/i.test(titulo)) return <Plus className="h-4 w-4 text-emerald-600" />;
  if (/criado/i.test(titulo)) return <Flag className="h-4 w-4 text-blue-600" />;
  return <CheckCircle2 className="h-4 w-4 text-blue-600" />;
}

/**
 * Relógio de histórico de ocorrências do lead (fica ao lado do nome).
 * Fica âmbar/vermelho quando o lead está atrasado (passou da data de retorno sem visita).
 */
export default function HistoricoOcorrencias({
  leadId,
  nome,
  atrasado,
  diasAtraso,
  className = "",
}: {
  leadId: string;
  nome?: string;
  atrasado?: boolean;
  diasAtraso?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [itens, setItens] = useState<Ocorrencia[]>([]);
  const [erro, setErro] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const data: any = await apiRequest("GET", `/api/leads/${leadId}/ocorrencias`);
      setResumo(data && data.lead ? data.lead : null);
      setItens(Array.isArray(data?.ocorrencias) ? data.ocorrencias : []);
    } catch (e: any) {
      setErro(String((e && e.message) || e));
    } finally {
      setCarregando(false);
    }
  }, [leadId]);

  const abrir = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setOpen(true);
      carregar();
    },
    [carregar]
  );

  const estaAtrasado = atrasado || (resumo?.atrasado ?? false);
  const dias = diasAtraso ?? resumo?.diasAtraso ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={abrir}
        aria-label="Histórico de ocorrências"
        title={estaAtrasado ? `Atrasado há ${dias} dia(s) — ver histórico` : "Histórico de ocorrências"}
        className={`inline-flex items-center justify-center rounded-full p-1 transition shrink-0 ${
          estaAtrasado
            ? "text-red-600 bg-red-100 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300"
            : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
        } ${className}`}
        data-testid="button-historico-ocorrencias"
      >
        {estaAtrasado ? <Clock className="h-4 w-4" /> : <History className="h-4 w-4" />}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <History className="h-5 w-5 text-emerald-600" />
              Histórico de ocorrências
            </DialogTitle>
            <DialogDescription className="break-words">
              {resumo?.fantasyName || nome || "Lead"}
            </DialogDescription>
          </DialogHeader>

          {carregando ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 mx-auto animate-spin mb-2" /> Carregando…
            </div>
          ) : erro ? (
            <div className="py-6 text-sm text-red-600 flex items-start gap-2">
              <XCircle className="h-5 w-5 shrink-0 mt-0.5" /> {erro}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Resumo */}
              {resumo && (
                <div className="rounded-lg border p-3 space-y-1.5 text-sm bg-slate-50 dark:bg-slate-900/40">
                  {resumo.atrasado && (
                    <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold">
                      <AlertTriangle className="h-4 w-4" />
                      Retorno atrasado há {resumo.diasAtraso} dia{resumo.diasAtraso > 1 ? "s" : ""}
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Prospecta</span>
                    <span className="font-medium text-right">{resumo.responsavel || "não atribuído"}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Próxima visita</span>
                    <span className="font-medium text-right">{fmtData(resumo.nextContactDate)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Cadastrado em</span>
                    <span className="font-medium text-right">{fmtData(resumo.createdAt)}</span>
                  </div>
                  {resumo.postponementCount > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Prorrogações</span>
                      <span className="font-medium text-right">{resumo.postponementCount}</span>
                    </div>
                  )}
                  {resumo.naoConvertido && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Situação</span>
                      <span className="font-medium text-right text-gray-600 dark:text-gray-300">Não convertido</span>
                    </div>
                  )}
                </div>
              )}

              {/* Linha do tempo */}
              {itens.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Ainda não há ocorrências registradas para este lead.
                </p>
              ) : (
                <ol className="space-y-3">
                  {itens.map((o, i) => (
                    <li key={i} className="flex gap-2.5">
                      <div className="shrink-0 mt-0.5">{iconePara(o.titulo)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm">{o.titulo}</span>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtData(o.data)}</span>
                        </div>
                        {o.detalhe && !new RegExp(`^${o.titulo}`, "i").test(o.detalhe) && (
                          <p className="text-xs text-muted-foreground break-words">{o.detalhe}</p>
                        )}
                        {o.por && <p className="text-[11px] text-muted-foreground">por {o.por}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
