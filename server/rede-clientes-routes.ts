// server/rede-clientes-routes.ts
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba REDE DE CLIENTE
//
// Uma REDE agrupa clientes que sao a mesma gestao: filiais do mesmo dono, socios
// em comum, ou CNPJs de mesma raiz (os 8 primeiros digitos). O cadastro segue
// separado — a rede e' so' a lente que consolida.
//
// FATURAMENTO: mesma fonte e o MESMO filtro de exclusao do resto da tela de
// carteiras (server/carteira-routes.ts): titulos emitidos em `receivables`, fora
// os cancelados, fora as 4 empresas do grupo + BARUC, fora aporte/devolucao/
// troca/amostra/bonificacao/remessa/transferencia, fora NF-e que nao e' de venda
// e fora pedido na lixeira. Se a regra mudar la', tem que mudar aqui — por isso
// as constantes estao juntas e comentadas.
//
// DEBITO = estoque de hoje: titulo vencido (ou a vencer com vencimento passado)
// com saldo em aberto, pelo mesmo filtro.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { nfVendaWhere } from "./faturamento-oficial";
import { authenticateUser } from "./authMiddleware";

const TZ = "America/Sao_Paulo";

/** 'YYYY-MM' do mes corrente em horario de Brasilia. */
function mesCorrente(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" })
    .format(new Date())
    .slice(0, 7);
}

// ── Filtro de venda (espelho de carteira-routes.ts) ──────────────────────────
const CNPJS_GRUPO = ["28295493000153", "28295493000234", "28295493000315", "52921727000105"];
const CNPJS_NAO_CLIENTE = ["14877972000173"]; // BARUC — transporte/armazenagem, nao e' cliente de venda
const DOCS_FORA = [...CNPJS_GRUPO, ...CNPJS_NAO_CLIENTE];
const C_GRUPO = `(COALESCE(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),'') IN (${DOCS_FORA.map((c) => `'${c}'`).join(",")})
                  OR UPPER(COALESCE(customer_name,'')) ~ '(^|[^A-Z])(PURO|BARUC)([^A-Z]|$)')`;
const C_CATEGORIA = `(UPPER(COALESCE(category,'')) ~ '(APORTE|SOCIO|SÓCIO|EMPREST|ADIANT|DEVOLU|TROCA|AMOSTRA|BONIFICA|BRINDE|DOACAO|DOAÇÃO|REMESSA|TRANSFER)'
                      OR TRIM(COALESCE(category,'')) ~ '^[0-9]+([.-][0-9]+)*$')`;
const C_NF_INVALIDA = `(receivables.fiscal_invoice_id IS NOT NULL AND NOT EXISTS (
                          SELECT 1 FROM fiscal_invoices fx
                          WHERE fx.id = receivables.fiscal_invoice_id AND ${nfVendaWhere("fx")}))`;
const C_LIXEIRA = `EXISTS (SELECT 1 FROM billing_pipeline bpx
                           WHERE bpx.id = receivables.billing_pipeline_id AND bpx.stage = 'lixeira')`;
const FILTRO_VENDA = `
      AND NOT (${C_GRUPO})
      AND NOT ${C_CATEGORIA}
      AND NOT ${C_NF_INVALIDA}
      AND NOT ${C_LIXEIRA}`;
const NAO_CANCELADO = `COALESCE(status::text,'') NOT IN ('cancelada','cancelado','cancelled','canceled')`;
const VENCIDO = `(COALESCE(status::text,'') = 'vencida'
                  OR (COALESCE(status::text,'') = 'a_vencer'
                      AND due_date::date < (now() AT TIME ZONE 'America/Sao_Paulo')::date))`;

/** Chave do cliente nos titulos: CPF/CNPJ so' digitos; sem documento, o nome. */
const CHAVE_TITULO = `COALESCE(
    NULLIF(regexp_replace(COALESCE(customer_document,''),'[^0-9]','','g'),''),
    'N|' || COALESCE(NULLIF(UPPER(TRIM(COALESCE(customer_name,''))),''),'?')
  )`;

/** Mesma chave, montada a partir do CADASTRO. */
const CHAVE_CADASTRO = `COALESCE(
    NULLIF(regexp_replace(COALESCE(NULLIF(c.cnpj,''),NULLIF(c.cpf,''),''),'[^0-9]','','g'),''),
    'N|' || COALESCE(NULLIF(UPPER(TRIM(COALESCE(c.name,''))),''),'?')
  )`;

/** Escopo: vendedor e telemarketing so' enxergam a carteira deles. */
function escopo(req: any) {
  const usuario: any = req?.currentUser || req?.user || null;
  const papel = String(usuario?.role || "");
  const restrito = ["vendedor", "telemarketing"].includes(papel);
  const limpa = (x: any) => String(x || "").replace(/[^A-Za-z0-9_-]/g, "");
  const ids: string[] = [];
  if (restrito) {
    const add = (x: any) => { const v = limpa(x); if (v && !ids.includes(v)) ids.push(v); };
    add(usuario?.id);
    const codigos: any[] = [];
    if (usuario?.omieVendorCode) codigos.push(usuario.omieVendorCode);
    const mapa = usuario?.omieVendorCodes;
    if (mapa && typeof mapa === "object") for (const v of Object.values(mapa)) if (v) codigos.push(v);
    for (const c of codigos) { add(c); add(`omie-vendor-${limpa(c)}`); }
    if (!ids.length) ids.push("__sem_carteira__");
  }
  const nome = [usuario?.firstName, usuario?.lastName].filter(Boolean).join(" ").trim() || usuario?.email || "";
  return { usuario, papel, restrito, ids, nome };
}

/** So' estes papeis criam, renomeiam e apagam rede. Vendedor apenas consulta. */
const PAPEIS_EDITAM = ["admin", "coordinator", "administrative"];
const podeEditar = (papel: string) => PAPEIS_EDITAM.includes(papel);

// ── Tabelas sob demanda (mesmo padrao das anotacoes da carteira) ─────────────
let __redesProntas = false;
async function ensureRedes(): Promise<void> {
  if (__redesProntas) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cliente_redes (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      nome varchar NOT NULL,
      observacao text,
      criado_por varchar,
      criado_por_nome varchar,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cliente_rede_membros (
      rede_id varchar NOT NULL,
      customer_id varchar NOT NULL,
      created_at timestamptz DEFAULT now(),
      PRIMARY KEY (rede_id, customer_id)
    )`);
  // Um cliente pertence a UMA rede so'. Duas redes com o mesmo cliente fariam
  // o faturamento aparecer duas vezes e ninguem saberia qual esta certa.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_rede_membro_cliente ON cliente_rede_membros (customer_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_rede_membro_rede ON cliente_rede_membros (rede_id)`);
  __redesProntas = true;
}

const esc = (s: any) => String(s ?? "").replace(/'/g, "''");
const limpaId = (s: any) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "");

export function registerRedesClientes(app: Express) {
  // ---------------------------------------------------------------------------
  // GET /api/carteira/redes
  // Redes + membros + numeros consolidados. Uma varredura por assunto, nao uma
  // consulta por rede.
  // ---------------------------------------------------------------------------
  app.get("/api/carteira/redes", authenticateUser, async (req: Request, res: Response) => {
    try {
      await ensureRedes();
      const e = escopo(req);
      const mes = String(req.query.mes || "").match(/^\d{4}-\d{2}$/) ? String(req.query.mes) : mesCorrente();
      const ano = mes.slice(0, 4);

      const redes = (await db.execute(sql`
        SELECT id, nome, observacao, criado_por_nome,
               to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY') AS criada_em
        FROM cliente_redes ORDER BY nome`)).rows as any[];
      if (!redes.length) {
        return res.json({ mes, ano, redes: [], podeEditar: podeEditar(e.papel), escopo: { restrito: e.restrito, papel: e.papel } });
      }

      // Membros com o cadastro. O vendedor restrito enxerga a rede inteira (o
      // sentido dela e' consolidar), mas so' se tiver ao menos um cliente seu —
      // rede de outra carteira nem aparece.
      const membros = (await db.execute(sql.raw(`
        SELECT m.rede_id, c.id, c.name, c.fantasy_name, c.city, c.neighborhood,
               c.is_active, c.seller_id, c.created_at::date::text AS cadastro_em,
               c.inactivated_at::date::text AS inativado_em,
               NULLIF(regexp_replace(COALESCE(NULLIF(c.cnpj,''),NULLIF(c.cpf,''),''),'[^0-9]','','g'),'') AS doc,
               ${CHAVE_CADASTRO} AS chave,
               COALESCE(vend.nome,'Sem vendedor') AS vendedor
        FROM cliente_rede_membros m
        JOIN customers c ON c.id = m.customer_id
        LEFT JOIN LATERAL (
          SELECT NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),'') AS nome
          FROM users u
          WHERE c.seller_id IS NOT NULL AND c.seller_id <> '' AND (
                u.id = c.seller_id
             OR u.omie_vendor_code = c.seller_id
             OR u.omie_vendor_code = REPLACE(c.seller_id,'omie-vendor-','')
          ) LIMIT 1
        ) vend ON TRUE
        LIMIT 20000`))).rows as any[];

      const chaves = Array.from(new Set(membros.map((m) => String(m.chave || "")).filter(Boolean)));
      const listaChaves = chaves.length ? chaves.map((k) => `'${esc(k)}'`).join(",") : `''`;

      // Faturamento do mes vigente e do ano, e o debito de hoje — por chave.
      const fat = (await db.execute(sql.raw(`
        SELECT ${CHAVE_TITULO} AS chave,
               COALESCE(SUM(COALESCE(NULLIF(amount::text,'')::numeric,0))
                        FILTER (WHERE to_char(issue_date,'YYYY-MM') = '${esc(mes)}'),0)::float AS fat_mes,
               COALESCE(SUM(COALESCE(NULLIF(amount::text,'')::numeric,0))
                        FILTER (WHERE to_char(issue_date,'YYYY') = '${esc(ano)}'),0)::float    AS fat_ano
        FROM receivables
        WHERE deleted_at IS NULL
          AND ${NAO_CANCELADO}
          AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
          AND issue_date >= '${esc(ano)}-01-01'
          ${FILTRO_VENDA}
          AND ${CHAVE_TITULO} IN (${listaChaves})
        GROUP BY 1`))).rows as any[];

      const deb = (await db.execute(sql.raw(`
        SELECT ${CHAVE_TITULO} AS chave,
               COALESCE(SUM(COALESCE(NULLIF(amount::text,'')::numeric,0)
                          - COALESCE(NULLIF(amount_paid::text,'')::numeric,0)),0)::float AS debito
        FROM receivables
        WHERE deleted_at IS NULL
          AND ${VENCIDO}
          AND (COALESCE(NULLIF(amount::text,'')::numeric,0) - COALESCE(NULLIF(amount_paid::text,'')::numeric,0)) > 0
          ${FILTRO_VENDA}
          AND ${CHAVE_TITULO} IN (${listaChaves})
        GROUP BY 1`))).rows as any[];

      // PRIMEIRA VENDA de todos os tempos: a data de conquista e' a MENOR entre
      // o cadastro e a 1a venda. `customers.created_at` sozinho engana — tem
      // centenas de clientes "criados" na data da importacao.
      const prim = (await db.execute(sql.raw(`
        SELECT ${CHAVE_TITULO} AS chave, MIN(issue_date)::date::text AS primeira
        FROM receivables
        WHERE deleted_at IS NULL
          AND ${NAO_CANCELADO}
          AND COALESCE(NULLIF(amount::text,'')::numeric,0) > 0
          ${FILTRO_VENDA}
          AND ${CHAVE_TITULO} IN (${listaChaves})
        GROUP BY 1`))).rows as any[];

      const mFat = new Map(fat.map((r) => [String(r.chave), r]));
      const mDeb = new Map(deb.map((r) => [String(r.chave), Number(r.debito || 0)]));
      const mPri = new Map(prim.map((r) => [String(r.chave), r.primeira as string]));

      const porRede = new Map<string, any[]>();
      for (const m of membros) {
        const k = String(m.chave || "");
        const f: any = mFat.get(k) || {};
        const conquista = [m.cadastro_em, mPri.get(k)].filter(Boolean).sort()[0] || null;
        const cli = {
          id: String(m.id),
          nome: String(m.fantasy_name || m.name || "").trim() || "(sem nome)",
          doc: m.doc || null,
          cidade: m.city || "",
          bairro: m.neighborhood || "",
          ativo: m.is_active !== false,
          conquista,
          cadastroEm: m.cadastro_em || null,
          inativadoEm: m.inativado_em || null,
          vendedor: String(m.vendedor || "Sem vendedor"),
          sellerId: String(m.seller_id || ""),
          fatMes: Number(f.fat_mes || 0),
          fatAno: Number(f.fat_ano || 0),
          debito: Number(mDeb.get(k) || 0),
        };
        const arr = porRede.get(String(m.rede_id));
        if (arr) arr.push(cli); else porRede.set(String(m.rede_id), [cli]);
      }

      const saida = redes.map((r) => {
        // Ordem DENTRO da rede: faturamento do mes vigente do maior para o menor —
        // e' o que responde "quem esta puxando a rede agora". Empate (varias
        // filiais em zero no comeco do mes) desempata pelo faturamento do ano e,
        // so' entao, pelo nome, para a lista nao dancar a cada recarga.
        const cls = (porRede.get(String(r.id)) || []).sort(
          (a, b) => b.fatMes - a.fatMes || b.fatAno - a.fatAno || a.nome.localeCompare(b.nome, "pt-BR"),
        );
        const soma = (f: (c: any) => number) => cls.reduce((t, c) => t + f(c), 0);
        return {
          id: String(r.id),
          nome: String(r.nome || ""),
          observacao: r.observacao || "",
          criadaPor: r.criado_por_nome || "—",
          criadaEm: r.criada_em || "",
          clientes: cls,
          totais: {
            clientes: cls.length,
            ativos: cls.filter((c) => c.ativo).length,
            inativos: cls.filter((c) => !c.ativo).length,
            fatMes: soma((c) => c.fatMes),
            fatAno: soma((c) => c.fatAno),
            debito: soma((c) => c.debito),
          },
        };
      });

      // Vendedor restrito: so' as redes que tocam a carteira dele.
      const filtradas = e.restrito
        ? saida.filter((r) => r.clientes.some((c: any) => e.ids.includes(c.sellerId)))
        : saida;

      res.json({
        mes, ano, redes: filtradas,
        podeEditar: podeEditar(e.papel),
        escopo: { restrito: e.restrito, papel: e.papel, vendedor: e.nome },
      });
    } catch (err: any) {
      console.error("[redes GET]", err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/carteira/redes/clientes?busca=...
  // Fonte do seletor de clientes. Devolve a rede a que cada um ja pertence, para
  // o usuario nao tentar colocar o mesmo cliente em duas.
  // ---------------------------------------------------------------------------
  app.get("/api/carteira/redes/clientes", authenticateUser, async (req: Request, res: Response) => {
    try {
      await ensureRedes();
      const busca = String(req.query.busca || "").trim();
      const digitos = busca.replace(/\D/g, "");
      let filtro = "";
      if (busca.length >= 2) {
        const alvo = esc(busca.toUpperCase());
        const partes = [
          `UPPER(COALESCE(c.name,'')) LIKE '%${alvo}%'`,
          `UPPER(COALESCE(c.fantasy_name,'')) LIKE '%${alvo}%'`,
        ];
        if (digitos.length >= 3) {
          partes.push(`regexp_replace(COALESCE(c.cnpj,''),'[^0-9]','','g') LIKE '%${esc(digitos)}%'`);
          partes.push(`regexp_replace(COALESCE(c.cpf,''),'[^0-9]','','g') LIKE '%${esc(digitos)}%'`);
        }
        filtro = ` AND (${partes.join(" OR ")})`;
      }
      const rows = (await db.execute(sql.raw(`
        SELECT c.id, c.name, c.fantasy_name, c.city, c.neighborhood, c.is_active,
               NULLIF(regexp_replace(COALESCE(NULLIF(c.cnpj,''),NULLIF(c.cpf,''),''),'[^0-9]','','g'),'') AS doc,
               r.id AS rede_id, r.nome AS rede_nome
        FROM customers c
        LEFT JOIN cliente_rede_membros m ON m.customer_id = c.id
        LEFT JOIN cliente_redes r ON r.id = m.rede_id
        WHERE COALESCE(c.is_supplier,false) = false
          AND COALESCE(c.is_lead,false) = false
          ${filtro}
        ORDER BY COALESCE(NULLIF(c.fantasy_name,''), c.name)
        LIMIT 300`))).rows as any[];
      res.json(rows.map((r) => ({
        id: String(r.id),
        nome: String(r.fantasy_name || r.name || "").trim() || "(sem nome)",
        doc: r.doc || null,
        cidade: r.city || "",
        bairro: r.neighborhood || "",
        ativo: r.is_active !== false,
        redeId: r.rede_id ? String(r.rede_id) : null,
        redeNome: r.rede_nome || null,
      })));
    } catch (err: any) {
      console.error("[redes clientes]", err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/carteira/redes/do-cliente/:id
  // A marcação que aparece no cadastro do cliente.
  // ---------------------------------------------------------------------------
  app.get("/api/carteira/redes/do-cliente/:id", authenticateUser, async (req: Request, res: Response) => {
    try {
      await ensureRedes();
      const id = String(req.params.id || "");
      const rows = (await db.execute(sql`
        SELECT r.id, r.nome,
               (SELECT COUNT(*)::int FROM cliente_rede_membros x WHERE x.rede_id = r.id) AS n
        FROM cliente_rede_membros m
        JOIN cliente_redes r ON r.id = m.rede_id
        WHERE m.customer_id = ${id}
        LIMIT 1`)).rows as any[];
      if (!rows.length) return res.json({ rede: null });
      res.json({ rede: { id: String(rows[0].id), nome: String(rows[0].nome), clientes: Number(rows[0].n || 0) } });
    } catch (err: any) {
      console.error("[redes do-cliente]", err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/carteira/redes   { nome, observacao, clienteIds[] }
  // ---------------------------------------------------------------------------
  app.post("/api/carteira/redes", authenticateUser, async (req: Request, res: Response) => {
    try {
      await ensureRedes();
      const e = escopo(req);
      if (!podeEditar(e.papel)) return res.status(403).json({ ok: false, error: "Criar rede é restrito ao Admin, Coordenação e Administrativo." });
      const b: any = req.body || {};
      const nome = String(b.nome || "").trim().slice(0, 160);
      if (!nome) return res.status(400).json({ ok: false, error: "Dê um nome à rede." });
      const ids = Array.from(new Set((Array.isArray(b.clienteIds) ? b.clienteIds : []).map(limpaId).filter(Boolean)));
      if (!ids.length) return res.status(400).json({ ok: false, error: "Escolha pelo menos um cliente." });

      const dup = (await db.execute(sql`SELECT 1 FROM cliente_redes WHERE UPPER(TRIM(nome)) = ${nome.toUpperCase()} LIMIT 1`)).rows as any[];
      if (dup.length) return res.status(400).json({ ok: false, error: "Já existe uma rede com esse nome." });

      // Cliente que ja esta em outra rede nao entra caladamente: o usuario
      // precisa saber em qual, para decidir o que fazer.
      const jaEm = (await db.execute(sql.raw(`
        SELECT c.name, c.fantasy_name, r.nome AS rede
        FROM cliente_rede_membros m
        JOIN cliente_redes r ON r.id = m.rede_id
        JOIN customers c ON c.id = m.customer_id
        WHERE m.customer_id IN (${ids.map((i) => `'${esc(i)}'`).join(",")})`))).rows as any[];
      if (jaEm.length) {
        const lista = jaEm.map((x) => `${x.fantasy_name || x.name} (${x.rede})`).join("; ");
        return res.status(400).json({ ok: false, error: `Estes clientes já estão em outra rede: ${lista}` });
      }

      const novo = (await db.execute(sql`
        INSERT INTO cliente_redes (nome, observacao, criado_por, criado_por_nome)
        VALUES (${nome}, ${String(b.observacao || "").slice(0, 2000) || null}, ${e.usuario?.id || null}, ${e.nome || "—"})
        RETURNING id`)).rows as any[];
      const redeId = String(novo[0].id);
      for (const cid of ids) {
        await db.execute(sql`INSERT INTO cliente_rede_membros (rede_id, customer_id) VALUES (${redeId}, ${cid}) ON CONFLICT DO NOTHING`);
      }
      res.json({ ok: true, id: redeId });
    } catch (err: any) {
      console.error("[redes POST]", err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/carteira/redes/:id   { nome?, observacao?, clienteIds? }
  // clienteIds, quando vem, SUBSTITUI a lista de membros.
  // ---------------------------------------------------------------------------
  app.patch("/api/carteira/redes/:id", authenticateUser, async (req: Request, res: Response) => {
    try {
      await ensureRedes();
      const e = escopo(req);
      if (!podeEditar(e.papel)) return res.status(403).json({ ok: false, error: "Editar rede é restrito ao Admin, Coordenação e Administrativo." });
      const id = limpaId(req.params.id);
      const b: any = req.body || {};
      const existe = (await db.execute(sql`SELECT id FROM cliente_redes WHERE id = ${id} LIMIT 1`)).rows as any[];
      if (!existe.length) return res.status(404).json({ ok: false, error: "Rede não encontrada." });

      if (b.nome !== undefined) {
        const nome = String(b.nome || "").trim().slice(0, 160);
        if (!nome) return res.status(400).json({ ok: false, error: "Dê um nome à rede." });
        const dup = (await db.execute(sql`
          SELECT 1 FROM cliente_redes WHERE UPPER(TRIM(nome)) = ${nome.toUpperCase()} AND id <> ${id} LIMIT 1`)).rows as any[];
        if (dup.length) return res.status(400).json({ ok: false, error: "Já existe uma rede com esse nome." });
        await db.execute(sql`UPDATE cliente_redes SET nome = ${nome}, updated_at = now() WHERE id = ${id}`);
      }
      if (b.observacao !== undefined) {
        await db.execute(sql`UPDATE cliente_redes SET observacao = ${String(b.observacao || "").slice(0, 2000) || null}, updated_at = now() WHERE id = ${id}`);
      }
      if (Array.isArray(b.clienteIds)) {
        const ids = Array.from(new Set(b.clienteIds.map(limpaId).filter(Boolean)));
        if (!ids.length) return res.status(400).json({ ok: false, error: "A rede precisa de pelo menos um cliente." });
        const jaEm = (await db.execute(sql.raw(`
          SELECT c.name, c.fantasy_name, r.nome AS rede
          FROM cliente_rede_membros m
          JOIN cliente_redes r ON r.id = m.rede_id
          JOIN customers c ON c.id = m.customer_id
          WHERE m.rede_id <> '${esc(id)}'
            AND m.customer_id IN (${ids.map((i) => `'${esc(i)}'`).join(",")})`))).rows as any[];
        if (jaEm.length) {
          const lista = jaEm.map((x) => `${x.fantasy_name || x.name} (${x.rede})`).join("; ");
          return res.status(400).json({ ok: false, error: `Estes clientes já estão em outra rede: ${lista}` });
        }
        await db.execute(sql`DELETE FROM cliente_rede_membros WHERE rede_id = ${id}`);
        for (const cid of ids) {
          await db.execute(sql`INSERT INTO cliente_rede_membros (rede_id, customer_id) VALUES (${id}, ${cid}) ON CONFLICT DO NOTHING`);
        }
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[redes PATCH]", err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/carteira/redes/:id — desfaz o agrupamento. O CADASTRO dos
  // clientes nao e' tocado: rede e' lente, nao dono do cliente.
  // ---------------------------------------------------------------------------
  app.delete("/api/carteira/redes/:id", authenticateUser, async (req: Request, res: Response) => {
    try {
      await ensureRedes();
      const e = escopo(req);
      if (!podeEditar(e.papel)) return res.status(403).json({ ok: false, error: "Excluir rede é restrito ao Admin, Coordenação e Administrativo." });
      const id = limpaId(req.params.id);
      await db.execute(sql`DELETE FROM cliente_rede_membros WHERE rede_id = ${id}`);
      await db.execute(sql`DELETE FROM cliente_redes WHERE id = ${id}`);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[redes DELETE]", err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
}
