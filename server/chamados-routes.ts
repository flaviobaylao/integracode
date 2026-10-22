import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import multer from "multer";

// ===========================================================================
// CHAMADOS (21/out/2026) — solicitações de serviço abertas por qualquer usuário
// (vendedores internos/externos pelo celular) para um DESTINO (pessoa/setor).
//
// Destinos padrão (configuráveis em system_settings.chamados_destinos):
//   flavio  – Administração
//   cinthia – Comercial
//   naiara  – Indústria
//   lanucy  – Adm, Logística, Financeiro
//
// Fluxo: Novo → (Receber) Em atendimento → (Responder) Respondido → (Finalizar) Solucionado.
// O responsável pode responder quantas vezes quiser sem fechar; "Responder e finalizar" fecha
// como solucionado. Só quem abriu pode Reabrir um chamado solucionado. Tudo fica no histórico
// (mensagens + linhas de sistema). Anexos (fotos/documentos) em qualquer etapa, opcionais,
// guardados no Postgres (chamado_anexos) e servidos só a quem pode ver a mensagem.
// O responsável pode CONSULTAR outro destino dentro do mesmo chamado; a conversa
// entre setores é INTERNA (o autor só vê uma linha de sistema).
//
// Visibilidade: cada usuário vê SOMENTE os chamados em que participa (abriu, é
// responsável pelo destino ou foi consultado). Admin tem a aba "Todos".
//
// Tabelas criadas sob demanda (CREATE TABLE IF NOT EXISTS), fora do schema drizzle,
// para nenhum SELECT existente depender delas.
// ===========================================================================

const APP_URL = process.env.APP_URL || "https://integracode-production.up.railway.app";

type Destino = { key: string; nome: string; setor: string; userIds?: string[]; emails?: string[]; nomeLike?: string[] };

const DESTINOS_PADRAO: Destino[] = [
  { key: "flavio", nome: "Flávio", setor: "Administração", emails: ["flavio@bebahonest.com.br", "flaviobaylao@gmail.com"] },
  { key: "cinthia", nome: "Cinthia", setor: "Comercial", emails: ["cinthiamarque90@gmail.com"] },
  { key: "naiara", nome: "Naiara", setor: "Indústria", nomeLike: ["naiara%", "nayara%"] },
  { key: "lanucy", nome: "Lanucy", setor: "Adm, Logística, Financeiro", emails: ["lanucy@bebahonest.com.br"], nomeLike: ["lanucy%"] },
];

const PRIORIDADES = ["Baixa", "Normal", "Urgente"];
const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];

let ensured: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS chamados_numero_seq START 1`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chamados (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        numero integer NOT NULL UNIQUE DEFAULT nextval('chamados_numero_seq'),
        autor_id varchar NOT NULL,
        autor_nome varchar,
        autor_papel varchar,
        destino_key varchar NOT NULL,
        assunto text NOT NULL,
        descricao text,
        prioridade varchar NOT NULL DEFAULT 'Normal',
        status varchar NOT NULL DEFAULT 'novo',
        recebido_por varchar,
        recebido_em timestamp,
        respondido_em timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chamado_mensagens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        chamado_id varchar NOT NULL,
        autor_id varchar,
        autor_nome varchar,
        tipo varchar NOT NULL DEFAULT 'publica',
        de_key varchar,
        para_key varchar,
        texto text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_chamado_msg_chamado ON chamado_mensagens (chamado_id, created_at)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chamado_consultas (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        chamado_id varchar NOT NULL,
        destino_key varchar NOT NULL,
        pendente boolean NOT NULL DEFAULT true,
        solicitado_por varchar,
        created_at timestamp NOT NULL DEFAULT now(),
        respondido_em timestamp,
        UNIQUE (chamado_id, destino_key)
      )`);
      await db.execute(sql`ALTER TABLE chamados ADD COLUMN IF NOT EXISTS solucionado_em timestamp`);
      await db.execute(sql`ALTER TABLE chamados ADD COLUMN IF NOT EXISTS solucionado_por varchar`);
      await db.execute(sql`ALTER TABLE chamados ADD COLUMN IF NOT EXISTS reaberto_em timestamp`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chamado_anexos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        chamado_id varchar NOT NULL,
        mensagem_id varchar,
        autor_id varchar,
        nome varchar NOT NULL,
        mime varchar,
        tamanho integer,
        dados bytea NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_chamado_anexos_chamado ON chamado_anexos (chamado_id)`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS chamado_leituras (
        chamado_id varchar NOT NULL,
        user_id varchar NOT NULL,
        lido_em timestamp NOT NULL DEFAULT now(),
        PRIMARY KEY (chamado_id, user_id)
      )`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const r = rows(await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`));
    return r[0]?.value ?? null;
  } catch { return null; }
}
async function setSetting(key: string, value: string, by: string) {
  await db.execute(sql`INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${value}, ${by}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
}

type DestinoResolvido = { key: string; nome: string; setor: string; label: string; userIds: string[] };

// Resolve os destinos: config salva (userIds explícitos) OU padrão por e-mail/nome.
async function getDestinos(): Promise<DestinoResolvido[]> {
  let cfg: Destino[] = DESTINOS_PADRAO;
  const raw = await getSetting("chamados_destinos");
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p) && p.length) cfg = p; } catch { /* usa padrão */ } }

  const users = rows(await db.execute(sql`SELECT id, lower(coalesce(email,'')) AS email, lower(coalesce(first_name,'')) AS fn
    FROM users WHERE is_active = true`));
  const out: DestinoResolvido[] = [];
  for (const d of cfg) {
    const ids = new Set<string>((d.userIds || []).map(String));
    if (!d.userIds || d.userIds.length === 0) {
      const emails = (d.emails || []).map((e) => e.toLowerCase());
      for (const u of users) if (emails.includes(u.email)) ids.add(String(u.id));
      if (ids.size === 0) {
        for (const pat of d.nomeLike || []) {
          const pre = pat.toLowerCase().replace(/%$/, "");
          for (const u of users) if (u.fn.startsWith(pre) || u.email.startsWith(pre)) ids.add(String(u.id));
        }
      }
    }
    out.push({ key: d.key, nome: d.nome, setor: d.setor, label: `${d.nome} – ${d.setor}`, userIds: Array.from(ids) });
  }
  return out;
}

function nomeDe(u: any): string {
  const n = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
  return n || u?.email || "Usuário";
}
const isAdminUser = (u: any) => ["admin"].includes(String(u?.role || ""));
const numeroFmt = (n: number) => "CH-" + String(n).padStart(4, "0");

function papelNoChamado(c: any, uid: string, minhasKeys: string[], consultasKeys: string[]) {
  if (minhasKeys.includes(c.destino_key)) return "dono";
  if (consultasKeys.some((k) => minhasKeys.includes(k))) return "consultado";
  if (String(c.autor_id) === uid) return "autor";
  return "admin";
}

// ---------- WhatsApp (aviso interno; nunca bloqueia a operação) ----------
async function avisar(userIds: string[], texto: string) {
  if (!userIds.length) return;
  if ((await getSetting("chamados_whatsapp")) === "off") return;
  try {
    const list = rows(await db.execute(sql`SELECT id, phone FROM users WHERE id IN (${sql.join(userIds.map((i) => sql`${i}`), sql`, `)})`));
    const { enviarInterno } = await import("./envio-texto");
    const vistos = new Set<string>();
    for (const u of list) {
      const fone = String(u.phone || "").replace(/\D/g, "");
      if (fone.length < 10 || vistos.has(fone)) continue;
      vistos.add(fone);
      const tel = fone.startsWith("55") ? fone : "55" + fone;
      enviarInterno(tel, texto).catch((e: any) => console.warn("[chamados] aviso falhou", e?.message || e));
    }
  } catch (e: any) { console.warn("[chamados] aviso", e?.message || e); }
}
function avisarBg(userIds: string[], texto: string) { setTimeout(() => { avisar(userIds, texto).catch(() => {}); }, 0); }
const trecho = (t: string, n = 120) => (t.length > n ? t.slice(0, n) + "…" : t);

// ---------- anexos ----------
const MAX_ARQ_MB = 15;
const uploadMw = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARQ_MB * 1024 * 1024, files: 10 } }).array("arquivos", 10);
// Aceita multipart (com arquivos) ou JSON; responde 400 legível se um arquivo passar do limite.
function comArquivos(req: any, res: Response, next: any) {
  uploadMw(req, res, (err: any) => {
    if (!err) return next();
    const msg = err?.code === "LIMIT_FILE_SIZE" ? `Arquivo maior que ${MAX_ARQ_MB} MB` : err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE" ? "Máximo de 10 arquivos por envio" : (err?.message || "Falha no upload");
    res.status(400).json({ message: msg });
  });
}
const arquivosDe = (req: any): any[] => (Array.isArray(req.files) ? req.files : []);
const nomeArq = (f: any) => { try { return Buffer.from(String(f.originalname || "arquivo"), "latin1").toString("utf8"); } catch { return String(f.originalname || "arquivo"); } };
async function salvarAnexos(chamadoId: string, mensagemId: string | null, autorId: string, files: any[]) {
  for (const f of files) {
    await db.execute(sql`INSERT INTO chamado_anexos (chamado_id, mensagem_id, autor_id, nome, mime, tamanho, dados)
      VALUES (${chamadoId}, ${mensagemId}, ${autorId}, ${nomeArq(f).slice(0, 200)}, ${String(f.mimetype || "application/octet-stream")}, ${Number(f.size || 0)}, ${f.buffer})`);
  }
}
// Insere mensagem e devolve o id (para ligar os anexos)
async function inserirMsg(chamadoId: string, autorId: string, autorNome: string, tipo: string, deKey: string | null, paraKey: string | null, texto: string): Promise<string> {
  const r = rows(await db.execute(sql`INSERT INTO chamado_mensagens (chamado_id, autor_id, autor_nome, tipo, de_key, para_key, texto)
    VALUES (${chamadoId}, ${autorId}, ${autorNome}, ${tipo}, ${deKey}, ${paraKey}, ${texto}) RETURNING id`));
  return String(r[0].id);
}
const sufixoAnexos = (n: number) => (n ? `\n📎 ${n} anexo${n > 1 ? "s" : ""}` : "");

// ---------- carga de chamados visíveis para um usuário ----------
async function carregarVisiveis(user: any, caixa: string) {
  await ensureTables();
  const uid = String(user.id);
  const destinos = await getDestinos();
  const minhasKeys = destinos.filter((d) => d.userIds.includes(uid)).map((d) => d.key);
  const admin = isAdminUser(user);
  const keysSql = minhasKeys.length ? sql.join(minhasKeys.map((k) => sql`${k}`), sql`, `) : sql`'__nenhum__'`;

  let filtro;
  if (caixa === "todos" && admin) filtro = sql`true`;
  else filtro = sql`(c.autor_id = ${uid} OR c.destino_key IN (${keysSql})
      OR EXISTS (SELECT 1 FROM chamado_consultas q WHERE q.chamado_id = c.id AND q.destino_key IN (${keysSql})))`;

  const chamados = rows(await db.execute(sql`SELECT c.* FROM chamados c WHERE ${filtro} ORDER BY c.numero DESC LIMIT 500`));
  if (!chamados.length) return { chamados: [], destinos, minhasKeys, admin, uid };

  const ids = sql.join(chamados.map((c) => sql`${c.id}`), sql`, `);
  const consultas = rows(await db.execute(sql`SELECT * FROM chamado_consultas WHERE chamado_id IN (${ids}) ORDER BY created_at`));
  const ultimas = rows(await db.execute(sql`SELECT chamado_id, tipo, autor_id, max(created_at) AS ult FROM chamado_mensagens
     WHERE chamado_id IN (${ids}) GROUP BY chamado_id, tipo, autor_id`));
  const leituras = rows(await db.execute(sql`SELECT chamado_id, lido_em FROM chamado_leituras WHERE user_id = ${uid} AND chamado_id IN (${ids})`));
  const lidoMap = new Map(leituras.map((l) => [String(l.chamado_id), new Date(l.lido_em).getTime()]));
  const destMap = new Map(destinos.map((d) => [d.key, d]));

  const out = chamados.map((c) => {
    const cons = consultas.filter((q) => q.chamado_id === c.id);
    const consKeys = cons.map((q) => q.destino_key);
    const papel = papelNoChamado(c, uid, minhasKeys, consKeys);
    // última atividade relevante para este usuário (não conta o que ele mesmo escreveu)
    let ult = 0;
    for (const m of ultimas) {
      if (m.chamado_id !== c.id || String(m.autor_id || "") === uid) continue;
      if (papel === "autor" && m.tipo === "interna") continue;
      ult = Math.max(ult, new Date(m.ult).getTime());
    }
    const lido = lidoMap.get(String(c.id)) || 0;
    const d = destMap.get(c.destino_key);
    const pend = cons.filter((q) => q.pendente);
    const consultaPendenteParaMim = cons.some((q) => q.pendente && minhasKeys.includes(q.destino_key));
    return {
      id: c.id, numero: c.numero, codigo: numeroFmt(c.numero),
      assunto: c.assunto, descricao: c.descricao, prioridade: c.prioridade, status: c.status,
      autorId: c.autor_id, autorNome: c.autor_nome, autorPapel: c.autor_papel,
      destinoKey: c.destino_key, destinoNome: d?.nome || c.destino_key, destinoSetor: d?.setor || "",
      createdAt: c.created_at, updatedAt: c.updated_at, solucionadoEm: c.solucionado_em || null,
      papel, naoLido: ult > lido,
      consultas: cons.map((q) => ({ key: q.destino_key, nome: destMap.get(q.destino_key)?.nome || q.destino_key, setor: destMap.get(q.destino_key)?.setor || "", pendente: !!q.pendente })),
      aguardando: papel === "dono" ? pend.map((q) => destMap.get(q.destino_key)?.nome || q.destino_key) : [],
      consultaPendenteParaMim,
    };
  });
  return { chamados: out, destinos, minhasKeys, admin, uid };
}

async function carregarUm(user: any, id: string) {
  const vis = await carregarVisiveis(user, isAdminUser(user) ? "todos" : "meus");
  const c = vis.chamados.find((x) => x.id === id);
  return { c, vis };
}

export function registerChamados(app: Express) {
  // Destinos (lista de seleção) + perfil do usuário
  app.get("/api/chamados/perfil", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureTables();
      const destinos = await getDestinos();
      const uid = String(req.currentUser.id);
      res.json({
        destinos: destinos.map((d) => ({ key: d.key, nome: d.nome, setor: d.setor, label: d.label, configurado: d.userIds.length > 0 })),
        minhasKeys: destinos.filter((d) => d.userIds.includes(uid)).map((d) => d.key),
        admin: isAdminUser(req.currentUser),
        usuario: { id: uid, nome: nomeDe(req.currentUser) },
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Lista: caixa = meus | recebidos | consultas | todos (admin)
  app.get("/api/chamados", authenticateUser, async (req: any, res: Response) => {
    try {
      const caixa = String(req.query.caixa || "tudo");
      const vis = await carregarVisiveis(req.currentUser, caixa);
      let lista = vis.chamados;
      if (caixa === "meus") lista = lista.filter((c) => c.autorId === vis.uid);
      else if (caixa === "recebidos") lista = lista.filter((c) => c.papel === "dono");
      else if (caixa === "consultas") lista = lista.filter((c) => c.papel === "consultado");
      res.json({ chamados: lista });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Contadores (badge do menu)
  app.get("/api/chamados/contadores", authenticateUser, async (req: any, res: Response) => {
    try {
      const vis = await carregarVisiveis(req.currentUser, "tudo");
      const naoLidos = vis.chamados.filter((c) => c.naoLido).length;
      res.json({
        naoLidos,
        meus: vis.chamados.filter((c) => c.autorId === vis.uid && c.naoLido).length,
        recebidos: vis.chamados.filter((c) => c.papel === "dono" && c.naoLido).length,
        consultas: vis.chamados.filter((c) => c.papel === "consultado" && c.naoLido).length,
        novos: vis.chamados.filter((c) => c.papel === "dono" && c.status === "novo").length,
        // Entrada: chamados que pedem atenção do usuário (distintos) — novo recebido ainda não
        // aberto, mensagem/resposta não lida, ou consulta de outro setor aguardando retorno dele.
        entrada: vis.chamados.filter((c) => c.naoLido || (c.papel === "dono" && c.status === "novo") || c.consultaPendenteParaMim).length,
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Detalhe + mensagens (autor não vê mensagens internas). Marca como lido.
  app.get("/api/chamados/:id", authenticateUser, async (req: any, res: Response) => {
    try {
      const { c } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      const msgs = rows(await db.execute(sql`SELECT * FROM chamado_mensagens WHERE chamado_id = ${c.id} ORDER BY created_at`));
      const uid = String(req.currentUser.id);
      const vis = c.papel === "autor" ? msgs.filter((m) => m.tipo !== "interna") : msgs;
      const anexos = rows(await db.execute(sql`SELECT id, mensagem_id, nome, mime, tamanho FROM chamado_anexos WHERE chamado_id = ${c.id} ORDER BY created_at`));
      await db.execute(sql`INSERT INTO chamado_leituras (chamado_id, user_id, lido_em) VALUES (${c.id}, ${uid}, now())
        ON CONFLICT (chamado_id, user_id) DO UPDATE SET lido_em = now()`);
      res.json({
        chamado: { ...c, naoLido: false },
        mensagens: vis.map((m) => ({ id: m.id, tipo: m.tipo, autorId: m.autor_id, autorNome: m.autor_nome, deKey: m.de_key, paraKey: m.para_key, texto: m.texto, createdAt: m.created_at, minha: String(m.autor_id || "") === uid,
          anexos: anexos.filter((a) => String(a.mensagem_id || "") === String(m.id)).map((a) => ({ id: a.id, nome: a.nome, mime: a.mime, tamanho: a.tamanho })) })),
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Baixar/ver anexo — só quem enxerga o chamado; anexo de conversa interna não é servido ao autor.
  app.get("/api/chamados/anexos/:anexoId", authenticateUser, async (req: any, res: Response) => {
    try {
      await ensureTables();
      const a = rows(await db.execute(sql`SELECT a.*, m.tipo AS msg_tipo FROM chamado_anexos a LEFT JOIN chamado_mensagens m ON m.id = a.mensagem_id WHERE a.id = ${String(req.params.anexoId)}`))[0];
      if (!a) return res.status(404).json({ message: "Anexo não encontrado" });
      const { c } = await carregarUm(req.currentUser, String(a.chamado_id));
      if (!c) return res.status(404).json({ message: "Anexo não encontrado" });
      if (c.papel === "autor" && a.msg_tipo === "interna") return res.status(403).json({ message: "Sem acesso" });
      const nome = String(a.nome || "arquivo");
      res.setHeader("Content-Type", String(a.mime || "application/octet-stream"));
      res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(nome)}`);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(Buffer.isBuffer(a.dados) ? a.dados : Buffer.from(a.dados));
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Abrir chamado (qualquer usuário)
  app.post("/api/chamados", authenticateUser, comArquivos, async (req: any, res: Response) => {
    try {
      await ensureTables();
      const u = req.currentUser;
      const destinoKey = String(req.body?.destinoKey || "");
      const assunto = String(req.body?.assunto || "").trim();
      const descricao = String(req.body?.descricao || "").trim();
      const prioridade = PRIORIDADES.includes(req.body?.prioridade) ? req.body.prioridade : "Normal";
      const destinos = await getDestinos();
      const d = destinos.find((x) => x.key === destinoKey);
      if (!d) return res.status(400).json({ message: "Escolha para quem é o chamado" });
      if (assunto.length < 3) return res.status(400).json({ message: "Informe o assunto" });
      const autorNome = nomeDe(u);
      const ins = rows(await db.execute(sql`INSERT INTO chamados (autor_id, autor_nome, autor_papel, destino_key, assunto, descricao, prioridade, status)
        VALUES (${String(u.id)}, ${autorNome}, ${String(u.role || "")}, ${destinoKey}, ${assunto}, ${descricao || null}, ${prioridade}, 'novo')
        RETURNING id, numero`));
      const novo = ins[0];
      const files = arquivosDe(req);
      const msgId = await inserirMsg(novo.id, String(u.id), autorNome, "publica", "autor", destinoKey, descricao || assunto);
      await salvarAnexos(novo.id, msgId, String(u.id), files);
      await db.execute(sql`INSERT INTO chamado_leituras (chamado_id, user_id) VALUES (${novo.id}, ${String(u.id)}) ON CONFLICT DO NOTHING`);
      const cod = numeroFmt(novo.numero);
      avisarBg(d.userIds.filter((x) => x !== String(u.id)),
        `📩 Novo chamado ${cod}${prioridade === "Urgente" ? " (URGENTE)" : ""} de ${autorNome}\n${assunto}${sufixoAnexos(files.length)}\n\nAbra no Integra: ${APP_URL}/chamados?id=${novo.id}`);
      res.json({ ok: true, id: novo.id, numero: novo.numero, codigo: cod, destino: d.label });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Responsável recebe o chamado
  app.post("/api/chamados/:id/receber", authenticateUser, async (req: any, res: Response) => {
    try {
      const { c } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      if (c.papel !== "dono" && !isAdminUser(req.currentUser)) return res.status(403).json({ message: "Só o responsável pode receber" });
      if (c.status !== "novo") return res.json({ ok: true, jaRecebido: true });
      const nome = nomeDe(req.currentUser);
      await db.execute(sql`UPDATE chamados SET status = 'em_atendimento', recebido_por = ${String(req.currentUser.id)}, recebido_em = now(), updated_at = now() WHERE id = ${c.id}`);
      await db.execute(sql`INSERT INTO chamado_mensagens (chamado_id, autor_id, autor_nome, tipo, texto)
        VALUES (${c.id}, ${String(req.currentUser.id)}, ${nome}, 'sistema', ${nome + " recebeu o chamado"})`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Responsável responde ao autor → Respondido (chamado continua aberto) ou, com finalizar=true,
  // fecha como Solucionado. Aviso no celular do autor nos dois casos.
  app.post("/api/chamados/:id/responder", authenticateUser, comArquivos, async (req: any, res: Response) => {
    try {
      const texto = String(req.body?.texto || "").trim();
      const finalizar = req.body?.finalizar === true || req.body?.finalizar === "true";
      const files = arquivosDe(req);
      if (!texto && !files.length && !finalizar) return res.status(400).json({ message: "Escreva a resposta ou anexe um arquivo" });
      const { c } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      if (c.papel !== "dono" && !isAdminUser(req.currentUser)) return res.status(403).json({ message: "Só o responsável pode responder ao solicitante" });
      if (c.status === "solucionado") return res.status(400).json({ message: "Chamado já finalizado. Quem abriu pode reabrir." });
      const uid = String(req.currentUser.id);
      const nome = nomeDe(req.currentUser);
      if (texto || files.length) {
        const msgId = await inserirMsg(c.id, uid, nome, "publica", c.destinoKey, "autor", texto || "(anexo)");
        await salvarAnexos(c.id, msgId, uid, files);
      }
      if (finalizar) {
        await db.execute(sql`UPDATE chamados SET status = 'solucionado', solucionado_em = now(), solucionado_por = ${uid},
          respondido_em = coalesce(respondido_em, now()),
          recebido_por = coalesce(recebido_por, ${uid}), recebido_em = coalesce(recebido_em, now()), updated_at = now() WHERE id = ${c.id}`);
        await db.execute(sql`UPDATE chamado_consultas SET pendente = false WHERE chamado_id = ${c.id} AND pendente = true`);
        await inserirMsg(c.id, uid, nome, "sistema", null, null, `${nome} finalizou o chamado como solucionado`);
      } else {
        await db.execute(sql`UPDATE chamados SET status = 'respondido', respondido_em = now(),
          recebido_por = coalesce(recebido_por, ${uid}), recebido_em = coalesce(recebido_em, now()), updated_at = now() WHERE id = ${c.id}`);
      }
      if (String(c.autorId) !== uid) {
        const cab = finalizar ? `✅ Seu chamado ${c.codigo} foi SOLUCIONADO e finalizado por ${nome}.` : `💬 Seu chamado ${c.codigo} foi atendido por ${nome}.`;
        avisarBg([String(c.autorId)], `${cab}${texto ? `\n"${trecho(texto)}"` : ""}${sufixoAnexos(files.length)}\n\nVer no Integra: ${APP_URL}/chamados?id=${c.id}`);
      }
      res.json({ ok: true, finalizado: finalizar });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Quem abriu reabre um chamado solucionado (motivo e anexos opcionais) → volta ao responsável
  app.post("/api/chamados/:id/reabrir", authenticateUser, comArquivos, async (req: any, res: Response) => {
    try {
      const texto = String(req.body?.texto || "").trim();
      const files = arquivosDe(req);
      const { c, vis } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      const uid = String(req.currentUser.id);
      if (String(c.autorId) !== uid) return res.status(403).json({ message: "Só quem abriu pode reabrir" });
      if (c.status !== "solucionado") return res.status(400).json({ message: "Só um chamado finalizado pode ser reaberto" });
      const nome = nomeDe(req.currentUser);
      await inserirMsg(c.id, uid, nome, "sistema", null, null, `${nome} reabriu o chamado`);
      if (texto || files.length) {
        const msgId = await inserirMsg(c.id, uid, nome, "publica", "autor", c.destinoKey, texto || "(anexo)");
        await salvarAnexos(c.id, msgId, uid, files);
      }
      await db.execute(sql`UPDATE chamados SET status = 'reaberto', reaberto_em = now(), updated_at = now() WHERE id = ${c.id}`);
      const dono = vis.destinos.find((x) => x.key === c.destinoKey);
      avisarBg((dono?.userIds || []).filter((x) => x !== uid),
        `🔁 ${nome} reabriu o chamado ${c.codigo}\n${c.assunto}${texto ? `\n"${trecho(texto)}"` : ""}${sufixoAnexos(files.length)}\n\nVer no Integra: ${APP_URL}/chamados?id=${c.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Responsável consulta outro destino (interno)
  app.post("/api/chamados/:id/consultar", authenticateUser, comArquivos, async (req: any, res: Response) => {
    try {
      const texto = String(req.body?.texto || "").trim();
      const alvo = String(req.body?.destinoKey || "");
      const files = arquivosDe(req);
      if (!texto && !files.length) return res.status(400).json({ message: "Escreva o que precisa saber" });
      const { c, vis } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      if (c.papel !== "dono" && !isAdminUser(req.currentUser)) return res.status(403).json({ message: "Só o responsável pode consultar outro setor" });
      const d = vis.destinos.find((x) => x.key === alvo);
      if (!d || alvo === c.destinoKey) return res.status(400).json({ message: "Escolha outro setor" });
      if (c.status === "solucionado") return res.status(400).json({ message: "Chamado finalizado" });
      const nome = nomeDe(req.currentUser);
      await db.execute(sql`INSERT INTO chamado_consultas (chamado_id, destino_key, pendente, solicitado_por)
        VALUES (${c.id}, ${alvo}, true, ${String(req.currentUser.id)})
        ON CONFLICT (chamado_id, destino_key) DO UPDATE SET pendente = true, respondido_em = NULL`);
      await db.execute(sql`INSERT INTO chamado_mensagens (chamado_id, autor_id, autor_nome, tipo, texto)
        VALUES (${c.id}, ${String(req.currentUser.id)}, ${nome}, 'sistema', ${nome + " consultou " + d.setor + " (" + d.nome + ")"})`);
      const msgIdC = await inserirMsg(c.id, String(req.currentUser.id), nome, "interna", c.destinoKey, alvo, texto || "(anexo)");
      await salvarAnexos(c.id, msgIdC, String(req.currentUser.id), files);
      await db.execute(sql`UPDATE chamados SET status = CASE WHEN status = 'novo' OR status = 'respondido' THEN 'em_atendimento' ELSE status END,
        recebido_por = coalesce(recebido_por, ${String(req.currentUser.id)}), recebido_em = coalesce(recebido_em, now()), updated_at = now() WHERE id = ${c.id}`);
      avisarBg(d.userIds.filter((x) => x !== String(req.currentUser.id)),
        `🔎 ${nome} pediu sua ajuda no chamado ${c.codigo}\n${c.assunto}${texto ? `\n"${trecho(texto)}"` : ""}${sufixoAnexos(files.length)}\n\nResponder no Integra: ${APP_URL}/chamados?id=${c.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Setor consultado devolve o retorno ao responsável (interno)
  app.post("/api/chamados/:id/retorno", authenticateUser, comArquivos, async (req: any, res: Response) => {
    try {
      const texto = String(req.body?.texto || "").trim();
      const files = arquivosDe(req);
      if (!texto && !files.length) return res.status(400).json({ message: "Escreva o retorno" });
      const { c, vis } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      const meusConsultados = c.consultas.filter((q: any) => vis.minhasKeys.includes(q.key)).map((q: any) => q.key);
      if (!meusConsultados.length) return res.status(403).json({ message: "Você não foi consultado neste chamado" });
      const nome = nomeDe(req.currentUser);
      const de = meusConsultados[0];
      const msgIdR = await inserirMsg(c.id, String(req.currentUser.id), nome, "interna", de, c.destinoKey, texto || "(anexo)");
      await salvarAnexos(c.id, msgIdR, String(req.currentUser.id), files);
      await db.execute(sql`UPDATE chamado_consultas SET pendente = false, respondido_em = now()
        WHERE chamado_id = ${c.id} AND destino_key IN (${sql.join(meusConsultados.map((k: string) => sql`${k}`), sql`, `)})`);
      await db.execute(sql`INSERT INTO chamado_mensagens (chamado_id, autor_id, autor_nome, tipo, texto)
        VALUES (${c.id}, ${String(req.currentUser.id)}, ${nome}, 'sistema', ${nome + " devolveu a consulta para " + c.destinoNome})`);
      await db.execute(sql`UPDATE chamados SET updated_at = now() WHERE id = ${c.id}`);
      const dono = vis.destinos.find((x) => x.key === c.destinoKey);
      avisarBg((dono?.userIds || []).filter((x) => x !== String(req.currentUser.id)),
        `↩️ ${nome} respondeu sua consulta no chamado ${c.codigo}${texto ? `\n"${trecho(texto)}"` : ""}${sufixoAnexos(files.length)}\n\nVer no Integra: ${APP_URL}/chamados?id=${c.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // Autor complementa um chamado ainda aberto (finalizado → usar Reabrir)
  app.post("/api/chamados/:id/complementar", authenticateUser, comArquivos, async (req: any, res: Response) => {
    try {
      const texto = String(req.body?.texto || "").trim();
      const files = arquivosDe(req);
      if (!texto && !files.length) return res.status(400).json({ message: "Escreva a mensagem ou anexe um arquivo" });
      const { c, vis } = await carregarUm(req.currentUser, req.params.id);
      if (!c) return res.status(404).json({ message: "Chamado não encontrado" });
      if (String(c.autorId) !== String(req.currentUser.id)) return res.status(403).json({ message: "Só quem abriu pode complementar" });
      if (c.status === "solucionado") return res.status(400).json({ message: "Chamado finalizado. Use Reabrir." });
      const nome = nomeDe(req.currentUser);
      const msgIdM = await inserirMsg(c.id, String(req.currentUser.id), nome, "publica", "autor", c.destinoKey, texto || "(anexo)");
      await salvarAnexos(c.id, msgIdM, String(req.currentUser.id), files);
      await db.execute(sql`UPDATE chamados SET status = CASE WHEN status = 'respondido' THEN 'em_atendimento' ELSE status END, updated_at = now() WHERE id = ${c.id}`);
      const dono = vis.destinos.find((x) => x.key === c.destinoKey);
      avisarBg((dono?.userIds || []).filter((x) => x !== String(req.currentUser.id)),
        `💬 ${nome} complementou o chamado ${c.codigo}${texto ? `\n"${trecho(texto)}"` : ""}${sufixoAnexos(files.length)}\n\nVer no Integra: ${APP_URL}/chamados?id=${c.id}`);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  // ---- Admin: quem atende cada destino ----
  app.get("/api/admin/chamados/destinos", authenticateUser, async (req: any, res: Response) => {
    try {
      if (!isAdminUser(req.currentUser)) return res.status(403).json({ message: "Somente admin" });
      const destinos = await getDestinos();
      const ids = Array.from(new Set(destinos.flatMap((d) => d.userIds)));
      const us = ids.length ? rows(await db.execute(sql`SELECT id, email, first_name, last_name, phone FROM users WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)) : [];
      res.json({
        destinos: destinos.map((d) => ({ ...d, usuarios: us.filter((u) => d.userIds.includes(String(u.id))).map((u) => ({ id: u.id, nome: [u.first_name, u.last_name].filter(Boolean).join(" "), email: u.email, temTelefone: !!u.phone })) })),
        whatsapp: (await getSetting("chamados_whatsapp")) !== "off",
      });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.put("/api/admin/chamados/destinos", authenticateUser, async (req: any, res: Response) => {
    try {
      if (!isAdminUser(req.currentUser)) return res.status(403).json({ message: "Somente admin" });
      const by = req.currentUser.email || "admin";
      if (Array.isArray(req.body?.destinos)) {
        const lista: Destino[] = req.body.destinos
          .filter((d: any) => d && /^[a-z0-9_-]{2,30}$/.test(String(d.key || "")) && d.nome && d.setor)
          .map((d: any) => ({ key: String(d.key), nome: String(d.nome), setor: String(d.setor), userIds: (d.userIds || []).map(String) }));
        if (!lista.length) return res.status(400).json({ message: "Lista inválida" });
        await setSetting("chamados_destinos", JSON.stringify(lista), by);
      }
      if (typeof req.body?.whatsapp === "boolean") await setSetting("chamados_whatsapp", req.body.whatsapp ? "on" : "off", by);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
}
