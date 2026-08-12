import { db } from './db';
import { sql } from 'drizzle-orm';
import { sendUmblerTalkText } from './chat-routes';

// ============================================================================
// Alerta de fim de dia: lista dos clientes (presenciais/virtuais) da rota de HOJE
// que NÃO foram visitados, por vendedor. "Visitado" = check-in OU pedido do dia
// OU atendimento virtual registrado.
//   - Vendedor EXTERNO (role 'vendedor')      -> WhatsApp do próprio vendedor (users.phone)
//   - Vendedor INTERNO  (role 'telemarketing') -> WhatsApp da Cinthia (62999883656)
// Dispara às 18:30 (BRT) em dias úteis (cron no scheduler.ts), com kill-switch em
// system_settings 'rota_nao_visitados_ativo' (default OFF — ligar após conferir o preview).
// ============================================================================

const CINTHIA_PHONE = '62999883656'; // vendedores internos (telemarketing) -> Cinthia

export async function enviarAlertaNaoVisitados(
  apply: boolean,
  opts?: { toOverride?: string; limit?: number }
): Promise<any> {
  const rowsOf = (r: any): any[] => (r && r.rows ? r.rows : (Array.isArray(r) ? r : []));
  const digits = (v: any) => String(v || '').replace(/[^0-9]/g, '');
  const toOverride = opts && opts.toOverride ? digits(opts.toOverride) : '';
  const limit = opts && opts.limit && opts.limit > 0 ? opts.limit : 0;

  // 1) ROTA DE HOJE por cliente: cards agendados para hoje (BRT).
  //    - Permanente: next_visit_date = hoje e status pendente (após visita o card avança de data).
  //    - Não-permanente: scheduled_date = hoje (qualquer status; o "visitado" é subtraído depois).
  //    Vendedor responsável = seller do card, senão o do cadastro do cliente.
  const rota = rowsOf(await db.execute(sql`
    SELECT DISTINCT c.id AS cid, c.name AS nome, c.city AS cidade,
           c.virtual_service AS virtual, COALESCE(sc.seller_id, c.seller_id) AS sid
    FROM sales_cards sc
    JOIN customers c ON c.id = sc.customer_id
    WHERE c.is_active = true AND COALESCE(c.omie_status, 'ativo') = 'ativo'
      AND (
        (sc.is_permanent = true
          AND (sc.next_visit_date)::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
          AND sc.status IN ('pending', 'in_progress'))
        OR
        ((sc.is_permanent = false OR sc.is_permanent IS NULL)
          AND (sc.scheduled_date)::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date)
      )`));

  // 2) VISITADOS hoje = check-in OU pedido (venda) OU atendimento virtual.
  const checkins = rowsOf(await db.execute(sql`
    SELECT DISTINCT customer_id AS cid FROM route_checkpoints
    WHERE checkpoint_type = 'check_in'
      AND (checkpoint_time AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`));
  const pedidos = rowsOf(await db.execute(sql`
    SELECT DISTINCT customer_id AS cid FROM billing_pipeline
    WHERE (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
      AND LOWER(COALESCE(NULLIF(operation_type::text, ''), 'venda')) = 'venda'`));
  const virtuais = rowsOf(await db.execute(sql`
    SELECT DISTINCT customer_id AS cid FROM virtual_service_logs
    WHERE (attendance_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`));
  const visitados = new Set<string>();
  for (const r of [...checkins, ...pedidos, ...virtuais]) if (r.cid) visitados.add(String(r.cid));

  // 3) Usuários (resolver seller_id -> user; trata omie_vendor_code).
  const us = rowsOf(await db.execute(sql`SELECT id, first_name, last_name, email, omie_vendor_code, phone, role, is_active FROM users`));
  const uById = new Map<string, any>();
  const uByCode = new Map<string, any>();
  const nm = (u: any) => ((String(u.first_name || '').trim() + ' ' + String(u.last_name || '').trim()).trim() || (u.email ? String(u.email).split('@')[0] : '') || 'Vendedor');
  for (const u of us) { uById.set(String(u.id), u); if (u.omie_vendor_code) uByCode.set(String(u.omie_vendor_code), u); }
  const resolveUser = (sid: string | null) => {
    if (!sid) return null;
    const st = String(sid);
    return uById.get(st) || uByCode.get(st) || uByCode.get(st.replace('omie-vendor-', '')) || null;
  };

  // 4) Agrupa NÃO visitados por vendedor (só papéis vendedor/telemarketing).
  const bySeller = new Map<string, { u: any; lista: { nome: string; cidade: string; virtual: boolean }[]; total: number }>();
  const seen = new Set<string>();
  for (const r of rota) {
    const cid = String(r.cid);
    if (seen.has(cid)) continue; seen.add(cid);
    const u = resolveUser(r.sid ? String(r.sid) : null);
    if (!u) continue;
    if (!['vendedor', 'telemarketing'].includes(String(u.role))) continue;
    const key = String(u.id);
    const e = bySeller.get(key) || { u, lista: [], total: 0 };
    e.total++;
    if (!visitados.has(cid)) e.lista.push({ nome: String(r.nome || 'Cliente'), cidade: String(r.cidade || ''), virtual: r.virtual === true });
    bySeller.set(key, e);
  }

  // 5) Monta mensagens (quebra em partes <= 1900 chars) + destinatário.
  const nowBr = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dataBr = `${String(nowBr.getDate()).padStart(2, '0')}/${String(nowBr.getMonth() + 1).padStart(2, '0')}/${nowBr.getFullYear()}`;
  const BUDGET = 1900;
  const plano: any[] = [];
  for (const [, e] of bySeller) {
    if (e.lista.length === 0) continue;
    const vendedorNome = nm(e.u);
    const interno = String(e.u.role) === 'telemarketing';
    const destino = interno ? CINTHIA_PHONE : digits(e.u.phone);
    const visitadosN = e.total - e.lista.length;
    const footer = `\n\n📞 Vamos correr atrás dos que faltam!`;
    const mkHeader = (part: number, tot: number) =>
      `📋 *Clientes NÃO visitados hoje* (${dataBr})\n👤 ${vendedorNome}${interno ? ' (interno)' : ''}${tot > 1 ? ` — parte ${part}/${tot}` : ''}\n` +
      `✅ Visitados: ${visitadosN} de ${e.total} da rota • ⛔ Faltam: ${e.lista.length}\n`;

    const lines = e.lista
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map((c, i) => `${i + 1}. ${c.nome}${c.cidade ? ' — ' + c.cidade : ''}${c.virtual ? ' 💻(virtual)' : ''}`);

    const worst = mkHeader(99, 99).length;
    const maxBody = BUDGET - worst - footer.length;
    const chunks: string[] = [];
    let cur = '';
    for (const ln of lines) {
      const cand = cur === '' ? ln : cur + '\n' + ln;
      if (cur !== '' && cand.length > maxBody) { chunks.push(cur); cur = ln; }
      else cur = cand;
    }
    if (cur !== '') chunks.push(cur);
    const tot = chunks.length || 1;
    const msgs = chunks.map((b, idx) => mkHeader(idx + 1, tot) + b + (idx === tot - 1 ? footer : ''));

    plano.push({
      vendedor: vendedorNome, sellerId: String(e.u.id), interno, destino: destino || null,
      naoVisitados: e.lista.length, visitados: visitadosN, total: e.total, partes: msgs.length, _msgs: msgs,
    });
  }

  // 6) Envio.
  let enviados = 0, falhas = 0; const detalhes: any[] = [];
  if (apply) {
    const alvo = limit > 0 ? plano.slice(0, limit) : plano;
    for (const p of alvo) {
      const to = toOverride && toOverride.length >= 10 ? toOverride : (p.destino ? digits(p.destino) : '');
      if (!to || to.length < 10) { falhas++; detalhes.push({ vendedor: p.vendedor, err: 'sem telefone de destino' }); continue; }
      for (const m of p._msgs) {
        try {
          const rr = await sendUmblerTalkText(to, m);
          if (rr.success) enviados++; else { falhas++; detalhes.push({ to, err: rr.error }); }
        } catch (err: any) { falhas++; detalhes.push({ to, err: String(err) }); }
        await new Promise(r => setTimeout(r, 600));
      }
    }
    try {
      const stamp = new Date().toISOString() + ' enviados=' + enviados + ' falhas=' + falhas + ' vendedores=' + plano.length;
      const upd: any = await db.execute(sql.raw("UPDATE system_settings SET value='" + stamp + "', updated_by='cron-nao-visitados', updated_at=now() WHERE key='rota_nao_visitados_last'"));
      const n = (upd && (upd.rowCount ?? (upd.rows ? upd.rows.length : 0))) || 0;
      if (!n) await db.execute(sql.raw("INSERT INTO system_settings (key,value,updated_by) VALUES ('rota_nao_visitados_last','" + stamp + "','cron-nao-visitados')"));
    } catch { }
  }

  return {
    apply, data: dataBr, vendedoresComLista: plano.length, enviados, falhas,
    detalhes: detalhes.slice(0, 20),
    plano: plano.map(({ _msgs, ...rest }) => ({ ...rest, msgs: _msgs })),
  };
}

// Wrapper do cron: só envia se a flag estiver LIGADA (system_settings 'rota_nao_visitados_ativo' = 'on').
// Default DESLIGADO por segurança — ligar após conferir o preview.
export async function runRotaNaoVisitadosCron(): Promise<void> {
  try {
    const r: any = await db.execute(sql.raw("SELECT value FROM system_settings WHERE key='rota_nao_visitados_ativo' LIMIT 1"));
    const rows = r && r.rows ? r.rows : (Array.isArray(r) ? r : []);
    const ativo = rows[0] && String(rows[0].value).toLowerCase() === 'on';
    if (!ativo) { console.log('[nao-visitados] flag desligada (rota_nao_visitados_ativo != on) — pulando'); return; }
    const out = await enviarAlertaNaoVisitados(true);
    console.log('[nao-visitados] enviado:', JSON.stringify({ vendedores: out.vendedoresComLista, enviados: out.enviados, falhas: out.falhas }));
  } catch (err: any) {
    console.error('[nao-visitados] erro:', err?.message || err);
  }
}
