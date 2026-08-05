// ============================================================================
// INTEGRA 2.0 — "A conversa tem que bater com o dia de hoje"
// A IA respondeu a AGOSFOOD em 05/08/2026 dizendo "quando chegar o finalzinho de julho,
// e so chamar". Julho ja tinha passado. O prompt ate levava a data, mas nada dizia ao
// modelo o que ele NAO pode fazer com ela — e nada contava a realidade daquele cliente:
// quando ele comprou pela ultima vez, de quanto em quanto tempo ele compra, quando o
// vendedor passa la de novo.
//
// Este modulo monta esse bloco. Sao fatos do banco, nao opiniao: sem pedido registrado,
// o bloco simplesmente nao fala de periodicidade — melhor calar do que inventar.
//
// Wiring: chamado por generateAgentReply (agent-runtime.ts), junto do contextoDoAviso.
// ============================================================================
import { db } from './db';
import { sql } from 'drizzle-orm';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Bloco de calendario: o que e hoje e, principalmente, o que nao inventar.
export function blocoCalendario(agora = new Date()): string {
  const brt = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const mes = MESES[brt.getMonth()];
  const ano = brt.getFullYear();
  const dia = brt.getDate();
  const ultimoDia = new Date(ano, brt.getMonth() + 1, 0).getDate();
  const faltam = ultimoDia - dia;
  const parte = dia <= 10 ? 'começo' : (dia <= 20 ? 'meio' : 'fim');
  return [
    '# CALENDARIO — a conversa tem que bater com hoje',
    `Mes vigente: ${mes} de ${ano}. Hoje e dia ${dia} (${parte} do mes); faltam ${faltam} dia(s) para acabar ${mes}.`,
    `Proximo mes: ${MESES[(brt.getMonth() + 1) % 12]}.`,
    'REGRAS (nao negociaveis):',
    `- Nunca cite um mes que ja passou como se fosse futuro. Se for falar de prazo, fale de ${mes} ou do mes seguinte.`,
    '- Nunca invente data de visita, de entrega ou de recompra. Use SO as datas que aparecem neste prompt ou que voce buscou com uma ferramenta.',
    '- Se nao tiver a data, diga que vai confirmar com o vendedor — nao chute "final do mes", "semana que vem" nem periodo nenhum.',
  ].join('\n');
}

const ddmm = (d: any) => {
  try { return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch { return ''; }
};

/**
 * Retrato do cliente para a conversa de hoje: ultimas compras, de quanto em quanto tempo
 * ele compra, quanto tempo faz da ultima e quando e a proxima visita. Devolve '' quando
 * nao da para identificar o cliente — o prompt segue sem o bloco, sem inventar nada.
 */
export async function contextoDoCliente(customerId?: string | null): Promise<string> {
  try {
    if (!customerId) return '';
    const c: any = await db.execute(sql`
      SELECT COALESCE(fantasy_name, name) AS nome FROM customers WHERE id = ${customerId} LIMIT 1`);
    const nome = String(c.rows?.[0]?.nome || '').slice(0, 60);

    // Compras de verdade: card concluido/faturado, operacao de venda.
    const p: any = await db.execute(sql`
      SELECT (COALESCE(sc.completed_date, sc.updated_at, sc.created_at)
                AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
             sc.sale_value
      FROM sales_cards sc
      WHERE sc.customer_id = ${customerId}
        AND COALESCE(sc.operation_type, 'venda') = 'venda'
        AND COALESCE(sc.status, '') NOT IN ('cancelled', 'telemarketing')
        AND (sc.completed_date IS NOT NULL OR COALESCE(sc.status, '') IN ('blocked', 'completed', 'invoiced'))
      ORDER BY 1 DESC LIMIT 6`);
    const compras = (p.rows || []) as any[];

    const linhas: string[] = ['# ESTE CLIENTE (dados do sistema — nao invente nada alem disto)'];
    if (nome) linhas.push(`Cliente: ${nome}`);

    if (compras.length) {
      const dias = compras.map(r => new Date(r.dia).getTime()).filter(t => !isNaN(t));
      const ultima = dias[0];
      const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).setHours(12, 0, 0, 0);
      const faz = Math.round((hoje - ultima) / 86400000);
      linhas.push(`Ultima compra: ${ddmm(compras[0].dia)} (ha ${faz} dia(s)).`);
      if (dias.length >= 3) {
        // Intervalo tipico = mediana dos intervalos. Media escorrega com um pedido atipico.
        const gaps: number[] = [];
        for (let i = 1; i < dias.length; i++) gaps.push(Math.round((dias[i - 1] - dias[i]) / 86400000));
        const validos = gaps.filter(g => g > 0).sort((a, b) => a - b);
        if (validos.length) {
          const mediana = validos[Math.floor(validos.length / 2)];
          linhas.push(`Costuma comprar a cada ~${mediana} dias (ultimas ${dias.length} compras: ${compras.map(r => ddmm(r.dia)).join(', ')}).`);
          const prevista = new Date(ultima + mediana * 86400000);
          linhas.push(`Pela periodicidade, a proxima compra cairia por volta de ${ddmm(prevista)}.`
            + (faz > mediana * 1.5 ? ' Ele esta ATRASADO em relacao ao ritmo dele — vale perguntar se precisa de reposicao.' : ''));
        }
      }
    } else {
      linhas.push('Sem compra registrada no sistema. Nao fale em "de costume", "como sempre" nem em periodicidade.');
    }

    // Proxima visita agendada (mesma fonte usada na resposta da Rota do Dia).
    const v: any = await db.execute(sql`
      SELECT to_char(scheduled_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') AS quando
      FROM visit_agenda
      WHERE customer_id = ${customerId} AND visit_status = 'pending'
        AND (scheduled_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date
      ORDER BY scheduled_date LIMIT 1`);
    const visita = v.rows?.[0]?.quando;
    linhas.push(visita
      ? `Proxima visita do vendedor: ${visita}. Se o cliente perguntar quando passam la, e essa data.`
      : 'Sem visita agendada no sistema. Se perguntarem quando o vendedor passa, diga que vai confirmar — nao chute data.');

    return linhas.join('\n');
  } catch (e: any) {
    console.error('[CTX-CLIENTE]', e?.message || e);
    return '';
  }
}
