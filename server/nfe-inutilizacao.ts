// ═══════════════════════════════════════════════════════════════════════════
// INUTILIZAÇÃO DE NUMERAÇÃO NF-e / NFC-e (set/2026)
// ───────────────────────────────────────────────────────────────────────────
// Regra (Ajuste SINIEF 07/05, cl. 14ª): número pulado na sequência de um
// CNPJ + modelo + série deve ser inutilizado na SEFAZ até o 10º dia do mês
// seguinte. Esta tela:
//   1. LEVANTA as lacunas — a fonte de verdade é a CHAVE DE ACESSO das notas
//      de produção que CONSUMIRAM número (autorizada, cancelada, denegada).
//      O issuer_cnpj da tabela não é confiável para notas antigas; a chave é.
//      Nota rejeitada / rascunho / erro não consome número → vira lacuna.
//   2. ENVIA o pedido (NFeInutilizacao4) com o A1 do CNPJ e guarda o protocolo
//      em fiscal_inutilizacoes; faixas homologadas saem do levantamento.
//   3. Marca como 'inutilizada' as notas do Integra presas nessa faixa.
// Só leitura no levantamento; escrita só no envio (admin/administrativo).
// ═══════════════════════════════════════════════════════════════════════════
import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { inutilizarNumeracao, UF_CODES } from "./sefaz-service";

const CUF_UF: Record<string, string> = Object.fromEntries(Object.entries(UF_CODES).map(([uf, c]) => [c, uf]));

const NOMES_CNPJ: Record<string, string> = {
  "28295493000153": "IND — Puro Indústria (matriz)",
  "28295493000234": "GYN — Puro Indústria (filial Goiânia)",
  "28295493000315": "BSB — Puro Indústria (filial Brasília)",
  "52921727000105": "SERV — Puro Serviços",
};

let _ensured = false;
async function ensureTabela() {
  if (_ensured) return;
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS fiscal_inutilizacoes (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      cnpj varchar(14) NOT NULL,
      uf varchar(2) NOT NULL,
      modelo varchar(2) NOT NULL,
      serie integer NOT NULL,
      ano integer NOT NULL,
      numero_inicial integer NOT NULL,
      numero_final integer NOT NULL,
      justificativa text NOT NULL,
      ambiente varchar NOT NULL,
      status varchar NOT NULL,             -- homologada | rejeitada | erro
      c_stat varchar,
      x_motivo text,
      protocolo varchar,
      dh_recbto varchar,
      xml_enviado text,
      xml_recebido text,
      xml_completo text,
      notas_marcadas integer DEFAULT 0,
      created_by varchar,
      created_at timestamp NOT NULL DEFAULT now()
    )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_fiscal_inut_chave ON fiscal_inutilizacoes (cnpj, modelo, serie, status)`));
  _ensured = true;
}

type Faixa = { ini: number; fim: number; qtd: number; dataAntes: string | null; dataDepois: string | null; ano: number; statusIntegra: string[] };

function subtrair(faixas: { ini: number; fim: number }[], usadas: { ini: number; fim: number }[]) {
  let out = faixas.slice();
  for (const u of usadas) {
    const nx: { ini: number; fim: number }[] = [];
    for (const f of out) {
      if (u.fim < f.ini || u.ini > f.fim) { nx.push(f); continue; }
      if (u.ini > f.ini) nx.push({ ini: f.ini, fim: u.ini - 1 });
      if (u.fim < f.fim) nx.push({ ini: u.fim + 1, fim: f.fim });
    }
    out = nx;
  }
  return out;
}

export async function levantarLacunas(filtro: { cnpj?: string; desde?: string }) {
  await ensureTabela();
  const cnpjF = String(filtro.cnpj || "").replace(/\D/g, "");
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(filtro.desde || "")) ? String(filtro.desde) : null;

  // Pares consecutivos de números USADOS (pela chave) com salto > 1.
  const r: any = await db.execute(sql`
    WITH k AS (
      SELECT DISTINCT ON (access_key)
             substr(access_key,1,2) cuf, substr(access_key,7,14) c, substr(access_key,21,2) m,
             substr(access_key,23,3)::int s, substr(access_key,26,9)::int n, emission_date dt
      FROM fiscal_invoices
      WHERE environment = 'producao' AND length(access_key) = 44 AND access_key ~ '^[0-9]{44}$'
        AND (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied')
             OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%')
        AND (${cnpjF} = '' OR substr(access_key,7,14) = ${cnpjF})
    ), w AS (
      SELECT cuf,c,m,s,n,dt, lag(n) OVER (PARTITION BY c,m,s ORDER BY n) p, lag(dt) OVER (PARTITION BY c,m,s ORDER BY n) pdt FROM k
    ), resumo AS (
      SELECT c,m,s, max(cuf) cuf, count(*)::int notas, min(n) primeiro, max(n) ultimo, max(dt) ultima_emissao FROM k GROUP BY 1,2,3
    )
    SELECT 'gap' tipo, w.c, w.m, w.s, w.cuf, (w.p+1) ini, (w.n-1) fim, w.pdt dt_antes, w.dt dt_depois, null::int notas, null::int primeiro, null::int ultimo, null::timestamp ultima_emissao
      FROM w WHERE w.n - w.p > 1 AND (${desde}::date IS NULL OR w.dt >= ${desde}::date)
    UNION ALL
    SELECT 'resumo', c, m, s, cuf, null, null, null, null, notas, primeiro, ultimo, ultima_emissao FROM resumo
    ORDER BY 2,3,4,6`);
  const rows: any[] = r.rows || r;

  const inut: any = await db.execute(sql`
    SELECT cnpj, modelo, serie, numero_inicial, numero_final FROM fiscal_inutilizacoes
    WHERE status = 'homologada' AND ambiente = 'producao'`);
  const inutRows: any[] = inut.rows || inut;

  // Notas do Integra que TÊM número mas não consumiram (rejeitada/erro/rascunho) — explica a lacuna.
  const presas: any = await db.execute(sql`
    SELECT regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') c, coalesce(invoice_model,'55') m,
           coalesce(nullif(series,''),'1')::int s, invoice_number n, lower(coalesce(status,'')) st
    FROM fiscal_invoices
    WHERE environment = 'producao' AND invoice_number IS NOT NULL
      AND NOT (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied','inutilizada')
               OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%')
      AND (${cnpjF} = '' OR regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') = ${cnpjF})`);
  const presasRows: any[] = presas.rows || presas;

  const grupos = new Map<string, any>();
  const key = (c: string, m: string, s: number) => `${c}|${m}|${s}`;
  for (const row of rows) {
    const k = key(row.c, row.m, Number(row.s));
    if (!grupos.has(k)) grupos.set(k, { cnpj: row.c, nome: NOMES_CNPJ[row.c] || row.c, uf: CUF_UF[row.cuf] || "GO", modelo: row.m, serie: Number(row.s), faixas: [] as Faixa[] });
    const g = grupos.get(k);
    if (row.tipo === "resumo") {
      Object.assign(g, { notas: row.notas, primeiro: Number(row.primeiro), ultimo: Number(row.ultimo), ultimaEmissao: row.ultima_emissao, uf: CUF_UF[row.cuf] || g.uf });
    } else {
      const partes = subtrair([{ ini: Number(row.ini), fim: Number(row.fim) }],
        inutRows.filter((i) => i.cnpj === row.c && i.modelo === row.m && Number(i.serie) === Number(row.s))
          .map((i) => ({ ini: Number(i.numero_inicial), fim: Number(i.numero_final) })));
      const depois = row.dt_depois ? new Date(row.dt_depois) : null;
      for (const p of partes) {
        const st = presasRows.filter((x) => x.c === row.c && x.m === row.m && Number(x.s) === Number(row.s) && Number(x.n) >= p.ini && Number(x.n) <= p.fim).map((x) => x.st);
        g.faixas.push({
          ini: p.ini, fim: p.fim, qtd: p.fim - p.ini + 1,
          dataAntes: row.dt_antes ? new Date(row.dt_antes).toISOString() : null,
          dataDepois: depois ? depois.toISOString() : null,
          // Ano do pedido = ano em que a sequência "passou" pelos números (nota seguinte).
          ano: depois ? depois.getUTCFullYear() : new Date().getUTCFullYear(),
          statusIntegra: Array.from(new Set(st)),
        });
      }
    }
  }
  const lista = Array.from(grupos.values()).map((g) => ({
    ...g,
    totalFaixas: g.faixas.length,
    totalNumeros: g.faixas.reduce((a: number, f: Faixa) => a + f.qtd, 0),
  }));
  return { geradoEm: new Date().toISOString(), grupos: lista };
}

export function registerInutilizacaoRoutes(app: Express) {
  const roles = requireRole(["admin", "administrative", "coordinator"]);
  const rolesEnvio = requireRole(["admin", "administrative"]);

  app.get("/api/fiscal/inutilizacao/lacunas", authenticateUser, roles, async (req, res) => {
    try {
      res.json(await levantarLacunas({ cnpj: String(req.query.cnpj || ""), desde: String(req.query.desde || "") }));
    } catch (e: any) {
      console.error("[INUTILIZACAO] lacunas:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/api/fiscal/inutilizacao", authenticateUser, roles, async (_req, res) => {
    try {
      await ensureTabela();
      const r: any = await db.execute(sql`
        SELECT id, cnpj, uf, modelo, serie, ano, numero_inicial, numero_final, justificativa, ambiente, status,
               c_stat, x_motivo, protocolo, dh_recbto, notas_marcadas, created_by, created_at
        FROM fiscal_inutilizacoes ORDER BY created_at DESC LIMIT 500`);
      res.json(r.rows || r);
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.get("/api/fiscal/inutilizacao/:id/xml", authenticateUser, roles, async (req, res) => {
    try {
      await ensureTabela();
      const r: any = await db.execute(sql`SELECT cnpj, modelo, serie, numero_inicial, numero_final, xml_completo, xml_recebido FROM fiscal_inutilizacoes WHERE id = ${req.params.id}`);
      const row = (r.rows || r)[0];
      if (!row) return res.status(404).json({ error: "não encontrado" });
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="inut_${row.cnpj}_${row.modelo}_${row.serie}_${row.numero_inicial}-${row.numero_final}.xml"`);
      res.send(row.xml_completo || row.xml_recebido || "");
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  app.post("/api/fiscal/inutilizacao", authenticateUser, rolesEnvio, async (req: any, res) => {
    try {
      await ensureTabela();
      const b = req.body || {};
      const cnpj = String(b.cnpj || "").replace(/\D/g, "");
      const modelo = String(b.modelo || "55") === "65" ? "65" : "55";
      const serie = Number(b.serie);
      const ini = Math.trunc(Number(b.numeroInicial));
      const fim = Math.trunc(Number(b.numeroFinal));
      const ambiente = b.ambiente === "homologacao" ? "homologacao" : "producao";
      const uf = String(b.uf || "GO").toUpperCase();
      const ano = Math.trunc(Number(b.ano));
      const justificativa = String(b.justificativa || "");
      if (cnpj.length !== 14 || !(serie >= 0) || !(ini >= 1 && fim >= ini)) return res.status(400).json({ error: "Dados da faixa inválidos." });

      // Trava de segurança: nunca pedir faixa que contenha número já USADO (pela chave) em produção.
      if (ambiente === "producao") {
        const u: any = await db.execute(sql`
          SELECT substr(access_key,26,9)::int n FROM fiscal_invoices
          WHERE environment = 'producao' AND length(access_key) = 44 AND access_key ~ '^[0-9]{44}$'
            AND substr(access_key,7,14) = ${cnpj} AND substr(access_key,21,2) = ${modelo}
            AND substr(access_key,23,3)::int = ${serie}
            AND substr(access_key,26,9)::int BETWEEN ${ini} AND ${fim}
            AND (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied')
                 OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%')
          LIMIT 5`);
        const usados = (u.rows || u).map((x: any) => x.n);
        if (usados.length) return res.status(409).json({ error: `A faixa contém número(s) já usados: ${usados.join(", ")}. Ajuste a faixa.` });
        const dup: any = await db.execute(sql`
          SELECT numero_inicial, numero_final FROM fiscal_inutilizacoes
          WHERE status = 'homologada' AND ambiente = 'producao' AND cnpj = ${cnpj} AND modelo = ${modelo} AND serie = ${serie}
            AND numero_inicial <= ${fim} AND numero_final >= ${ini} LIMIT 1`);
        const d = (dup.rows || dup)[0];
        if (d) return res.status(409).json({ error: `Faixa sobrepõe inutilização já homologada (${d.numero_inicial}–${d.numero_final}).` });
      }

      const r = await inutilizarNumeracao({ cnpj, uf, modelo, serie, ano, numeroInicial: ini, numeroFinal: fim, justificativa, ambiente });
      const status = r.ok ? "homologada" : (r.cStat ? "rejeitada" : "erro");
      const quem = req.currentUser?.email || req.currentUser?.id || req.user?.email || null;

      let marcadas = 0;
      if (r.ok && ambiente === "producao") {
        const up: any = await db.execute(sql`
          UPDATE fiscal_invoices SET status = 'inutilizada', updated_at = now()
          WHERE environment = 'producao'
            AND regexp_replace(coalesce(issuer_cnpj,''),'[^0-9]','','g') = ${cnpj}
            AND coalesce(invoice_model,'55') = ${modelo}
            AND coalesce(nullif(series,''),'1')::int = ${serie}
            AND invoice_number BETWEEN ${ini} AND ${fim}
            AND NOT (lower(coalesce(status,'')) IN ('authorized','cancelled','canceled','denied','inutilizada')
                     OR status ILIKE '%autoriz%' OR status ILIKE '%cancel%' OR status ILIKE '%deneg%')`);
        marcadas = Number(up.rowCount || 0);
      }

      const ins: any = await db.execute(sql`
        INSERT INTO fiscal_inutilizacoes (cnpj, uf, modelo, serie, ano, numero_inicial, numero_final, justificativa, ambiente, status,
          c_stat, x_motivo, protocolo, dh_recbto, xml_enviado, xml_recebido, xml_completo, notas_marcadas, created_by)
        VALUES (${cnpj}, ${uf}, ${modelo}, ${serie}, ${ano}, ${ini}, ${fim}, ${justificativa}, ${ambiente}, ${status},
          ${r.cStat}, ${r.xMotivo || r.error || null}, ${r.protocolo}, ${r.dhRecbto}, ${r.xmlEnviado || null}, ${r.xmlRecebido || null}, ${r.xmlCompleto || null}, ${marcadas}, ${quem})
        RETURNING id`);
      const id = (ins.rows || ins)[0]?.id;
      console.log(`[INUTILIZACAO] ${cnpj} mod ${modelo} serie ${serie} ${ini}-${fim} (${ambiente}) → ${status} cStat=${r.cStat} ${r.xMotivo || r.error || ""}`);
      res.status(r.ok ? 200 : 422).json({ id, status, ok: r.ok, cStat: r.cStat, xMotivo: r.xMotivo, protocolo: r.protocolo, error: r.error, notasMarcadas: marcadas });
    } catch (e: any) {
      console.error("[INUTILIZACAO] envio:", e?.message);
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
