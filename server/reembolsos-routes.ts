import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import multer from "multer";
import { dataCalendario } from "@shared/tempo";

// ===========================================================================
// REEMBOLSO DE DESPESAS (28/out/2026) — módulo do grupo Chamados.
// Qualquer usuário pede reembolso de algo que pagou do próprio bolso (gelo, café,
// material...), com comprovante obrigatório e os dados para receber (Pix ou
// conta bancária). Mesmo fluxo de aprovação da Programação de Viagens:
//   aguardando (solicitante) -> aprovado (qualquer Admin; se o próprio Admin
//   solicitante aprovar, fica marcado como AUTOAPROVADO para auditoria) -> lancado (Financeiro/Lanucy: 1 clique cria a CONTA A PAGAR com
//   comprovantes anexados) -> pago (quando a conta a pagar é baixada)
//   | recusado (admin) | cancelado (solicitante, enquanto aguarda).
// O formulário já coleta os campos que a Conta a Pagar exige (fornecedor =
// favorecido, emissão, vencimento, valor, categoria DRE) + os opcionais usados
// (CPF/CNPJ, forma de pagamento, instância, descrição).
// Avisos: via Chamados (abrirChamadoSistema) — pedido -> Flávio, Elbber e Cinthia;
// aprovado -> Lanucy.
// Tabelas criadas sob demanda (CREATE TABLE IF NOT EXISTS), fora do drizzle.
// ===========================================================================

const APROVADORES = ["admin"];                                  // quem aprova
const FINANCEIRO = ["admin", "administrative", "coordinator"];   // quem lança no Contas a Pagar (mesma regra do módulo financeiro)
const FORMAS = ["pix", "transferencia", "dinheiro"];
const INSTANCIAS = ["BSB", "GYN", "IND", "SERV", "CAIXINHA"];
const APP_URL = process.env.APP_URL || "https://integracode-production.up.railway.app";

const rows = (r: any): any[] => (r?.rows ?? r ?? []) as any[];
const num = (v: any, d = 0) => { const n = Number(String(v ?? "").replace(",", ".")); return isFinite(n) ? n : d; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const nomeDe = (u: any) => [u?.firstName ?? u?.first_name, u?.lastName ?? u?.last_name].filter(Boolean).join(" ").trim() || u?.email || "Usuário";
const fmtBRL = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtData = (s: any) => String(s || "").slice(0, 10).split("-").reverse().join("/");
const dia = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10));
const ehDia = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const codigo = (n: number) => "RB-" + String(n).padStart(4, "0");
const ehAprovador = (u: any) => APROVADORES.includes(String(u?.role || ""));
const ehFinanceiro = (u: any) => FINANCEIRO.includes(String(u?.role || ""));

// Chave PIX conforme o tipo (CPF/CNPJ com dígito verificador, celular com DDD, e-mail com @, aleatória UUID)
const soDig = (v: string) => String(v || "").replace(/\D/g, "");
function cpfValido(d: string) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
function cnpjValido(d: string) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n: number) => { const p = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * p[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
function normalizarPix(tipo: string, chave: string) {
  if (["CPF", "CNPJ", "Celular"].includes(tipo)) return soDig(chave);
  return String(chave || "").trim().toLowerCase();
}
function validarPix(tipo: string, chave: string): string | null {
  const k = normalizarPix(tipo, chave);
  switch (tipo) {
    case "CPF": return cpfValido(k) ? null : "Chave PIX CPF inválida: informe os 11 números do CPF";
    case "CNPJ": return cnpjValido(k) ? null : "Chave PIX CNPJ inválida: informe os 14 números do CNPJ";
    case "Celular": return /^\d{2}9\d{8}$/.test(k) ? null : "Chave PIX celular inválida: DDD + número, 11 números";
    case "E-mail": return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(k) ? null : "Chave PIX e-mail inválida: precisa ter @";
    case "Aleatória": return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(k) ? null : "Chave PIX aleatória inválida";
    default: return "Escolha o tipo de chave PIX";
  }
}

let ensured: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await db.execute(sql`CREATE SEQUENCE IF NOT EXISTS reembolsos_numero_seq START 1`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS reembolsos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        numero integer NOT NULL UNIQUE DEFAULT nextval('reembolsos_numero_seq'),
        solicitante_id varchar NOT NULL, solicitante_nome varchar,
        descricao text NOT NULL, data_despesa date NOT NULL, valor numeric NOT NULL,
        vencimento date NOT NULL, forma varchar NOT NULL, instancia varchar, chart_account_id varchar,
        favorecido_nome varchar NOT NULL, favorecido_doc varchar,
        pix_tipo varchar, pix_chave varchar, banco varchar, agencia varchar, conta varchar, tipo_conta varchar,
        obs text, status varchar NOT NULL DEFAULT 'aguardando',
        aprovador_id varchar, aprovador_nome varchar, aprovado_em timestamp, valor_aprovado numeric, motivo_recusa text,
        payable_id varchar, lancado_por varchar, lancado_nome varchar, lancado_em timestamp, pago_em timestamp,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`ALTER TABLE reembolsos ADD COLUMN IF NOT EXISTS autoaprovado boolean NOT NULL DEFAULT false`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS reembolso_itens (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        reembolso_id varchar NOT NULL, descricao varchar NOT NULL, data date, valor numeric NOT NULL DEFAULT 0, ordem integer NOT NULL DEFAULT 0
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS reembolso_anexos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        reembolso_id varchar NOT NULL, nome varchar NOT NULL, mime varchar, tamanho integer, dados bytea NOT NULL,
        autor_id varchar, created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE TABLE IF NOT EXISTS reembolso_eventos (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
        reembolso_id varchar NOT NULL, autor_nome varchar, texto text NOT NULL, created_at timestamp NOT NULL DEFAULT now()
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_reemb_itens ON reembolso_itens (reembolso_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_reemb_anx ON reembolso_anexos (reembolso_id)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_reemb_evt ON reembolso_eventos (reembolso_id, created_at)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

async function evento(id: string, autor: string, texto: string) {
  await db.execute(sql`INSERT INTO reembolso_eventos (reembolso_id, autor_nome, texto) VALUES (${id}, ${autor}, ${texto})`);
}
async function chamado(destinos: string[], assunto: string, descricao: string, autor: any) {
  try {
    const { abrirChamadoSistema } = await import("./chamados-routes");
    await abrirChamadoSistema({ destinoKeys: destinos, assunto, descricao, autor: autor ? { id: String(autor.id), nome: nomeDe(autor), role: String(autor.role || "") } : null });
  } catch (e: any) { console.warn("[reembolsos] chamado falhou:", e?.message || e); }
}
async function carregar(id: string) {
  return rows(await db.execute(sql`SELECT * FROM reembolsos WHERE id = ${id}`))[0] || null;
}
async function nomeCategoria(id: any): Promise<string> {
  if (!id) return "—";
  const c = rows(await db.execute(sql`SELECT code, name FROM chart_of_accounts WHERE id = ${String(id)}`))[0];
  return c ? `${c.code} ${c.name}` : String(id);
}
async function mudancas(r: any, cat: any, venc: string, inst: any): Promise<string> {
  const m: string[] = [];
  if (String(cat || "") !== String(r.chart_account_id || "")) m.push(r.chart_account_id ? `categoria: ${await nomeCategoria(r.chart_account_id)} → ${await nomeCategoria(cat)}` : `categoria definida: ${await nomeCategoria(cat)}`);
  if (venc !== dia(r.vencimento)) m.push(`vencimento: ${fmtData(dia(r.vencimento))} → ${fmtData(venc)}`);
  if (String(inst || "") !== String(r.instancia || "")) m.push(`empresa: ${r.instancia || "—"} → ${inst || "—"}`);
  return m.length ? ` ${m.join("; ")}.` : "";
}
const podeVer = (u: any, r: any) => ehAprovador(u) || ehFinanceiro(u) || String(r.solicitante_id) === String(u.id);

// Conta a pagar baixada => reembolso pago (sincroniza na leitura)
async function sincronizarPagos(ids?: string[]) {
  try {
    await db.execute(sql`UPDATE reembolsos r SET status = 'pago', pago_em = COALESCE(r.pago_em, now()), updated_at = now()
      FROM payables p WHERE p.id = r.payable_id AND r.status = 'lancado' AND p.status = 'paga' AND p.deleted_at IS NULL
      ${ids && ids.length ? sql`AND r.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql``}`);
  } catch (e: any) { console.warn("[reembolsos] sync pagos:", e?.message || e); }
}

function saida(r: any) {
  return {
    id: r.id, numero: r.numero, codigo: codigo(r.numero),
    solicitanteId: r.solicitante_id, solicitanteNome: r.solicitante_nome,
    descricao: r.descricao, dataDespesa: dia(r.data_despesa), valor: num(r.valor),
    vencimento: dia(r.vencimento), forma: r.forma, instancia: r.instancia, chartAccountId: r.chart_account_id,
    favorecidoNome: r.favorecido_nome, favorecidoDoc: r.favorecido_doc || "",
    pixTipo: r.pix_tipo || "", pixChave: r.pix_chave || "", banco: r.banco || "", agencia: r.agencia || "", conta: r.conta || "", tipoConta: r.tipo_conta || "",
    obs: r.obs || "", status: r.status,
    aprovadorNome: r.aprovador_nome, autoaprovado: !!r.autoaprovado, aprovadoEm: r.aprovado_em, valorAprovado: r.valor_aprovado == null ? null : num(r.valor_aprovado), motivoRecusa: r.motivo_recusa,
    payableId: r.payable_id, lancadoNome: r.lancado_nome, lancadoEm: r.lancado_em, pagoEm: r.pago_em, createdAt: r.created_at,
  };
}

function dadosPagamento(r: any): string {
  if (r.forma === "pix") return `PIX ${r.pix_tipo ? `(${r.pix_tipo}) ` : ""}${r.pix_chave || ""}`.trim();
  if (r.forma === "transferencia") return `Transferência: ${r.banco || "?"} · ag ${r.agencia || "?"} · ${r.tipo_conta || "conta"} ${r.conta || "?"}`;
  return "Dinheiro (Caixinha)";
}

const MAX_MB = 15;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 10 } }).array("arquivos", 10);
function comArquivos(req: any, res: Response, next: any) {
  upload(req, res, (err: any) => {
    if (!err) return next();
    res.status(400).json({ message: err?.code === "LIMIT_FILE_SIZE" ? `Arquivo maior que ${MAX_MB} MB` : err?.code === "LIMIT_FILE_COUNT" ? "Máximo de 10 arquivos" : (err?.message || "Falha no upload") });
  });
}
const nomeArq = (f: any) => { try { return Buffer.from(String(f.originalname || "arquivo"), "latin1").toString("utf8"); } catch { return String(f.originalname || "arquivo"); } };
const arquivos = (req: any): any[] => (Array.isArray(req.files) ? req.files : []);

export function registerReembolsos(app: Express) {
  const guard = async (req: Request, res: Response) => {
    const u: any = (req as any).currentUser || (req as any).user;
    if (!u?.id) { res.status(401).json({ message: "Unauthorized" }); return null; }
    try { await ensure(); } catch (e: any) { res.status(500).json({ message: "Reembolsos indisponível: " + (e?.message || e) }); return null; }
    return u;
  };

  // Perfil + listas de apoio (categorias DRE de despesa, instâncias)
  app.get("/api/reembolsos/config", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    let categorias: any[] = [];
    try {
      categorias = rows(await db.execute(sql`SELECT id, code, name FROM chart_of_accounts
        WHERE is_active = true AND type = 'despesa' AND code LIKE '%.%' ORDER BY code`)).map((c) => ({ id: String(c.id), code: c.code, name: c.name }));
      if (!categorias.length) categorias = rows(await db.execute(sql`SELECT id, code, name FROM chart_of_accounts
        WHERE is_active = true AND code LIKE '%.%' ORDER BY code`)).map((c) => ({ id: String(c.id), code: c.code, name: c.name }));
    } catch {}
    const eu = rows(await db.execute(sql`SELECT * FROM users WHERE id = ${String(u.id)}`))[0] || {};
    res.json({
      me: { id: String(u.id), nome: nomeDe(u), cpf: eu.cpf || eu.document || "" },
      aprovador: ehAprovador(u), financeiro: ehFinanceiro(u),
      categorias, instancias: INSTANCIAS,
    });
  });

  app.get("/api/reembolsos", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    await sincronizarPagos();
    const todos = ehAprovador(u) || ehFinanceiro(u);
    const r = rows(await db.execute(todos
      ? sql`SELECT * FROM reembolsos ORDER BY numero DESC LIMIT 500`
      : sql`SELECT * FROM reembolsos WHERE solicitante_id = ${String(u.id)} ORDER BY numero DESC LIMIT 500`));
    res.json(r.map(saida));
  });

  app.get("/api/reembolsos/:id", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    await sincronizarPagos([req.params.id]);
    const r = await carregar(req.params.id);
    if (!r || !podeVer(u, r)) return res.status(404).json({ message: "Reembolso não encontrado" });
    const itens = rows(await db.execute(sql`SELECT id, descricao, data, valor FROM reembolso_itens WHERE reembolso_id = ${r.id} ORDER BY ordem`));
    const anx = rows(await db.execute(sql`SELECT id, nome, mime, tamanho FROM reembolso_anexos WHERE reembolso_id = ${r.id} ORDER BY created_at`));
    const evt = rows(await db.execute(sql`SELECT autor_nome, texto, created_at FROM reembolso_eventos WHERE reembolso_id = ${r.id} ORDER BY created_at`));
    let payable: any = null;
    if (r.payable_id) {
      payable = rows(await db.execute(sql`SELECT id, title_number, status::text AS status, amount, due_date FROM payables WHERE id = ${r.payable_id}`))[0] || null;
    }
    let categoria: any = null;
    if (r.chart_account_id) categoria = rows(await db.execute(sql`SELECT code, name FROM chart_of_accounts WHERE id = ${r.chart_account_id}`))[0] || null;
    res.json({
      ...saida(r),
      categoriaNome: categoria ? `${categoria.code} ${categoria.name}` : null,
      itens: itens.map((i) => ({ id: i.id, descricao: i.descricao, data: dia(i.data), valor: num(i.valor) })),
      anexos: anx.map((a) => ({ id: a.id, nome: a.nome, mime: a.mime, tamanho: a.tamanho })),
      eventos: evt.map((e) => ({ autor: e.autor_nome, texto: e.texto, em: e.created_at })),
      payable: payable ? { id: payable.id, titulo: payable.title_number, status: payable.status, valor: num(payable.amount), vencimento: dia(payable.due_date) } : null,
    });
  });

  // Solicitação: multipart com "dados" (JSON) + "arquivos" (comprovantes, obrigatório)
  app.post("/api/reembolsos", authenticateUser, comArquivos, async (req: any, res) => {
    const u = await guard(req, res); if (!u) return;
    try {
      let b: any = {};
      try { b = typeof req.body?.dados === "string" ? JSON.parse(req.body.dados) : (req.body || {}); } catch { return res.status(400).json({ message: "Dados inválidos" }); }
      const files = arquivos(req);
      const itens = (Array.isArray(b.itens) ? b.itens : [])
        .map((i: any) => ({ descricao: String(i?.descricao || "").trim().slice(0, 200), data: String(i?.data || "").slice(0, 10), valor: r2(num(i?.valor)) }))
        .filter((i: any) => i.descricao || i.valor);
      if (!itens.length) return res.status(400).json({ message: "Informe o que foi comprado e o valor" });
      if (itens.some((i: any) => !i.descricao || !(i.valor > 0))) return res.status(400).json({ message: "Cada item precisa de descrição e valor maior que zero" });
      if (!files.length) return res.status(400).json({ message: "Anexe pelo menos um comprovante (foto da nota/cupom ou PDF)" });
      const total = r2(itens.reduce((a: number, i: any) => a + i.valor, 0));
      const datas = itens.map((i: any) => i.data).filter(ehDia).sort();
      const dataDespesa = ehDia(String(b.dataDespesa || "")) ? String(b.dataDespesa) : (datas[0] || new Date().toISOString().slice(0, 10));
      const vencimento = String(b.vencimento || "").slice(0, 10);
      if (!ehDia(vencimento)) return res.status(400).json({ message: "Informe a data para pagamento (vencimento)" });
      const forma = String(b.forma || "");
      if (!FORMAS.includes(forma)) return res.status(400).json({ message: "Escolha como quer receber: PIX, Transferência ou Dinheiro" });
      const instancia = String(b.instancia || "");
      if (!INSTANCIAS.includes(instancia)) return res.status(400).json({ message: "Escolha a empresa (instância)" });
      // Categoria DRE: definida pelo Financeiro no lançamento (o solicitante não escolhe)
      const chartAccountId = ehFinanceiro(u) && b.chartAccountId ? String(b.chartAccountId) : "";
      const favNome = String(b.favorecidoNome || nomeDe(u)).trim().slice(0, 200);
      const favDoc = String(b.favorecidoDoc || "").replace(/[^\d./-]/g, "").slice(0, 20);
      if (!favNome) return res.status(400).json({ message: "Informe o nome do favorecido" });
      const pixTipo = String(b.pixTipo || "").slice(0, 20), pixChave = String(b.pixChave || "").trim().slice(0, 120);
      const banco = String(b.banco || "").trim().slice(0, 80), agencia = String(b.agencia || "").trim().slice(0, 20), conta = String(b.conta || "").trim().slice(0, 30), tipoConta = String(b.tipoConta || "").slice(0, 20);
      if (forma === "pix" && !pixChave) return res.status(400).json({ message: "Informe a chave PIX" });
      if (forma === "pix") { const erroPix = validarPix(pixTipo, pixChave); if (erroPix) return res.status(400).json({ message: erroPix }); }
      if (forma === "transferencia" && (!banco || !agencia || !conta)) return res.status(400).json({ message: "Informe banco, agência e conta" });
      const descricao = String(b.descricao || "").trim().slice(0, 500) || itens.map((i: any) => i.descricao).join(", ").slice(0, 500);

      const ins = rows(await db.execute(sql`INSERT INTO reembolsos (solicitante_id, solicitante_nome, descricao, data_despesa, valor, vencimento, forma, instancia, chart_account_id,
          favorecido_nome, favorecido_doc, pix_tipo, pix_chave, banco, agencia, conta, tipo_conta, obs)
        VALUES (${String(u.id)}, ${nomeDe(u)}, ${descricao}, ${dataDespesa}::date, ${total}, ${vencimento}::date, ${forma}, ${instancia}, ${chartAccountId || null},
          ${favNome}, ${favDoc || null}, ${pixTipo || null}, ${pixChave ? normalizarPix(pixTipo, pixChave) : null}, ${banco || null}, ${agencia || null}, ${conta || null}, ${tipoConta || null}, ${String(b.obs || "").slice(0, 2000) || null})
        RETURNING *`))[0];
      let ordem = 0;
      for (const i of itens) {
        await db.execute(sql`INSERT INTO reembolso_itens (reembolso_id, descricao, data, valor, ordem)
          VALUES (${ins.id}, ${i.descricao}, ${ehDia(i.data) ? i.data : null}::date, ${i.valor}, ${ordem++})`);
      }
      for (const f of files) {
        await db.execute(sql`INSERT INTO reembolso_anexos (reembolso_id, nome, mime, tamanho, dados, autor_id)
          VALUES (${ins.id}, ${nomeArq(f).slice(0, 200)}, ${String(f.mimetype || "")}, ${Number(f.size || 0)}, ${f.buffer}, ${String(u.id)})`);
      }
      const cod = codigo(ins.numero);
      await evento(ins.id, nomeDe(u), `Solicitação enviada: ${fmtBRL(total)} (${itens.length} item(ns), ${files.length} comprovante(s)). Receber por ${dadosPagamento(ins)} até ${fmtData(vencimento)}.`);
      await chamado(["flavio", "elbber", "cinthia"], `Reembolso ${cod} — aprovar ${fmtBRL(total)}`,
        `${nomeDe(u)} pediu reembolso de ${fmtBRL(total)}:\n${itens.map((i: any) => `• ${i.descricao} — ${fmtBRL(i.valor)}`).join("\n")}\nReceber por: ${dadosPagamento(ins)} · até ${fmtData(vencimento)}\n\nAprove ou recuse em: ${APP_URL}/reembolsos?id=${ins.id}`, u);
      res.json(saida(ins));
    } catch (e: any) { console.error("[reembolsos] criar", e); res.status(500).json({ message: e?.message || "Erro ao solicitar" }); }
  });

  // Aprovação: qualquer Admin, menos o próprio solicitante. Pode ajustar valor, categoria, vencimento e instância.
  app.post("/api/reembolsos/:id/aprovar", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!ehAprovador(u)) return res.status(403).json({ message: "Só Admin aprova reembolso" });
    const r = await carregar(req.params.id);
    if (!r || r.status !== "aguardando") return res.status(400).json({ message: "Reembolso não está aguardando aprovação" });
    const auto = String(r.solicitante_id) === String(u.id);
    const b = req.body || {};
    const valor = b.valorAprovado != null && num(b.valorAprovado) > 0 ? r2(num(b.valorAprovado)) : num(r.valor);
    const venc = ehDia(String(b.vencimento || "")) ? String(b.vencimento) : dia(r.vencimento);
    const inst = INSTANCIAS.includes(String(b.instancia || "")) ? String(b.instancia) : r.instancia;
    const cat = r.chart_account_id; // categoria é do Financeiro (definida no lançamento)
    const alt = await mudancas(r, cat, venc, inst);
    await db.execute(sql`UPDATE reembolsos SET status = 'aprovado', valor_aprovado = ${valor}, vencimento = ${venc}::date, instancia = ${inst}, chart_account_id = ${cat},
      aprovador_id = ${String(u.id)}, aprovador_nome = ${nomeDe(u)}, aprovado_em = now(), autoaprovado = ${auto}, updated_at = now() WHERE id = ${r.id}`);
    const cod = codigo(r.numero);
    await evento(r.id, nomeDe(u), `${auto ? "⚠ AUTOAPROVADO (o próprio solicitante aprovou) — " : ""}Aprovado ${fmtBRL(valor)}${valor !== num(r.valor) ? ` (pedido: ${fmtBRL(num(r.valor))})` : ""}. Enviado ao Financeiro para lançar no Contas a Pagar.${alt}`);
    if (auto) {
      try {
        const { logFinancialAudit } = await import("./financial-audit");
        await logFinancialAudit({ req, action: "update" as any, entity: "reembolso", entityId: r.id, amount: valor, note: `AUTOAPROVAÇÃO: ${cod} aprovado pelo próprio solicitante (${nomeDe(u)})` });
      } catch {}
    }
    await chamado(["lanucy"], `Reembolso ${cod} — lançar no Contas a Pagar`,
      `${auto ? "⚠ Autoaprovado (o próprio solicitante aprovou). " : ""}Aprovado por ${nomeDe(u)}: reembolsar ${fmtBRL(valor)} a ${r.favorecido_nome} até ${fmtData(venc)}.\n${dadosPagamento(r)}\nComprovantes no pedido.\n\nLance com 1 clique em: ${APP_URL}/reembolsos?id=${r.id}`, u);
    res.json(saida(await carregar(r.id)));
  });

  app.post("/api/reembolsos/:id/recusar", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!ehAprovador(u)) return res.status(403).json({ message: "Só Admin recusa reembolso" });
    const r = await carregar(req.params.id);
    if (!r || r.status !== "aguardando") return res.status(400).json({ message: "Reembolso não está aguardando aprovação" });
    const motivo = String(req.body?.motivo || "").trim().slice(0, 1000);
    if (motivo.length < 3) return res.status(400).json({ message: "Escreva o motivo da recusa" });
    await db.execute(sql`UPDATE reembolsos SET status = 'recusado', motivo_recusa = ${motivo || null}, aprovador_id = ${String(u.id)}, aprovador_nome = ${nomeDe(u)}, aprovado_em = now(), updated_at = now() WHERE id = ${r.id}`);
    await evento(r.id, nomeDe(u), `Recusado${motivo ? ": " + motivo : "."}`);
    res.json(saida(await carregar(r.id)));
  });

  app.post("/api/reembolsos/:id/cancelar", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const r = await carregar(req.params.id);
    if (!r || String(r.solicitante_id) !== String(u.id)) return res.status(403).json({ message: "Só quem pediu pode cancelar" });
    if (r.status !== "aguardando") return res.status(400).json({ message: "Só dá para cancelar enquanto aguarda aprovação" });
    await db.execute(sql`UPDATE reembolsos SET status = 'cancelado', updated_at = now() WHERE id = ${r.id}`);
    await evento(r.id, nomeDe(u), "Cancelado pelo solicitante.");
    res.json(saida(await carregar(r.id)));
  });

  // 1 CLIQUE: cria a Conta a Pagar com os dados do reembolso + comprovantes anexados
  app.post("/api/reembolsos/:id/lancar", authenticateUser, async (req: any, res) => {
    const u = await guard(req, res); if (!u) return;
    if (!ehFinanceiro(u)) return res.status(403).json({ message: "Só o Financeiro lança no Contas a Pagar" });
    const r = await carregar(req.params.id);
    if (!r || r.status !== "aprovado") return res.status(400).json({ message: "Reembolso não está aprovado" });
    if (r.payable_id) return res.status(400).json({ message: "Este reembolso já foi lançado" });
    const b = req.body || {};
    const venc = ehDia(String(b.vencimento || "")) ? String(b.vencimento) : dia(r.vencimento);
    const inst = INSTANCIAS.includes(String(b.instancia || "")) ? String(b.instancia) : r.instancia;
    const cat = b.chartAccountId ? String(b.chartAccountId) : r.chart_account_id;
    if (!cat) return res.status(400).json({ message: "Escolha a categoria DRE (obrigatória para lançar no Contas a Pagar)" });
    const valor = num(r.valor_aprovado ?? r.valor);
    const cod = codigo(r.numero);
    const alt = await mudancas(r, cat, venc, inst);
    try {
      const { storage } = await import("./storage");
      const itens = rows(await db.execute(sql`SELECT descricao, valor FROM reembolso_itens WHERE reembolso_id = ${r.id} ORDER BY ordem`));
      const pagamento = dadosPagamento(r);
      const payable: any = await storage.createPayable({
        titleNumber: cod,
        supplierName: r.favorecido_nome,
        supplierDocument: r.favorecido_doc || null,
        description: `Reembolso ${cod} — ${r.descricao}`.slice(0, 1000),
        issueDate: dataCalendario(dia(r.data_despesa)),
        dueDate: dataCalendario(venc),
        amount: valor.toFixed(2),
        originalAmount: valor.toFixed(2),
        paymentMethod: r.forma,
        chartAccountId: cat,
        omieInstanceId: inst || null,
        source: "manual",
        externalId: `reembolso:${r.id}`,
        notes: `Reembolso ${cod} pedido por ${r.solicitante_nome}, aprovado por ${r.aprovador_nome || "-"}${r.autoaprovado ? " (AUTOAPROVADO pelo próprio solicitante)" : ""}.\nPagar por: ${pagamento}${r.favorecido_doc ? `\nCPF/CNPJ: ${r.favorecido_doc}` : ""}\nItens: ${itens.map((i) => `${i.descricao} ${fmtBRL(num(i.valor))}`).join("; ")}\nOrigem: ${APP_URL}/reembolsos?id=${r.id}`,
        createdBy: u.email || null,
      } as any);
      // comprovantes -> anexos da conta a pagar (mesmo armazenamento base64 do módulo financeiro)
      const anx = rows(await db.execute(sql`SELECT nome, mime, tamanho, dados FROM reembolso_anexos WHERE reembolso_id = ${r.id} ORDER BY created_at`));
      for (const a of anx) {
        const b64 = Buffer.from(a.dados).toString("base64");
        await db.execute(sql`INSERT INTO payable_attachments (id, payable_id, kind, file_name, mime_type, size_bytes, content_base64, created_by, created_at)
          VALUES (gen_random_uuid(), ${payable.id}, 'outro', ${String(a.nome)}, ${a.mime || null}, ${Number(a.tamanho || 0)}, ${b64}, ${u.email || null}, now())`);
      }
      try {
        const { logFinancialAudit } = await import("./financial-audit");
        await logFinancialAudit({ req, action: "create" as any, entity: "payable", entityId: payable.id, after: payable, amount: valor, note: `reembolso ${cod}` });
      } catch {}
      await db.execute(sql`UPDATE reembolsos SET status = 'lancado', payable_id = ${payable.id}, vencimento = ${venc}::date, instancia = ${inst}, chart_account_id = ${cat},
        lancado_por = ${String(u.id)}, lancado_nome = ${nomeDe(u)}, lancado_em = now(), updated_at = now() WHERE id = ${r.id}`);
      await evento(r.id, nomeDe(u), `Lançado no Contas a Pagar (título ${cod}, venc. ${fmtData(venc)}, ${fmtBRL(valor)}) com ${anx.length} comprovante(s) anexado(s).${alt}`);
      res.json({ ...saida(await carregar(r.id)), payableId: payable.id });
    } catch (e: any) {
      console.error("[reembolsos] lancar", e);
      res.status(500).json({ message: "Não foi possível lançar: " + (e?.message || e) });
    }
  });

  app.get("/api/reembolsos/anexos/:aid", authenticateUser, async (req, res) => {
    const u = await guard(req, res); if (!u) return;
    const a = rows(await db.execute(sql`SELECT * FROM reembolso_anexos WHERE id = ${req.params.aid}`))[0];
    const r = a ? await carregar(a.reembolso_id) : null;
    if (!a || !r || !podeVer(u, r)) return res.status(404).send("Não encontrado");
    res.setHeader("Content-Type", a.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(a.nome)}"`);
    res.send(a.dados);
  });
}
