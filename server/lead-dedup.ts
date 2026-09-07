// =============================================================================
//  INTEGRA 2.0 — Dedup de leads x clientes ativos (set/2026)
//  ---------------------------------------------------------------------------
//  Regra do cliente: um lead que JÁ é um cliente ATIVO deve sair da relação de
//  leads (status 'discarded', motivo 'ja_cadastrado_ativo').
//  Critério de correspondência (nessa ordem, qualquer um confirma):
//    1) COORDENADA + NOME  — a <= 80m E nomes com tokens em comum (>=50%);
//    2) NOME               — nome fantasia normalizado idêntico;
//    3) TELEFONE           — últimos 9 dígitos iguais.
//  A coordenada NUNCA descarta sozinha (evita casar negócios vizinhos).
//
//  Uso: chamado no POST /api/customers quando um cliente NOVO (não-lead) é
//  criado pelo botão "Novo Cliente". Nunca lança / nunca bloqueia a criação.
// =============================================================================
import { db } from './db';
import { customers } from '@shared/schema';
import { eq, sql } from 'drizzle-orm';

const stripAcc = (s: any) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'a', 'o', 'ltda', 'me', 'epp', 'mercado', 'mercadinho', 'loja', 'comercio', 'bar', 'cafe', 'padaria', 'panificadora', 'restaurante', 'lanchonete', 'conveniencia', 'distribuidora', 'super', 'supermercado', 'emporio']);
const tokensOf = (s: any): string[] => stripAcc(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t: string) => t.length >= 3 && !STOP.has(t));
const normNameFull = (s: any): string => stripAcc(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const normPhone = (s: any): string => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const havKm = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
  const R = 6371, tr = (x: number) => x * Math.PI / 180;
  const dLat = tr(bLat - aLat), dLng = tr(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(aLat)) * Math.cos(tr(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};
const simTok = (a: any, b: any): number => {
  const A = new Set(tokensOf(a)), B = new Set(tokensOf(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
};

// Retorna o critério que casou (coordenada+nome | nome | telefone) ou null.
export function leadMatchesCustomer(l: any, c: any): string | null {
  const cName = c.fantasyName || c.name;
  const la = Number(l.latitude), lo = Number(l.longitude), ca = Number(c.latitude), co = Number(c.longitude);
  if (Number.isFinite(la) && Number.isFinite(lo) && Number.isFinite(ca) && Number.isFinite(co) && !(ca === 0 && co === 0)) {
    if (havKm(la, lo, ca, co) <= 0.08 && simTok(l.fantasyName, cName) >= 0.5) return 'coordenada+nome';
  }
  const ln = normNameFull(l.fantasyName);
  if (ln.length >= 5 && ln === normNameFull(cName)) return 'nome';
  const lp = normPhone(l.phone), cp = normPhone(c.phone);
  if (lp && cp && lp === cp) return 'telefone';
  return null;
}

// Descarta os leads ATIVOS que correspondem a este cliente (já cadastrado e ativo).
// Retorna quantos leads foram descartados. Nunca lança.
export async function discardLeadsForCustomer(customerId: string): Promise<number> {
  try {
    const rows = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
    const c: any = rows[0];
    if (!c) return 0;
    if (c.isActive === false || c.isLead === true || c.isSupplier === true) return 0;

    const ls: any[] = ((await db.execute(sql`
      SELECT id, fantasy_name AS "fantasyName", latitude, longitude, phone
      FROM leads
      WHERE status NOT IN ('converted', 'discarded')
    `)).rows || []) as any[];

    let n = 0;
    for (const l of ls) {
      const crit = leadMatchesCustomer(l, c);
      if (!crit) continue;
      await db.execute(sql`
        UPDATE leads
        SET status = 'discarded', non_conversion_reason = 'ja_cadastrado_ativo',
            return_overdue = false, updated_at = NOW()
        WHERE id = ${l.id}
      `);
      n++;
    }
    if (n > 0) console.log(`🚫 [lead-dedup] cliente "${c.fantasyName || c.name}" descartou ${n} lead(s) duplicado(s) (já cadastrado e ativo).`);
    return n;
  } catch (e: any) {
    console.warn('[lead-dedup] discardLeadsForCustomer:', e?.message);
    return 0;
  }
}
