// ============================================================================
// RE-15 — ASSINATURA ELETRÔNICA DO RELATÓRIO DE PRODUÇÃO (Flavio, 04/out/2026)
//
// "permita que o relatório seja assinado pelo responsável via Integra"
//
// Como funciona:
// - A assinatura é POR ORDEM DE PRODUÇÃO (só finalizada) e por PAPEL
//   (Produção / Qualidade). O RE-15 de qualquer seleção de ordens mostra as
//   assinaturas de cada uma — não importa em que combinação o relatório sai.
// - O responsável confirma com a PRÓPRIA SENHA do Integra (bcrypt), na sessão
//   real dele: durante "Entrar como" a assinatura é recusada — ninguém assina
//   em nome de outro.
// - No ato da assinatura gravamos um SNAPSHOT dos dados que o RE-15 mostra
//   (sem custos) e o SHA-256 dele. Se a ordem for alterada depois (reaberta,
//   lote, análise, insumos...), o hash não confere e a assinatura passa a
//   aparecer como "alterada após a assinatura" — sem efeito.
// - Cada assinatura tem um CÓDIGO DE VERIFICAÇÃO. A rota pública
//   /verificar/re15/:codigo (sem login, com limite por IP) mostra quem
//   assinou, quando, o que foi assinado e se continua válida — é o que o
//   cliente/fiscal confere pelo QR code impresso no PDF.
//
// Tabela própria criada no boot (idempotente). Rotas /api/industria/re15/*
// herdam o guard de /api/industria (authenticateUser + admin) do index.ts.
// ============================================================================
import type { Express } from "express";
import crypto from "crypto";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import { comparePassword } from "./localAuth";
import { rateLimitPorIp } from "./authMiddleware";

export const PAPEIS: Record<string, string> = { producao: 'Produção', qualidade: 'Qualidade' };

let tabelaOk: Promise<void> | null = null;
export function ensureRe15Assinaturas(): Promise<void> {
  if (!tabelaOk) {
    tabelaOk = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS industria_assinaturas_op (
          id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
          documento VARCHAR NOT NULL DEFAULT 'RE-15',
          production_order_id VARCHAR NOT NULL,
          order_number VARCHAR,
          product_name VARCHAR,
          lot_number VARCHAR,
          papel VARCHAR NOT NULL,
          signer_user_id VARCHAR NOT NULL,
          signer_name VARCHAR,
          signer_email VARCHAR,
          signer_funcao VARCHAR,
          content_hash VARCHAR(64) NOT NULL,
          snapshot JSONB NOT NULL,
          codigo VARCHAR NOT NULL UNIQUE,
          ip VARCHAR,
          user_agent VARCHAR,
          signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          revoked_at TIMESTAMPTZ,
          revoked_by VARCHAR,
          revoke_reason VARCHAR
        )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_assin_op_order ON industria_assinaturas_op (production_order_id)`);
    })().catch((e) => { tabelaOk = null; throw e; });
  }
  return tabelaOk;
}

// ---------------------------------------------------------------------------
// Snapshot canônico: exatamente o conteúdo do RE-15 (sem custo). Ordem fixa
// de chaves e valores normalizados (numeric do pg chega como string, data
// como Date) para o hash ser estável entre leituras.
// ---------------------------------------------------------------------------
const nz = (v: any): any => (v === undefined || v === '' ? null : v);
const numN = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};
const dt = (v: any): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
};
const txt = (v: any): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

export function snapshotRe15(o: any, items: any[]) {
  const its = (items || []).map((it: any) => ({
    material_id: txt(it.raw_material_id),
    material: txt(it.raw_material_name),
    quantidade: numN(it.quantity_used),
    unidade: txt(it.unit),
    lote_mp: txt(it.lot_number),
  })).sort((a, b) =>
    String(a.material_id).localeCompare(String(b.material_id)) ||
    String(a.lote_mp).localeCompare(String(b.lote_mp)) ||
    (Number(a.quantidade) - Number(b.quantidade)));
  return {
    documento: 'RE-15',
    ordem: txt(o.order_number),
    produto: txt(o.product_name),
    status: txt(o.status),
    instancia: txt(o.instance_name),
    data_producao: dt(o.production_date || o.created_at),
    inicio: dt(o.start_date),
    fim: dt(o.end_date),
    qtd_planejada: numN(o.quantity),
    qtd_produzida: numN(o.quantity_produced),
    lote: txt(o.lot_number),
    validade_lote: dt(o.lot_expiry_date),
    brix: numN(o.brix_degree),
    ph: numN(o.ph),
    sensorial: txt(o.sensory_analysis),
    pasteurizacao_inicio: txt(o.pasteurization_start_time),
    pasteurizacao_fim: txt(o.pasteurization_end_time),
    temp_min: numN(o.pasteurization_start_temp),
    temp_max: numN(o.pasteurization_end_temp),
    observacoes: nz(txt(o.notes)),
    insumos: its,
  };
}
export const hashSnapshot = (s: any) => crypto.createHash('sha256').update(JSON.stringify(s), 'utf8').digest('hex');

// Código legível, sem caracteres ambíguos (0/O, 1/I/L). 12 símbolos ≈ 60 bits.
const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function novoCodigo(): string {
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALFA[b[i] % ALFA.length];
  return `RE15-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const inList = (ids: string[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

async function carregarOrdens(ids: string[]): Promise<Map<string, { o: any; items: any[] }>> {
  const out = new Map<string, { o: any; items: any[] }>();
  if (!ids.length) return out;
  const po: any = await db.execute(sql`SELECT * FROM production_orders WHERE id IN (${inList(ids)})`);
  const its: any = await db.execute(sql`SELECT * FROM production_order_items WHERE production_order_id IN (${inList(ids)})`);
  for (const o of (po.rows || [])) out.set(String(o.id), { o, items: [] });
  for (const it of (its.rows || [])) out.get(String(it.production_order_id))?.items.push(it);
  return out;
}

const nomeDe = (u: any) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim() || String(u?.email || 'Usuário');

// Situação de uma assinatura frente aos dados atuais da ordem
function situacao(a: any, hashAtual: string | null): 'valida' | 'alterada' | 'revogada' | 'ordem_excluida' {
  if (a.revoked_at) return 'revogada';
  if (hashAtual == null) return 'ordem_excluida';
  return hashAtual === a.content_hash ? 'valida' : 'alterada';
}

const pub = (a: any, sit: string) => ({
  id: a.id,
  production_order_id: a.production_order_id,
  papel: a.papel,
  papel_label: PAPEIS[a.papel] || a.papel,
  signer_user_id: a.signer_user_id,
  signer_name: a.signer_name,
  signer_funcao: a.signer_funcao,
  signed_at: a.signed_at,
  codigo: a.codigo,
  content_hash: a.content_hash,
  situacao: sit,
});

export function registerRe15AssinaturaRoutes(app: Express) {
  void ensureRe15Assinaturas().catch((e) => console.warn('[RE-15] tabela de assinaturas:', e?.message || e));

  // Assinaturas ativas das ordens pedidas (+ situação contra os dados atuais)
  app.get('/api/industria/re15/assinaturas', async (req: any, res) => {
    try {
      await ensureRe15Assinaturas();
      const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
      if (!ids.length) return res.json({ porOrdem: {} });
      const ordens = await carregarOrdens(ids);
      const r: any = await db.execute(sql`
        SELECT * FROM industria_assinaturas_op
         WHERE production_order_id IN (${inList(ids)}) AND revoked_at IS NULL
         ORDER BY signed_at ASC`);
      const hashes = new Map<string, string>();
      ordens.forEach((v, k) => hashes.set(k, hashSnapshot(snapshotRe15(v.o, v.items))));
      const porOrdem: Record<string, any[]> = {};
      for (const a of (r.rows || [])) {
        const k = String(a.production_order_id);
        (porOrdem[k] = porOrdem[k] || []).push(pub(a, situacao(a, hashes.get(k) ?? null)));
      }
      res.json({ porOrdem });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Assinar (uma ou várias ordens de uma vez, com a senha do próprio usuário)
  app.post('/api/industria/re15/assinar', async (req: any, res) => {
    try {
      await ensureRe15Assinaturas();
      if (req.impersonating) {
        return res.status(403).json({ error: 'Saia do modo "Entrar como" para assinar: a assinatura é sempre de quem está logado de verdade.' });
      }
      const papel = String(req.body?.papel || '');
      if (!PAPEIS[papel]) return res.status(400).json({ error: 'Papel inválido (use Produção ou Qualidade).' });
      const ids: string[] = Array.isArray(req.body?.orderIds) ? req.body.orderIds.map(String).slice(0, 200) : [];
      if (!ids.length) return res.status(400).json({ error: 'Nenhuma ordem selecionada.' });
      const senha = String(req.body?.senha || '');
      if (!senha) return res.status(400).json({ error: 'Informe sua senha do Integra para assinar.' });
      const funcao = txt(req.body?.funcao)?.slice(0, 120) || null;

      const u: any = await storage.getUser(String(req.currentUser?.id || ''));
      if (!u || !u.isActive || !u.password) return res.status(403).json({ error: 'Usuário sem senha cadastrada — não é possível assinar.' });
      const ok = await comparePassword(senha, String(u.password));
      if (!ok) {
        console.warn(`[RE-15] senha incorreta na assinatura — usuário ${u.email}`);
        return res.status(401).json({ error: 'Senha incorreta.' });
      }

      const ip = String((req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.socket?.remoteAddress || '').trim().slice(0, 80);
      const ua = String(req.headers['user-agent'] || '').slice(0, 250);
      const ordens = await carregarOrdens(ids);
      const resultado: any[] = [];

      for (const id of ids) {
        const v = ordens.get(id);
        if (!v) { resultado.push({ id, ok: false, motivo: 'ordem não encontrada' }); continue; }
        const { o, items } = v;
        if (o.status !== 'finalizada') { resultado.push({ id, ordem: o.order_number, ok: false, motivo: 'só ordens finalizadas podem ser assinadas' }); continue; }
        const snap = snapshotRe15(o, items);
        const hash = hashSnapshot(snap);

        const ex: any = await db.execute(sql`
          SELECT * FROM industria_assinaturas_op
           WHERE production_order_id = ${id} AND papel = ${papel} AND revoked_at IS NULL`);
        let jaValida: any = null;
        for (const a of (ex.rows || [])) {
          if (a.content_hash === hash) { jaValida = a; continue; }
          // Assinatura antiga sobre dados que mudaram: perde efeito e dá lugar à nova
          await db.execute(sql`
            UPDATE industria_assinaturas_op
               SET revoked_at = now(), revoked_by = ${u.email || u.id}, revoke_reason = 'substituída: ordem alterada após a assinatura'
             WHERE id = ${a.id}`);
        }
        if (jaValida) {
          resultado.push({ id, ordem: o.order_number, ok: false, motivo: `já assinada como ${PAPEIS[papel]} por ${jaValida.signer_name}` });
          continue;
        }
        let ins: any = null;
        for (let t = 0; t < 3 && !ins; t++) {
          try {
            const r: any = await db.execute(sql`
              INSERT INTO industria_assinaturas_op
                (production_order_id, order_number, product_name, lot_number, papel,
                 signer_user_id, signer_name, signer_email, signer_funcao,
                 content_hash, snapshot, codigo, ip, user_agent)
              VALUES (${id}, ${o.order_number}, ${o.product_name}, ${o.lot_number}, ${papel},
                 ${u.id}, ${nomeDe(u)}, ${u.email || null}, ${funcao},
                 ${hash}, ${JSON.stringify(snap)}::jsonb, ${novoCodigo()}, ${ip}, ${ua})
              RETURNING *`);
            ins = (r.rows || [])[0];
          } catch (e: any) { if (!/unique|duplicate/i.test(String(e?.message))) throw e; }
        }
        console.log(`[RE-15] ${o.order_number} assinada como ${papel} por ${u.email} (${ins?.codigo})`);
        resultado.push({ id, ordem: o.order_number, ok: true, codigo: ins?.codigo });
      }
      res.json({ resultado, assinadas: resultado.filter((r) => r.ok).length });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Revogar: só quem assinou (ou admin real — não o perfil Indústria promovido)
  app.post('/api/industria/re15/assinaturas/:id/revogar', async (req: any, res) => {
    try {
      await ensureRe15Assinaturas();
      if (req.impersonating) return res.status(403).json({ error: 'Saia do modo "Entrar como" para revogar.' });
      const r: any = await db.execute(sql`SELECT * FROM industria_assinaturas_op WHERE id = ${String(req.params.id)} LIMIT 1`);
      const a = (r.rows || [])[0];
      if (!a) return res.status(404).json({ error: 'Assinatura não encontrada.' });
      if (a.revoked_at) return res.json({ ok: true, jaRevogada: true });
      const u = req.currentUser;
      const adminReal = u?.role === 'admin' && !req.perfilIndustria && !req.perfilContador;
      if (String(a.signer_user_id) !== String(u?.id) && !adminReal) {
        return res.status(403).json({ error: 'Só quem assinou (ou um administrador) pode revogar esta assinatura.' });
      }
      const motivo = txt(req.body?.motivo)?.slice(0, 250) || 'revogada pelo usuário';
      await db.execute(sql`
        UPDATE industria_assinaturas_op SET revoked_at = now(), revoked_by = ${u?.email || u?.id}, revoke_reason = ${motivo}
         WHERE id = ${a.id}`);
      console.log(`[RE-15] assinatura ${a.codigo} (${a.order_number}) revogada por ${u?.email}: ${motivo}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ---------------------------------------------------------------------------
  // VERIFICAÇÃO PÚBLICA — /verificar/re15/:codigo (sem login)
  // ---------------------------------------------------------------------------
  app.get('/verificar/re15/:codigo', rateLimitPorIp(30), async (req: any, res: any) => {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]));
    const pagina = (corpo: string, status = 200) => {
      res.status(status);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verificação de assinatura — RE-15</title><meta name="robots" content="noindex">
<style>body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f6f7f6;color:#111}
.w{max-width:720px;margin:0 auto;padding:20px 16px}.cab{display:flex;align-items:center;gap:14px;border-bottom:2px solid #16a34a;padding-bottom:10px;margin-bottom:16px}
.cab img{height:52px}h1{font-size:18px;margin:0}h2{font-size:12px;color:#555;font-weight:normal;margin:3px 0 0}
.st{border-radius:8px;padding:12px 14px;margin:0 0 14px;font-size:15px;font-weight:bold}
.ok{background:#dcfce7;color:#14532d;border:1px solid #86efac}.alt{background:#fef3c7;color:#78350f;border:1px solid #fcd34d}.rev{background:#fee2e2;color:#7f1d1d;border:1px solid #fca5a5}
.st small{display:block;font-weight:normal;font-size:12px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;margin-bottom:14px}th,td{border:1px solid #d4d4d4;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f0f0f0;width:34%}td.num{text-align:right}.sec{font-size:13px;font-weight:bold;margin:14px 0 4px}
.hash{font-family:monospace;font-size:11px;word-break:break-all}.rod{font-size:11px;color:#666;margin-top:18px}</style></head>
<body><div class="w"><div class="cab"><img src="/honest-logo.png" alt="Honest"><div><h1>Verificação de assinatura eletrônica</h1>
<h2>RE-15 Relatório de Produção · PURO INDÚSTRIA E COMÉRCIO DE PRODUTOS NATURAIS LTDA · CNPJ 28.295.493/0001-53</h2></div></div>
${corpo}
<p class="rod">Assinatura eletrônica realizada no sistema Integra mediante autenticação do signatário com login e senha pessoais.
O conteúdo assinado é protegido por resumo criptográfico SHA-256: qualquer alteração posterior nos dados da ordem é detectada nesta página.</p>
</div></body></html>`);
    };
    try {
      await ensureRe15Assinaturas();
      const codigo = String(req.params.codigo || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
      const r: any = await db.execute(sql`SELECT * FROM industria_assinaturas_op WHERE codigo = ${codigo} LIMIT 1`);
      const a = (r.rows || [])[0];
      if (!a) {
        return pagina(`<div class="st rev">Código não encontrado<small>Confira se o código foi digitado exatamente como aparece no relatório (ex.: RE15-ABCD-EFGH-JKMN).</small></div>`, 404);
      }
      const ordens = await carregarOrdens([String(a.production_order_id)]);
      const v = ordens.get(String(a.production_order_id));
      const sit = situacao(a, v ? hashSnapshot(snapshotRe15(v.o, v.items)) : null);
      const quando = (d: any) => d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-';
      const dia = (d: any) => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '-';
      const nf = (x: any) => (x == null ? '-' : Number(x).toLocaleString('pt-BR', { maximumFractionDigits: 3 }));
      const s = typeof a.snapshot === 'string' ? JSON.parse(a.snapshot) : (a.snapshot || {});
      const st = sit === 'valida'
        ? `<div class="st ok">✔ Assinatura VÁLIDA<small>Os dados atuais da ordem conferem exatamente com o conteúdo assinado.</small></div>`
        : sit === 'alterada'
          ? `<div class="st alt">⚠ Ordem ALTERADA após a assinatura<small>Os dados da ordem foram modificados depois de assinados. Esta assinatura não vale para a versão atual; vale apenas para o conteúdo abaixo.</small></div>`
          : sit === 'revogada'
            ? `<div class="st rev">✖ Assinatura REVOGADA em ${esc(quando(a.revoked_at))}<small>Motivo: ${esc(a.revoke_reason || '-')}</small></div>`
            : `<div class="st rev">✖ A ordem de produção não existe mais no sistema<small>O conteúdo assinado está reproduzido abaixo.</small></div>`;
      const sens = s.sensorial === 'conforme' ? 'Conforme' : s.sensorial === 'nao_conforme' ? 'Não Conforme' : (s.sensorial || '-');
      const insumos = (s.insumos || []).map((i: any) =>
        `<tr><td>${esc(i.material || '-')}</td><td>${esc(i.unidade || '')}</td><td class="num">${nf(i.quantidade)}</td><td>${esc(i.lote_mp || '-')}</td></tr>`).join('');
      pagina(`${st}
<table><tbody>
<tr><th>Código de verificação</th><td><b>${esc(a.codigo)}</b></td></tr>
<tr><th>Assinado por</th><td>${esc(a.signer_name)}${a.signer_funcao ? ` — ${esc(a.signer_funcao)}` : ''}</td></tr>
<tr><th>Papel</th><td>Responsável — ${esc(PAPEIS[a.papel] || a.papel)}</td></tr>
<tr><th>Data/hora da assinatura</th><td>${esc(quando(a.signed_at))} (horário de Brasília)</td></tr>
<tr><th>Resumo SHA-256</th><td class="hash">${esc(a.content_hash)}</td></tr>
</tbody></table>
<p class="sec">Conteúdo assinado</p>
<table><tbody>
<tr><th>Ordem de produção</th><td>${esc(s.ordem || a.order_number)}</td></tr>
<tr><th>Produto</th><td>${esc(s.produto || a.product_name)}</td></tr>
<tr><th>Data de produção</th><td>${esc(dia(s.data_producao))}</td></tr>
<tr><th>Lote produzido / validade</th><td>${esc(s.lote || '-')} · val. ${esc(dia(s.validade_lote))}</td></tr>
<tr><th>Quantidade produzida</th><td>${nf(s.qtd_produzida ?? s.qtd_planejada)}</td></tr>
<tr><th>Brix / pH / sensorial</th><td>${nf(s.brix)} / ${nf(s.ph)} / ${esc(sens)}</td></tr>
<tr><th>Pasteurização</th><td>${esc(s.pasteurizacao_inicio || '-')} até ${esc(s.pasteurizacao_fim || '-')} · ${nf(s.temp_min)} °C a ${nf(s.temp_max)} °C</td></tr>
</tbody></table>
<p class="sec">Matéria-prima consumida</p>
<table><thead><tr><th style="width:auto">Material</th><th style="width:auto">Un.</th><th style="width:auto">Qtd</th><th style="width:auto">Lote MP</th></tr></thead>
<tbody>${insumos || '<tr><td colspan="4">Sem insumos</td></tr>'}</tbody></table>`);
    } catch (e: any) {
      console.error('[RE-15] verificação:', e?.message || e);
      pagina(`<div class="st rev">Não foi possível verificar agora. Tente novamente em instantes.</div>`, 500);
    }
  });
}
