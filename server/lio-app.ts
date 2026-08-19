// ============================================================================
// CIELO SMART — API PARA O APP DO BALCAO (integracao via Deep Link)
// ----------------------------------------------------------------------------
// Contexto: a integracao REMOTA foi descartada. O realm que a Cielo entregou
// (api-hml-mtls.cielo.com.br) exige certificado de cliente mTLS, e a orientacao
// da propria Cielo foi desenvolver um app Android que roda na maquininha.
//
// Neste desenho, o INTEGRA nao fala com a Cielo. Quem fala e o app, por Deep
// Link, dentro do aparelho:
//
//     App INTEGRA Balcao  --lio://payment?request=<base64>--> com.ads.lio.uriappclient
//                         <--order://response?response=<base64>--
//            |
//            | HTTPS comum (este arquivo). Sem mTLS.
//            v
//     INTEGRA (Railway)
//
// Este modulo expoe as DUAS rotas que o app consome:
//   GET  /api/lio-app/pedidos-pendentes     -> o que ha para cobrar
//   POST /api/lio-app/pedido/:id/pago       -> resultado da cobranca
//
// GANHO REAL: a Order Manager nao tem webhook, e por isso a versao remota
// precisava de polling + job de conciliacao. Aqui o app avisa na hora — ele E o
// webhook que a API nunca teve.
//
// AUTENTICACAO: token POR DISPOSITIVO, gerado aqui — NAO sao as credenciais da
// Cielo. As credenciais da Cielo (client-id / access-token) ficam no app e vao
// no JSON do Deep Link; nunca passam por estas rotas.
// Guardamos apenas o SHA-256 do token: vazamento do banco nao entrega acesso.
// ============================================================================
import type { Express, Request, Response, NextFunction } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { authenticateUser } from './authMiddleware';

// statusCode do retorno da Cielo — o campo que separa venda de estorno.
// Ignorar isso significa dar baixa num cancelamento como se fosse venda.
const STATUS_CODE_PIX = '0';
const STATUS_CODE_AUTORIZADA = '1';
const STATUS_CODE_CANCELAMENTO = '2';

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let _schemaPronto = false;
async function ensureSchema(): Promise<void> {
  if (_schemaPronto) return;

  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS lio_dispositivos (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    nome varchar NOT NULL,
    token_hash varchar NOT NULL UNIQUE,
    ativo boolean NOT NULL DEFAULT true,
    merchant_code varchar,
    last_seen_at timestamp,
    created_at timestamp DEFAULT now(),
    revoked_at timestamp
  )`));

  // A tabela lio_pedidos nasceu na integracao remota. Continua sendo a fila do
  // balcao — muda so quem executa a cobranca. Evoluida por ALTER para nao
  // perder o historico ja gravado.
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS lio_pedidos (
    id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id varchar UNIQUE,
    reference varchar NOT NULL,
    sales_card_id varchar,
    status varchar NOT NULL DEFAULT 'AGUARDANDO',
    amount numeric(10,2),
    nsu varchar,
    card_brand varchar,
    authorization_code varchar,
    liquidado boolean NOT NULL DEFAULT false,
    paid_at timestamp,
    checagens int NOT NULL DEFAULT 0,
    last_check_at timestamp,
    error text,
    payload text,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  )`));

  for (const alter of [
    `ALTER TABLE lio_pedidos ALTER COLUMN order_id DROP NOT NULL`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS origem varchar NOT NULL DEFAULT 'remota'`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS dispositivo_id varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS payment_transaction_id varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS status_code varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS cielo_code varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS terminal varchar`,
    `ALTER TABLE lio_pedidos ADD COLUMN IF NOT EXISTS installments int`,
  ]) {
    try { await db.execute(sql.raw(alter)); } catch { /* coluna ja existe / banco antigo */ }
  }

  // Chave de idempotencia da liquidacao vinda do app: se a rede oscilar no meio
  // do POST, o app reenvia e o indice impede lancamento duplicado.
  try {
    await db.execute(sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_lio_pedidos_ptid
       ON lio_pedidos (payment_transaction_id) WHERE payment_transaction_id IS NOT NULL`
    ));
  } catch { /* indice parcial nao suportado no banco antigo */ }

  try {
    await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS idx_lio_pedidos_fila ON lio_pedidos (status, origem)`));
  } catch { /* noop */ }

  _schemaPronto = true;
}

// ---------------------------------------------------------------------------
// Autenticacao do dispositivo
// ---------------------------------------------------------------------------
export type ReqDispositivo = Request & { dispositivo?: { id: string; nome: string; merchantCode: string | null } };

async function autenticarDispositivo(req: ReqDispositivo, res: Response, next: NextFunction) {
  try {
    await ensureSchema();
    const header = String(req.headers['authorization'] || '');
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ message: 'Token do dispositivo ausente.' });

    const r: any = await db.execute(sql`SELECT id, nome, merchant_code, ativo
      FROM lio_dispositivos WHERE token_hash = ${sha256(token)} LIMIT 1`);
    const d = ((r.rows || r) as any[])[0];
    if (!d || d.ativo !== true) return res.status(401).json({ message: 'Dispositivo nao autorizado.' });

    void db.execute(sql`UPDATE lio_dispositivos SET last_seen_at = now() WHERE id = ${d.id}`).catch(() => {});
    req.dispositivo = { id: String(d.id), nome: String(d.nome), merchantCode: d.merchant_code || null };
    next();
  } catch (e: any) {
    res.status(500).json({ message: String(e?.message || e) });
  }
}

// ---------------------------------------------------------------------------
// Liquidacao — mesmo caminho de faturamento de sempre
// ---------------------------------------------------------------------------
export type RetornoPagamentoApp = {
  paymentTransactionId?: string;
  orderId?: string;
  authCode?: string;
  cieloCode?: string;
  brand?: string;
  mask?: string;
  installments?: number;
  terminal?: string;
  statusCode?: string;
  paidAmount?: number; // centavos
};

/**
 * Registra o pagamento e empurra para o pipeline. Idempotente por claim atomico
 * (liquidado = false -> true): se o app reenviar, o segundo POST nao fatura de
 * novo.
 *
 * Reusa reconcilePendingOrders — o MESMO caminho do cartao do hotsite, do PIX e
 * do Link de Pagamento. Nao existe um segundo caminho de faturamento so para o
 * balcao.
 */
async function liquidarPedidoApp(id: string, d: RetornoPagamentoApp): Promise<{ liquidado: boolean; motivo?: string }> {
  await ensureSchema();

  const claim: any = await db.execute(sql`UPDATE lio_pedidos SET
      liquidado = true,
      status = 'PAGO',
      status_code = ${d.statusCode || null},
      order_id = COALESCE(order_id, ${d.orderId || null}),
      payment_transaction_id = ${d.paymentTransactionId || null},
      authorization_code = ${d.authCode || null},
      cielo_code = ${d.cieloCode || null},
      nsu = ${d.cieloCode || d.authCode || null},
      card_brand = ${d.brand || null},
      terminal = ${d.terminal || null},
      installments = ${Number.isFinite(d.installments as number) ? Number(d.installments) : null},
      paid_at = now(),
      updated_at = now()
    WHERE id = ${id} AND liquidado = false`);

  const ganhou = (claim.rowCount ?? claim?.rows?.length ?? 0) === 1;
  if (!ganhou) return { liquidado: false, motivo: 'ja_liquidado' };

  const r: any = await db.execute(sql`SELECT sales_card_id FROM lio_pedidos WHERE id = ${id} LIMIT 1`);
  const salesCardId = ((r.rows || r) as any[])[0]?.sales_card_id;
  if (!salesCardId) {
    console.log(`✅ [LIO-APP] Pedido ${id} pago (venda avulsa, sem pedido do INTEGRA).`);
    return { liquidado: true, motivo: 'sem_sales_card' };
  }

  const detalhe = [
    d.brand ? `bandeira ${d.brand}` : null,
    d.cieloCode ? `NSU ${d.cieloCode}` : null,
    d.authCode ? `aut. ${d.authCode}` : null,
    d.statusCode === STATUS_CODE_PIX ? 'via Pix' : null,
  ].filter(Boolean).join(', ');

  try {
    await db.execute(sql`UPDATE sales_cards SET notes = COALESCE(notes,'') ||
      ${'\n🧾 PAGO na maquininha Cielo Smart' + (detalhe ? ' (' + detalhe + ')' : '') + '.'}
      WHERE id = ${salesCardId}`);
  } catch { /* nota e cosmetica, nunca bloqueia a baixa */ }

  try {
    const { reconcilePendingOrders } = await import('./billing-pipeline-routes');
    const rr = await reconcilePendingOrders({ apply: true, minAgeMinutes: 0, cardIds: [salesCardId] });
    console.log(`🚀 [LIO-APP] Pedido ${id} enviado ao pipeline (recovered=${rr?.recovered}).`);
  } catch (e: any) {
    // Dinheiro ja entrou. Marca o erro e deixa o cron do pipeline recuperar —
    // nao tenta de novo aqui para nao duplicar lancamento.
    await db.execute(sql`UPDATE lio_pedidos SET error = ${String(e?.message || e)}, updated_at = now() WHERE id = ${id}`);
    console.warn(`⚠️ [LIO-APP] Pago, mas envio ao pipeline falhou (${id}):`, e?.message || e);
  }
  return { liquidado: true };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
export function registerLioApp(app: Express): void {

  // =========================================================================
  // ROTAS DO APP (token de dispositivo)
  // =========================================================================

  /**
   * Credenciais da Cielo entregues em runtime, apos o app se autenticar com o
   * token do dispositivo.
   *
   * POR QUE NAO EMBUTIR NO APK: um APK e um zip — client-id e access-token
   * dentro dele sao extraiveis por qualquer um com o arquivo, e trocar exige
   * publicar versao nova e esperar a frota atualizar. Aqui o unico segredo no
   * aparelho e o token do dispositivo, que e revogavel numa chamada.
   */
  app.get('/api/lio-app/config', autenticarDispositivo, async (req: ReqDispositivo, res) => {
    const clientID = (process.env.CIELO_LIO_CLIENT_ID || '').trim();
    const accessToken = (process.env.CIELO_LIO_ACCESS_TOKEN || '').trim();
    if (!clientID || !accessToken) {
      return res.status(503).json({ message: 'Credenciais da Cielo ausentes no servidor (CIELO_LIO_CLIENT_ID / CIELO_LIO_ACCESS_TOKEN).' });
    }
    res.json({
      clientID,
      accessToken,
      merchantCode: req.dispositivo!.merchantCode || null,
      dispositivo: req.dispositivo!.nome,
    });
  });

  /**
   * O app lista o que ha para cobrar. Devolve ja no formato que o app precisa
   * para montar o JSON do Deep Link — inclusive os precos em CENTAVOS, que e o
   * que a Cielo espera em `value` e `unitPrice`.
   */
  app.get('/api/lio-app/pedidos-pendentes', autenticarDispositivo, async (req: ReqDispositivo, res) => {
    try {
      const limite = Math.min(Math.max(parseInt(String(req.query.limite || '50'), 10) || 50, 1), 200);
      const r: any = await db.execute(sql`SELECT id, reference, amount, payload, sales_card_id, created_at
        FROM lio_pedidos
        WHERE origem = 'app' AND liquidado = false AND status = 'AGUARDANDO'
          AND (dispositivo_id IS NULL OR dispositivo_id = ${req.dispositivo!.id})
        ORDER BY created_at ASC LIMIT ${limite}`);

      const pedidos = ((r.rows || r) as any[]).map((l) => {
        let itens: any[] = [];
        try { itens = JSON.parse(l.payload || '{}')?.itens || []; } catch { /* payload corrompido nao derruba a fila */ }
        return {
          id: String(l.id),
          reference: l.reference,
          valorCentavos: Math.round(Number(l.amount || 0) * 100),
          itens,
          salesCardId: l.sales_card_id || null,
          criadoEm: l.created_at,
        };
      });

      res.json({ dispositivo: req.dispositivo!.nome, total: pedidos.length, pedidos });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /**
   * O app devolve o resultado da cobranca. Corpo esperado: os campos extraidos
   * do JSON que veio em Base64 no `order://response`.
   */
  app.post('/api/lio-app/pedido/:id/pago', autenticarDispositivo, async (req: ReqDispositivo, res) => {
    const id = String(req.params.id);
    try {
      await ensureSchema();
      const b = (req.body || {}) as RetornoPagamentoApp;
      const statusCode = b.statusCode != null ? String(b.statusCode) : '';

      // Um cancelamento chega no MESMO formato de um pagamento. Recusar aqui e
      // o que impede um estorno de ser faturado como venda.
      if (statusCode === STATUS_CODE_CANCELAMENTO) {
        await db.execute(sql`UPDATE lio_pedidos SET status = 'CANCELADO', status_code = ${statusCode}, updated_at = now()
          WHERE id = ${id} AND liquidado = false`);
        return res.status(409).json({
          message: 'statusCode=2 e cancelamento, nao pagamento. Pedido marcado como CANCELADO, nada foi faturado.',
        });
      }
      if (statusCode && statusCode !== STATUS_CODE_AUTORIZADA && statusCode !== STATUS_CODE_PIX) {
        return res.status(400).json({ message: `statusCode "${statusCode}" nao reconhecido como pagamento.` });
      }

      const existe: any = await db.execute(sql`SELECT id, liquidado FROM lio_pedidos WHERE id = ${id} LIMIT 1`);
      const linha = ((existe.rows || existe) as any[])[0];
      if (!linha) return res.status(404).json({ message: 'Pedido nao encontrado.' });
      if (linha.liquidado === true) return res.json({ ok: true, jaLiquidado: true });

      const r = await liquidarPedidoApp(id, b);
      res.json({ ok: true, ...r });
    } catch (e: any) {
      // Idempotencia via indice: o reenvio do app cai aqui e responde ok.
      if (/idx_lio_pedidos_ptid|duplicate key/i.test(String(e?.message || e))) {
        return res.json({ ok: true, jaLiquidado: true });
      }
      console.error(`❌ [LIO-APP] Falha ao liquidar ${id}:`, e?.message || e);
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /** O app relata falha/cancelamento pelo usuario (codigos 1 a 4 da Cielo). */
  app.post('/api/lio-app/pedido/:id/erro', autenticarDispositivo, async (req: ReqDispositivo, res) => {
    try {
      await ensureSchema();
      const { code, reason } = req.body || {};
      await db.execute(sql`UPDATE lio_pedidos
        SET status = 'FALHOU', error = ${`code=${code ?? '?'} ${String(reason || '')}`.trim()}, updated_at = now()
        WHERE id = ${String(req.params.id)} AND liquidado = false`);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  // =========================================================================
  // ROTAS ADMIN (sessao do INTEGRA)
  // =========================================================================

  /** Coloca um pedido na fila do balcao. Substitui o antigo /lio/enviar. */
  app.post('/api/admin/lio-app/enfileirar', authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const { reference, itens, salesCardId, dispositivoId } = req.body || {};
      if (!String(reference || '').trim()) return res.status(400).json({ message: 'reference e obrigatorio' });
      const lista: any[] = Array.isArray(itens) ? itens : [];
      if (!lista.length) return res.status(400).json({ message: 'Pedido sem itens' });

      // Guarda de centavos: preco fracionario quase sempre e reais enviados por
      // engano — cobraria 100x do cliente. Recusa antes de entrar na fila.
      for (const it of lista) {
        const p = Number(it?.unitPrice);
        const q = Number(it?.quantity);
        if (!Number.isInteger(p) || p <= 0) {
          return res.status(400).json({ message: `Item "${it?.name}": unitPrice deve ser inteiro em CENTAVOS (recebido ${it?.unitPrice}).` });
        }
        if (!Number.isFinite(q) || q <= 0) {
          return res.status(400).json({ message: `Item "${it?.name}": quantidade invalida.` });
        }
      }
      const totalCentavos = lista.reduce((s, it) => s + Number(it.unitPrice) * Number(it.quantity), 0);

      if (salesCardId) {
        // TRAVA FINANCEIRA — a mais importante deste arquivo.
        // O mesmo pedido pode ser cobrado por Link de Pagamento, PIX da loja,
        // cartao do hotsite E agora pela maquininha. orderAlreadyPaid() e a
        // unica funcao que conhece TODOS esses caminhos. Reimplementar essa
        // verificacao aqui seria abrir a porta para cobranca em dobro no
        // cliente — por isso reusamos a de sempre.
        const { orderAlreadyPaid } = await import('./payment-link');
        if (await orderAlreadyPaid(String(salesCardId))) {
          return res.status(409).json({ message: 'Pedido ja esta pago por outro meio. Nao foi enfileirado para evitar cobranca em dobro.' });
        }
        // Tambem evita duas filas abertas para o mesmo pedido (dois operadores,
        // ou duplo clique): o segundo enfileiramento devolve o primeiro.
        const dup: any = await db.execute(sql`SELECT id FROM lio_pedidos
          WHERE sales_card_id = ${String(salesCardId)} AND liquidado = false AND status = 'AGUARDANDO' LIMIT 1`);
        const jaNaFila = ((dup.rows || dup) as any[])[0];
        if (jaNaFila) {
          return res.status(200).json({ id: jaNaFila.id, reference, valorCentavos: totalCentavos, jaEstavaNaFila: true });
        }
      }

      const r: any = await db.execute(sql`INSERT INTO lio_pedidos
        (reference, sales_card_id, status, origem, dispositivo_id, amount, payload)
        VALUES (${String(reference)}, ${salesCardId || null}, 'AGUARDANDO', 'app',
                ${dispositivoId || null}, ${(totalCentavos / 100).toFixed(2)},
                ${JSON.stringify({ itens: lista })})
        RETURNING id`);
      const id = ((r.rows || r) as any[])[0]?.id;
      res.status(201).json({ id, reference, valorCentavos: totalCentavos });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /** Cadastra um dispositivo e devolve o token — exibido UMA unica vez. */
  app.post('/api/admin/lio-app/dispositivos', authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const nome = String(req.body?.nome || '').trim();
      if (!nome) return res.status(400).json({ message: 'nome e obrigatorio' });
      const token = randomBytes(32).toString('hex');
      const r: any = await db.execute(sql`INSERT INTO lio_dispositivos (nome, token_hash, merchant_code)
        VALUES (${nome}, ${sha256(token)}, ${String(req.body?.merchantCode || '') || null}) RETURNING id`);
      res.status(201).json({
        id: ((r.rows || r) as any[])[0]?.id,
        nome,
        token,
        aviso: 'Guarde este token agora: ele nao pode ser recuperado depois (guardamos so o hash).',
      });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  app.get('/api/admin/lio-app/dispositivos', authenticateUser, async (_req: any, res) => {
    try {
      await ensureSchema();
      const r: any = await db.execute(sql`SELECT id, nome, ativo, merchant_code, last_seen_at, created_at, revoked_at
        FROM lio_dispositivos ORDER BY created_at DESC`);
      res.json({ dispositivos: (r.rows || r) as any[] });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  app.post('/api/admin/lio-app/dispositivos/:id/revogar', authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      await db.execute(sql`UPDATE lio_dispositivos SET ativo = false, revoked_at = now() WHERE id = ${String(req.params.id)}`);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  /** Fila e historico do balcao — base da tela de conciliacao do caixa. */
  app.get('/api/admin/lio-app/pedidos', authenticateUser, async (req: any, res) => {
    try {
      await ensureSchema();
      const dias = Math.min(Math.max(parseInt(String(req.query.dias || '7'), 10) || 7, 1), 90);
      const r: any = await db.execute(sql`SELECT * FROM lio_pedidos
        WHERE created_at > now() - (${String(dias)} || ' days')::interval
        ORDER BY created_at DESC LIMIT 500`);
      const linhas = (r.rows || r) as any[];
      res.json({
        total: linhas.length,
        pagos: linhas.filter(l => l.liquidado).length,
        aguardando: linhas.filter(l => !l.liquidado && l.status === 'AGUARDANDO').length,
        pedidos: linhas,
      });
    } catch (e: any) {
      res.status(500).json({ message: String(e?.message || e) });
    }
  });

  console.log('📱 [LIO-APP] Rotas do app do balcao registradas (Deep Link, sem mTLS)');
}
