// server/distribuidor.ts
// =============================================================================
// DISTRIBUIDOR (Amorix) — 19/nov/2026
//
// A Amorix existe em dois registros: o CLIENTE (customers.is_distribuidor) que compra da Honest
// (sell-in, fluxo normal do pipeline) e o VENDEDOR (users.seller_type = 'distribuidor') que e' a
// carteira dos clientes finais atendidos por ela.
//
// Regras implementadas aqui (usadas pelo pipeline, pelas rotas de venda e pelo agente WhatsApp):
//  1. Pedido de cliente cuja carteira e' um distribuidor = SELL-OUT: nao fatura pela Honest. Entra
//     em 'pedido' e, em vez de 'a_faturar', vai para a raia 'amorix' (PDF enviado a Amorix) e
//     dali para 'entregue' (entrega feita pela Amorix). Sem NF-e, sem titulo, sem baixa de estoque.
//  2. So' admin, administracao e coordenacao podem LANCAR pedido para esses clientes. Vendedor,
//     telemarketing, IA e demais perfis sao barrados (tela + servidor).
//  3. Excecao: gestor pode marcar "Faturar pela Honest" no card (faturar_honest_por) — o pedido
//     passa a seguir o fluxo normal.
// =============================================================================
import { db } from "./db";
import { sql } from "drizzle-orm";

export const PAPEIS_PODEM_LANCAR_PARA_DISTRIBUIDOR = ['admin', 'administrative', 'coordinator'] as const;

export type InfoDistribuidor = {
  sellout: boolean;            // cliente final da carteira de um distribuidor
  clienteDistribuidor: boolean; // o proprio cliente e' o distribuidor (compra da Honest)
  distribuidorId: string | null;
  distribuidorNome: string | null;
};

const cache = new Map<string, { at: number; v: InfoDistribuidor }>();
const TTL = 60_000;

/** Classifica o cliente: e' o distribuidor, e' cliente final de um distribuidor, ou nenhum. */
export async function infoDistribuidorDoCliente(customerId: string | null | undefined): Promise<InfoDistribuidor> {
  const vazio: InfoDistribuidor = { sellout: false, clienteDistribuidor: false, distribuidorId: null, distribuidorNome: null };
  if (!customerId) return vazio;
  const hit = cache.get(customerId);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  try {
    const r: any = await db.execute(sql`
      SELECT c.is_distribuidor,
             u.id AS dist_id,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS dist_nome
      FROM customers c
      LEFT JOIN users u ON u.id = c.seller_id AND u.seller_type = 'distribuidor' AND u.is_active = true
      WHERE c.id = ${customerId}
      LIMIT 1`);
    const row = r.rows?.[0];
    const v: InfoDistribuidor = row
      ? {
          clienteDistribuidor: !!row.is_distribuidor,
          sellout: !row.is_distribuidor && !!row.dist_id,
          distribuidorId: row.dist_id || null,
          distribuidorNome: row.dist_nome || null,
        }
      : vazio;
    cache.set(customerId, { at: Date.now(), v });
    return v;
  } catch (e: any) {
    console.warn('[DISTRIBUIDOR] infoDistribuidorDoCliente:', e?.message || e);
    return vazio;
  }
}

export function papelPodeLancarParaDistribuidor(role: string | null | undefined): boolean {
  return (PAPEIS_PODEM_LANCAR_PARA_DISTRIBUIDOR as readonly string[]).includes(String(role || ''));
}

/** Mensagem padrao de bloqueio (tela e API). */
export function mensagemBloqueioDistribuidor(nome?: string | null): string {
  return `Cliente atendido pela ${nome || 'Amorix'} — pedidos para esta carteira só pela administração (admin, administrativo ou coordenação).`;
}

/**
 * Verifica se `user` pode lancar pedido para `customerId`. Devolve null quando pode, ou a mensagem
 * de bloqueio quando nao pode. Quem chama responde 403 com { code: 'DISTRIBUIDOR_SOMENTE_ADMIN' }.
 */
export async function bloqueioLancamentoDistribuidor(user: any, customerId: string | null | undefined): Promise<string | null> {
  const info = await infoDistribuidorDoCliente(customerId);
  if (!info.sellout) return null;
  if (papelPodeLancarParaDistribuidor(user?.role)) return null;
  return mensagemBloqueioDistribuidor(info.distribuidorNome);
}

/** Ids dos usuarios do tipo distribuidor (para as telas saberem quais carteiras sao bloqueadas). */
export async function vendedoresDistribuidores(): Promise<Array<{ id: string; nome: string; customerId: string | null }>> {
  try {
    const r: any = await db.execute(sql`
      SELECT id, TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS nome, distribuidor_customer_id
      FROM users WHERE seller_type = 'distribuidor' AND is_active = true ORDER BY first_name`);
    return (r.rows || []).map((x: any) => ({ id: String(x.id), nome: x.nome || 'Distribuidor', customerId: x.distribuidor_customer_id || null }));
  } catch { return []; }
}

/** Estagios que um pedido sell-out NAO pode visitar (sao do faturamento/entrega da Honest). */
export const ESTAGIOS_PROIBIDOS_SELLOUT = new Set(['a_faturar', 'faturado', 'impresso', 'bsb', 'aguardando_rota_bsb', 'em_rota_bsb', 'outras_cidades', 'aguardando_rota', 'em_rota']);
