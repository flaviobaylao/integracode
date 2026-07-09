import { db } from './db';
import { sql } from 'drizzle-orm';
import { sendUmblerTalkText } from './chat-routes';

// Alerta diário: lista de clientes ativos NÃO positivados no mês, por vendedor.
// Destinatários: telefone do vendedor (users.phone) + gestores (admin/administrative com telefone) + números fixos.
// Positivado = comprou no mês (billing_pipeline OU receivable — inclui faturas do 1.0).
export async function enviarAlertaPositivacaoVendedores(apply: boolean, opts?: { toOverride?: string; limit?: number }): Promise<any> {
  const toOverride = opts && opts.toOverride ? String(opts.toOverride).replace(/[^0-9]/g, '') : '';
  const limit = opts && opts.limit && opts.limit > 0 ? opts.limit : 0;
  const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
  const digits = (v: any) => String(v || '').replace(/[^0-9]/g, '');

  // 1) Universo: clientes na lista de Ativos (resolvidos no cadastro)
  const au = rowsOf(await db.execute(sql`
    SELECT c.id AS rid, c.name AS nome, c.city AS cidade, c.cnpj AS cnpj, c.cpf AS cpf, c.seller_id AS sid, c.weekdays AS weekdays
    FROM active_customers ac
    LEFT JOIN customers c ON c.id = ac.customer_id
    WHERE ac.is_active IS NOT FALSE AND c.id IS NOT NULL`));

  // 2) Positivação do mês (billing_pipeline OU receivable)
  const bp = rowsOf(await db.execute(sql`
    SELECT DISTINCT customer_id AS cid FROM billing_pipeline
    WHERE created_at >= date_trunc('month',(now() at time zone 'America/Sao_Paulo'))
      AND created_at < date_trunc('month',(now() at time zone 'America/Sao_Paulo')) + interval '1 month'
      AND COALESCE(sale_value,0) > 0`));
  const rc = rowsOf(await db.execute(sql`
    SELECT customer_id AS cid, customer_document AS doc FROM receivables
    WHERE issue_date >= date_trunc('month',(now() at time zone 'America/Sao_Paulo'))
      AND issue_date < date_trunc('month',(now() at time zone 'America/Sao_Paulo')) + interval '1 month'
      AND COALESCE(amount,0) > 0 AND status <> 'cancelada'`));
  const posById = new Set<string>(); const posByDoc = new Set<string>();
  for (const r of bp) if (r.cid) posById.add(String(r.cid));
  for (const r of rc) { if (r.cid) posById.add(String(r.cid)); const d = digits(r.doc); if (d.length >= 11) posByDoc.add(d); }

  // 3) Usuários: nome, telefone, papel
  const us = rowsOf(await db.execute(sql`SELECT id, first_name, last_name, email, omie_vendor_code, phone, role, is_active FROM users`));
  const uById = new Map<string, any>(); const uByCode = new Map<string, any>();
  const nm = (u: any) => ((String(u.first_name || '').trim() + ' ' + String(u.last_name || '').trim()).trim() || (u.email ? String(u.email).split('@')[0] : '') || 'Vendedor');
  for (const u of us) { uById.set(String(u.id), u); if (u.omie_vendor_code) uByCode.set(String(u.omie_vendor_code), u); }
  const resolveUser = (sid: string | null) => { if (!sid) return null; const st = String(sid); return uById.get(st) || uByCode.get(st) || uByCode.get(st.replace('omie-vendor-', '')) || null; };

  // Gestores (coordenadores/diretores) = admin/administrative com telefone cadastrado
  const gestores = us.filter((u: any) => ['admin', 'administrative'].includes(String(u.role)) && u.is_active !== false && digits(u.phone).length >= 10).map((u: any) => digits(u.phone));
  // Números fixos (system_settings 'positivacao_fixos' CSV) — default 5562995782812
  let fixos: string[] = ['5562995782812'];
  try {
    const fx = rowsOf(await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='positivacao_fixos' LIMIT 1")));
    if (fx[0] && fx[0].value) { const l = String(fx[0].value).split(',').map((x: string) => digits(x)).filter((x: string) => x.length >= 10); if (l.length) fixos = l; }
  } catch { }

  // 4) Agrupa NÃO positivados por vendedor
  const bySeller = new Map<string, { u: any; naoPos: { nome: string; cidade: string }[]; total: number }>();
  const seenC = new Set<string>();
  for (const r of au) {
    const rid = String(r.rid); if (seenC.has(rid)) continue; seenC.add(rid);
    const doc = digits(r.cnpj) || digits(r.cpf);
    const pos = posById.has(rid) || (doc.length >= 11 && posByDoc.has(doc));
    const u = resolveUser(r.sid ? String(r.sid) : null);
    if (!u) continue;
    if (!['vendedor', 'telemarketing'].includes(String(u.role))) continue;
    const key = String(u.id);
    const e = bySeller.get(key) || { u, naoPos: [], total: 0 };
    e.total++;
    if (!pos) e.naoPos.push({ nome: String(r.nome || 'Cliente'), cidade: String(r.cidade || ''), weekdays: r.weekdays });
    bySeller.set(key, e);
  }

  const nowBr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const mes = nowBr.getMonth() + 1, ano = nowBr.getFullYear();
  // Helpers de dia de rota (weekdays do cadastro)
  const dayOrder = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom'];
  const dayFull: Record<string, string> = { Seg: 'Segunda', Ter: 'Terça', Qua: 'Quarta', Qui: 'Quinta', Sex: 'Sexta', Sab: 'Sábado', Dom: 'Domingo' };
  const normDay = (t: any): string | null => {
    const x = String(t || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (x.startsWith('seg')) return 'Seg'; if (x.startsWith('ter')) return 'Ter'; if (x.startsWith('qua')) return 'Qua';
    if (x.startsWith('qui')) return 'Qui'; if (x.startsWith('sex')) return 'Sex'; if (x.startsWith('sab')) return 'Sab'; if (x.startsWith('dom')) return 'Dom';
    return null;
  };
  const parseWeekdays = (w: any): string[] => {
    let arr: any[] = [];
    if (Array.isArray(w)) arr = w;
    else if (typeof w === 'string') { const t = w.trim(); if (t) { try { const p = JSON.parse(t); arr = Array.isArray(p) ? p : t.split(/[,;]/); } catch { arr = t.split(/[,;]/); } } }
    const out: string[] = [];
    for (const x of arr) { const d = normDay(x); if (d && !out.includes(d)) out.push(d); }
    out.sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
    return out;
  };
  const plano: any[] = [];
  for (const [, e] of bySeller) {
    if (e.naoPos.length === 0) continue;
    const vendedorNome = nm(e.u);
    const mm = String(mes).padStart(2, '0');
    const positivados = e.total - e.naoPos.length;
    const pctFat = e.total > 0 ? Math.round((positivados / e.total) * 100) : 0;
    const footer = `\n\n💪 Vamos positivá-los hoje!`;
    const BUDGET = 1900; // limite do Umbler é 2000 chars — margem de segurança
    const mkHeader = (part: number, tot: number) => `☀️ Bom dia, ${vendedorNome}!${tot > 1 ? ` (parte ${part}/${tot})` : ''}\n💰 ${pctFat}% da sua carteira já faturou este mês (${positivados} de ${e.total}).\n\n📋 Clientes ativos ainda *NÃO positivados* em ${mm}/${ano} (${e.naoPos.length} de ${e.total}) — por dia de rota:\n`;

    // Agrupa por dia de rota (primeiro weekday do cadastro); alfabético dentro de cada dia.
    const groups = new Map<string, { nome: string; cidade: string }[]>();
    for (const c of e.naoPos) {
      const days = parseWeekdays((c as any).weekdays);
      const key = days[0] || 'Sem';
      const g = groups.get(key) || [];
      g.push({ nome: c.nome, cidade: c.cidade });
      groups.set(key, g);
    }
    const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ia = a === 'Sem' ? 99 : dayOrder.indexOf(a); const ib = b === 'Sem' ? 99 : dayOrder.indexOf(b);
      return ia - ib;
    });
    const lines: string[] = [];
    let firstG = true;
    for (const key of orderedKeys) {
      const label = key === 'Sem' ? 'Sem dia de rota' : dayFull[key];
      if (!firstG) lines.push(''); firstG = false;
      lines.push(`🗓️ *${label}*`);
      const arr = groups.get(key)!.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      arr.forEach((c, i) => lines.push(`${i + 1}. ${c.nome}${c.cidade ? ' — ' + c.cidade : ''}`));
    }

    // Divide em partes <= BUDGET, ciente do dia (repete o cabeçalho do dia com "(cont.)" quando quebra no meio).
    const worstHeader = mkHeader(99, 99).length;
    const maxBody = BUDGET - worstHeader - footer.length;
    const chunks: string[] = [];
    let cur = ''; let curDay: string | null = null;
    const headerOf = (ln: string) => ln.startsWith('🗓️ ') ? ln.replace('🗓️ ', '').replace(/\*/g, '').replace(/ \(cont\.\)$/, '') : null;
    for (const ln of lines) {
      const cand = cur === '' ? ln : cur + '\n' + ln;
      if (cur !== '' && cand.length > maxBody) {
        chunks.push(cur);
        const h = headerOf(ln);
        if (!h && curDay) cur = `🗓️ *${curDay} (cont.)*\n` + ln; else cur = ln;
      } else { cur = cand; }
      const h2 = headerOf(ln); if (h2) curDay = h2;
    }
    if (cur !== '') chunks.push(cur);
    const tot = chunks.length || 1;
    const msgs = chunks.map((b, idx) => mkHeader(idx + 1, tot) + b + (idx === tot - 1 ? footer : ''));
    const sellerPhone = digits(e.u.phone);
    const destinatarios = Array.from(new Set([...(sellerPhone.length >= 10 ? [sellerPhone] : []), ...gestores, ...fixos]));
    plano.push({ vendedor: vendedorNome, sellerId: String(e.u.id), sellerPhone: sellerPhone || null, naoPositivados: e.naoPos.length, positivados, pctFaturamento: pctFat, total: e.total, destinatarios, _msgs: msgs });
  }

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
      const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + stamp + "', updated_by='cron-positivacao', updated_at=now() WHERE key='positivacao_alerta_last'"));
      const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
      if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('positivacao_alerta_last','" + stamp + "','cron-positivacao')"));
    } catch { }
  }
  return { apply, mes, ano, vendedoresComLista: plano.length, gestores: gestores.length, fixos, enviados, falhas, detalhes: detalhes.slice(0, 20), plano: plano.map(({ _msgs, ...rest }) => ({ ...rest, partes: _msgs.length, msgs: _msgs })) };
}

// Wrapper do cron: só envia se a flag estiver ligada (system_settings 'positivacao_alerta_ativo' = 'on').
export async function runPositivacaoAlertaCron(): Promise<void> {
  try {
    const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='positivacao_alerta_ativo' LIMIT 1"));
    const rows = r && r.rows ? r.rows : (Array.isArray(r) ? r : []);
    const ativo = rows[0] && String(rows[0].value).toLowerCase() === 'on';
    if (!ativo) { console.log('[positivacao-alerta] flag desligada (positivacao_alerta_ativo != on) — pulando'); return; }
    const out = await enviarAlertaPositivacaoVendedores(true);
    console.log('[positivacao-alerta] enviado:', JSON.stringify({ vendedores: out.vendedoresComLista, enviados: out.enviados, falhas: out.falhas }));
  } catch (err: any) {
    console.error('[positivacao-alerta] erro:', err?.message || err);
  }
}
