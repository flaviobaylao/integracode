import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import multer from "multer";

// ===========================================================================
// VIAGENS COM ADIANTAMENTO (27/out/2026)
// Viagem intermunicipal (GO/DF) com ajuda de custo paga ANTES da viagem e
// prestação de contas DEPOIS. Fluxo:
//   aguardando (vendedor pediu) -> aprovado (Admin/Adm) -> pago (Financeiro)
//   -> prestado (vendedor enviou despesas + comprovantes; km real vem da Rota do Dia)
//   -> encerrado (admin conferiu o acerto)         | recusado (volta ao vendedor)
// Cada passo abre/avisa um Chamado (módulo Chamados): solicitação -> Flávio e
// Cinthia; aprovação -> Lanucy (Financeiro); prestação -> Flávio, Cinthia e Lanucy.
// Tarifa: DF R$ 0,75/km, GO R$ 0,65/km (admin pode editar). Km previsto +10%
// (mesma regra da Rota do Dia). Alimentação/hospedagem: só admin define/edita.
// Tabelas criadas sob demanda (CREATE TABLE IF NOT EXISTS), fora do drizzle.
// ===========================================================================

const ADM = ["admin", "administrative"];
const TARIFA: Record<string, number> = { DF: 0.75, GO: 0.65 };
const ALIM_PADRAO = 60;
const HOSP_PADRAO = 180;
const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const num = (v: any, d = 0) => { const n = Number(v); return isFinite(n) ? n : d; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const isAdm = (u: any) => ADM.includes(String(u?.role || ""));
const nomeDe = (u: any) => [u?.firstName ?? u?.first_name, u?.lastName ?? u?.last_name].filter(Boolean).join(" ").trim() || u?.email || "Usuário";
const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtData = (s: string) => String(s || "").slice(0, 10).split("-").reverse().join("/");

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS viagens_numero_seq START 1`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS viagens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        numero integer NOT NULL UNIQUE DEFAULT nextval('viagens_numero_seq'),
        vendedor_id varchar NOT NULL, vendedor_nome varchar,
        cidade varchar NOT NULL, uf varchar(2) NOT NULL,
        data_ini date NOT NULL, data_fim date NOT NULL, dias integer, noites integer,
        ida_volta_km numeric, km_previsto numeric, tarifa numeric,
        alim_dia numeric, hosp_noite numeric,
        valor_km numeric, valor_alim numeric, valor_hosp numeric, valor_sugerido numeric,
        valor_aprovado numeric, obs text,
        status varchar NOT NULL DEFAULT 'aguardando',
        aprovador_id varchar, aprovador_nome varchar, aprovado_em timestamp, motivo_recusa text,
        pago_por varchar, pago_em timestamp,
        km_real numeric, valor_km_real numeric, valor_despesas numeric, valor_real numeric, saldo numeric, prestado_em timestamp,
        encerrado_por varchar, encerrado_em timestamp,
        criado_por varchar, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS viagem_despesas (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        viagem_id varchar NOT NULL, tipo varchar NOT NULL, valor numeric NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS viagem_anexos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        viagem_id varchar NOT NULL, despesa_id varchar, categoria varchar NOT NULL DEFAULT 'outro',
        nome varchar NOT NULL, mime varchar, tamanho integer, dados bytea NOT NULL,
        autor_id varchar, created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS viagem_eventos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        viagem_id varchar NOT NULL, autor_nome varchar, texto text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_viagem_desp ON viagem_despesas (viagem_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_viagem_anx ON viagem_anexos (viagem_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_viagem_evt ON viagem_eventos (viagem_id, created_at)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

async function evento(viagemId: string, autor: string, texto: string) {
  await db.execute(sql`INSERT INTO viagem_eventos (viagem_id, autor_nome, texto) VALUES (${viagemId}, ${autor}, ${texto})`);
}
async function chamado(destinos: string[], assunto: string, descricao: string, autor: any) {
  try {
    const { abrirChamadoSistema } = await import("./chamados-routes");
    await abrirChamadoSistema({ destinoKeys: destinos, assunto, descricao, autor: autor ? { id: String(autor.id), nome: nomeDe(autor), role: String(autor.role || "") } : null });
  } catch (e: any) { console.warn("[viagens] chamado falhou:", e?.message || e); }
}
const APP_URL = process.env.APP_URL || "https://integracode-production.up.railway.app";

async function carregar(id: string) {
  return rows(await db.execute(sql`SELECT * FROM viagens WHERE id = ${id}`))[0] || null;
}
function podeVer(u: any, v: any) { return isAdm(u) || String(v.vendedor_id) === String(u.id); }

function saida(v: any) {
  return {
    id: v.id, numero: v.numero, codigo: "VG-" + String(v.numero).padStart(4, "0"),
    vendedorId: v.vendedor_id, vendedorNome: v.vendedor_nome, cidade: v.cidade, uf: v.uf,
    dataIni: String(v.data_ini).slice(0, 10), dataFim: String(v.data_fim).slice(0, 10),
    dias: num(v.dias), noites: num(v.noites), idaVoltaKm: num(v.ida_volta_km), kmPrevisto: num(v.km_previsto),
    tarifa: num(v.tarifa), alimDia: num(v.alim_dia), hospNoite: num(v.hosp_noite),
    valorKm: num(v.valor_km), valorAlim: num(v.valor_alim), valorHosp: num(v.valor_hosp), valorSugerido: num(v.valor_sugerido),
    valorAprovado: v.valor_aprovado == null ? null : num(v.valor_aprovado), obs: v.obs || "",
    status: v.status, aprovadorNome: v.aprovador_nome, aprovadoEm: v.aprovado_em, motivoRecusa: v.motivo_recusa,
    pagoEm: v.pago_em, kmReal: v.km_real == null ? null : num(v.km_real), valorKmReal: v.valor_km_real == null ? null : num(v.valor_km_real),
    valorDespesas: v.valor_despesas == null ? null : num(v.valor_despesas), valorReal: v.valor_real == null ? null : num(v.valor_real),
    saldo: v.saldo == null ? null : num(v.saldo), prestadoEm: v.prestado_em, encerradoEm: v.encerrado_em, createdAt: v.created_at,
  };
}

// Km real da viagem: soma da km das rotas do vendedor no período (Rota do Dia,
// já casa a casa e com +10%), dia a dia.
async function kmDoPeriodo(v: any) {
  const r = rows(await db.execute(sql`
    SELECT to_char(dr.route_date, 'YYYY-MM-DD') AS dia, COALESCE(NULLIF(dr.total_actual_distance::text, '')::numeric, 0) AS km
    FROM daily_routes dr
    JOIN users u ON u.id = ${v.vendedor_id}
    WHERE (dr.seller_id = u.id OR dr.seller_id = u.omie_vendor_code OR dr.seller_id = 'omie-vendor-' || COALESCE(u.omie_vendor_code, ''))
      AND dr.route_date::date >= ${String(v.data_ini).slice(0, 10)}::date AND dr.route_date::date <= ${String(v.data_fim).slice(0, 10)}::date
    ORDER BY 1`));
  return r.map((x) => ({ dia: x.dia, km: r2(num(x.km)) }));
}

// Recalcula a km das rotas do vendedor no periodo da viagem (regra de pernoite fora
// em actualRouteService: sem volta pra casa nos dias com pernoite).
async function recalcRotas(v: any) {
  try {
    const { recalculateRouteDistance } = await import("./actualRouteService");
    const { storage } = await import("./storage");
    const r = rows(await db.execute(sql`
      SELECT dr.id FROM daily_routes dr JOIN users u ON u.id = ${v.vendedor_id}
      WHERE (dr.seller_id = u.id OR dr.seller_id = u.omie_vendor_code OR dr.seller_id = 'omie-vendor-' || COALESCE(u.omie_vendor_code, ''))
        AND dr.route_date::date >= ${String(v.data_ini).slice(0, 10)}::date AND dr.route_date::date <= ${String(v.data_fim).slice(0, 10)}::date`));
    for (const x of r) { try { await recalculateRouteDistance(String(x.id), storage as any); } catch (e: any) { console.warn("[viagens] recalc rota", x.id, e?.message); } }
  } catch (e: any) { console.warn("[viagens] recalc rotas:", e?.message || e); }
}

const MAX_MB = 15;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 } }).array("arquivos", 10);
function comArquivos(req: any, res: Response, next: any) {
  upload(req, res, (err: any) => {
    if (!err) return next();
    res.status(400).json({ message: err?.code === "LIMIT_FILE_SIZE" ? `Arquivo maior que ${MAX_MB} MB` : (err?.message || "Falha no upload") });
  });
}
const nomeArq = (f: any) => { try { return Buffer.from(String(f.originalname || "arquivo"), "latin1").toString("utf8"); } catch { return String(f.originalname || "arquivo"); } };

export function registerViagens(app: Express) {
  const guard = async (req: Request, res: Response) => {
    const u: any = (req as any).currentUser || (req as any).user;
    if (!u?.id) { res.status(401).json({ message: "Unauthorized" }); return null; }
    try { await ensure(); } catch (e: any) { res.status(500).json({ message: "Viagens indisponível: " + (e?.message || e) }); return null; }
    return u;
  };

  // Perfil + listas de apoio (vendedores para admin, padrões de tarifa/diárias)
  app.get("/api/viagens/config", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const vend = isAdm(u) ? rows(await db.execute(sql`
      SELECT id, NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '') AS nome
      FROM users WHERE is_active = true AND role IN ('vendedor','telemarketing')
        AND COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') !~* '(hotsite|instagram|sistema|flavio|fl[aá]vio|honest)'
      ORDER BY 2`)).filter((x) => x.nome) : [];
    res.json({ admin: isAdm(u), me: { id: String(u.id), nome: nomeDe(u) }, vendedores: vend.map((x) => ({ id: String(x.id), nome: x.nome })),
      tarifa: TARIFA, alimPadrao: ALIM_PADRAO, hospPadrao: HOSP_PADRAO });
  });

  // Base do vendedor (casa) + histórico de viagens encerradas/prestadas ao destino
  app.get("/api/viagens/estimativa", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const vid = isAdm(u) ? String(req.query.vendedorId || u.id) : String(u.id);
    const cidade = String(req.query.cidade || "");
    const h = rows(await db.execute(sql`SELECT home_latitude AS lat, home_longitude AS lon FROM users WHERE id = ${vid}`))[0];
    const hist = rows(await db.execute(sql`SELECT ida_volta_km, km_real, dias FROM viagens
      WHERE cidade = ${cidade} AND km_real IS NOT NULL AND status IN ('prestado','encerrado') ORDER BY created_at DESC LIMIT 10`));
    // Ida+volta "limpa" de cada viagem passada: km real sem o +10% e sem a rodagem local (25 km/dia extra)
    const idas = hist.map((x) => num(x.km_real) / 1.1 - Math.max(0, num(x.dias) - 1) * 25).filter((x) => x > 0);
    res.json({ casa: h && num(h.lat) && num(h.lon) ? { lat: num(h.lat), lon: num(h.lon) } : null, historicoIdaVolta: idas.map(r2) });
  });

  app.get("/api/viagens", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const r = rows(await db.execute(isAdm(u)
      ? sql`SELECT * FROM viagens ORDER BY created_at DESC LIMIT 300`
      : sql`SELECT * FROM viagens WHERE vendedor_id = ${String(u.id)} ORDER BY created_at DESC LIMIT 300`));
    res.json(r.map(saida));
  });

  app.get("/api/viagens/:id", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const v = await carregar(req.params.id);
    if (!v || !podeVer(u, v)) return res.status(404).json({ message: "Viagem não encontrada" });
    const desp = rows(await db.execute(sql`SELECT id, tipo, valor FROM viagem_despesas WHERE viagem_id = ${v.id} ORDER BY created_at`));
    const anx = rows(await db.execute(sql`SELECT id, despesa_id, categoria, nome, mime, tamanho FROM viagem_anexos WHERE viagem_id = ${v.id} ORDER BY created_at`));
    const evt = rows(await db.execute(sql`SELECT autor_nome, texto, created_at FROM viagem_eventos WHERE viagem_id = ${v.id} ORDER BY created_at`));
    res.json({ ...saida(v), despesas: desp.map((d) => ({ id: d.id, tipo: d.tipo, valor: num(d.valor) })),
      anexos: anx.map((a) => ({ id: a.id, despesaId: a.despesa_id, categoria: a.categoria, nome: a.nome, mime: a.mime, tamanho: a.tamanho })),
      eventos: evt.map((e) => ({ autor: e.autor_nome, texto: e.texto, em: e.created_at })), kmDias: await kmDoPeriodo(v) });
  });

  // Solicitação (vendedor; admin pode solicitar por um vendedor)
  app.post("/api/viagens", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    try {
      const b = req.body || {};
      const adm = isAdm(u);
      const vendedorId = adm && b.vendedorId ? String(b.vendedorId) : String(u.id);
      const vu = rows(await db.execute(sql`SELECT id, first_name, last_name, email FROM users WHERE id = ${vendedorId}`))[0];
      if (!vu) return res.status(400).json({ message: "Vendedor inválido" });
      const uf = String(b.uf || "").toUpperCase();
      const cidade = String(b.cidade || "").trim();
      if (!cidade || !["GO", "DF"].includes(uf)) return res.status(400).json({ message: "Escolha uma cidade de GO ou DF" });
      const ini = String(b.dataIni || "").slice(0, 10), fim = String(b.dataFim || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ini) || !/^\d{4}-\d{2}-\d{2}$/.test(fim) || fim < ini) return res.status(400).json({ message: "Datas inválidas" });
      const dias = Math.round((Date.parse(fim) - Date.parse(ini)) / 864e5) + 1, noites = dias - 1;
      const idaVolta = Math.max(0, num(b.idaVoltaKm));
      const km = r2((idaVolta + (dias > 1 ? (dias - 1) * 25 : 0)) * 1.1);
      const tarifa = adm && b.tarifa != null ? num(b.tarifa, TARIFA[uf]) : TARIFA[uf];
      const alim = adm && b.alimDia != null ? num(b.alimDia, ALIM_PADRAO) : ALIM_PADRAO;
      const hosp = adm && b.hospNoite != null ? num(b.hospNoite, HOSP_PADRAO) : HOSP_PADRAO;
      const vKm = r2(km * tarifa), vAl = r2(alim * dias), vHo = r2(hosp * noites), tot = r2(vKm + vAl + vHo);
      const ins = rows(await db.execute(sql`INSERT INTO viagens (vendedor_id, vendedor_nome, cidade, uf, data_ini, data_fim, dias, noites,
          ida_volta_km, km_previsto, tarifa, alim_dia, hosp_noite, valor_km, valor_alim, valor_hosp, valor_sugerido, obs, criado_por)
        VALUES (${vendedorId}, ${nomeDe(vu)}, ${cidade}, ${uf}, ${ini}::date, ${fim}::date, ${dias}, ${noites},
          ${r2(idaVolta)}, ${km}, ${tarifa}, ${alim}, ${hosp}, ${vKm}, ${vAl}, ${vHo}, ${tot}, ${String(b.obs || "").slice(0, 2000)}, ${String(u.id)})
        RETURNING *`))[0];
      const cod = "VG-" + String(ins.numero).padStart(4, "0");
      await evento(ins.id, nomeDe(u), `Solicitação enviada: ${cidade}-${uf}, ${fmtData(ini)} a ${fmtData(fim)}, km previsto ${km.toLocaleString("pt-BR")} km, sugerido ${fmtBRL(tot)}.`);
      await chamado(["flavio", "cinthia"], `Viagem com adiantamento ${cod} — aprovar`,
        `${nomeDe(vu)} pediu adiantamento para ${cidade}-${uf}, de ${fmtData(ini)} a ${fmtData(fim)} (${dias} dia(s)).\nKm previsto: ${km.toLocaleString("pt-BR")} km × ${fmtBRL(tarifa)} = ${fmtBRL(vKm)}\nAlimentação: ${fmtBRL(vAl)} · Hospedagem: ${fmtBRL(vHo)}\nTotal sugerido: ${fmtBRL(tot)}\n\nAprove ou recuse em: ${APP_URL}/viagens?id=${ins.id}`, u);
      res.json(saida(ins));
    } catch (e: any) { console.error("[viagens] criar", e); res.status(500).json({ message: e?.message || "Erro ao solicitar" }); }
  });

  // Aprovação (Admin/Adm): pode ajustar tarifa, diárias e o valor final
  app.post("/api/viagens/:id/aprovar", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!isAdm(u)) return res.status(403).json({ message: "Só Admin ou Adm aprova" });
    const v = await carregar(req.params.id);
    if (!v || v.status !== "aguardando") return res.status(400).json({ message: "Viagem não está aguardando aprovação" });
    const b = req.body || {};
    const tarifa = b.tarifa != null ? num(b.tarifa, num(v.tarifa)) : num(v.tarifa);
    const alim = b.alimDia != null ? num(b.alimDia, num(v.alim_dia)) : num(v.alim_dia);
    const hosp = b.hospNoite != null ? num(b.hospNoite, num(v.hosp_noite)) : num(v.hosp_noite);
    const vKm = r2(num(v.km_previsto) * tarifa), vAl = r2(alim * num(v.dias)), vHo = r2(hosp * num(v.noites));
    const sug = r2(vKm + vAl + vHo);
    const valor = b.valorAprovado != null && num(b.valorAprovado) > 0 ? r2(num(b.valorAprovado)) : sug;
    await db.execute(sql`UPDATE viagens SET tarifa = ${tarifa}, alim_dia = ${alim}, hosp_noite = ${hosp}, valor_km = ${vKm}, valor_alim = ${vAl}, valor_hosp = ${vHo},
      valor_sugerido = ${sug}, valor_aprovado = ${valor}, status = 'aprovado', aprovador_id = ${String(u.id)}, aprovador_nome = ${nomeDe(u)}, aprovado_em = now(), updated_at = now()
      WHERE id = ${v.id}`);
    const cod = "VG-" + String(v.numero).padStart(4, "0");
    await recalcRotas(v);
    await evento(v.id, nomeDe(u), `Aprovado ${fmtBRL(valor)}. Enviado ao Financeiro.`);
    await chamado(["lanucy"], `Viagem ${cod} — pagar adiantamento`,
      `Aprovado por ${nomeDe(u)}: pagar ${fmtBRL(valor)} a ${v.vendedor_nome} antes de ${fmtData(v.data_ini)} (viagem a ${v.cidade}-${v.uf}).\nAnexe o comprovante e marque como pago em: ${APP_URL}/viagens?id=${v.id}`, u);
    res.json(saida(await carregar(v.id)));
  });

  app.post("/api/viagens/:id/recusar", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!isAdm(u)) return res.status(403).json({ message: "Só Admin ou Adm recusa" });
    const v = await carregar(req.params.id);
    if (!v || v.status !== "aguardando") return res.status(400).json({ message: "Viagem não está aguardando aprovação" });
    const motivo = String(req.body?.motivo || "").slice(0, 1000);
    await db.execute(sql`UPDATE viagens SET status = 'recusado', motivo_recusa = ${motivo}, aprovador_id = ${String(u.id)}, aprovador_nome = ${nomeDe(u)}, aprovado_em = now(), updated_at = now() WHERE id = ${v.id}`);
    await evento(v.id, nomeDe(u), `Recusado${motivo ? ": " + motivo : "."}`);
    res.json(saida(await carregar(v.id)));
  });

  // Pagamento (Financeiro / admin): comprovante opcional em "arquivos"
  app.post("/api/viagens/:id/pagar", authenticateUser, comArquivos, async (req: any, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!isAdm(u)) return res.status(403).json({ message: "Só o Financeiro (Admin) marca como pago" });
    const v = await carregar(req.params.id);
    if (!v || v.status !== "aprovado") return res.status(400).json({ message: "Viagem não está aprovada" });
    for (const f of (Array.isArray(req.files) ? req.files : [])) {
      await db.execute(sql`INSERT INTO viagem_anexos (viagem_id, categoria, nome, mime, tamanho, dados, autor_id)
        VALUES (${v.id}, 'pagamento', ${nomeArq(f).slice(0, 200)}, ${String(f.mimetype || "")}, ${Number(f.size || 0)}, ${f.buffer}, ${String(u.id)})`);
    }
    await db.execute(sql`UPDATE viagens SET status = 'pago', pago_por = ${String(u.id)}, pago_em = now(), updated_at = now() WHERE id = ${v.id}`);
    await evento(v.id, nomeDe(u), `Pago ${fmtBRL(num(v.valor_aprovado))}.`);
    res.json(saida(await carregar(v.id)));
  });

  // Despesas e anexos da prestação (vendedor da viagem ou admin), antes de enviar
  const podeEditarPrestacao = (u: any, v: any) => v && v.status === "pago" && (isAdm(u) || String(v.vendedor_id) === String(u.id));
  app.post("/api/viagens/:id/despesas", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const v = await carregar(req.params.id);
    if (!podeEditarPrestacao(u, v)) return res.status(400).json({ message: "Prestação de contas não está aberta" });
    const tipo = String(req.body?.tipo || "Outros").slice(0, 40);
    const r = rows(await db.execute(sql`INSERT INTO viagem_despesas (viagem_id, tipo, valor) VALUES (${v.id}, ${tipo}, ${r2(num(req.body?.valor))}) RETURNING id`))[0];
    res.json({ id: r.id });
  });
  app.patch("/api/viagens/despesas/:did", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const d = rows(await db.execute(sql`SELECT viagem_id FROM viagem_despesas WHERE id = ${req.params.did}`))[0];
    const v = d ? await carregar(d.viagem_id) : null;
    if (!podeEditarPrestacao(u, v)) return res.status(400).json({ message: "Prestação de contas não está aberta" });
    if (req.body?.tipo != null) await db.execute(sql`UPDATE viagem_despesas SET tipo = ${String(req.body.tipo).slice(0, 40)} WHERE id = ${req.params.did}`);
    if (req.body?.valor != null) await db.execute(sql`UPDATE viagem_despesas SET valor = ${r2(num(req.body.valor))} WHERE id = ${req.params.did}`);
    res.json({ ok: true });
  });
  app.delete("/api/viagens/despesas/:did", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const d = rows(await db.execute(sql`SELECT viagem_id FROM viagem_despesas WHERE id = ${req.params.did}`))[0];
    const v = d ? await carregar(d.viagem_id) : null;
    if (!podeEditarPrestacao(u, v)) return res.status(400).json({ message: "Prestação de contas não está aberta" });
    await db.execute(sql`DELETE FROM viagem_anexos WHERE despesa_id = ${req.params.did}`);
    await db.execute(sql`DELETE FROM viagem_despesas WHERE id = ${req.params.did}`);
    res.json({ ok: true });
  });
  app.post("/api/viagens/:id/anexos", authenticateUser, comArquivos, async (req: any, res) => {
    const u = await guard(req, res); if (!u) return;
    const v = await carregar(req.params.id);
    if (!podeEditarPrestacao(u, v)) return res.status(400).json({ message: "Prestação de contas não está aberta" });
    const despesaId = req.body?.despesaId ? String(req.body.despesaId) : null;
    for (const f of (Array.isArray(req.files) ? req.files : [])) {
      await db.execute(sql`INSERT INTO viagem_anexos (viagem_id, despesa_id, categoria, nome, mime, tamanho, dados, autor_id)
        VALUES (${v.id}, ${despesaId}, ${despesaId ? "despesa" : "outro"}, ${nomeArq(f).slice(0, 200)}, ${String(f.mimetype || "")}, ${Number(f.size || 0)}, ${f.buffer}, ${String(u.id)})`);
    }
    res.json({ ok: true });
  });
  app.delete("/api/viagens/anexos/:aid", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const a = rows(await db.execute(sql`SELECT viagem_id, categoria FROM viagem_anexos WHERE id = ${req.params.aid}`))[0];
    const v = a ? await carregar(a.viagem_id) : null;
    if (!a || a.categoria === "pagamento" || !podeEditarPrestacao(u, v)) return res.status(400).json({ message: "Não é possível remover" });
    await db.execute(sql`DELETE FROM viagem_anexos WHERE id = ${req.params.aid}`);
    res.json({ ok: true });
  });
  app.get("/api/viagens/anexos/:aid", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const a = rows(await db.execute(sql`SELECT * FROM viagem_anexos WHERE id = ${req.params.aid}`))[0];
    const v = a ? await carregar(a.viagem_id) : null;
    if (!a || !v || !podeVer(u, v)) return res.status(404).send("Não encontrado");
    res.setHeader("Content-Type", a.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(a.nome)}"`);
    res.send(a.dados);
  });

  // Envio da prestação: km real da Rota do Dia + despesas COM comprovante
  app.post("/api/viagens/:id/prestacao", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const v = await carregar(req.params.id);
    if (!podeEditarPrestacao(u, v)) return res.status(400).json({ message: "Prestação de contas não está aberta" });
    await recalcRotas(v);
    const kmDias = await kmDoPeriodo(v);
    const kmReal = r2(kmDias.reduce((a, d) => a + d.km, 0));
    const vKm = r2(kmReal * num(v.tarifa));
    const desp = rows(await db.execute(sql`
      SELECT COALESCE(SUM(d.valor), 0) AS total FROM viagem_despesas d
      WHERE d.viagem_id = ${v.id} AND EXISTS (SELECT 1 FROM viagem_anexos a WHERE a.despesa_id = d.id)`))[0];
    const vDesp = r2(num(desp?.total));
    const real = r2(vKm + vDesp), saldo = r2(real - num(v.valor_aprovado));
    await db.execute(sql`UPDATE viagens SET km_real = ${kmReal}, valor_km_real = ${vKm}, valor_despesas = ${vDesp}, valor_real = ${real}, saldo = ${saldo},
      status = 'prestado', prestado_em = now(), updated_at = now() WHERE id = ${v.id}`);
    const cod = "VG-" + String(v.numero).padStart(4, "0");
    const res2 = saldo > 0.009 ? `Saldo a favor do vendedor: ${fmtBRL(saldo)} (reembolsar).` : saldo < -0.009 ? `Sobra de ${fmtBRL(-saldo)}: devolução ou desconto no próximo pagamento de km.` : "Sem diferença.";
    await evento(v.id, nomeDe(u), `Prestação enviada: km real ${kmReal.toLocaleString("pt-BR")} km (${fmtBRL(vKm)}) + despesas comprovadas ${fmtBRL(vDesp)} = ${fmtBRL(real)}. ${res2}`);
    await chamado(saldo > 0.009 ? ["flavio", "cinthia", "lanucy"] : ["flavio", "cinthia"], `Viagem ${cod} — prestação de contas`,
      `${v.vendedor_nome} enviou a prestação de contas da viagem a ${v.cidade}-${v.uf}.\nAdiantado: ${fmtBRL(num(v.valor_aprovado))}\nGasto real: ${fmtBRL(real)} (km ${fmtBRL(vKm)} + despesas ${fmtBRL(vDesp)})\n${res2}\n\nConfira em: ${APP_URL}/viagens?id=${v.id}`, u);
    res.json(saida(await carregar(v.id)));
  });

  // Encerrar (admin) depois do acerto
  app.post("/api/viagens/:id/encerrar", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!isAdm(u)) return res.status(403).json({ message: "Só Admin ou Adm encerra" });
    const v = await carregar(req.params.id);
    if (!v || v.status !== "prestado") return res.status(400).json({ message: "Viagem não está com prestação enviada" });
    await db.execute(sql`UPDATE viagens SET status = 'encerrado', encerrado_por = ${String(u.id)}, encerrado_em = now(), updated_at = now() WHERE id = ${v.id}`);
    await evento(v.id, nomeDe(u), `Acerto conferido e viagem encerrada.`);
    res.json(saida(await carregar(v.id)));
  });

  // Reabrir prestação (admin), caso falte comprovante
  app.post("/api/viagens/:id/reabrir", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!isAdm(u)) return res.status(403).json({ message: "Só Admin ou Adm reabre" });
    const v = await carregar(req.params.id);
    if (!v || v.status !== "prestado") return res.status(400).json({ message: "Só reabre prestação enviada" });
    await db.execute(sql`UPDATE viagens SET status = 'pago', updated_at = now() WHERE id = ${v.id}`);
    await evento(v.id, nomeDe(u), `Prestação reaberta para ajuste${req.body?.motivo ? ": " + String(req.body.motivo).slice(0, 500) : "."}`);
    res.json(saida(await carregar(v.id)));
  });
}
