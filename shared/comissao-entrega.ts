// ============================================================================
// COMISSÃO DE ENTREGA (regra do Flavio, 17/10/2026)
// ----------------------------------------------------------------------------
// • O administrador escolhe quais entregadores participam da comissão e o PESO
//   do dia de trabalho de cada um (ex.: Marcelo 2, VIRSON 1 → um dia do Marcelo
//   vale dois dias do VIRSON).
// • Por semana (segunda a domingo), a comissão é PERCENTUAL (6,5%) sobre a soma
//   das entregas de TODOS os entregadores participantes.
// • Essa comissão é dividida pelos pontos de cada participante:
//   pontos = dias em que entregou na semana × peso.
//   Ex.: comissão R$ 3.000, mesmos dias, pesos 2 e 1 → R$ 2.000 e R$ 1.000.
// ============================================================================

export const PERCENTUAL_COMISSAO_PADRAO = 0.065;

export interface ParticipanteComissao {
  /** chave do entregador: e-mail em minúsculas (ou o nome, se não houver e-mail) */
  chave: string;
  nome: string;
  peso: number;
}

export interface ConfigComissao {
  percentual: number;
  participantes: ParticipanteComissao[];
}

export interface EntregaDoDia {
  chave: string;
  /** 'YYYY-MM-DD' (dia da entrega, horário de Brasília) */
  dia: string;
  valor: number;
}

export interface CotaComissao {
  chave: string;
  nome: string;
  peso: number;
  dias: number;
  pontos: number;
  /** valor entregue pelo próprio entregador na semana (informativo) */
  entregue: number;
  valor: number;
}

export interface ComissaoSemana {
  percentual: number;
  /** soma das entregas dos participantes */
  base: number;
  /** base × percentual */
  total: number;
  pontos: number;
  cotas: CotaComissao[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function chaveEntregador(email: any, nome: any): string {
  const e = String(email || '').trim().toLowerCase();
  return e || String(nome || '').trim().toLowerCase();
}

/** Normaliza a configuração lida do banco (tolerante a valores ruins). */
export function normalizarConfigComissao(raw: any): ConfigComissao {
  const pctNum = Number(raw?.percentual);
  const percentual = Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 1 ? pctNum : PERCENTUAL_COMISSAO_PADRAO;
  const vistos = new Set<string>();
  const participantes: ParticipanteComissao[] = [];
  for (const p of Array.isArray(raw?.participantes) ? raw.participantes : []) {
    const chave = String(p?.chave || '').trim().toLowerCase();
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    const peso = Number(p?.peso);
    participantes.push({ chave, nome: String(p?.nome || chave), peso: Number.isFinite(peso) && peso > 0 ? peso : 1 });
  }
  return { percentual, participantes };
}

/** Calcula a comissão de UMA semana a partir das entregas (já filtradas na semana). */
export function calcularComissaoSemana(entregas: EntregaDoDia[], cfg: ConfigComissao): ComissaoSemana {
  const part = new Map(cfg.participantes.map((p) => [p.chave, p]));
  const acc = new Map<string, { dias: Set<string>; entregue: number }>();
  let base = 0;
  for (const e of entregas) {
    if (!part.has(e.chave)) continue;
    const v = Number(e.valor) || 0;
    base += v;
    const a = acc.get(e.chave) || { dias: new Set<string>(), entregue: 0 };
    a.dias.add(String(e.dia).slice(0, 10));
    a.entregue += v;
    acc.set(e.chave, a);
  }
  const total = r2(base * cfg.percentual);
  const cotas: CotaComissao[] = cfg.participantes.map((p) => {
    const a = acc.get(p.chave);
    const dias = a ? a.dias.size : 0;
    return { chave: p.chave, nome: p.nome, peso: p.peso, dias, pontos: dias * p.peso, entregue: r2(a?.entregue || 0), valor: 0 };
  });
  const pontos = cotas.reduce((s, c) => s + c.pontos, 0);
  if (pontos > 0 && total > 0) {
    // Distribui em centavos e joga a sobra do arredondamento em quem tem mais pontos,
    // para a soma das cotas fechar exatamente com o total.
    let distribuido = 0;
    for (const c of cotas) {
      c.valor = Math.floor((total * c.pontos * 100) / pontos) / 100;
      distribuido += c.valor;
    }
    const sobra = r2(total - distribuido);
    if (sobra > 0) {
      const maior = cotas.reduce((m, c) => (c.pontos > m.pontos ? c : m), cotas[0]);
      maior.valor = r2(maior.valor + sobra);
    }
  }
  return { percentual: cfg.percentual, base: r2(base), total, pontos, cotas };
}
