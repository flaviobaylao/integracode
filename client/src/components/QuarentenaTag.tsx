import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";

/**
 * Marca discreta de QUARENTENA, exibida DEPOIS do nome fantasia do cliente.
 *
 * Regra (definida com o Flávio, 30/set/2026): mostra a marca quando o cliente
 * tem "Data de Início do Fornecimento" (serviceStartDate) NO FUTURO — ou seja,
 * ainda em quarentena de fato. É justamente essa data que o botão "Quarentena"
 * do Inbox e o da Gestão de Carteiras gravam. A marca some sozinha quando a
 * data chega.
 *
 * NÃO altera o cadastro: é só exibição. Reaproveita o cache de ['/api/customers']
 * (que várias telas já carregam), então onde a lista já existe não há requisição
 * extra. O mapa id→data é montado uma única vez por versão da lista e
 * compartilhado por todas as instâncias da marca.
 */

let _srcRef: any = undefined;
let _map: Map<string, string> = new Map();

function quarentenaMap(data: any): Map<string, string> {
  if (data === _srcRef) return _map;
  const m = new Map<string, string>();
  if (Array.isArray(data)) {
    const now = Date.now();
    for (const c of data) {
      const s = c?.serviceStartDate;
      if (!s) continue;
      const t = new Date(s).getTime();
      if (!Number.isNaN(t) && t > now) m.set(String(c.id), String(s));
    }
  }
  _srcRef = data;
  _map = m;
  return m;
}

function fmtBR(v: string): string {
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/**
 * Mapa id-do-cliente → data de início (ISO) apenas dos clientes EM QUARENTENA
 * (serviceStartDate no futuro). Reaproveita o cache de ['/api/customers'].
 * Use em telas que só têm o customerId por linha (ex.: Gestão de Carteiras)
 * para filtrar/rotular por quarentena. Ex.: `qMap.has(String(c.customerId))`.
 */
export function useQuarentenaMap(): Map<string, string> {
  const { data } = useQuery<any[]>({ queryKey: ["/api/customers"] });
  return quarentenaMap(data);
}

export function QuarentenaTag({
  customerId,
  date,
}: {
  customerId?: string | null;
  date?: string | null;
}) {
  // Quando a linha já traz o serviceStartDate (ex.: Clientes Ativos), `date` é a
  // fonte da verdade e não precisamos da lista. Só buscamos ['/api/customers']
  // quando dependemos do mapa por id.
  const needMap = !date && !!customerId;
  const { data } = useQuery<any[]>({ queryKey: ["/api/customers"], enabled: needMap });

  let iso: string | null = null;
  if (date) {
    const t = new Date(date).getTime();
    if (!Number.isNaN(t) && t > Date.now()) iso = String(date);
  } else if (customerId) {
    iso = quarentenaMap(data).get(String(customerId)) || null;
  }

  if (!iso) return null;
  const br = fmtBR(iso);

  return (
    <span
      className="ml-1 inline-flex items-center gap-0.5 align-middle text-[10px] font-normal leading-none text-amber-600 dark:text-amber-400 whitespace-nowrap"
      title={`Cliente em quarentena — visitas/fornecimento a partir de ${br}`}
      data-testid="tag-quarentena"
    >
      <Clock className="h-3 w-3" />
      quarentena{br ? ` até ${br}` : ""}
    </span>
  );
}

export default QuarentenaTag;
