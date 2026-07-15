import { db } from './db';
import { sql } from 'drizzle-orm';
import { sendUmblerTalkText } from './chat-routes';
import { storage } from './storage';

// Alerta diário (dias úteis, 08:30 BRT): débitos VENCIDOS por carteira.
// FONTE = aba Contas a Receber (storage.getReceivables({status:'vencida'})): traz o
// número REAL da NF (title_number, com correção do pipeline), o valor em aberto
// (amount - amount_paid) e o vencimento, pela MESMA regra da tela (status 'vencida'
// OU 'a_vencer' com vencimento < hoje no fuso Brasil). NÃO usa mais a tabela
// overdue_debts (sync do Omie, defasada).
// Carteira do vendedor = customers.seller_id (fallback: sellerName do recebível).
// - Vendedores/telemarketing recebem SOMENTE a própria carteira.
// - Coordenadores/administradores/admin recebem UMA lista CONSOLIDADA (todas as
//   carteiras, agrupada por vendedor) + os números fixos (system_settings 'debitos_fixos').
// Conteúdo por título: nome do cliente, número da NF, valor e vencimento.

function isBusinessDayBrazil(d?: Date): boolean {
  const now = d || new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dow = now.getDay(); // 0=Dom ... 6=Sab
  if (dow === 0 || dow === 6) return false;
  const y = now.getFullYear();
  // Páscoa (Meeus/Jones/Butcher)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, dd = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(y, month - 1, day);
  const md = (dt: Date) => String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const off = (base: Date, days: number) => { const x = new Date(base); x.setDate(x.getDate() + days); return md(x); };
  // Feriados nacionais fixos
  const fixos = new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25']);
  // Feriados móveis (relativos à Páscoa): Carnaval seg+ter, Sexta-feira Santa, Corpus Christi
  const moveis = new Set([off(easter, -48), off(easter, -47), off(easter, -2), off(easter, 60)]);
  const today = md(now);
  if (fixos.has(today) || moveis.has(today)) return false;
  return true;
}

type Titulo = { nf: string; valor: number; venc: string; dias: number };
type Cli = { nome: string; cidade: string; total: number; maxDias: number; titulos: Titulo[] };
type Seller = { u: any; nome: string; clientes: Map<string, Cli>; totalGeral: number };

// Empacota "blocos" (texto já pronto por cliente) em partes <= budget, com cabeçalho/rodapé.
function empacotar(blocks: string[], header: (part: number, tot: number) => string, footer: string, budget = 1900): string[] {
  const worst = header(99, 99).length;
  const maxBody = budget - worst - footer.length;
  const chunks: string[] = [];
  let cur = '';
  for (const blk of blocks) {
    const cand = cur === '' ? blk : cur + '\n' + blk;
    if (cur !== '' && cand.length > maxBody) { chunks.push(cur); cur = blk; }
    else { cur = cand; }
  }
  if (cur !== '') chunks.push(cur);
  const tot = chunks.length || 1;
  return chunks.map((b, idx) => header(idx + 1, tot) + b + (idx === tot - 1 ? footer : ''));
}

export async function enviarAlertaDebitosVencidos(apply: boolean, opts?: { toOverride?: string; limit?: number }): Promise<any> {
  const toOverride = opts && opts.toOverride ? String(opts.toOverride).replace(/[^0-9]/g, '') : '';
  const limit = opts && opts.limit && opts.limit > 0 ? opts.limit : 0;
  const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
  const digits = (v: any) => String(v || '').replace(/[^0-9]/g, '');
  const unesc = (v: any) => String(v || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?34;/g, '"').replace(/&apos;/g, "'");
  const brl = (n: number) => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const normName = (s: any) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const hojeBR = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const isoBR = (v: any) => { const d = (v instanceof Date) ? v : new Date(v); return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); };
  const ddmm = (v: any) => { try { const s = isoBR(v); const [, mo, da] = s.split('-'); return da + '/' + mo; } catch { return String(v || '').slice(0, 10); } };
  const diasAtraso = (v: any) => { try { const ms = Date.parse(hojeBR + 'T00:00:00Z') - Date.parse(isoBR(v) + 'T00:00:00Z'); return Math.max(0, Math.round(ms / 86400000)); } catch { return 0; } };

  // 1) Recebíveis VENCIDOS em aberto (fonte = aba Contas a Receber).
  const recsAll: any[] = await storage.getReceivables({ status: 'vencida' } as any);
  const recs = recsAll.filter((r) => String(r.status) === 'vencida' && (Number(r.amount || 0) - Number(r.amountPaid || 0)) > 0.005);

  // 2) Cadastro de clientes (carteira/vendedor + cidade)
  const cs = rowsOf(await db.execute(sql`SELECT id, name, city, cnpj, cpf, seller_id FROM customers`));
  const custById = new Map<string, any>(); const custByDoc = new Map<string, any>();
  for (const c of cs) { custById.set(String(c.id), c); const d = digits(c.cnpj) || digits(c.cpf); if (d.length >= 11) custByDoc.set(d, c); }

  // 3) Usuários: nome, telefone, papel, código Omie
  const us = rowsOf(await db.execute(sql`SELECT id, first_name, last_name, email, omie_vendor_code, phone, role, is_active FROM users`));
  const uById = new Map<string, any>(); const uByCode = new Map<string, any>(); const uByName = new Map<string, any>();
  const nm = (u: any) => ((String(u.first_name || '').trim() + ' ' + String(u.last_name || '').trim()).trim() || (u.email ? String(u.email).split('@')[0] : '') || 'Vendedor');
  for (const u of us) { uById.set(String(u.id), u); if (u.omie_vendor_code) uByCode.set(String(u.omie_vendor_code), u); const n = normName(nm(u)); if (n && !uByName.has(n)) uByName.set(n, u); }
  const resolveById = (sid: string | null) => { if (!sid) return null; const st = String(sid); return uById.get(st) || uByCode.get(st) || uByCode.get(st.replace('omie-vendor-', '')) || null; };

  // Gestores = coordenadores/administradores/admin ativos com telefone.
  const gestores = us.filter((u: any) => ['admin', 'administrative', 'coordinator'].includes(String(u.role)) && u.is_active !== false && digits(u.phone).length >= 10).map((u: any) => digits(u.phone));
  // Números fixos (system_settings 'debitos_fixos' CSV) — default 5562995782812
  let fixos: string[] = ['5562995782812'];
  try {
    const fx = rowsOf(await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='debitos_fixos' LIMIT 1")));
    if (fx[0] && fx[0].value) { const l = String(fx[0].value).split(',').map((x: string) => digits(x)).filter((x: string) => x.length >= 10); if (l.length) fixos = l; }
  } catch { }

  // 4) Agrupa por carteira (vendedor) -> cliente -> títulos
  const NONE = '__sem_vendedor__';
  const bySeller = new Map<string, Seller>();
  for (const r of recs) {
    const cid = String(r.customerId || '');
    const doc = digits(r.customerDocument);
    const cust = custById.get(cid) || (doc.length >= 11 ? custByDoc.get(doc) : null);
    // Resolve a carteira: 1º cadastro (seller_id), depois nome do vendedor do recebível.
    let u = cust ? resolveById(cust.seller_id ? String(cust.seller_id) : null) : null;
    if (!u && r.sellerName) u = uByName.get(normName(r.sellerName)) || null;
    const sellerKey = u ? String(u.id) : NONE;

    const nf = String(r.titleNumber || '').trim();
    const valor = Number(r.amount || 0) - Number(r.amountPaid || 0);
    const venc = ddmm(r.dueDate);
    const dias = diasAtraso(r.dueDate);
    const nomeCli = unesc(r.customerName || (cust ? cust.name : '') || 'Cliente');
    const cidade = unesc(cust ? (cust.city || '') : '');
    const custKey = cid || doc || normName(nomeCli);

    let s = bySeller.get(sellerKey);
    if (!s) { s = { u, nome: u ? nm(u) : 'Sem vendedor', clientes: new Map(), totalGeral: 0 }; bySeller.set(sellerKey, s); }
    let cli = s.clientes.get(custKey);
    if (!cli) { cli = { nome: nomeCli, cidade, total: 0, maxDias: 0, titulos: [] }; s.clientes.set(custKey, cli); }
    cli.titulos.push({ nf, valor, venc, dias });
    cli.total += valor;
    cli.maxDias = Math.max(cli.maxDias, dias);
    s.totalGeral += valor;
  }

  // Bloco de texto de um cliente (cabeçalho + títulos: NF, valor, vencimento).
  const blocoCliente = (idx: number, c: Cli): string => {
    c.titulos.sort((a, b) => b.dias - a.dias);
    const lines = [`${idx}. *${c.nome}*${c.cidade ? ' — ' + c.cidade : ''} — ${brl(c.total)} (${c.maxDias}d)`];
    for (const t of c.titulos) lines.push(`   • ${t.nf ? t.nf + ' — ' : ''}${brl(t.valor)} — venc. ${t.venc}`);
    return lines.join('\n');
  };

  // 5) Plano por VENDEDOR (somente carteiras de vendedor/telemarketing com usuário resolvido).
  const plano: any[] = [];
  for (const [key, s] of bySeller) {
    if (key === NONE || !s.u) continue;
    if (!['vendedor', 'telemarketing'].includes(String(s.u.role))) continue;
    const clientes = Array.from(s.clientes.values()).sort((a, b) => b.total - a.total);
    if (!clientes.length) continue;
    const footer = `\n\n📞 Priorize a cobrança destes clientes hoje. Bom trabalho!`;
    const header = (part: number, tot: number) => `☀️ Bom dia, ${s.nome}!${tot > 1 ? ` (parte ${part}/${tot})` : ''}\n💸 *Débitos vencidos da sua carteira*: ${clientes.length} cliente(s), total *${brl(s.totalGeral)}*.\n\n📋 Clientes (maior valor primeiro):\n`;
    const blocks = clientes.map((c, i) => blocoCliente(i + 1, c));
    const msgs = empacotar(blocks, header, footer);
    const sellerPhone = digits(s.u.phone);
    plano.push({ vendedor: s.nome, sellerId: String(s.u.id), sellerPhone: sellerPhone || null, clientes: clientes.length, totalDevido: s.totalGeral, _msgs: msgs, partes: msgs.length });
  }
  plano.sort((a, b) => b.totalDevido - a.totalDevido);

  // 6) Mensagem CONSOLIDADA para gestores: todas as carteiras, agrupada por vendedor.
  const totalGeralTodos = Array.from(bySeller.values()).reduce((acc, s) => acc + s.totalGeral, 0);
  const totalClientesTodos = Array.from(bySeller.values()).reduce((acc, s) => acc + s.clientes.size, 0);
  const gruposOrdenados = Array.from(bySeller.values()).sort((a, b) => b.totalGeral - a.totalGeral);
  const consBlocks: string[] = [];
  for (const s of gruposOrdenados) {
    const clientes = Array.from(s.clientes.values()).sort((a, b) => b.total - a.total);
    if (!clientes.length) continue;
    const sub: string[] = [`👤 *${s.nome}* — ${brl(s.totalGeral)} (${clientes.length} cliente(s))`];
    clientes.forEach((c, i) => { sub.push(blocoCliente(i + 1, c)); });
    consBlocks.push(sub.join('\n'));
  }
  const consFooter = `\n\n📊 Total geral: *${brl(totalGeralTodos)}* em ${totalClientesTodos} cliente(s).`;
  const consHeader = (part: number, tot: number) => `☀️ Bom dia! (gestão)\n💸 *Débitos vencidos — TODAS as carteiras*${tot > 1 ? ` (parte ${part}/${tot})` : ''}: total *${brl(totalGeralTodos)}*, ${totalClientesTodos} cliente(s).\n`;
  const consMsgs = consBlocks.length ? empacotar(consBlocks, consHeader, consFooter) : [];
  const consolidado = { destinatarios: Array.from(new Set([...gestores, ...fixos])), partes: consMsgs.length, msgs: consMsgs };

  // 7) Envio
  let enviados = 0, falhas = 0; const detalhes: any[] = [];
  if (apply) {
    const jobs: Array<{ to: string; m: string }> = [];
    if (toOverride && toOverride.length >= 10) {
      // TESTE: manda tudo para o número de override (gestor consolidado + amostra de carteiras).
      for (const m of consMsgs) jobs.push({ to: toOverride, m });
      const amostra = limit > 0 ? plano.slice(0, limit) : plano;
      for (const p of amostra) for (const m of p._msgs) jobs.push({ to: toOverride, m });
    } else {
      // Consolidada -> gestores + fixos
      for (const to of consolidado.destinatarios) for (const m of consMsgs) jobs.push({ to, m });
      // Carteira -> cada vendedor (só a própria)
      const alvo = limit > 0 ? plano.slice(0, limit) : plano;
      for (const p of alvo) { if (!p.sellerPhone) continue; for (const m of p._msgs) jobs.push({ to: p.sellerPhone, m }); }
    }
    for (const j of jobs) {
      try { const rr = await sendUmblerTalkText(j.to, j.m); if (rr.success) enviados++; else { falhas++; detalhes.push({ to: j.to, err: rr.error }); } }
      catch (err: any) { falhas++; detalhes.push({ to: j.to, err: String(err) }); }
      await new Promise((r) => setTimeout(r, 600));
    }
    try {
      const stamp = new Date().toISOString() + ' enviados=' + enviados + ' falhas=' + falhas + ' vendedores=' + plano.length + ' gestores=' + gestores.length;
      const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + stamp + "', updated_by='cron-debitos', updated_at=now() WHERE key='debitos_alerta_last'"));
      const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
      if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('debitos_alerta_last','" + stamp + "','cron-debitos')"));
    } catch { }
  }

  return {
    apply,
    fonte: 'receivables (Contas a Receber)',
    vendedoresComLista: plano.length,
    gestores: gestores.length,
    fixos,
    totalGeral: totalGeralTodos,
    totalClientes: totalClientesTodos,
    enviados, falhas, detalhes: detalhes.slice(0, 20),
    consolidado,
    plano: plano.map(({ _msgs, ...rest }) => ({ ...rest, msgs: _msgs })),
  };
}

// Wrapper do cron: só envia em DIA ÚTIL e se a flag estiver ligada (system_settings 'debitos_alerta_ativo' = 'on').
export async function runDebitosVencidosAlertaCron(): Promise<void> {
  try {
    if (!isBusinessDayBrazil()) { console.log('[debitos-alerta] hoje não é dia útil (fim de semana/feriado) — pulando'); return; }
    const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='debitos_alerta_ativo' LIMIT 1"));
    const rows = r && r.rows ? r.rows : (Array.isArray(r) ? r : []);
    const ativo = rows[0] && String(rows[0].value).toLowerCase() === 'on';
    if (!ativo) { console.log('[debitos-alerta] flag desligada (debitos_alerta_ativo != on) — pulando'); return; }
    const out = await enviarAlertaDebitosVencidos(true);
    console.log('[debitos-alerta] enviado:', JSON.stringify({ vendedores: out.vendedoresComLista, gestores: out.gestores, enviados: out.enviados, falhas: out.falhas }));
  } catch (err: any) {
    console.error('[debitos-alerta] erro:', err?.message || err);
  }
}
