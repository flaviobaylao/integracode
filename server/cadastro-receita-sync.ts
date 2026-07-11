import type { Express } from "express";
import { authenticateUser, requireRole } from "./authMiddleware";
import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";

// ─── Atualização de cadastro dos CLIENTES ATIVOS via dados oficiais ──────────
// Busca os dados de registro do CNPJ (Receita Federal / SEFAZ estaduais via
// provedores públicos) e atualiza o cadastro dos clientes ativos que tenham
// DADOS FALTANTES (UF, cidade, CEP, endereço, bairro ou razão social vazios).
// NUNCA altera dados de CONTATO (telefone, contato, e-mail) nem vendedor/rota.
// Roda em BACKGROUND (fire-and-forget) com throttle p/ respeitar limites das
// APIs públicas; o frontend acompanha por polling em /status (barra de
// progresso na tela Clientes Ativos).
// Provedores (fallback em cadeia): minhareceita.org → BrasilAPI → ReceitaWS.

type SyncErr = { name: string; cnpj: string; error: string };
type SyncState = {
  status: "idle" | "running" | "done" | "cancelled" | "error";
  total: number;
  done: number;
  updated: number;
  skipped: number;
  failed: number;
  current: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  startedBy: string | null;
  lastErrors: SyncErr[];
};

const state: SyncState = {
  status: "idle", total: 0, done: 0, updated: 0, skipped: 0, failed: 0,
  current: null, startedAt: null, finishedAt: null, startedBy: null, lastErrors: [],
};
let cancelRequested = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const onlyDigits = (s: any) => String(s || "").replace(/\D/g, "");
const formatCep = (d: string) => (d && d.length === 8 ? d.slice(0, 5) + "-" + d.slice(5) : d);

// Consulta o CNPJ nos provedores públicos de dados oficiais, em cadeia.
async function fetchOfficialCnpj(cnpj: string): Promise<{ ok: boolean; data?: any; provider?: string; error?: string }> {
  // 1) minhareceita.org (dados abertos da Receita Federal; sem limite rígido)
  try {
    const r = await fetch(`https://minhareceita.org/${cnpj}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j: any = await r.json();
      if (j && (j.razao_social || j.uf)) {
        return {
          ok: true, provider: "minhareceita",
          data: {
            razaoSocial: j.razao_social, fantasia: j.nome_fantasia,
            logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" "),
            numero: j.numero, complemento: j.complemento, bairro: j.bairro,
            municipio: j.municipio, uf: j.uf, cep: onlyDigits(j.cep),
          },
        };
      }
    }
  } catch { /* tenta o próximo provedor */ }
  // 2) BrasilAPI
  try {
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const j: any = await r.json();
      if (j && (j.razao_social || j.uf)) {
        return {
          ok: true, provider: "brasilapi",
          data: {
            razaoSocial: j.razao_social, fantasia: j.nome_fantasia,
            logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" "),
            numero: j.numero, complemento: j.complemento, bairro: j.bairro,
            municipio: j.municipio, uf: j.uf, cep: onlyDigits(j.cep),
          },
        };
      }
    } else if (r.status === 429) {
      await sleep(10000);
    }
  } catch { /* tenta o próximo provedor */ }
  // 3) ReceitaWS (último recurso; limite 3 req/min no plano público)
  try {
    const r = await fetch(`https://receitaws.com.br/v1/cnpj/${cnpj}`, { signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const j: any = await r.json();
      if (j && j.status !== "ERROR" && (j.nome || j.uf)) {
        return {
          ok: true, provider: "receitaws",
          data: {
            razaoSocial: j.nome, fantasia: j.fantasia, logradouro: j.logradouro,
            numero: j.numero, complemento: j.complemento, bairro: j.bairro,
            municipio: j.municipio, uf: j.uf, cep: onlyDigits(j.cep),
          },
        };
      }
    }
  } catch { /* sem mais provedores */ }
  return { ok: false, error: "CNPJ nao encontrado nos provedores publicos (minhareceita/BrasilAPI/ReceitaWS)" };
}

// Consulta a INSCRIÇÃO ESTADUAL na base pública CNPJ.ws — a MESMA verificação
// gratuita usada pelo Integra 1.0 ("Atualização de Inscrição Estadual
// (CNPJ.ws)"). Limite do plano público: 3 consultas/min → em 429 espera 21s e
// tenta 1x de novo. Retorna a IE ATIVA da UF do estabelecimento.
async function fetchIeCnpjWs(cnpj: string): Promise<{ ok: boolean; ie?: string | null; uf?: string; error?: string }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`https://publica.cnpj.ws/cnpj/${cnpj}`, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429) {
        if (attempt === 1) { await sleep(21000); continue; }
        return { ok: false, error: "limite de consultas da CNPJ.ws (429)" };
      }
      if (r.status === 404) return { ok: true, ie: null };
      if (!r.ok) return { ok: false, error: `CNPJ.ws HTTP ${r.status}` };
      const j: any = await r.json();
      const est = j?.estabelecimento || {};
      const ufEst = est?.estado?.sigla || "";
      const list: any[] = Array.isArray(est?.inscricoes_estaduais) ? est.inscricoes_estaduais : [];
      const ativas = list.filter((x) => x && x.ativo && x.inscricao_estadual);
      const daUf = ativas.find((x) => (x?.estado?.sigla || "") === ufEst) || ativas[0];
      return { ok: true, ie: daUf ? String(daUf.inscricao_estadual).replace(/\D/g, "") : null, uf: ufEst };
    } catch (e: any) {
      if (attempt === 2) return { ok: false, error: e?.message || "falha na CNPJ.ws" };
      await sleep(2000);
    }
  }
  return { ok: false, error: "falha na CNPJ.ws" };
}

async function persistSnapshot() {
  try {
    await storage.upsertSystemSetting({
      key: "cadastro_receita_sync_last",
      value: JSON.stringify(state),
      updatedBy: state.startedBy || "cadastro-sync",
    });
  } catch { /* snapshot é cosmético */ }
}

async function runSync(startedBy: string | null) {
  cancelRequested = false;
  state.status = "running";
  state.total = 0; state.done = 0; state.updated = 0; state.skipped = 0; state.failed = 0;
  state.current = null; state.lastErrors = [];
  state.startedAt = new Date().toISOString(); state.finishedAt = null; state.startedBy = startedBy;
  try {
    // Clientes ATIVOS (active_customers.is_active) com CNPJ válido e ao menos
    // um dado de cadastro FALTANTE. Clientes PF (CPF) não têm consulta pública.
    const q: any = await db.execute(sql`
      SELECT c.id, c.name, c.cnpj, c.state, c.city, c.zip_code, c.address, c.neighborhood, c.company_name, c.state_registration
      FROM customers c
      WHERE c.id IN (SELECT customer_id FROM active_customers WHERE is_active = true AND customer_id IS NOT NULL)
        AND length(regexp_replace(coalesce(c.cnpj, ''), '[^0-9]', '', 'g')) = 14
        AND (
          coalesce(c.state, '') = '' OR coalesce(c.city, '') = '' OR coalesce(c.zip_code, '') = ''
          OR btrim(coalesce(c.address, '')) IN ('', ',', '-', 'N/I', 'S/N') OR coalesce(c.neighborhood, '') = ''
          OR coalesce(c.company_name, '') = ''
          OR btrim(coalesce(c.state_registration, '')) = ''
        )
      ORDER BY c.name
    `);
    const rows: any[] = q?.rows ?? q ?? [];
    state.total = rows.length;
    console.log(`[CADASTRO-SYNC] ${rows.length} clientes ativos com dados faltantes (iniciado por ${startedBy || "n/d"})`);
    for (const row of rows) {
      if (cancelRequested) { state.status = "cancelled"; break; }
      state.current = row.name;
      const cnpj = onlyDigits(row.cnpj);
      const needsCadastro = !row.state || !row.city || !row.zip_code || !row.neighborhood || !row.company_name
        || ["", ",", "-", "N/I", "S/N"].includes(String(row.address || "").trim());
      const needsIe = !String(row.state_registration || "").trim();
      const upd: Record<string, any> = {};
      let anyFail = false;
      let ieConsultada = false;
      if (needsCadastro) {
        const r = await fetchOfficialCnpj(cnpj);
        if (r.ok && r.data) {
          const d = r.data;
          if (d.razaoSocial) upd.companyName = String(d.razaoSocial).trim().slice(0, 120);
          if (d.fantasia) upd.fantasyName = String(d.fantasia).trim().slice(0, 120);
          const addr = ([d.logradouro, d.numero].filter(Boolean).join(", ") + (d.complemento ? ` ${d.complemento}` : "")).trim();
          if (addr.length > 3) upd.address = addr.slice(0, 200);
          if (d.bairro) upd.neighborhood = String(d.bairro).trim().slice(0, 80);
          if (d.municipio) upd.city = String(d.municipio).trim().slice(0, 80);
          if (d.uf && /^[A-Za-z]{2}$/.test(String(d.uf).trim())) upd.state = String(d.uf).trim().toUpperCase();
          if (d.cep && d.cep.length === 8) upd.zipCode = formatCep(d.cep);
          // Dados de CONTATO (phone/contact/email) e vendedor/rota: INTOCADOS.
        } else {
          anyFail = true;
          if (state.lastErrors.length < 20) state.lastErrors.push({ name: row.name, cnpj, error: r.error || "falha" });
        }
      }
      // IE via CNPJ.ws quando faltante — mesma verificação gratuita do 1.0.
      // "ok && ie null" = CNPJ sem IE ativa (não contribuinte) → não grava nada.
      if (needsIe) {
        ieConsultada = true;
        const ieRes = await fetchIeCnpjWs(cnpj);
        if (ieRes.ok && ieRes.ie) {
          upd.stateRegistration = ieRes.ie;
        } else if (!ieRes.ok) {
          anyFail = true;
          if (state.lastErrors.length < 20) state.lastErrors.push({ name: row.name, cnpj, error: `IE: ${ieRes.error || "falha"}` });
        }
      }
      if (Object.keys(upd).length > 0) {
        await storage.updateCustomer(row.id, upd as any);
        state.updated++;
        console.log(`[CADASTRO-SYNC] ✅ ${row.name} (${cnpj}) atualizado: ${Object.keys(upd).join(", ")}`);
      } else if (anyFail) {
        state.failed++;
      } else {
        state.skipped++;
      }
      state.done++;
      if (state.done % 10 === 0) await persistSnapshot();
      // Throttle: CNPJ.ws é 3 req/min → 20s quando a IE foi consultada; senão 1,5s.
      await sleep(ieConsultada ? 20000 : 1500);
    }
    if (state.status === "running") state.status = "done";
  } catch (e: any) {
    console.error("[CADASTRO-SYNC] erro fatal:", e?.message);
    state.status = "error";
    if (state.lastErrors.length < 20) state.lastErrors.push({ name: "JOB", cnpj: "", error: e?.message || "erro" });
  }
  state.current = null;
  state.finishedAt = new Date().toISOString();
  await persistSnapshot();
  console.log(`[CADASTRO-SYNC] fim: ${state.status} — ${state.updated} atualizados, ${state.skipped} sem mudança, ${state.failed} falhas, de ${state.total}`);
}

export function registerCadastroReceitaSync(app: Express) {
  // AUTO-RETOMADA: se o servidor reiniciou no meio de uma execução (ex.:
  // deploy do Railway), o snapshot fica 'running' sem job vivo. 60s após o
  // boot, retoma automaticamente — o job re-consulta quem ainda tem dados
  // faltantes, então continua exatamente de onde parou (progresso é durável).
  setTimeout(async () => {
    try {
      if (state.status !== "idle") return;
      const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'cadastro_receita_sync_last'`);
      const v = (r?.rows ?? r ?? [])[0]?.value;
      if (v) {
        const snap = JSON.parse(String(v));
        if (snap?.status === "running") {
          console.log("[CADASTRO-SYNC] 🔁 retomando execução interrompida por restart do servidor");
          runSync(snap.startedBy || "auto-resume");
        }
      }
    } catch { /* sem retomada */ }
  }, 60000);

  // Consulta de IE por CNPJ (CNPJ.ws — a mesma verificação gratuita do 1.0).
  // Usada no cadastro de NOVOS clientes p/ preencher e exigir a IE.
  app.post("/api/sintegra/lookup", authenticateUser, async (req: any, res) => {
    const cnpj = String(req.body?.cnpj || "").replace(/\D/g, "");
    if (cnpj.length !== 14) return res.status(400).json({ success: false, message: "CNPJ deve ter 14 dígitos" });
    const r = await fetchIeCnpjWs(cnpj);
    if (!r.ok) return res.status(502).json({ success: false, message: r.error || "Falha na consulta" });
    res.json({ success: true, ie: r.ie || null, uf: r.uf || null, message: r.ie ? undefined : "CNPJ sem inscrição estadual ativa (não contribuinte / ISENTO)" });
  });

  // Inicia a atualização em background (fire-and-forget; 409 se já rodando)
  app.post("/api/admin/cadastro-receita-sync/start", authenticateUser, requireRole(["admin", "coordinator"]), async (req: any, res) => {
    if (state.status === "running") {
      return res.status(409).json({ message: "Atualização já em andamento", state });
    }
    runSync(req.currentUser?.email || null); // sem await — roda em background
    res.json({ started: true });
  });

  // Progresso (pollado pela barra na tela Clientes Ativos)
  app.get("/api/admin/cadastro-receita-sync/status", authenticateUser, async (_req, res) => {
    if (state.status === "idle") {
      try {
        const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'cadastro_receita_sync_last'`);
        const v = (r?.rows ?? r ?? [])[0]?.value;
        if (v) return res.json({ ...JSON.parse(String(v)), fromSnapshot: true });
      } catch { /* devolve o estado em memória */ }
    }
    res.json(state);
  });

  // Cancela o job em andamento (para no próximo cliente)
  app.post("/api/admin/cadastro-receita-sync/cancel", authenticateUser, requireRole(["admin", "coordinator"]), async (_req, res) => {
    cancelRequested = true;
    res.json({ cancelling: state.status === "running" });
  });
}
