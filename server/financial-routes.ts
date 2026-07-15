import { Express } from 'express';
import { storage } from './storage';
import { authenticateUser } from './authMiddleware';
import { nowBrazil } from './brazilTimezone';
import * as bbPixService from './bb-pix-service';
import { logFinancialAudit, actorOf } from './financial-audit';
import { webhookTokenGuard } from './webhook-security';
import { db } from './db';
import { sql } from 'drizzle-orm';

// FASE 2 - Flags para badges nas listas (DRE / Fluxo / Conciliada + origem da baixa).
// Consultas agregadas unicas (sem N+1): ids conciliados via extrato bancario e ids
// com baixa automatica do BB (webhook de boleto/PIX ou varredura de consulta).
async function badgeFlagsFor(kind: 'receivable' | 'payable'): Promise<{ ofx: Set<string>; autoBB: Set<string> }> {
  const ofx = new Set<string>(); const autoBB = new Set<string>();
  const col = kind === 'receivable' ? 'receivable_id' : 'payable_id';
  try {
    const m: any = await db.execute(sql.raw(`SELECT DISTINCT ${col} AS id FROM bank_statement_item_matches WHERE ${col} IS NOT NULL`));
    for (const r of (m.rows || [])) ofx.add(String(r.id));
  } catch {}
  if (kind === 'receivable') {
    try {
      const w: any = await db.execute(sql.raw(`SELECT DISTINCT receivable_id AS id FROM receivable_payments WHERE notes ILIKE 'Baixa automatica boleto BB%' OR notes ILIKE 'Pagamento PIX BB autom%'`));
      for (const r of (w.rows || [])) autoBB.add(String(r.id));
    } catch {}
  }
  return { ofx, autoBB };
}

function attachBadges(items: any[], flags: { ofx: Set<string>; autoBB: Set<string> }, paidStatus: string) {
  for (const it of items) {
    const amt = parseFloat(it.amount || '0');
    const paid = parseFloat(it.amountPaid || '0');
    const quitada = String(it.status) === paidStatus || (amt > 0 && paid >= amt - 0.005);
    // Conciliada = quitada COM vinculo bancario real (extrato OFX ou baixa automatica BB).
    // Baixado = quitada por baixa manual, SEM conciliacao no extrato bancario (nao confundir).
    const conciliadoBanco = quitada && (flags.autoBB.has(String(it.id)) || flags.ofx.has(String(it.id)));
    it.badges = {
      dre: !!it.chartAccountId,
      fluxo: !!it.financialAccountId,
      conciliada: conciliadoBanco,
      baixado: quitada && !conciliadoBanco,
      origem: quitada ? (flags.autoBB.has(String(it.id)) ? 'webhook' : (flags.ofx.has(String(it.id)) ? 'extrato' : 'manual')) : null,
    };
  }
}

function isFinancialAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
}

// Leitura financeira ampliada: além de admin/coord/administrativo, permite
// vendedor e telemarketing VISUALIZAREM (somente GET; escrita segue restrita).
function isFinancialReadAuthorized(req: any, res: any, next: any) {
  const user = req.currentUser || req.user;
  if (!user) return res.status(401).json({ message: 'Não autenticado' });
  const allowedRoles = ['admin', 'coordinator', 'administrative', 'vendedor', 'telemarketing'];
  if (!allowedRoles.includes(user.role)) {
    return res.status(403).json({ message: 'Acesso restrito ao módulo financeiro' });
  }
  next();
}

// Normaliza o body de contas (edição): datas string -> Date; valores "1.234,56" -> "1234.56"
function normalizeFinancialBody(body: any): any {
  const out: any = { ...body };
  const isoRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const dateFields = ['dueDate', 'issueDate', 'paidDate', 'paidAt', 'emissionDate', 'expectedSettlementDate'];
  for (const k of dateFields) {
    if (out[k] === '' || out[k] === null) { out[k] = null; }
    else if (typeof out[k] === 'string') { const d = new Date(out[k]); if (!isNaN(d.getTime())) out[k] = d; }
  }
  // genérico: qualquer string em formato ISO de data vira Date (cobre createdAt/updatedAt/etc. carregados no form de edição)
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && isoRe.test(out[k])) { const d = new Date(out[k]); if (!isNaN(d.getTime())) out[k] = d; }
  }
  const numFields = ['amount', 'amountPaid', 'interestTotal', 'discountTotal'];
  for (const k of numFields) {
    if (typeof out[k] === 'string' && out[k].includes(',')) out[k] = out[k].replace(/\./g, '').replace(',', '.');
  }
  // "" vindo do form (ex.: "Selecione") vira null — evita "invalid input value for enum" e FKs vazias
  const emptyToNullFields = ['paymentMethod', 'chartAccountId', 'financialAccountId', 'omieInstanceId'];
  for (const k of emptyToNullFields) {
    if (out[k] === '') out[k] = null;
  }
  // nunca sobrescrever PK / timestamps de auditoria a partir do payload do cliente
  delete out.id;
  delete out.createdAt;
  delete out.updatedAt;
  return out;
}

function addMonthsUTC(base: Date, n: number): Date {
  const r = new Date(base.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const dim = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, dim));
  return r;
}

function buildRecurrenceDates(base: Date, rec: any): Date[] {
  const interval = Math.max(1, parseInt(rec.interval) || 1);
  const MAX = 120;
  const step = (i: number): Date => {
    if (rec.freq === 'daily') { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + interval * i); return d; }
    if (rec.freq === 'weekly') { const d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + interval * 7 * i); return d; }
    if (rec.freq === 'monthly') return addMonthsUTC(base, interval * i);
    if (rec.freq === 'yearly') return addMonthsUTC(base, interval * 12 * i);
    return new Date(base.getTime());
  };
  const dates: Date[] = [];
  if (rec.endType === 'date' && rec.until) {
    const until = new Date(rec.until);
    for (let i = 0; i < MAX; i++) { const d = step(i); if (d.getTime() > until.getTime()) break; dates.push(d); }
  } else {
    const count = Math.min(MAX, Math.max(1, parseInt(rec.count) || 1));
    for (let i = 0; i < count; i++) dates.push(step(i));
  }
  if (dates.length === 0) dates.push(new Date(base.getTime()));
  return dates;
}

export function registerFinancialRoutes(app: Express) {

  // Garante o valor 'cartao' no enum de forma de pagamento (opcao unica "Cartao"
  // usada na baixa e na criacao de titulos, tanto a receber quanto a pagar). Sem
  // isso o front envia paymentMethod='cartao' e o Postgres rejeita (o enum so tinha
  // cartao_credito/cartao_debito) -> a baixa/criacao com cartao falhava com 500.
  // Aditivo e idempotente; roda uma vez no boot, antes de qualquer requisicao.
  db.execute(sql`ALTER TYPE financial_payment_method ADD VALUE IF NOT EXISTS 'cartao'`)
    .catch((e: any) => console.warn('[financial] ensure cartao payment method:', e?.message || e));

  // ============================================================================
  // CHART OF ACCOUNTS
  // ============================================================================

  // FASE 3.4l - coluna aditiva: include_in_dre (default true). Contas com valor
  // false ficam de fora da DRE, mas seguem classificaveis e entram no fluxo de caixa.
  let __incDreReady = false;
  async function ensureIncludeInDreColumn() {
    if (__incDreReady) return;
    try { await db.execute(sql`ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS include_in_dre boolean NOT NULL DEFAULT true`); } catch {}
    __incDreReady = true;
  }
  async function incDreMap(): Promise<Map<string, boolean>> {
    await ensureIncludeInDreColumn();
    const q: any = await db.execute(sql`SELECT id, include_in_dre FROM chart_of_accounts`);
    return new Map((((q as any).rows) || []).map((x: any) => [String(x.id), x.include_in_dre !== false]));
  }
  // Sanitiza o payload de gravacao do plano de contas: mantem SO as colunas reais e
  // editaveis. Sem isso, o front manda o objeto inteiro (form = {...item}) com id e
  // createdAt (string ISO); ao passar createdAt para db.update().set(), o drizzle tenta
  // value.toISOString() numa string e quebra ("value.toISOString is not a function"),
  // impedindo QUALQUER edicao. Tambem mapeia o campo antigo instanceId -> omieInstanceId.
  function sanitizeChartAccount(body: any): any {
    const src = (body || {}) as any;
    const out: any = {};
    for (const k of ['code', 'name', 'type', 'parentId', 'dreGroup', 'omieInstanceId', 'isActive']) {
      if (src[k] !== undefined) out[k] = src[k];
    }
    if (out.omieInstanceId === undefined && src.instanceId !== undefined) {
      out.omieInstanceId = src.instanceId || null;
    }
    return out;
  }

  app.get('/api/financial/chart-of-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getChartOfAccounts(instanceId);
      const fmap = await incDreMap();
      res.json(accounts.map((a: any) => ({ ...a, includeInDre: fmap.get(String(a.id)) !== false })));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getChartOfAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta não encontrada' });
      await ensureIncludeInDreColumn();
      const fq: any = await db.execute(sql`SELECT include_in_dre FROM chart_of_accounts WHERE id = ${req.params.id}`);
      const inc = ((((fq as any).rows) || [])[0]?.include_in_dre) !== false;
      res.json({ ...account, includeInDre: inc });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/chart-of-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await ensureIncludeInDreColumn();
      const { includeInDre } = (req.body || {}) as any;
      const rest = sanitizeChartAccount(req.body);
      const account: any = await storage.createChartOfAccount(rest);
      if (includeInDre === false) { try { await db.execute(sql`UPDATE chart_of_accounts SET include_in_dre = false WHERE id = ${account.id}`); } catch {} }
      res.status(201).json({ ...account, includeInDre: includeInDre !== false });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await ensureIncludeInDreColumn();
      const { includeInDre } = (req.body || {}) as any;
      const rest = sanitizeChartAccount(req.body);
      const account: any = Object.keys(rest).length
        ? await storage.updateChartOfAccount(req.params.id, rest)
        : await storage.getChartOfAccount(req.params.id);
      if (typeof includeInDre === 'boolean') { try { await db.execute(sql`UPDATE chart_of_accounts SET include_in_dre = ${includeInDre} WHERE id = ${req.params.id}`); } catch {} }
      const fq: any = await db.execute(sql`SELECT include_in_dre FROM chart_of_accounts WHERE id = ${req.params.id}`);
      const inc = ((((fq as any).rows) || [])[0]?.include_in_dre) !== false;
      res.json({ ...account, includeInDre: inc });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/chart-of-accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteChartOfAccount(req.params.id);
      res.json({ message: 'Conta removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/chart-of-accounts/seed', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const existing = await storage.getChartOfAccounts();
      if (existing.length > 0) {
        return res.status(400).json({ message: 'Plano de contas já possui registros. Limpe antes de popular novamente.' });
      }

      const dreAccounts = [
        { code: '1', name: 'Receita Bruta de Vendas', type: 'receita' as const, dreGroup: 'receita_bruta' },
        { code: '1.01', name: 'Devoluções/Descontos', type: 'receita' as const, dreGroup: 'devolucoes' },
        { code: '1.02', name: 'Impostos sobre Vendas (ICMS, PIS/COFINS, ISS)', type: 'receita' as const, dreGroup: 'impostos_vendas' },

        { code: '2', name: 'CPV', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.01', name: 'Matéria-prima (frutas/polpas)', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.02', name: 'Embalagens (garrafas/tampas/rótulos)', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.03', name: 'Energia e utilidades de produção', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.04', name: 'Mão de obra direta', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.05', name: 'Manutenção/limpeza fabril', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.06', name: 'Fretes de entrada', type: 'despesa' as const, dreGroup: 'cpv' },
        { code: '2.07', name: 'Análise produto', type: 'despesa' as const, dreGroup: 'cpv' },

        { code: '3', name: 'Despesas Comerciais', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.01', name: 'Comissões', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.02', name: 'Marketing', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.03', name: 'Salários logística', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.04', name: 'Locação veículo', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.05', name: 'Energia e utilidades de armazenamento', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.06', name: 'Manutenções (refrigeradores, veículos, máquinas)', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.07', name: 'Combustível, gelo, IPVA, manutenção', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },
        { code: '3.08', name: 'Representantes', type: 'despesa' as const, dreGroup: 'despesas_comerciais' },

        { code: '4', name: 'Despesas Administrativas', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.01', name: 'Salários ADM', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.02', name: 'Serviços contábeis', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.03', name: 'TI (ERP, internet)', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.04', name: 'Energia ADM', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.05', name: 'Água/esgoto', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.06', name: 'Aluguel', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.07', name: 'Limpeza', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.08', name: 'Telefone', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },
        { code: '4.09', name: 'Material escritório', type: 'despesa' as const, dreGroup: 'despesas_administrativas' },

        { code: '5', name: 'Despesas Gerais', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.01', name: 'Seguros', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.02', name: 'Taxas', type: 'despesa' as const, dreGroup: 'despesas_gerais' },
        { code: '5.03', name: 'Taxas bancárias', type: 'despesa' as const, dreGroup: 'despesas_gerais' },

        { code: '6', name: 'Outras Receitas/Despesas Operacionais', type: 'despesa' as const, dreGroup: 'outras_receitas_despesas' },

        { code: '7', name: 'Depreciação e Amortização', type: 'despesa' as const, dreGroup: 'depreciacao' },

        { code: '8', name: 'Receitas Financeiras', type: 'receita' as const, dreGroup: 'receitas_financeiras' },

        { code: '9', name: 'Despesas Financeiras (juros, tarifas)', type: 'despesa' as const, dreGroup: 'despesas_financeiras' },

        { code: '10', name: 'IRPJ/CSLL', type: 'despesa' as const, dreGroup: 'irpj_csll' },
      ];

      const created = [];
      for (const acc of dreAccounts) {
        const result = await storage.createChartOfAccount({
          code: acc.code,
          name: acc.name,
          type: acc.type,
          dreGroup: acc.dreGroup,
          isActive: true,
        });
        created.push(result);
      }

      res.json({ message: `${created.length} contas criadas com sucesso`, count: created.length });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // FINANCIAL ACCOUNTS (bank/cash)
  // ============================================================================

  const maskAccountSecrets = (account: any) => {
    if (!account) return account;
    const masked = { ...account };
    if (masked.interClientSecret) masked.interClientSecret = '***';
    if (masked.interCertificateCrt) masked.interCertificateCrt = '[CERTIFICADO CONFIGURADO]';
    if (masked.interCertificateKey) masked.interCertificateKey = '[CHAVE CONFIGURADA]';
    if (masked.bbClientSecret) masked.bbClientSecret = '***';
    if (masked.bbDevAppKey) masked.bbDevAppKey = masked.bbDevAppKey.substring(0, 6) + '***';
    if (masked.bbPixClientSecret) masked.bbPixClientSecret = '***';
    if (masked.bbPagamentosClientSecret) masked.bbPagamentosClientSecret = '***';
    if (masked.bbExtratoClientSecret) masked.bbExtratoClientSecret = '***';
    return masked;
  };

  app.get('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const accounts = await storage.getFinancialAccounts(instanceId);
      res.json(accounts.map(maskAccountSecrets));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.getFinancialAccount(req.params.id);
      if (!account) return res.status(404).json({ message: 'Conta financeira não encontrada' });
      res.json(maskAccountSecrets(account));
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  const cleanAccountData = (data: any) => {
    const cleaned = { ...data };
    const decimalFields = ['balance', 'bbJurosPercentual', 'bbMultaPercentual'];
    for (const field of decimalFields) {
      if (cleaned[field] === '' || cleaned[field] === null || cleaned[field] === undefined) {
        cleaned[field] = field === 'balance' ? '0' : null;
      } else if (typeof cleaned[field] === 'string') {
        cleaned[field] = cleaned[field].replace(',', '.');
      }
    }
    const nullableStringFields = ['bankName', 'bankCode', 'agency', 'accountNumber', 'pixKey',
      'omieInstanceId', 'description', 'accountSubtype',
      'bbClientId', 'bbClientSecret', 'bbDevAppKey', 'bbConvenio', 'bbContrato',
      'bbCarteira', 'bbVariacaoCarteira', 'bbDiasCompensacao', 'bbSenhaBoletos',
      'bbInstrucaoLinha1', 'bbInstrucaoLinha2', 'bbInstrucaoLinha3', 'bbInstrucaoLinha4',
      'bbPixClientId', 'bbPixClientSecret',
      'bbPagamentosClientId', 'bbPagamentosClientSecret',
      'bbExtratoClientId', 'bbExtratoClientSecret',
      'interClientId', 'interClientSecret', 'interCertificateCrt', 'interCertificateKey'];
    for (const field of nullableStringFields) {
      if (cleaned[field] === '') cleaned[field] = null;
    }
    return cleaned;
  };

  app.post('/api/financial/accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.createFinancialAccount(cleanAccountData(req.body));
      res.status(201).json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const account = await storage.updateFinancialAccount(req.params.id, cleanAccountData(req.body));
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/accounts/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await storage.deleteFinancialAccount(req.params.id);
      res.json({ message: 'Conta financeira removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts/:id/test-bb-pix', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const result = await bbPixService.testConnection(req.params.id);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // ============================================================================
  // ACCOUNT MOVEMENTS (immutable history - read only)
  // ============================================================================

  app.get('/api/financial/accounts/:id/movements', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.limit) filters.limit = parseInt(req.query.limit as string);
      if (req.query.offset) filters.offset = parseInt(req.query.offset as string);
      const movements = await storage.getAccountMovements(req.params.id, filters);
      res.json(movements);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // PIX CHARGES (Cobranças PIX)
  // ============================================================================

  app.get('/api/financial/pix-charges', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.financialAccountId) filters.financialAccountId = req.query.financialAccountId;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.receivableId) filters.receivableId = req.query.receivableId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      const charges = await storage.getPixCharges(filters);
      res.json(charges);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/pix-charges/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const charge = await storage.getPixCharge(req.params.id);
      if (!charge) return res.status(404).json({ message: 'Cobrança PIX não encontrada' });
      res.json(charge);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/immediate', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const { accountId, amount, debtorName, debtorDocument, description, expirationSeconds, receivableId, customerId } = req.body;
      
      if (!accountId || !amount) {
        return res.status(400).json({ message: 'accountId e amount são obrigatórios' });
      }

      const charge = await bbPixService.createImmediateCharge(accountId, {
        amount: parseFloat(amount),
        debtorName,
        debtorDocument,
        description,
        expirationSeconds: expirationSeconds ? parseInt(expirationSeconds) : undefined,
        receivableId,
        customerId,
        createdBy: user?.email || null,
      });

      res.status(201).json(charge);
    } catch (error: any) {
      console.error('❌ [PIX-ROUTE] Erro ao criar cobrança imediata:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/due-date', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const { accountId, amount, dueDate, validityAfterDue, debtorName, debtorDocument, description, receivableId, customerId } = req.body;
      
      if (!accountId || !amount || !dueDate || !debtorName || !debtorDocument) {
        return res.status(400).json({ message: 'accountId, amount, dueDate, debtorName e debtorDocument são obrigatórios' });
      }

      const charge = await bbPixService.createDueDateCharge(accountId, {
        amount: parseFloat(amount),
        dueDate,
        validityAfterDue: validityAfterDue ? parseInt(validityAfterDue) : undefined,
        debtorName,
        debtorDocument,
        description,
        receivableId,
        customerId,
        createdBy: user?.email || null,
      });

      res.status(201).json(charge);
    } catch (error: any) {
      console.error('❌ [PIX-ROUTE] Erro ao criar cobrança com vencimento:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-charges/:id/check-status', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const charge = await bbPixService.checkChargeStatus(req.params.id);
      res.json(charge);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/pix-webhook', webhookTokenGuard, async (req, res) => {
    try {
      await bbPixService.handleWebhookNotification(req.body);
      res.status(200).json({ message: 'OK' });
    } catch (error: any) {
      console.error('❌ [PIX-WEBHOOK] Erro:', error.message);
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/accounts/:id/configure-webhook', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { webhookUrl } = req.body;
      if (!webhookUrl) return res.status(400).json({ message: 'webhookUrl é obrigatório' });
      await bbPixService.configureWebhook(req.params.id, webhookUrl);
      res.json({ message: 'Webhook configurado com sucesso' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // RECEIVABLES (Contas a Receber)
  // ============================================================================

  // FASE 3.1 - Regras de classificacao DRE de contas a pagar por fornecedor.
  // Aplicadas em massa via /api/financial/payable-rules/apply (dryRun por padrao)
  // e automaticamente na criacao de novas contas a pagar sem conta gerencial.
  const PAYABLE_RULES: Array<{ p: string; code: string }> = [
    { p: 'BANCO DO BRASIL', code: '5.03' },
    { p: 'SIMPLES NACIONAL', code: '1.02' },
    { p: 'SECRETARIA DA ECONOMIA', code: '1.02' },
    { p: 'DOHLER', code: '2.01' },
    { p: 'BLUEBERRY', code: '2.01' },
    { p: 'JOAQUIM CORREIA FLORENTINO', code: '2.01' },
    { p: 'HP GUIMARAES', code: '2.02' },
    { p: 'CAPITAL EMBALAGENS', code: '2.02' },
    { p: 'ELLOFLEX', code: '2.02' },
    { p: 'VANTAGEM ENERGIA', code: '2.03' },
    { p: 'NAIARA GOMES', code: '2.04' },
    { p: 'MARCELO CHAVES COSTA BARBOSA', code: '3.09' },
    { p: 'GILMAR MOREIRA', code: '3.03' },
    { p: 'VOLUS', code: '4.10' },
    { p: 'FLAVIO EVANGELISTA BAYLAO', code: '4.01' },
    { p: 'FGTS', code: '4.01' },
    { p: 'IMPERIAL EMPREENDIMENTOS', code: '4.06' },
    { p: 'BANCO VOLKSWAGEN', code: '9.01' },
    { p: 'BANCO VOTORANTIM', code: '9.01' },
  ];
  let __accByCode: { map: Record<string, string>; at: number } = { map: {}, at: 0 };
  async function chartAccountIdByCode(code: string): Promise<string | null> {
    const now = Date.now();
    if (now - __accByCode.at > 60000) {
      try {
        const q: any = await db.execute(sql`SELECT id, code FROM chart_of_accounts WHERE is_active = true`);
        const m: Record<string, string> = {};
        for (const r of ((q as any).rows || [])) m[String(r.code)] = String(r.id);
        __accByCode = { map: m, at: now };
      } catch {}
    }
    return __accByCode.map[code] || null;
  }
  // Regras DINAMICAS (criadas pela tela de revisao) - tabela payable_class_rules.
  let __rulesTableReady = false;
  async function ensurePayableRulesTable(): Promise<void> {
    if (__rulesTableReady) return;
    await db.execute(sql`CREATE TABLE IF NOT EXISTS payable_class_rules (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      pattern varchar NOT NULL UNIQUE,
      chart_account_id varchar NOT NULL,
      created_by varchar,
      created_at timestamp NOT NULL DEFAULT now()
    )`);
    __rulesTableReady = true;
  }
  let __dynRules: { rows: Array<{ pattern: string; accountId: string }>; at: number } = { rows: [], at: 0 };
  async function dynamicPayableRules(): Promise<Array<{ pattern: string; accountId: string }>> {
    const now = Date.now();
    if (now - __dynRules.at < 60000) return __dynRules.rows;
    try {
      await ensurePayableRulesTable();
      const q: any = await db.execute(sql`SELECT pattern, chart_account_id FROM payable_class_rules ORDER BY created_at`);
      __dynRules = { rows: ((q as any).rows || []).map((r: any) => ({ pattern: String(r.pattern).toUpperCase(), accountId: String(r.chart_account_id) })), at: now };
    } catch {}
    return __dynRules.rows;
  }
  async function payableRuleAccountFor(supplierName: any): Promise<string | null> {
    const s = String(supplierName || '').toUpperCase();
    for (const r of PAYABLE_RULES) if (s.includes(r.p)) return await chartAccountIdByCode(r.code);
    for (const r of await dynamicPayableRules()) if (s.includes(r.pattern)) return r.accountId;
    return null;
  }

  app.post('/api/financial/payable-rules/apply', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const user = actorOf(req);
      const results: any[] = [];
      let total = 0;
      for (const r of PAYABLE_RULES) {
        const accId = await chartAccountIdByCode(r.code);
        if (!accId) { results.push({ regra: r.p, conta: r.code, erro: 'conta nao encontrada' }); continue; }
        const like = '%' + r.p + '%';
        if (dryRun) {
          const q: any = await db.execute(sql`SELECT count(*)::int AS n, COALESCE(sum(amount::numeric),0)::numeric(14,2) AS v FROM payables WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada' AND upper(supplier_name) LIKE ${like}`);
          const row = (q as any).rows?.[0] || {};
          results.push({ regra: r.p, conta: r.code, titulos: row.n ?? 0, valor: row.v ?? '0' });
          total += Number(row.n || 0);
        } else {
          const u: any = await db.execute(sql`UPDATE payables SET chart_account_id = ${accId}, updated_at = now(), updated_by = ${user?.email || 'payable-rules'} WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada' AND upper(supplier_name) LIKE ${like}`);
          const n = ((u as any)?.rowCount ?? 0) as number;
          results.push({ regra: r.p, conta: r.code, atualizados: n });
          total += n;
        }
      }
      res.json({ ok: true, dryRun, total, results });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // FASE 3.1 - Fornecedores com titulos sem classificacao, agrupados (tela de revisao).
  app.get('/api/financial/payables-unclassified', authenticateUser, isFinancialAuthorized, async (_req, res) => {
    try {
      const q: any = await db.execute(sql`
        SELECT upper(coalesce(supplier_name,'(SEM FORNECEDOR)')) AS fornecedor,
               count(*)::int AS titulos,
               COALESCE(sum(amount::numeric),0)::numeric(14,2) AS valor,
               max(coalesce(description,'')) AS exemplo
        FROM payables
        WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada'
        GROUP BY 1 ORDER BY 3 DESC LIMIT 200`);
      res.json((q as any).rows || []);
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // FASE 3.1 - Cria regra dinamica (fornecedor -> conta) e aplica na hora aos pendentes.
  app.post('/api/financial/payable-rules', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const pattern = String(req.body?.pattern || '').trim().toUpperCase();
      const accountId = String(req.body?.chartAccountId || '');
      if (pattern.length < 4) return res.status(400).json({ message: 'padrão muito curto (mínimo 4 caracteres)' });
      if (!accountId) return res.status(400).json({ message: 'conta gerencial obrigatória' });
      const acc: any = await db.execute(sql`SELECT id FROM chart_of_accounts WHERE id = ${accountId} AND is_active = true LIMIT 1`);
      if (!((acc as any).rows || []).length) return res.status(404).json({ message: 'conta gerencial não encontrada' });
      const user = actorOf(req);
      await ensurePayableRulesTable();
      await db.execute(sql`INSERT INTO payable_class_rules (pattern, chart_account_id, created_by) VALUES (${pattern}, ${accountId}, ${user?.email || null}) ON CONFLICT (pattern) DO UPDATE SET chart_account_id = ${accountId}`);
      __dynRules.at = 0;
      const like = '%' + pattern + '%';
      const u: any = await db.execute(sql`UPDATE payables SET chart_account_id = ${accountId}, updated_at = now(), updated_by = ${user?.email || 'payable-rules'} WHERE chart_account_id IS NULL AND deleted_at IS NULL AND status <> 'cancelada' AND upper(supplier_name) LIKE ${like}`);
      await logFinancialAudit({ req, action: 'update', entity: 'payable', entityId: pattern, note: 'regra de classificação DRE criada/aplicada' });
      res.json({ ok: true, pattern, aplicados: ((u as any)?.rowCount ?? 0) as number });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.get('/api/financial/payable-rules', authenticateUser, isFinancialAuthorized, async (_req, res) => {
    try {
      await ensurePayableRulesTable();
      const q: any = await db.execute(sql`SELECT r.id, r.pattern, r.created_by, r.created_at, c.code, c.name FROM payable_class_rules r LEFT JOIN chart_of_accounts c ON c.id = r.chart_account_id ORDER BY r.created_at DESC`);
      res.json({ fixas: PAYABLE_RULES, dinamicas: (q as any).rows || [] });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  // FASE 2 - PIX recebidos sem cobranca correspondente (capturados pelo webhook).
  // Lista de apoio: a baixa continua sendo feita pela Conciliacao 2.0 (extrato OFX).
  app.get('/api/financial/pix-nao-identificados', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await bbPixService.ensurePixUnmatchedTable();
      const status = String(req.query.status || 'pendente');
      const q: any = status === 'todos'
        ? await db.execute(sql`SELECT * FROM pix_unmatched ORDER BY created_at DESC LIMIT 300`)
        : await db.execute(sql`SELECT * FROM pix_unmatched WHERE status = ${status} ORDER BY created_at DESC LIMIT 300`);
      res.json((q as any).rows || []);
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.post('/api/financial/pix-nao-identificados/:id/status', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      await bbPixService.ensurePixUnmatchedTable();
      const novo = String(req.body?.status || '');
      if (!['pendente', 'resolvido', 'ignorado'].includes(novo)) return res.status(400).json({ message: 'status invalido' });
      const user = actorOf(req);
      const u: any = await db.execute(sql`UPDATE pix_unmatched SET status = ${novo}, resolved_by = ${user?.email || null}, resolved_at = now(), notes = ${req.body?.notes || null} WHERE id = ${req.params.id}`);
      res.json({ ok: true, updated: ((u as any)?.rowCount ?? 0) as number });
    } catch (error: any) { res.status(500).json({ message: error.message }); }
  });

  app.get('/api/financial/receivables', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.customerId) filters.customerId = req.query.customerId;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.dueDateStart) filters.dueDateStart = new Date(req.query.dueDateStart as string);
      if (req.query.dueDateEnd) filters.dueDateEnd = new Date(req.query.dueDateEnd as string);
      if (req.query.paymentMethod) filters.paymentMethod = req.query.paymentMethod;
      if (req.query.chartAccountId) filters.chartAccountId = req.query.chartAccountId;
      
      const receivables = await storage.getReceivables(filters);
      const all = receivables as any[];
      // FASE 3.2 - paginacao opcional (?limit=&offset=). Sem os parametros, retorna tudo.
      const limitR = parseInt(String(req.query.limit || '')) || 0;
      const offsetR = parseInt(String(req.query.offset || '')) || 0;
      const pageR = limitR > 0 ? all.slice(offsetR, offsetR + limitR) : all;
      try { attachBadges(pageR, await badgeFlagsFor('receivable'), 'recebida'); } catch {}
      // Comprovante de entrega: anexa as fotos tiradas pelo entregador (delivery_route_stops.photos),
      // ligadas ao recebível por billing_pipeline (billingPipelineId) ou pelo sales_card_id. Batched.
      try {
        const pipeIds = Array.from(new Set(pageR.map((r: any) => r.billingPipelineId).filter(Boolean)));
        const cardIds = Array.from(new Set(pageR.map((r: any) => r.salesCardId).filter(Boolean)));
        if (pipeIds.length || cardIds.length) {
          const conds: any[] = [];
          if (pipeIds.length) conds.push(sql`billing_id IN (${sql.join(pipeIds.map((id: string) => sql`${id}`), sql`, `)})`);
          if (cardIds.length) conds.push(sql`sales_card_id IN (${sql.join(cardIds.map((id: string) => sql`${id}`), sql`, `)})`);
          const stopsRes: any = await db.execute(sql`
            SELECT billing_id, sales_card_id, photos
            FROM delivery_route_stops
            WHERE photos IS NOT NULL AND jsonb_array_length(photos) > 0 AND (${sql.join(conds, sql` OR `)})
          `);
          const stopRows: any[] = stopsRes?.rows || stopsRes || [];
          const byBilling = new Map<string, string[]>();
          const byCard = new Map<string, string[]>();
          for (const s of stopRows) {
            let ph: string[] = [];
            try { ph = Array.isArray(s.photos) ? s.photos : (s.photos ? JSON.parse(s.photos) : []); } catch {}
            if (!ph.length) continue;
            if (s.billing_id && !byBilling.has(s.billing_id)) byBilling.set(s.billing_id, ph);
            if (s.sales_card_id && !byCard.has(s.sales_card_id)) byCard.set(s.sales_card_id, ph);
          }
          for (const r of pageR as any[]) {
            r.deliveryPhotos = (r.billingPipelineId && byBilling.get(r.billingPipelineId)) || (r.salesCardId && byCard.get(r.salesCardId)) || [];
          }
        }
      } catch { /* nunca bloqueia a lista */ }
      // ?paged=1: retorna a PAGINA + um RESUMO (contagem e somas) calculado sobre TODO o
      // conjunto filtrado no servidor. Permite abrir a tela SEM filtro e ainda assim rapido:
      // manda so a 1a pagina e os totais vem do resumo (nao baixa 10k+ linhas no cliente).
      if (req.query.paged) {
        let amount = 0, paid = 0;
        for (const r of all) { amount += Number(r.amount || 0); paid += Number(r.amountPaid || 0); }
        return res.json({ rows: pageR, total: all.length, summary: { count: all.length, amount, paid, saldo: amount - paid } });
      }
      res.json(pageR);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.getReceivable(req.params.id);
      if (!receivable) return res.status(404).json({ message: 'Conta a receber não encontrada' });
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // HISTÓRICO COMPLETO da conta a receber: cobrança + documento (boleto/PIX) + recebimentos/baixas
  // + conciliações + auditoria, com DATAS de todos os fatos e USUÁRIOS responsáveis. Somente leitura.
  app.get('/api/financial/receivables/:id/history', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const id = req.params.id;
      const receivable: any = await storage.getReceivable(id);
      if (!receivable) return res.status(404).json({ message: 'Conta a receber não encontrada' });

      // Mapa email -> "Nome" para resolver responsáveis.
      const userMap: Record<string, string> = {};
      try {
        const users = await storage.getUsers();
        for (const u of users as any[]) {
          const nm = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
          if (u.email) userMap[String(u.email).toLowerCase()] = nm;
        }
      } catch {}
      const uname = (e: any) => { if (!e) return null; const k = String(e).toLowerCase().trim(); return userMap[k] || e; };

      // NF-e vinculada
      let fiscalInvoice: any = null;
      if (receivable.fiscalInvoiceId) {
        try {
          const fi: any = await storage.getFiscalInvoice(receivable.fiscalInvoiceId);
          if (fi) fiscalInvoice = { id: fi.id, invoiceNumber: fi.invoiceNumber, status: fi.status, accessKey: fi.accessKey, emissionDate: fi.emissionDate, environment: fi.environment };
        } catch {}
      }

      // Boletos (documento de cobrança)
      let boletos: any[] = [];
      try {
        const b: any = await db.execute(sql`SELECT id, nosso_numero, linha_digitavel, codigo_barras, data_vencimento, valor_original, status, created_at, updated_by, deleted_at, deleted_by FROM boleto_charges WHERE receivable_id = ${id} ORDER BY created_at ASC`);
        boletos = (b.rows || []).map((r: any) => ({
          id: r.id, nossoNumero: r.nosso_numero, linhaDigitavel: r.linha_digitavel, codigoBarras: r.codigo_barras,
          dueDate: r.data_vencimento, amount: r.valor_original, status: r.status, createdAt: r.created_at,
          canceledAt: r.deleted_at, canceledBy: uname(r.deleted_by),
        }));
      } catch {}

      // PIX (documento de cobrança)
      let pix: any[] = [];
      try {
        const p: any = await db.execute(sql`SELECT id, txid, status, amount, amount_paid, end_to_end_id, due_date, expires_at, paid_at, created_by, created_at FROM pix_charges WHERE receivable_id = ${id} ORDER BY created_at ASC`);
        pix = (p.rows || []).map((r: any) => ({
          id: r.id, txid: r.txid, status: r.status, amount: r.amount, amountPaid: r.amount_paid,
          endToEndId: r.end_to_end_id, dueDate: r.due_date, expiresAt: r.expires_at, paidAt: r.paid_at,
          createdAt: r.created_at, createdBy: uname(r.created_by),
        }));
      } catch {}

      // Recebimentos / baixas
      let payments: any[] = [];
      try {
        const pays: any[] = await storage.getReceivablePayments(id);
        payments = (pays || []).map((pp: any) => ({
          id: pp.id, paidAt: pp.paidAt, amount: pp.amount, paymentMethod: pp.paymentMethod,
          reference: pp.reference, notes: pp.notes, financialAccountId: pp.financialAccountId,
          createdAt: pp.createdAt, createdBy: uname(pp.createdBy),
        }));
      } catch {}

      // Conciliações bancárias (extrato x título)
      let reconciliations: any[] = [];
      try {
        const rc: any = await db.execute(sql`
          SELECT m.id, m.amount, m.match_kind, m.title_amount_settled, m.interest, m.discount, m.created_by, m.created_at,
                 i.transaction_date, i.description AS item_description, i.document AS item_document, i.origin_name, i.amount AS item_amount,
                 i.matched_at, i.matched_by, i.reconciliation_status, i.notes AS item_notes,
                 s.file_name, fa.name AS account_name
          FROM bank_statement_item_matches m
          JOIN bank_statement_items i ON i.id = m.bank_statement_item_id
          LEFT JOIN bank_statements s ON s.id = i.statement_id
          LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
          WHERE m.receivable_id = ${id}
          ORDER BY COALESCE(i.matched_at, m.created_at) ASC`);
        reconciliations = (rc.rows || []).map((r: any) => ({
          id: r.id, amount: r.amount, matchKind: r.match_kind, settled: r.title_amount_settled, interest: r.interest, discount: r.discount,
          matchedAt: r.matched_at, matchedBy: uname(r.matched_by), createdAt: r.created_at, createdBy: uname(r.created_by),
          transactionDate: r.transaction_date, itemDescription: r.item_description, itemDocument: r.item_document, originName: r.origin_name, itemAmount: r.item_amount,
          status: r.reconciliation_status, statement: r.file_name, account: r.account_name, notes: r.item_notes,
        }));
      } catch {}
      // Fallback: item conciliado diretamente (sem linha de match)
      if (!reconciliations.length) {
        try {
          const rc2: any = await db.execute(sql`
            SELECT i.id, i.transaction_date, i.description AS item_description, i.amount AS item_amount, i.matched_at, i.matched_by, i.reconciliation_status, i.notes AS item_notes, s.file_name, fa.name AS account_name
            FROM bank_statement_items i LEFT JOIN bank_statements s ON s.id = i.statement_id LEFT JOIN financial_accounts fa ON fa.id = s.financial_account_id
            WHERE i.matched_receivable_id = ${id} ORDER BY i.matched_at ASC`);
          reconciliations = (rc2.rows || []).map((r: any) => ({
            id: r.id, matchedAt: r.matched_at, matchedBy: uname(r.matched_by), transactionDate: r.transaction_date,
            itemDescription: r.item_description, itemAmount: r.item_amount, status: r.reconciliation_status,
            statement: r.file_name, account: r.account_name, notes: r.item_notes,
          }));
        } catch {}
      }

      // Auditoria financeira (create/update/pay/delete/reverse/status)
      let audit: any[] = [];
      try {
        const a: any = await db.execute(sql`SELECT action, user_email, user_role, amount, note, created_at FROM financial_audit_log WHERE entity = 'receivable' AND entity_id = ${id} ORDER BY created_at ASC`);
        audit = (a.rows || []).map((r: any) => ({ action: r.action, user: uname(r.user_email), role: r.user_role, amount: r.amount, note: r.note, at: r.created_at }));
      } catch {}

      // Linha do tempo consolidada
      const ACTION_LABEL: Record<string, string> = { create: 'Conta criada', update: 'Conta editada', delete: 'Conta excluída', pay: 'Baixa registrada', reverse: 'Baixa estornada', status: 'Status alterado', reconcile: 'Conciliação', config: 'Configuração' };
      const timeline: any[] = [];
      const push = (date: any, type: string, label: string, user?: any, detail?: any) => { if (date) timeline.push({ date, type, label, user: user || null, detail: detail || null }); };
      push(receivable.issueDate || receivable.createdAt, 'emissao', 'Conta a receber emitida', uname(receivable.createdBy), receivable.titleNumber ? `Título ${receivable.titleNumber}` : (fiscalInvoice ? `NF-e ${fiscalInvoice.invoiceNumber || ''}` : null));
      for (const b of boletos) push(b.createdAt, 'boleto', 'Boleto emitido', null, `Nosso nº ${b.nossoNumero || '-'}${b.dueDate ? ' · venc. ' + new Date(b.dueDate).toLocaleDateString('pt-BR') : ''}`);
      for (const b of boletos) if (b.canceledAt) push(b.canceledAt, 'boleto', 'Boleto cancelado', b.canceledBy, `Nosso nº ${b.nossoNumero || '-'}`);
      for (const p of pix) push(p.createdAt, 'pix', 'Cobrança PIX criada', p.createdBy, `txid ${String(p.txid || '').slice(0, 12)}…`);
      for (const p of payments) push(p.paidAt || p.createdAt, 'baixa', 'Recebimento / baixa', p.createdBy, `${p.paymentMethod || ''}${p.notes ? ' · ' + p.notes : ''}`.trim());
      for (const r of reconciliations) push(r.matchedAt || r.createdAt, 'conciliacao', 'Conciliação bancária', r.matchedBy || r.createdBy, `${r.statement ? 'Extrato ' + r.statement : ''}${r.account ? ' · ' + r.account : ''}`.trim() || null);
      for (const a of audit) if (a.action !== 'create' && a.action !== 'pay' && a.action !== 'reconcile') push(a.at, 'auditoria', ACTION_LABEL[a.action] || a.action, a.user, a.note);
      timeline.sort((x, y) => new Date(x.date).getTime() - new Date(y.date).getTime());

      res.json({
        receivable: {
          id: receivable.id, titleNumber: receivable.titleNumber, customerName: receivable.customerName, customerDocument: receivable.customerDocument,
          category: receivable.category, description: receivable.description, amount: receivable.amount, amountPaid: receivable.amountPaid,
          status: receivable.status, paymentMethod: receivable.paymentMethod, issueDate: receivable.issueDate, dueDate: receivable.dueDate,
          omieInstanceId: receivable.omieInstanceId, fiscalInvoiceId: receivable.fiscalInvoiceId, billingPipelineId: receivable.billingPipelineId,
          createdAt: receivable.createdAt, createdBy: uname(receivable.createdBy),
          updatedAt: receivable.updatedAt, updatedBy: uname(receivable.updatedBy),
          deletedAt: receivable.deletedAt, deletedBy: uname(receivable.deletedBy),
        },
        fiscalInvoice, boletos, pix, payments, reconciliations, audit, timeline,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/receivables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const data: any = { ...normalizeFinancialBody(req.body), createdBy: user?.email || null };
      if (!data.issueDate) data.issueDate = new Date();
      // FASE 3.4e - categoria DRE obrigatoria: default = receita bruta (venda); sem categoria, nao cria.
      if (!data.chartAccountId) {
        try {
          const q: any = await db.execute(sql`SELECT id FROM chart_of_accounts WHERE dre_group = 'receita_bruta' AND code LIKE '%.%' AND is_active = true ORDER BY code LIMIT 1`);
          data.chartAccountId = (q as any).rows?.[0]?.id || null;
        } catch {}
      }
      if (!data.chartAccountId) return res.status(400).json({ message: 'Selecione a categoria DRE (plano de contas). Nenhuma conta pode ser criada sem categoria.' });
      const receivable = await storage.createReceivable(data);
      await logFinancialAudit({ req, action: 'create', entity: 'receivable', entityId: receivable.id, after: receivable, amount: Number(receivable.amount) });
      res.status(201).json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getReceivable(req.params.id);
      const receivable = await storage.updateReceivable(req.params.id, normalizeFinancialBody(req.body));
      await logFinancialAudit({ req, action: 'update', entity: 'receivable', entityId: req.params.id, before, after: receivable });
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/receivables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getReceivable(req.params.id);
      await storage.deleteReceivable(req.params.id, actorOf(req).email);
      await logFinancialAudit({ req, action: 'delete', entity: 'receivable', entityId: req.params.id, before, amount: before ? Number(before.amount) : null });
      res.json({ message: 'Conta a receber removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Receivable Payments
  app.get('/api/financial/receivables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payments = await storage.getReceivablePayments(req.params.id);
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/receivables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const exists = await storage.getReceivable(req.params.id);
      if (!exists) return res.status(404).json({ message: 'Recebível não encontrado' });
      const b = req.body || {};
      // FASE 2 - Trava de dupla baixa: titulo cancelado ou ja quitado nao aceita nova baixa.
      // Para lancar de novo, desfaca a baixa/conciliacao original (o titulo volta a ficar aberto).
      const amtBaixaR = parseFloat(String(b.amount ?? '0'));
      if (!(amtBaixaR > 0)) return res.status(400).json({ message: 'Valor da baixa deve ser maior que zero.' });
      if (String((exists as any).status) === 'cancelada') return res.status(409).json({ message: 'Título cancelado não aceita baixa.' });
      const jaPagoR = parseFloat((exists as any).amountPaid || '0');
      const totalR = parseFloat((exists as any).amount || '0');
      if (String((exists as any).status) === 'recebida' || (totalR > 0 && jaPagoR >= totalR - 0.005)) {
        return res.status(409).json({ message: 'Título já quitado/conciliado. Desfaça a baixa original antes de lançar nova.' });
      }
      const rawDate = b.paidAt || b.paymentDate || b.paidDate;
      const data: any = {
        receivableId: req.params.id,
        paidAt: rawDate ? new Date(rawDate) : new Date(),
        amount: String(b.amount ?? '0'),
        paymentMethod: b.paymentMethod || null,
        financialAccountId: b.financialAccountId || null,
        reference: b.reference || null,
        notes: b.notes || null,
        createdBy: user?.email || null,
      };
      const payment = await storage.createReceivablePayment(data);
      await logFinancialAudit({ req, action: 'pay', entity: 'receivable', entityId: req.params.id, amount: Number(data.amount), note: 'baixa' });

      const receivable = await storage.getReceivable(req.params.id);
      if (receivable) {
        const totalPaid = parseFloat(receivable.amountPaid || '0') + parseFloat(data.amount);
        const totalAmount = parseFloat(receivable.amount);
        const newStatus = totalPaid >= totalAmount ? 'recebida' : 'a_vencer';
        await storage.updateReceivable(req.params.id, { 
          amountPaid: totalPaid.toFixed(2),
          status: newStatus as any
        });
      }
      
      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // BAIXA ADMINISTRATIVA (perdão/incobrável): fecha o título em 100% SEM entrada de
  // dinheiro (NÃO conta como recebimento no caixa). Exige MOTIVO e registra QUEM
  // executou (updated_by + auditoria financeira). Marca status 'cancelada' (estado
  // "fechado / não recebível" já usado no sistema — some das listas de aberto/vencido
  // e não entra em "recebido") e carimba o motivo em notes.
  app.post('/api/financial/receivables/:id/write-off', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const reason = String(req.body?.reason ?? '').trim();
      if (!reason) return res.status(400).json({ message: 'Informe o MOTIVO da baixa administrativa.' });
      const rec: any = await storage.getReceivable(req.params.id);
      if (!rec) return res.status(404).json({ message: 'Recebível não encontrado' });
      if (String(rec.status) === 'cancelada') return res.status(409).json({ message: 'Título já está cancelado/baixado.' });
      if (String(rec.status) === 'recebida') return res.status(409).json({ message: 'Título já recebido — desfaça o recebimento antes de dar baixa administrativa.' });
      const total = parseFloat(rec.amount || '0');
      const jaPago = parseFloat(rec.amountPaid || '0');
      const saldo = Math.max(0, total - jaPago);
      const stamp = `[BAIXA ADMINISTRATIVA ${new Date().toISOString().slice(0, 10)} por ${user?.email || '?'}] ${reason}`;
      const prevNotes = String(rec.notes || '');
      await storage.updateReceivable(req.params.id, {
        status: 'cancelada' as any,
        notes: prevNotes ? (prevNotes + '\n' + stamp) : stamp,
        updatedBy: user?.email || null,
      } as any);
      await logFinancialAudit({ req, action: 'status', entity: 'receivable', entityId: req.params.id, amount: saldo, note: 'baixa administrativa (100%): ' + reason });
      res.json({ ok: true, saldoBaixado: saldo, status: 'cancelada' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Débitos Vencidos = MESMA lista de "vencida" da Contas a Receber, agrupada por
  // cliente. Fonte LOCAL (2.0), não mais o Omie ERP (que estava divergindo). Reusa
  // getReceivables({status:'vencida'}) para bater EXATAMENTE com a aba Contas a Receber
  // (mesma regra de vencido por dia-calendário no fuso Brasil).
  app.get('/api/financial/overdue-debts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const digits = (s: any) => String(s == null ? '' : s).replace(/\D/g, '');
      const instanceId = (req.query.instanceId as string) || undefined;
      const rows: any[] = await storage.getReceivables(instanceId ? ({ status: 'vencida', instanceId } as any) : ({ status: 'vencida' } as any));
      const vencidas = rows.filter((r) => String(r.status) === 'vencida' && !r.deletedAt);
      // Telefone do cliente (por id e por documento) para os botões de WhatsApp.
      const phoneById = new Map<string, string>();
      const phoneByDoc = new Map<string, string>();
      try {
        const custRows: any = await db.execute(sql`SELECT id, phone, cnpj, cpf FROM customers`);
        for (const c of ((custRows as any).rows || [])) {
          if (!c.phone) continue;
          if (c.id) phoneById.set(String(c.id), String(c.phone));
          const doc = digits(c.cnpj || c.cpf || '');
          if (doc) phoneByDoc.set(doc, String(c.phone));
        }
      } catch {}
      const hojeMs = Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) + 'T00:00:00Z');
      const isoBR = (d: any) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const fmtBR = (d: any) => { const [y, m, dd] = isoBR(d).split('-'); return `${dd}/${m}/${y}`; };
      const diasAtraso = (d: any) => Math.max(0, Math.round((hojeMs - Date.parse(isoBR(d) + 'T00:00:00Z')) / 86400000));
      const groups = new Map<string, any>();
      for (const r of vencidas) {
        const doc = digits(r.customerDocument || '');
        const key = doc || String(r.customerName || '').trim().toLowerCase() || String(r.customerId || r.id);
        const saldo = Math.max(0, Number(r.amount || 0) - Number(r.amountPaid || 0));
        const seller = r.sellerName || 'Sem vendedor';
        const tel = (r.customerId && phoneById.get(String(r.customerId))) || (doc && phoneByDoc.get(doc)) || '';
        let g = groups.get(key);
        if (!g) { g = { cliente: { codigo_cliente_omie: 0, nome_fantasia: r.customerName || '(sem nome)', cnpj_cpf: r.customerDocument || '', telefone: tel }, debitos: [], valorTotal: 0, diasMaximoAtraso: 0, vendedores: new Set<string>(), omieInstanceId: r.omieInstanceId || null }; groups.set(key, g); }
        const dias = diasAtraso(r.dueDate);
        g.debitos.push({ numero_documento: r.titleNumber || '', numero_documento_fiscal: r.titleNumber || '', codigo_lancamento_omie: 0, receivableId: r.id, valor: saldo, data_vencimento: fmtBR(r.dueDate), dias_atraso: dias, observacao: r.description || '', codigo_vendedor: seller });
        g.valorTotal += saldo;
        g.diasMaximoAtraso = Math.max(g.diasMaximoAtraso, dias);
        g.vendedores.add(seller);
        if (!g.cliente.telefone && tel) g.cliente.telefone = tel;
      }
      const debts = Array.from(groups.values()).map((g) => ({ ...g, vendedores: Array.from(g.vendedores) }));
      debts.sort((a, b) => (b.diasMaximoAtraso - a.diasMaximoAtraso) || (b.valorTotal - a.valorTotal));
      const totalAmount = debts.reduce((s, g) => s + g.valorTotal, 0);
      res.json({ debts, totalAmount, totalClients: debts.length, lastSyncAt: null });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // PAYABLES (Contas a Pagar)
  // ============================================================================

  app.get('/api/financial/payables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.supplierDocument) filters.supplierDocument = req.query.supplierDocument;
      if (req.query.status) filters.status = req.query.status;
      if (req.query.instanceId) filters.instanceId = req.query.instanceId;
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.dueDateStart) filters.dueDateStart = new Date(req.query.dueDateStart as string);
      if (req.query.dueDateEnd) filters.dueDateEnd = new Date(req.query.dueDateEnd as string);
      if (req.query.source) filters.source = req.query.source;
      if (req.query.chartAccountId) filters.chartAccountId = req.query.chartAccountId;
      
      const payables = await storage.getPayables(filters);
      // FASE 3.2 - paginacao opcional (?limit=&offset=). Sem os parametros, retorna tudo.
      const limitP = parseInt(String(req.query.limit || '')) || 0;
      const offsetP = parseInt(String(req.query.offset || '')) || 0;
      const pageP = limitP > 0 ? (payables as any[]).slice(offsetP, offsetP + limitP) : (payables as any[]);
      try { attachBadges(pageP, await badgeFlagsFor('payable'), 'paga'); } catch {}
      res.json(pageP);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.getPayable(req.params.id);
      if (!payable) return res.status(404).json({ message: 'Conta a pagar não encontrada' });
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const data: any = { ...normalizeFinancialBody(req.body), createdBy: user?.email || null };
      if (!data.issueDate) data.issueDate = new Date();
      // FASE 3.1 - classificacao DRE automatica por regra de fornecedor.
      if (!data.chartAccountId) { try { data.chartAccountId = await payableRuleAccountFor(data.supplierName); } catch {} }
      // FASE 3.4e - categoria DRE obrigatoria: sem categoria (manual ou por regra), nao cria.
      if (!data.chartAccountId) return res.status(400).json({ message: 'Selecione a categoria DRE (plano de contas). Nenhuma conta pode ser criada sem categoria.' });
      const rec = req.body.recurrence;
      if (rec && rec.freq && rec.freq !== 'none') {
        const base = data.dueDate instanceof Date ? data.dueDate : (data.dueDate ? new Date(data.dueDate) : new Date());
        const dates = buildRecurrenceDates(base, rec);
        const items: any[] = [];
        for (const d of dates) { items.push(await storage.createPayable({ ...data, dueDate: d })); }
        await logFinancialAudit({ req, action: 'create', entity: 'payable', entityId: items[0]?.id, amount: Number(data.amount), note: 'recorrência ' + items.length + 'x' });
        return res.status(201).json({ recurring: true, count: items.length, items });
      }
      const payable = await storage.createPayable(data);
      await logFinancialAudit({ req, action: 'create', entity: 'payable', entityId: payable.id, after: payable, amount: Number(payable.amount) });
      res.status(201).json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ===== ANEXOS (DANFE / BOLETO) DE CONTAS A PAGAR =====
  // Armazenados no banco (base64) para durabilidade no Railway (disco efemero).
  // Reutilizavel por Contas a Pagar e por Compras (ambos criam payables).
  app.post('/api/financial/payables/:id/attachments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { kind, fileName, mimeType, base64 } = req.body || {};
      if (!fileName || !base64) return res.status(400).json({ message: 'fileName e base64 sao obrigatorios' });
      const clean = String(base64).replace(/^data:[^;]+;base64,/, '');
      const size = Math.floor(clean.length * 3 / 4);
      if (size > 15 * 1024 * 1024) return res.status(413).json({ message: 'Arquivo muito grande (limite 15MB).' });
      const k = ['danfe', 'boleto', 'outro'].includes(String(kind)) ? String(kind) : 'outro';
      const user = actorOf(req);
      const r: any = await db.execute(sql`INSERT INTO payable_attachments (id, payable_id, kind, file_name, mime_type, size_bytes, content_base64, created_by, created_at) VALUES (gen_random_uuid(), ${req.params.id}, ${k}, ${String(fileName)}, ${mimeType || null}, ${size}, ${clean}, ${user?.email || null}, now()) RETURNING id, kind, file_name, mime_type, size_bytes, created_at`);
      res.status(201).json(r.rows?.[0] || { ok: true });
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get('/api/financial/payables/:id/attachments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT id, kind, file_name, mime_type, size_bytes, created_at, created_by FROM payable_attachments WHERE payable_id = ${req.params.id} ORDER BY created_at ASC`);
      res.json(r.rows || []);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.get('/api/financial/payable-attachments/:attId/download', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const r: any = await db.execute(sql`SELECT file_name, mime_type, content_base64 FROM payable_attachments WHERE id = ${req.params.attId} LIMIT 1`);
      const row = r.rows?.[0];
      if (!row) return res.status(404).json({ message: 'Anexo nao encontrado' });
      const buf = Buffer.from(String(row.content_base64), 'base64');
      res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.file_name || 'anexo')}"`);
      res.send(buf);
    } catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });
  app.delete('/api/financial/payable-attachments/:attId', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try { await db.execute(sql`DELETE FROM payable_attachments WHERE id = ${req.params.attId}`); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ message: e?.message || String(e) }); }
  });

  app.patch('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getPayable(req.params.id);
      const payable = await storage.updatePayable(req.params.id, normalizeFinancialBody(req.body));
      await logFinancialAudit({ req, action: 'update', entity: 'payable', entityId: req.params.id, before, after: payable });
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete('/api/financial/payables/:id', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const before = await storage.getPayable(req.params.id);
      await storage.deletePayable(req.params.id, actorOf(req).email);
      await logFinancialAudit({ req, action: 'delete', entity: 'payable', entityId: req.params.id, before, amount: before ? Number(before.amount) : null });
      res.json({ message: 'Conta a pagar removida' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // FASE 1b - restauracao de soft-delete + lixeira (somente perfis financeiros).
  app.post('/api/financial/receivables/:id/restore', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const receivable = await storage.restoreReceivable(req.params.id);
      if (!receivable) return res.status(404).json({ message: 'Conta não encontrada' });
      await logFinancialAudit({ req, action: 'restore', entity: 'receivable', entityId: req.params.id, after: receivable });
      res.json(receivable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables/:id/restore', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payable = await storage.restorePayable(req.params.id);
      if (!payable) return res.status(404).json({ message: 'Conta não encontrada' });
      await logFinancialAudit({ req, action: 'restore', entity: 'payable', entityId: req.params.id, after: payable });
      res.json(payable);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/lixeira', authenticateUser, isFinancialAuthorized, async (_req, res) => {
    try {
      const [recs, pays] = await Promise.all([storage.getDeletedReceivables(), storage.getDeletedPayables()]);
      res.json({ receivables: recs, payables: pays });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Payable Payments
  app.get('/api/financial/payables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const payments = await storage.getPayablePayments(req.params.id);
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/payables/:id/payments', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const exists = await storage.getPayable(req.params.id);
      if (!exists) return res.status(404).json({ message: 'Conta a pagar não encontrada' });
      const b = req.body || {};
      // FASE 2 - Trava de dupla baixa: titulo cancelado ou ja quitado nao aceita nova baixa.
      // Para lancar de novo, desfaca a baixa/conciliacao original (o titulo volta a ficar aberto).
      const amtBaixaP = parseFloat(String(b.amount ?? '0'));
      if (!(amtBaixaP > 0)) return res.status(400).json({ message: 'Valor da baixa deve ser maior que zero.' });
      if (String((exists as any).status) === 'cancelada') return res.status(409).json({ message: 'Título cancelado não aceita baixa.' });
      const jaPagoP = parseFloat((exists as any).amountPaid || '0');
      const totalP = parseFloat((exists as any).amount || '0');
      if (String((exists as any).status) === 'paga' || (totalP > 0 && jaPagoP >= totalP - 0.005)) {
        return res.status(409).json({ message: 'Título já quitado/conciliado. Desfaça a baixa original antes de lançar nova.' });
      }
      const rawDate = b.paidAt || b.paymentDate || b.paidDate;
      const data: any = {
        payableId: req.params.id,
        paidAt: rawDate ? new Date(rawDate) : new Date(),
        amount: String(b.amount ?? '0'),
        paymentMethod: b.paymentMethod || null,
        financialAccountId: b.financialAccountId || null,
        reference: b.reference || null,
        notes: b.notes || null,
        createdBy: user?.email || null,
      };
      const payment = await storage.createPayablePayment(data);
      await logFinancialAudit({ req, action: 'pay', entity: 'payable', entityId: req.params.id, amount: Number(data.amount), note: 'baixa' });

      const payable = await storage.getPayable(req.params.id);
      if (payable) {
        const totalPaid = parseFloat(payable.amountPaid || '0') + parseFloat(data.amount);
        const totalAmount = parseFloat(payable.amount);
        const newStatus = totalPaid >= totalAmount ? 'paga' : 'a_vencer';
        await storage.updatePayable(req.params.id, {
          amountPaid: totalPaid.toFixed(2),
          status: newStatus as any
        });
      }

      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // FASE 3.3 - FLUXO DE CAIXA (regime de caixa, por conta bancaria)
  // ============================================================================

  // Realizado = pagamentos efetivos (data em que o dinheiro entrou/saiu), excluindo
  // titulos cancelados/apagados. Previsto = titulos abertos pelo mes de vencimento
  // (valor restante). Tudo quebrado por conta bancaria ('sem_conta' quando nao ha).
  app.get('/api/financial/cashflow', authenticateUser, isFinancialReadAuthorized, async (req, res) => {
    try {
      const year = parseInt(String(req.query.year || '')) || new Date().getFullYear();
      const startDate = new Date(Date.UTC(year, 0, 1));
      const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

      const accQ: any = await db.execute(sql`SELECT id, name, type, balance FROM financial_accounts WHERE is_active = true ORDER BY name`);
      const accounts = (((accQ as any).rows || []) as any[]).map((a: any) => ({ id: a.id, name: a.name, type: a.type, balance: Number(a.balance || 0) }));

      const bucketize = (rows: any[]) => {
        const out: Record<string, number[]> = { total: new Array(12).fill(0) };
        for (const r of rows) {
          const mi = Number(r.m) - 1;
          if (mi < 0 || mi > 11) continue;
          const key = r.acc || 'sem_conta';
          if (!out[key]) out[key] = new Array(12).fill(0);
          const v = Number(r.v || 0);
          out[key][mi] += v;
          out.total[mi] += v;
        }
        return out;
      };
      const scalarize = (rows: any[]) => {
        const out: Record<string, number> = { total: 0 };
        for (const r of rows) {
          const key = r.acc || 'sem_conta';
          const v = Number(r.v || 0);
          out[key] = (out[key] || 0) + v;
          out.total += v;
        }
        return out;
      };

      const realEntQ: any = await db.execute(sql`
        SELECT extract(month FROM p.paid_at)::int AS m,
               COALESCE(p.financial_account_id, t.financial_account_id) AS acc,
               COALESCE(sum(p.amount::numeric), 0) AS v
        FROM receivable_payments p
        JOIN receivables t ON t.id = p.receivable_id
        WHERE t.status <> 'cancelada' AND t.deleted_at IS NULL
          AND p.paid_at >= ${startDate} AND p.paid_at <= ${endDate}
        GROUP BY 1, 2`);
      const realSaiQ: any = await db.execute(sql`
        SELECT extract(month FROM p.paid_at)::int AS m,
               COALESCE(p.financial_account_id, t.financial_account_id) AS acc,
               COALESCE(sum(p.amount::numeric), 0) AS v
        FROM payable_payments p
        JOIN payables t ON t.id = p.payable_id
        WHERE t.status <> 'cancelada' AND t.deleted_at IS NULL
          AND p.paid_at >= ${startDate} AND p.paid_at <= ${endDate}
        GROUP BY 1, 2`);
      const prevEntQ: any = await db.execute(sql`
        SELECT extract(month FROM t.due_date)::int AS m,
               t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM receivables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date >= ${startDate} AND t.due_date <= ${endDate}
        GROUP BY 1, 2`);
      const prevSaiQ: any = await db.execute(sql`
        SELECT extract(month FROM t.due_date)::int AS m,
               t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM payables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date >= ${startDate} AND t.due_date <= ${endDate}
        GROUP BY 1, 2`);
      const atrEntQ: any = await db.execute(sql`
        SELECT t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM receivables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date < ${startDate}
        GROUP BY 1`);
      const atrSaiQ: any = await db.execute(sql`
        SELECT t.financial_account_id AS acc,
               COALESCE(sum(t.amount::numeric - COALESCE(t.amount_paid::numeric, 0)), 0) AS v
        FROM payables t
        WHERE t.status IN ('a_vencer', 'vencida') AND t.deleted_at IS NULL
          AND t.due_date < ${startDate}
        GROUP BY 1`);

      res.json({
        year,
        accounts,
        realizado: { entradas: bucketize((realEntQ as any).rows || []), saidas: bucketize((realSaiQ as any).rows || []) },
        previsto: { entradas: bucketize((prevEntQ as any).rows || []), saidas: bucketize((prevSaiQ as any).rows || []) },
        atrasados: { entradas: scalarize((atrEntQ as any).rows || []), saidas: scalarize((atrSaiQ as any).rows || []) },
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // FASE 3.3 - Backfill de conta bancaria (dryRun por padrao; so preenche NULLs,
  // nunca sobrescreve). Ordem: A) conta do pagamento -> titulo; C) mapa por forma
  // de pagamento; D) legados baixados sem forma -> BB - MATRIZ; B) titulo -> pagamentos.
  app.post('/api/financial/backfill-accounts', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const by = (actorOf(req) as any)?.email || 'backfill-f33';
      const accQ: any = await db.execute(sql`SELECT id, name FROM financial_accounts WHERE is_active = true`);
      const accRows = (((accQ as any).rows || []) as any[]);
      const byName = (n: string) => accRows.find((a: any) => String(a.name).trim().toUpperCase() === n)?.id || null;
      const MATRIZ = byName('BB - MATRIZ');
      const CAIXINHA = byName('CAIXINHA');
      const CARTOES = byName('CARTOES');
      if (!MATRIZ || !CAIXINHA || !CARTOES) {
        return res.status(400).json({ message: 'Contas BB - MATRIZ / CAIXINHA / CARTOES nao encontradas', encontradas: accRows.map((a: any) => a.name) });
      }

      const steps: any[] = [];
      const run = async (label: string, countQ: any, updateQ: any) => {
        const c: any = await db.execute(countQ);
        const candidatos = Number((c as any).rows?.[0]?.n || 0);
        let atualizados = 0;
        if (!dryRun && candidatos > 0) {
          const u: any = await db.execute(updateQ);
          atualizados = Number((u as any)?.rowCount ?? 0);
        }
        steps.push({ step: label, candidatos, atualizados });
      };

      // A0 - normaliza conta vazia ('') para NULL (heranca de importacoes antigas)
      await run('A0a recebiveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM receivables WHERE financial_account_id = ''`,
        sql`UPDATE receivables SET financial_account_id = NULL WHERE financial_account_id = ''`);
      await run('A0b pagaveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM payables WHERE financial_account_id = ''`,
        sql`UPDATE payables SET financial_account_id = NULL WHERE financial_account_id = ''`);
      await run('A0c pagamentos de recebiveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM receivable_payments WHERE financial_account_id = ''`,
        sql`UPDATE receivable_payments SET financial_account_id = NULL WHERE financial_account_id = ''`);
      await run('A0d pagamentos de pagaveis: conta vazia -> NULL',
        sql`SELECT count(*)::int AS n FROM payable_payments WHERE financial_account_id = ''`,
        sql`UPDATE payable_payments SET financial_account_id = NULL WHERE financial_account_id = ''`);

      // A1/A2 - conta do pagamento mais recente -> titulo sem conta
      await run('A1 recebiveis <- conta dos pagamentos',
        sql`SELECT count(*)::int AS n FROM receivables r
            WHERE r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'
              AND EXISTS (SELECT 1 FROM receivable_payments p WHERE p.receivable_id = r.id AND p.financial_account_id IS NOT NULL)`,
        sql`UPDATE receivables r SET financial_account_id = s.acc, updated_by = ${by}, updated_at = now()
            FROM (SELECT DISTINCT ON (receivable_id) receivable_id, financial_account_id AS acc
                  FROM receivable_payments WHERE financial_account_id IS NOT NULL
                  ORDER BY receivable_id, paid_at DESC) s
            WHERE r.id = s.receivable_id AND r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'`);
      await run('A2 pagaveis <- conta dos pagamentos',
        sql`SELECT count(*)::int AS n FROM payables r
            WHERE r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'
              AND EXISTS (SELECT 1 FROM payable_payments p WHERE p.payable_id = r.id AND p.financial_account_id IS NOT NULL)`,
        sql`UPDATE payables r SET financial_account_id = s.acc, updated_by = ${by}, updated_at = now()
            FROM (SELECT DISTINCT ON (payable_id) payable_id, financial_account_id AS acc
                  FROM payable_payments WHERE financial_account_id IS NOT NULL
                  ORDER BY payable_id, paid_at DESC) s
            WHERE r.id = s.payable_id AND r.financial_account_id IS NULL AND r.deleted_at IS NULL AND r.status <> 'cancelada'`);

      // C1/C2 - mapa por forma de pagamento (dinheiro -> CAIXINHA; cartao -> CARTOES; resto -> BB - MATRIZ)
      const mapCase = sql`CASE WHEN payment_method = 'dinheiro' THEN ${CAIXINHA}
                               WHEN payment_method IN ('cartao_credito', 'cartao_debito') THEN ${CARTOES}
                               ELSE ${MATRIZ} END`;
      await run('C1 recebiveis: mapa por forma de pagamento',
        sql`SELECT count(*)::int AS n FROM receivables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('recebida', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`,
        sql`UPDATE receivables SET financial_account_id = ${mapCase}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('recebida', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`);
      await run('C2 pagaveis: mapa por forma de pagamento',
        sql`SELECT count(*)::int AS n FROM payables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('paga', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`,
        sql`UPDATE payables SET financial_account_id = ${mapCase}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL
              AND status IN ('paga', 'a_vencer', 'vencida') AND payment_method IS NOT NULL`);

      // D1/D2 - legados ja baixados sem forma de pagamento -> BB - MATRIZ
      await run('D1 recebidas legadas (sem forma) -> BB - MATRIZ',
        sql`SELECT count(*)::int AS n FROM receivables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'recebida' AND payment_method IS NULL`,
        sql`UPDATE receivables SET financial_account_id = ${MATRIZ}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'recebida' AND payment_method IS NULL`);
      await run('D2 pagas legadas (sem forma) -> BB - MATRIZ',
        sql`SELECT count(*)::int AS n FROM payables
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'paga' AND payment_method IS NULL`,
        sql`UPDATE payables SET financial_account_id = ${MATRIZ}, updated_by = ${by}, updated_at = now()
            WHERE financial_account_id IS NULL AND deleted_at IS NULL AND status = 'paga' AND payment_method IS NULL`);

      // B1/B2 - conta do titulo -> pagamentos sem conta (depois de A/C/D)
      await run('B1 pagamentos de recebiveis <- conta do titulo',
        sql`SELECT count(*)::int AS n FROM receivable_payments p JOIN receivables r ON r.id = p.receivable_id
            WHERE p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`,
        sql`UPDATE receivable_payments p SET financial_account_id = r.financial_account_id
            FROM receivables r WHERE r.id = p.receivable_id
              AND p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`);
      await run('B2 pagamentos de pagaveis <- conta do titulo',
        sql`SELECT count(*)::int AS n FROM payable_payments p JOIN payables r ON r.id = p.payable_id
            WHERE p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`,
        sql`UPDATE payable_payments p SET financial_account_id = r.financial_account_id
            FROM payables r WHERE r.id = p.payable_id
              AND p.financial_account_id IS NULL AND r.financial_account_id IS NOT NULL`);

      try { await logFinancialAudit({ req, action: 'config', entity: 'backfill_accounts', note: (dryRun ? 'dryRun ' : '') + JSON.stringify(steps).slice(0, 900) }); } catch {}
      res.json({ dryRun, contas: { MATRIZ, CAIXINHA, CARTOES }, steps });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // DRE (Income Statement) - Monthly Breakdown
  // ============================================================================

  app.get('/api/financial/dre', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const year = parseInt(req.query.year as string) || new Date().getFullYear();

      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      // FASE 2 - DRE nao considera titulos cancelados.
      const receivables = (await storage.getReceivables({ instanceId, startDate, endDate })).filter((r: any) => String(r.status) !== 'cancelada');
      const payables = (await storage.getPayables({ instanceId, startDate, endDate })).filter((p: any) => String(p.status) !== 'cancelada');
      const chartAccounts = await storage.getChartOfAccounts(instanceId);

      // FASE 3.4l - contas marcadas como fora da DRE (include_in_dre=false) nao geram
      // linhas na DRE. Continuam no accountMap (para nao caírem em "sem categoria") e
      // seguem no fluxo de caixa (regime caixa, por conta bancaria).
      const incFmap = await incDreMap();
      const inDre = (a: any) => incFmap.get(String(a.id)) !== false;

      const accountMap = new Map(chartAccounts.map(a => [a.id, a]));

      const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

      const getMonthIndex = (dateVal: any): number => {
        const d = new Date(dateVal);
        return d.getMonth();
      };

      const buildAccountMonthly = (accountId: string, items: any[], amountField: string = 'amount'): number[] => {
        const monthly = new Array(12).fill(0);
        for (const item of items) {
          if (item.chartAccountId === accountId) {
            const m = getMonthIndex(item.issueDate);
            if (m >= 0 && m < 12) {
              monthly[m] += parseFloat(item[amountField] || '0');
            }
          }
        }
        return monthly;
      }

      const dreGroups = [
        'receita_bruta', 'devolucoes', 'impostos_vendas',
        'cpv',
        'despesas_comerciais', 'despesas_administrativas', 'despesas_gerais',
        'outras_receitas_despesas', 'depreciacao',
        'receitas_financeiras', 'despesas_financeiras',
        'irpj_csll',
      ];

      const lines: any[] = [];

      for (const group of dreGroups) {
        const groupAccounts = chartAccounts.filter(a => a.dreGroup === group && inDre(a)).sort((a, b) => a.code.localeCompare(b.code));
        if (groupAccounts.length === 0) continue;

        const isGroupHeader = groupAccounts.find(a => !a.code.includes('.'));
        const childAccounts = groupAccounts.filter(a => a.code.includes('.'));

        for (const acc of childAccounts) {
          let monthly: number[];
          if (acc.type === 'receita') {
            monthly = buildAccountMonthly(acc.id, receivables);
          } else {
            monthly = buildAccountMonthly(acc.id, payables);
          }
          const total = monthly.reduce((s, v) => s + v, 0);
          lines.push({
            code: acc.code,
            name: acc.name,
            dreGroup: group,
            type: acc.type,
            isHeader: false,
            monthly,
            total,
            accountId: acc.id,
          });
        }
      }

      // FASE 3.1 - Devolucoes no DRE: alimentadas pelas NF-es de devolucao emitidas
      // (nature_of_operation com DEVOLU, ex: CFOP 1.202), pela data de emissao/criacao.
      try {
        const devAcc = chartAccounts.find(a => a.dreGroup === 'devolucoes' && a.code.includes('.') && inDre(a));
        if (devAcc) {
          const instCond = instanceId ? sql`AND omie_instance_id = ${instanceId}` : sql``;
          const dq: any = await db.execute(sql`
            SELECT extract(month FROM COALESCE(emission_date, created_at))::int AS m,
                   COALESCE(sum(total_invoice::numeric), 0) AS v
            FROM fiscal_invoices
            WHERE upper(coalesce(nature_of_operation, '')) LIKE '%DEVOLU%'
              AND COALESCE(emission_date, created_at) >= ${startDate}
              AND COALESCE(emission_date, created_at) <= ${endDate}
              AND status NOT IN ('draft', 'cancelled', 'cancelada', 'rejected', 'rejeitada')
              ${instCond}
            GROUP BY 1`);
          const monthly = new Array(12).fill(0);
          for (const r of ((dq as any).rows || [])) { const mi = Number(r.m) - 1; if (mi >= 0 && mi < 12) monthly[mi] = Number(r.v || 0); }
          const total = monthly.reduce((s, v) => s + v, 0);
          const idx = lines.findIndex(l => l.accountId === devAcc.id);
          const line = { code: devAcc.code, name: devAcc.name, dreGroup: 'devolucoes', type: devAcc.type, isHeader: false, monthly, total, accountId: devAcc.id };
          if (idx >= 0) lines[idx] = line; else lines.push(line);
        }
      } catch {}

      const unclassifiedRecMonthly = new Array(12).fill(0);
      for (const r of receivables) {
        if (!r.chartAccountId || !accountMap.has(r.chartAccountId)) {
          const m = getMonthIndex(r.issueDate);
          if (m >= 0 && m < 12) unclassifiedRecMonthly[m] += parseFloat(r.amount || '0');
        }
      }
      const unclassifiedRecTotal = unclassifiedRecMonthly.reduce((s, v) => s + v, 0);

      const unclassifiedPayMonthly = new Array(12).fill(0);
      for (const p of payables) {
        if (!p.chartAccountId || !accountMap.has(p.chartAccountId)) {
          const m = getMonthIndex(p.issueDate);
          if (m >= 0 && m < 12) unclassifiedPayMonthly[m] += parseFloat(p.amount || '0');
        }
      }
      const unclassifiedPayTotal = unclassifiedPayMonthly.reduce((s, v) => s + v, 0);

      const sumGroupMonthly = (group: string): number[] => {
        const monthly = new Array(12).fill(0);
        for (const line of lines) {
          if (line.dreGroup === group) {
            for (let i = 0; i < 12; i++) monthly[i] += line.monthly[i];
          }
        }
        return monthly;
      }

      const receitaBruta = sumGroupMonthly('receita_bruta');
      const devolucoes = sumGroupMonthly('devolucoes');
      const impostos = sumGroupMonthly('impostos_vendas');
      const cpvTotal = sumGroupMonthly('cpv');
      const despCom = sumGroupMonthly('despesas_comerciais');
      const despAdm = sumGroupMonthly('despesas_administrativas');
      const despGer = sumGroupMonthly('despesas_gerais');
      const outrasRD = sumGroupMonthly('outras_receitas_despesas');
      const depreciacao = sumGroupMonthly('depreciacao');
      const recFin = sumGroupMonthly('receitas_financeiras');
      const despFin = sumGroupMonthly('despesas_financeiras');
      const irpj = sumGroupMonthly('irpj_csll');

      const receitaLiquida = receitaBruta.map((v, i) => v - devolucoes[i] - impostos[i]);
      const lucroBruto = receitaLiquida.map((v, i) => v - cpvTotal[i]);
      const despOpTotal = despCom.map((v, i) => v + despAdm[i] + despGer[i] + outrasRD[i]);
      const ebitdaCalc = lucroBruto.map((v, i) => v - despCom[i] - despAdm[i] - despGer[i] - outrasRD[i]);
      const ebitCalc = ebitdaCalc.map((v, i) => v - depreciacao[i]);
      const resultadoFinanceiro = recFin.map((v, i) => v - despFin[i]);
      const resultadoAntesIR = ebitCalc.map((v, i) => v - despFin[i] + recFin[i]);
      const lucroLiquido = resultadoAntesIR.map((v, i) => v - irpj[i]);

      const sumArr = (arr: number[]) => arr.reduce((s, v) => s + v, 0);

      const computed = {
        receitaBruta: { monthly: receitaBruta, total: sumArr(receitaBruta) },
        devolucoes: { monthly: devolucoes, total: sumArr(devolucoes) },
        impostos: { monthly: impostos, total: sumArr(impostos) },
        receitaLiquida: { monthly: receitaLiquida, total: sumArr(receitaLiquida) },
        cpvTotal: { monthly: cpvTotal, total: sumArr(cpvTotal) },
        lucroBruto: { monthly: lucroBruto, total: sumArr(lucroBruto) },
        despesasComerciais: { monthly: despCom, total: sumArr(despCom) },
        despesasAdministrativas: { monthly: despAdm, total: sumArr(despAdm) },
        despesasGerais: { monthly: despGer, total: sumArr(despGer) },
        outrasReceitasDespesas: { monthly: outrasRD, total: sumArr(outrasRD) },
        despesasOperacionaisTotal: { monthly: despOpTotal.map((v, i) => v + depreciacao[i]), total: sumArr(despOpTotal) + sumArr(depreciacao) },
        depreciacao: { monthly: depreciacao, total: sumArr(depreciacao) },
        ebitda: { monthly: ebitdaCalc, total: sumArr(ebitdaCalc) },
        ebit: { monthly: ebitCalc, total: sumArr(ebitCalc) },
        receitasFinanceiras: { monthly: recFin, total: sumArr(recFin) },
        despesasFinanceiras: { monthly: despFin, total: sumArr(despFin) },
        resultadoFinanceiro: { monthly: resultadoFinanceiro, total: sumArr(resultadoFinanceiro) },
        resultadoAntesIR: { monthly: resultadoAntesIR, total: sumArr(resultadoAntesIR) },
        irpjCsll: { monthly: irpj, total: sumArr(irpj) },
        lucroLiquido: { monthly: lucroLiquido, total: sumArr(lucroLiquido) },
        unclassifiedReceivables: { monthly: unclassifiedRecMonthly, total: unclassifiedRecTotal },
        unclassifiedPayables: { monthly: unclassifiedPayMonthly, total: unclassifiedPayTotal },
      };

      res.json({
        year,
        months,
        lines,
        computed,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // XML SEARCH (from fiscal_invoices)
  // ============================================================================

  app.get('/api/financial/xml-documents', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { db } = await import('./db');
      const { fiscalInvoices } = await import('@shared/schema');
      const { eq, and, gte, lte, desc, isNotNull, or, like } = await import('drizzle-orm');
      
      const conditions: any[] = [];
      
      if (req.query.instanceId) {
        conditions.push(eq(fiscalInvoices.omieInstanceId, req.query.instanceId as string));
      }
      if (req.query.status) {
        conditions.push(eq(fiscalInvoices.status, req.query.status as string));
      }
      if (req.query.startDate) {
        conditions.push(gte(fiscalInvoices.emissionDate, new Date(req.query.startDate as string)));
      }
      if (req.query.endDate) {
        conditions.push(lte(fiscalInvoices.emissionDate, new Date(req.query.endDate as string)));
      }
      if (req.query.customerName) {
        conditions.push(like(fiscalInvoices.customerName, `%${req.query.customerName}%`));
      }
      if (req.query.accessKey) {
        conditions.push(eq(fiscalInvoices.accessKey, req.query.accessKey as string));
      }

      const hasXml = or(
        isNotNull(fiscalInvoices.xmlEnvio),
        isNotNull(fiscalInvoices.xmlRetorno),
        isNotNull(fiscalInvoices.xmlAutorizacao)
      );

      let query;
      if (conditions.length > 0) {
        query = db.select({
          id: fiscalInvoices.id,
          invoiceNumber: fiscalInvoices.invoiceNumber,
          series: fiscalInvoices.series,
          accessKey: fiscalInvoices.accessKey,
          status: fiscalInvoices.status,
          customerName: fiscalInvoices.customerName,
          customerCnpjCpf: fiscalInvoices.customerCnpjCpf,
          issuerName: fiscalInvoices.issuerName,
          issuerCnpj: fiscalInvoices.issuerCnpj,
          totalInvoice: fiscalInvoices.totalInvoice,
          emissionDate: fiscalInvoices.emissionDate,
          omieInstanceId: fiscalInvoices.omieInstanceId,
          hasXmlEnvio: fiscalInvoices.xmlEnvio,
          hasXmlRetorno: fiscalInvoices.xmlRetorno,
          hasXmlAutorizacao: fiscalInvoices.xmlAutorizacao,
        }).from(fiscalInvoices).where(and(...conditions)).orderBy(desc(fiscalInvoices.emissionDate));
      } else {
        query = db.select({
          id: fiscalInvoices.id,
          invoiceNumber: fiscalInvoices.invoiceNumber,
          series: fiscalInvoices.series,
          accessKey: fiscalInvoices.accessKey,
          status: fiscalInvoices.status,
          customerName: fiscalInvoices.customerName,
          customerCnpjCpf: fiscalInvoices.customerCnpjCpf,
          issuerName: fiscalInvoices.issuerName,
          issuerCnpj: fiscalInvoices.issuerCnpj,
          totalInvoice: fiscalInvoices.totalInvoice,
          emissionDate: fiscalInvoices.emissionDate,
          omieInstanceId: fiscalInvoices.omieInstanceId,
          hasXmlEnvio: fiscalInvoices.xmlEnvio,
          hasXmlRetorno: fiscalInvoices.xmlRetorno,
          hasXmlAutorizacao: fiscalInvoices.xmlAutorizacao,
        }).from(fiscalInvoices).orderBy(desc(fiscalInvoices.emissionDate));
      }

      const results = await query;
      
      const mapped = results.map(r => ({
        ...r,
        hasXmlEnvio: !!r.hasXmlEnvio,
        hasXmlRetorno: !!r.hasXmlRetorno,
        hasXmlAutorizacao: !!r.hasXmlAutorizacao,
      }));

      res.json(mapped);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/xml-documents/:id/download/:type', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const { db } = await import('./db');
      const { fiscalInvoices } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');

      const [invoice] = await db.select().from(fiscalInvoices).where(eq(fiscalInvoices.id, req.params.id));
      if (!invoice) return res.status(404).json({ message: 'NF-e não encontrada' });

      let xml: string | null = null;
      let filename = '';

      switch (req.params.type) {
        case 'envio':
          xml = invoice.xmlEnvio;
          filename = `nfe_envio_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        case 'retorno':
          xml = invoice.xmlRetorno;
          filename = `nfe_retorno_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        case 'autorizacao':
          xml = invoice.xmlAutorizacao;
          filename = `nfe_autorizacao_${invoice.invoiceNumber || invoice.id}.xml`;
          break;
        default:
          return res.status(400).json({ message: 'Tipo de XML inválido' });
      }

      if (!xml) return res.status(404).json({ message: 'XML não disponível' });

      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(xml);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // ============================================================================
  // SPED FISCAL
  // ============================================================================

  app.get('/api/financial/sped-exports', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const instanceId = req.query.instanceId as string | undefined;
      const exports = await storage.getSpedExports(instanceId);
      res.json(exports);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post('/api/financial/sped-exports/generate', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const user = actorOf(req);
      const { type, periodStart, periodEnd, omieInstanceId } = req.body;

      if (!type || !periodStart || !periodEnd) {
        return res.status(400).json({ message: 'Tipo, período inicial e final são obrigatórios' });
      }

      const { db } = await import('./db');
      const { fiscalInvoices, fiscalInvoiceItems } = await import('@shared/schema');
      const { eq, and, gte, lte, desc } = await import('drizzle-orm');

      const conditions: any[] = [
        gte(fiscalInvoices.emissionDate, new Date(periodStart)),
        lte(fiscalInvoices.emissionDate, new Date(periodEnd)),
      ];
      if (omieInstanceId) {
        conditions.push(eq(fiscalInvoices.omieInstanceId, omieInstanceId));
      }

      const invoices = await db.select().from(fiscalInvoices)
        .where(and(...conditions))
        .orderBy(desc(fiscalInvoices.emissionDate));

      const allItems: any[] = [];
      for (const inv of invoices) {
        const items = await db.select().from(fiscalInvoiceItems)
          .where(eq(fiscalInvoiceItems.invoiceId, inv.id));
        allItems.push(...items.map(item => ({ ...item, invoice: inv })));
      }

      const receivablesList = await storage.getReceivables({
        instanceId: omieInstanceId,
        startDate: new Date(periodStart),
        endDate: new Date(periodEnd),
      });

      const payablesList = await storage.getPayables({
        instanceId: omieInstanceId,
        startDate: new Date(periodStart),
        endDate: new Date(periodEnd),
      });

      let content = '';

      if (type === 'SPED_FISCAL') {
        content = generateSpedFiscal(invoices, allItems, receivablesList, payablesList, periodStart, periodEnd, omieInstanceId);
      } else if (type === 'BLOCO_K') {
        content = generateBlocoK(invoices, allItems, periodStart, periodEnd);
      } else {
        return res.status(400).json({ message: 'Tipo inválido. Use SPED_FISCAL ou BLOCO_K' });
      }

      const fileName = `${type}_${omieInstanceId || 'ALL'}_${periodStart.substring(0,7)}.txt`;

      const spedExport = await storage.createSpedExport({
        type,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        omieInstanceId: omieInstanceId || null,
        fileName,
        fileContent: content,
        status: 'generated',
        createdBy: user?.email || null,
      });

      res.status(201).json(spedExport);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get('/api/financial/sped-exports/:id/download', authenticateUser, isFinancialAuthorized, async (req, res) => {
    try {
      const exports = await storage.getSpedExports();
      const spedExport = exports.find(e => e.id === req.params.id);
      if (!spedExport) return res.status(404).json({ message: 'Exportação não encontrada' });

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${spedExport.fileName}"`);
      res.send(spedExport.fileContent || '');
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

function formatDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

function formatDecimal(value: string | number | null, decimals = 2): string {
  const num = typeof value === 'string' ? parseFloat(value) : (value || 0);
  return num.toFixed(decimals).replace('.', ',');
}

function generateSpedFiscal(
  invoices: any[], 
  items: any[], 
  receivables: any[],
  payables: any[],
  periodStart: string, 
  periodEnd: string,
  instanceId?: string
): string {
  const lines: string[] = [];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  lines.push(`|0000|016|0|${formatDate(start)}|${formatDate(end)}|||${instanceId || ''}||||A|1|`);
  lines.push(`|0001|0|`);
  lines.push(`|0005|||||||||`);
  lines.push(`|0100|||||||||||||||||`);

  const productMap = new Map<string, any>();
  items.forEach(item => {
    if (item.productCode && !productMap.has(item.productCode)) {
      productMap.set(item.productCode, item);
    }
  });

  let itemIdx = 0;
  productMap.forEach((item, code) => {
    lines.push(`|0200|${code}|${item.productName || ''}||${item.ncm || ''}||${item.unit || 'UN'}|0|0|||0|`);
    itemIdx++;
  });

  lines.push(`|0990|${lines.length + 1}|`);

  lines.push(`|C001|0|`);
  
  invoices.forEach((inv, idx) => {
    const invItems = items.filter(i => i.invoice?.id === inv.id);
    lines.push(`|C100|0|1|${inv.customerCnpjCpf || ''}|55|00|${inv.series || '1'}|${inv.invoiceNumber || ''}|${inv.accessKey || ''}|${formatDate(inv.emissionDate || new Date())}|${formatDate(inv.emissionDate || new Date())}|${formatDecimal(inv.totalProducts)}|0,00|0,00|${formatDecimal(inv.totalDiscount)}|0,00|0,00|0,00|${formatDecimal(inv.totalProducts)}|9|0,00|${formatDecimal(inv.totalIcms)}|0,00|0,00|${formatDecimal(inv.totalPis)}|${formatDecimal(inv.totalCofins)}|0,00|0,00|0,00|0,00|`);
    
    invItems.forEach((item, itemIdx) => {
      lines.push(`|C170|${itemIdx + 1}|${item.productCode || ''}|${item.productName || ''}|${formatDecimal(item.quantity)}|${item.unit || 'UN'}|${formatDecimal(item.unitPrice)}|${formatDecimal(item.totalPrice)}|0,00|0|${item.cfop || inv.cfop || ''}|0|0,00|0,00|0,00|0,00|0,00|${item.ncm || ''}|0,00|0,00|0,00|0,00|`);
    });

    lines.push(`|C190|${inv.cfop || ''}|0|${formatDecimal(inv.totalProducts)}|${formatDecimal(inv.totalIcms)}|0,00|0,00|0,00|0,00|0,00|0,00|`);
  });

  lines.push(`|C990|${lines.length + 1}|`);

  lines.push(`|E001|0|`);
  lines.push(`|E100|${formatDate(start)}|${formatDate(end)}|`);
  lines.push(`|E110|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|0,00|`);
  lines.push(`|E990|${lines.length + 1}|`);

  lines.push(`|H001|0|`);
  lines.push(`|H005|${formatDate(end)}|0,00|0|`);
  lines.push(`|H990|${lines.length + 1}|`);

  lines.push(`|9001|0|`);
  lines.push(`|9900|0000|1|`);
  lines.push(`|9900|9999|1|`);
  lines.push(`|9990|${lines.length + 1}|`);
  lines.push(`|9999|${lines.length + 1}|`);

  return lines.join('\r\n');
}

function generateBlocoK(
  invoices: any[], 
  items: any[],
  periodStart: string, 
  periodEnd: string
): string {
  const lines: string[] = [];
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  lines.push(`|0000|016|0|${formatDate(start)}|${formatDate(end)}||||||||A|1|`);
  
  lines.push(`|K001|0|`);
  lines.push(`|K100|${formatDate(start)}|${formatDate(end)}|`);

  const productMap = new Map<string, { code: string; name: string; totalQty: number }>();
  items.forEach(item => {
    const code = item.productCode || '';
    if (code) {
      const existing = productMap.get(code);
      if (existing) {
        existing.totalQty += parseFloat(item.quantity || '0');
      } else {
        productMap.set(code, {
          code,
          name: item.productName || '',
          totalQty: parseFloat(item.quantity || '0'),
        });
      }
    }
  });

  productMap.forEach((prod) => {
    lines.push(`|K200|${formatDate(end)}|${prod.code}|${formatDecimal(prod.totalQty)}|0|0,00|`);
  });

  invoices.forEach((inv) => {
    const invItems = items.filter(i => i.invoice?.id === inv.id);
    if (invItems.length > 0) {
      lines.push(`|K230|${formatDate(inv.emissionDate || new Date())}|${invItems[0]?.productCode || ''}|${formatDecimal(invItems.reduce((sum: number, i: any) => sum + parseFloat(i.quantity || '0'), 0))}|`);
    }
  });

  lines.push(`|K990|${lines.length + 1}|`);

  lines.push(`|9001|0|`);
  lines.push(`|9900|K001|1|`);
  lines.push(`|9990|${lines.length + 1}|`);
  lines.push(`|9999|${lines.length + 1}|`);

  return lines.join('\r\n');
}
