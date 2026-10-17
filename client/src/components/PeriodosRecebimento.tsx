// ============================================================================
// HORÁRIOS DE RECEBIMENTO DO CLIENTE — até 2 períodos livres (ex.: 08:15 às 11:45)
// ----------------------------------------------------------------------------
// Usado em todo lugar onde o cadastro de horário de recebimento é editado
// (Clientes, Clientes Ativos, Gestão de Entregas, Registro de Venda).
// Grava no mesmo campo de sempre, no formato ["08:15-11:45","13:30-17:00"].
// Se só um período estiver preenchido, só ele vale (o 2º é opcional).
// Cadastros antigos (horas cheias marcadas) aparecem já convertidos em períodos.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { Clock, X, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  periodosDoCadastro,
  serializarPeriodos,
  validarPeriodos,
  ehCadastroAntigo,
  formatarJanelas,
  FIM_GRADE_ANTIGA_SEMANA,
  FIM_GRADE_ANTIGA_SABADO,
  MAX_PERIODOS_RECEBIMENTO,
  type PeriodoRecebimento,
} from "@shared/janelas-entrega";

interface Props {
  /** valor gravado no cadastro (array, string JSON ou vazio) */
  value: any;
  /** recebe o novo valor já no formato de gravação */
  onChange: (slots: string[]) => void;
  /** true = sábado (só muda a regra de conversão do cadastro antigo) */
  sabado?: boolean;
  /** prefixo dos data-testid / ids */
  idPrefix: string;
  disabled?: boolean;
}

const VAZIO: PeriodoRecebimento = { ini: "", fim: "" };

function completar(lista: PeriodoRecebimento[]): PeriodoRecebimento[] {
  const out = lista.slice(0, MAX_PERIODOS_RECEBIMENTO).map((p) => ({ ...p }));
  while (out.length < MAX_PERIODOS_RECEBIMENTO) out.push({ ...VAZIO });
  return out;
}

function chave(v: any): string {
  try { return JSON.stringify(v ?? null); } catch { return String(v); }
}

export default function PeriodosRecebimento({ value, onChange, sabado = false, idPrefix, disabled }: Props) {
  const fimGrade = sabado ? FIM_GRADE_ANTIGA_SABADO : FIM_GRADE_ANTIGA_SEMANA;
  const [periodos, setPeriodos] = useState<PeriodoRecebimento[]>(() => completar(periodosDoCadastro(value, fimGrade)));
  // Último valor que ESTE componente emitiu: evita reprocessar o próprio eco
  // quando o formulário devolve o valor pela prop.
  const ultimoEmitido = useRef<string>(chave(value));

  useEffect(() => {
    const k = chave(value);
    if (k === ultimoEmitido.current) return;
    ultimoEmitido.current = k;
    setPeriodos(completar(periodosDoCadastro(value, fimGrade)));
  }, [value, fimGrade]);

  const todosDoCadastro = periodosDoCadastro(value, fimGrade);
  const antigo = ehCadastroAntigo(value);
  const excedentes = todosDoCadastro.length > MAX_PERIODOS_RECEBIMENTO ? todosDoCadastro.slice(MAX_PERIODOS_RECEBIMENTO) : [];
  const erro = validarPeriodos(periodos);

  const atualizar = (idx: number, campo: "ini" | "fim", v: string) => {
    const novos = periodos.map((p, i) => (i === idx ? { ...p, [campo]: v } : p));
    setPeriodos(novos);
    if (!validarPeriodos(novos)) {
      const slots = serializarPeriodos(novos);
      ultimoEmitido.current = chave(slots);
      onChange(slots);
    }
  };

  const limpar = (idx: number) => {
    const novos = periodos.map((p, i) => (i === idx ? { ...VAZIO } : p));
    setPeriodos(novos);
    if (!validarPeriodos(novos)) {
      const slots = serializarPeriodos(novos);
      ultimoEmitido.current = chave(slots);
      onChange(slots);
    }
  };

  const resumo = formatarJanelas(serializarPeriodos(periodos));

  return (
    <div className="space-y-2">
      {periodos.map((p, idx) => (
        <div key={idx} className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-700 w-24 shrink-0">
            {idx + 1}º período{idx > 0 ? " (opcional)" : ""}
          </span>
          <Input
            type="time"
            step={300}
            value={p.ini}
            disabled={disabled}
            onChange={(e) => atualizar(idx, "ini", e.target.value)}
            className="w-28 h-8 bg-white"
            aria-label={`${idx + 1}º período — início`}
            data-testid={`${idPrefix}-periodo-${idx + 1}-inicio`}
          />
          <span className="text-xs text-gray-600">até</span>
          <Input
            type="time"
            step={300}
            value={p.fim}
            disabled={disabled}
            onChange={(e) => atualizar(idx, "fim", e.target.value)}
            className="w-28 h-8 bg-white"
            aria-label={`${idx + 1}º período — fim`}
            data-testid={`${idPrefix}-periodo-${idx + 1}-fim`}
          />
          {(p.ini || p.fim) && !disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-gray-500"
              onClick={() => limpar(idx)}
              title="Limpar este período"
              data-testid={`${idPrefix}-periodo-${idx + 1}-limpar`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ))}

      {erro ? (
        <p className="text-xs text-red-600 flex items-center gap-1" data-testid={`${idPrefix}-erro`}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {erro} Enquanto isso, vale o último horário válido.
        </p>
      ) : (
        <p className="text-xs text-gray-600 flex items-center gap-1" data-testid={`${idPrefix}-resumo`}>
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {resumo ? <>Recebe das <strong className="font-semibold">{resumo}</strong></> : "Sem horário cadastrado: recebe a qualquer hora."}
        </p>
      )}

      {antigo && (
        <p className="text-xs text-amber-700">
          Cadastro antigo (horas marcadas) convertido em períodos. Confira e salve para gravar no formato novo.
        </p>
      )}
      {excedentes.length > 0 && (
        <p className="text-xs text-amber-700">
          O cadastro antigo tinha também {formatarJanelas(excedentes.map((x) => `${x.ini}-${x.fim}`))}. Só os 2 períodos acima são mantidos ao salvar.
        </p>
      )}
    </div>
  );
}
