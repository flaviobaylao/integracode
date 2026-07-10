import { db } from './db';
import { sql } from 'drizzle-orm';
import { sendUmblerTalkText } from './chat-routes';

// Alerta diário (dias úteis): débitos VENCIDOS dos clientes da carteira, por vendedor.
// Fonte: tabela overdue_debts (sincronizada do Omie) — por cliente: total, dias em atraso e
// a lista de títulos (numero_documento, valor, data_vencimento, dias_atraso).
// Carteira do vendedor = customers.seller_id (mesma definição do alerta de positivação);
// fallback = 1º código em overdue_debts.vendedores (código Omie) quando o cadastro não resolve.
// Destinatários: telefone do vendedor (users.phone) + gestores (admin/administrative com telefone) + fixos.

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

export async function enviarAlertaDebitosVencidos(apply: boolean, opts?: { toOverride?: string; limit?: number }): Promise<any> {
  const toOverride = opts && opts.toOverride ? String(opts.toOverride).replace(/[^0-9]/g, '') : '';
  const limit = opts && opts.limit && opts.limit > 0 ? opts.limit : 0;
  const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
  const digits = (v: any) => String(v || '').replace(/[^0-9]/g, '');
  const unesc = (v: any) => String(v || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#0?34;/g, '"').replace(/&apos;/g, "'");
  const brl = (n: number) => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ddmm = (s: any) => { const d = String(s || ''); const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[3] + '/' + m[2]; const m2 = d.match(/^(\d{2})\/(\d{2})/); if (m2) return m2[1] + '/' + m2[2]; return d.slice(0, 10); };

  // 1) Débitos vencidos (fonte-verdade da tela "Débitos Vencidos")
  const od = rowsOf(await db.execute(sql`
    SELECT client_id, client_document, client_name, total_amount, max_days_overdue, vendedores, debts
    FROM overdue_debts
    WHERE COALESCE(total_amount,0) > 0`));

  // 2) Cadastro de clientes (para resolver a carteira/vendedor + cidade)
  const cs = rowsOf(await db.execute(sql`
    SELECT id, name, city, cnpj, cpf, seller_id FROM customers`));
  const custById = new Map<string, any>(); const custByDoc = new Map<string, any>();
  for (const c of cs) { custById.set(String(c.id), c); const d = digits(c.cnpj) || digits(c.cpf); if (d.length >= 11) custByDoc.set(d, c); }

  // 3) Usuários: nome, telefone, papel, código Omie
  const us = rowsOf(await db.execute(sql`SELECT id, first_name, last_name, email, omie_vendor_code, phone, role, is_active FROM users`));
  const uById = new Map<string, any>(); const uByCode = new Map<string, any>();
  const nm = (u: any) => ((String(u.first_name || '').trim() + ' ' + String(u.last_name || '').trim()).trim() || (u.email ? String(u.email).split('@')[0] : '') || 'Vendedor');
  for (const u of us) { uById.set(String(u.id), u); if (u.omie_vendor_code) uByCode.set(String(u.omie_vendor_code), u); }
  const resolveById = (sid: string | null) => { if (!sid) return null; const st = String(sid); return uById.get(st) || uByCode.get(st) || uByCode.get(st.replace('omie-vendor-', '')) || null; };
  const resolveByCode = (code: any) => { const st = String(code || '').trim(); if (!st) return null; return uByCode.get(st) || null; };

  // Gestores (coordenadores/diretores) = admin/administrative com telefone cadastrado
  const gestores = us.filter((u: any) => ['admin', 'administrative'].includes(String(u.role)) && u.is_active !== false && digits(u.phone).length >= 10).map((u: any) => digits(u.phone));
  // Números fixos (system_settings 'debitos_fixos' CSV) — default 5562995782812
  let fixos: string[] = ['5562995782812'];
  try {
    const fx = rowsOf(await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='debitos_fixos' LIMIT 1")));
    if (fx[0] && fx[0].value) { const l = String(fx[0].value).split(',').map((x: string) => digits(x)).filter((x: string) => x.length >= 10); if (l.length) fixos = l; }
  } catch { }

  // 4) Agrupa débitos por vendedor da carteira
  type Cli = { nome: string; cidade: string; total: number; maxDias: number; titulos: { doc: string; valor: number; venc: string; dias: number }[] };
  const bySeller = new Map<string, { u: any; clientes: Cli[]; totalGeral: number }>();
  const seen = new Set<string>();
  for (const r of od) {
    const cidKey = String(r.client_id || '');
    const doc = digits(r.client_document);
    const dedupKey = cidKey || doc;
    if (dedupKey && seen.has(dedupKey)) continue;
    if (dedupKey) seen.add(dedupKey);

    // Resolve o vendedor: 1º pelo cadastro (seller_id), depois pelo código Omie do débito
    const cust = custById.get(cidKey) || (doc.length >= 11 ? custByDoc.get(doc) : null);
    let u = cust ? resolveById(cust.seller_id ? String(cust.seller_id) : null) : null;
    if (!u) {
      let vends: any[] = [];
      const raw = r.vendedores;
      if (Array.isArray(raw)) vends = raw;
      else if (typeof raw === 'string') { try { const p = JSON.parse(raw); if (Array.isArray(p)) vends = p; } catch { } }
      for (const code of vends) { const cand = resolveByCode(code); if (cand) { u = cand; break; } }
    }
    if (!u) continue;
    if (!['vendedor', 'telemarketing'].includes(String(u.role))) continue;

    // Títulos individuais do débito
    let debts: any[] = [];
    const rawD = r.debts;
    if (Array.isArray(rawD)) debts = rawD;
    else if (typeof rawD === 'string') { try { const p = JSON.parse(rawD); if (Array.isArray(p)) debts = p; } catch { } }
    const titulos = debts.map((d: any) => ({
      doc: String(d.numero_documento || d.numeroDocumento || '').trim(),
      valor: Number(d.valor) || 0,
      venc: ddmm(d.data_vencimento || d.dataVencimento),
      dias: Number(d.dias_atraso ?? d.diasAtraso) || 0,
    })).filter((t: any) => t.valor > 0).sort((a: any, b: any) => b.dias - a.dias);

    const nomeCli = unesc(r.client_name || (cust ? cust.name : '') || 'Cliente');
    const cidade = unesc(cust ? (cust.city || '') : '');
    const cli: Cli = {
      nome: nomeCli, cidade,
      total: Number(r.total_amount) || 0,
      maxDias: Number(r.max_days_overdue) || 0,
      titulos,
    };
    const key = String(u.id);
    const e = bySeller.get(key) || { u, clientes: [], totalGeral: 0 };
    e.clientes.push(cli);
    e.totalGeral += cli.total;
    bySeller.set(key, e);
  }

  const plano: any[] = [];
  for (const [, e] of bySeller) {
    if (e.clientes.length === 0) continue;
    const vendedorNome = nm(e.u);
    // Ordena clientes por maior valor devido primeiro
    e.clientes.sort((a, b) => b.total - a.total);

    const footer = `\n\n📞 Priorize a cobrança destes clientes hoje. Bom trabalho!`;
    const BUDGET = 1900; // limite do Umbler é 2000 chars — margem de segurança
    const mkHeader = (part: number, tot: number) => `☀️ Bom dia, ${vendedorNome}!${tot > 1 ? ` (parte ${part}/${tot})` : ''}\n💸 *Débitos vencidos da sua carteira*: ${e.clientes.length} cliente(s), total *${brl(e.totalGeral)}*.\n\n📋 Clientes com débitos vencidos (maior valor primeiro):\n`;

    // Cada cliente vira um BLOCO (cabeçalho + títulos); empacota blocos em partes <= BUDGET.
    const blocks: string[] = [];
    e.clientes.forEach((c, i) => {
      const lines: string[] = [];
      lines.push(`${i + 1}. *${c.nome}*${c.cidade ? ' — ' + c.cidade : ''} — ${brl(c.total)} (${c.maxDias}d em atraso)`);
      for (const t of c.titulos) {
        lines.push(`   • ${t.doc ? t.doc + ': ' : ''}${brl(t.valor)} venc. ${t.venc} (${t.dias}d)`);
      }
      blocks.push(lines.join('\n'));
    });

    const worstHeader = mkHeader(99, 99).length;
    const maxBody = BUDGET - worstHeader - footer.length;
    const chunks: string[] = [];
    let cur = '';
    for (const blk of blocks) {
      const cand = cur === '' ? blk : cur + '\n' + blk;
      if (cur !== '' && cand.length > maxBody) { chunks.push(cur); cur = blk; }
      else { cur = cand; }
    }
    if (cur !== '') chunks.push(cur);
    const tot = chunks.length || 1;
    const msgs = chunks.map((b, idx) => mkHeader(idx + 1, tot) + b + (idx === tot - 1 ? footer : ''));

    const sellerPhone = digits(e.u.phone);
    const destinatarios = Array.from(new Set([...(sellerPhone.length >= 10 ? [sellerPhone] : []), ...gestores, ...fixos]));
    plano.push({ vendedor: vendedorNome, sellerId: String(e.u.id), sellerPhone: sellerPhone || null, clientes: e.clientes.length, totalDevido: e.totalGeral, destinatarios, _msgs: msgs });
  }

  // Ordena o plano por maior total devido (visão de gestor)
  plano.sort((a, b) => b.totalDevido - a.totalDevido);

  let enviados = 0, falhas = 0; const detalhes: any[] = [];
  if (apply) {
    const alvo = limit > 0 ? plano.slice(0, limit) : plano;
    for (const p of alvo) {
      const dests = (toOverride && toOverride.length >= 10) ? [toOverride] : p.destinatarios;
      for (const to of dests) {
        for (const m of p._msgs) {
          try { const rr = await sendUmblerTalkText(to, m); if (rr.success) enviados++; else { falhas++; detalhes.push({ to, err: rr.error }); } }
          catch (err: any) { falhas++; detalhes.push({ to, err: String(err) }); }
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }
    try {
      const stamp = new Date().toISOString() + ' enviados=' + enviados + ' falhas=' + falhas + ' vendedores=' + plano.length;
      const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + stamp + "', updated_by='cron-debitos', updated_at=now() WHERE key='debitos_alerta_last'"));
      const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
      if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('debitos_alerta_last','" + stamp + "','cron-debitos')"));
    } catch { }
  }
  return { apply, vendedoresComLista: plano.length, gestores: gestores.length, fixos, enviados, falhas, detalhes: detalhes.slice(0, 20), plano: plano.map(({ _msgs, ...rest }) => ({ ...rest, partes: _msgs.length, msgs: _msgs })) };
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
    console.log('[debitos-alerta] enviado:', JSON.stringify({ vendedores: out.vendedoresComLista, enviados: out.enviados, falhas: out.falhas }));
  } catch (err: any) {
    console.error('[debitos-alerta] erro:', err?.message || err);
  }
}
