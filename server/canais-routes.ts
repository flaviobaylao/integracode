// ============================================================================
// INTEGRA 2.0 — CANAIS DE VENDA (Hotsite e Instagram) — 04/ago/2026
//
// Pagina unica (client/src/pages/Canais.tsx) que reune a gestao dos canais
// digitais. Este arquivo expoe o que a tela precisa:
//
//   GET  /api/canais/resumo                 -> contadores dos 2 canais
//   GET  /api/canais/pedidos?canal=...      -> pedidos do canal (sales_cards)
//   DELETE /api/canais/pedidos/:id          -> exclui pedido do canal (SOMENTE admin)
//   GET  /api/canais/hotsite/config         -> regras do canal Hotsite
//   POST /api/canais/hotsite/config         -> grava as regras
//   GET  /api/canais/hotsite/pagamentos     -> status REAL dos meios de pagamento
//   GET  /api/canais/instagram/config       -> regras do canal Instagram (IA)
//   POST /api/canais/instagram/config       -> grava as regras
//
// PRINCIPIO: esta tela NAO inventa regra nova. Ela expoe as regras que o codigo
// JA aplica hoje, que ate agora so existiam hardcoded ou em system_settings sem
// interface. Todo default abaixo e exatamente o valor que o sistema usava antes,
// entao enquanto ninguem mexer na tela nada muda de comportamento.
//
// CADASTRO DE CLIENTE: os dois canais gravam SOMENTE no INTEGRA 2.0. O envio
// automatico ao Omie foi removido do Hotsite em 04/ago/2026 (o Instagram nunca
// enviou). Ver server/routes.ts, POST /api/public/orders.
//
// Wiring em server/index.ts:
//   import { registerCanaisRoutes } from "./canais-routes";
//   registerCanaisRoutes(app);
// ============================================================================
import type { Express } from 'express';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { authenticateUser } from './authMiddleware';

// ---------------------------------------------------------------- settings
async function getSetting(key: string, def: string): Promise<string> {
  try {
    const r: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
    const v = (r.rows || r || [])[0]?.value;
    return v == null ? def : String(v).replace(/^"|"$/g, '');
  } catch { return def; }
}

async function setSetting(key: string, value: string, by: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${value}, ${by}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`);
}

// ------------------------------------------------- defaults do cliente novo
// Valores default = exatamente o que estava fixo no codigo antes de 04/ago/2026.
const DIAS_VALIDOS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const PERIODICIDADES = ['semanal', 'quinzenal', 'mensal', 'bimestral'];

// ------------------------------------------- pedido minimo do CONSUMIDOR
// TRAVA DE VALOR (ago/2026): consumidor nao fecha pedido abaixo do minimo, nem no
// Hotsite nem no Instagram (IA). Dois patamares, porque o consumidor escolhe a
// tabela: VAREJO (default R$ 70) e ATACADO (default R$ 200 — o preco de atacado so
// se justifica a partir desse volume). REVENDA nao entra aqui: seus minimos
// continuam onde sempre estiveram (150 Goiania/Brasilia, 350 interior).
// Editavel em Canais > Hotsite > Configuracoes; vale para os DOIS canais.
export const MIN_CONSUMIDOR_VAREJO_PADRAO = 70;
export const MIN_CONSUMIDOR_ATACADO_PADRAO = 200;

/** Le os minimos do consumidor (fail-safe: valor invalido cai no default). */
export async function getMinimosConsumidor(): Promise<{ varejo: number; atacado: number }> {
  const ler = async (chave: string, padrao: number): Promise<number> => {
    const n = Number(String(await getSetting(chave, String(padrao))).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : padrao;
  };
  return {
    varejo: await ler('pedido_min_consumidor_varejo', MIN_CONSUMIDOR_VAREJO_PADRAO),
    atacado: await ler('pedido_min_consumidor_atacado', MIN_CONSUMIDOR_ATACADO_PADRAO),
  };
}

/**
 * Minimo que vale para um pedido, dada a tabela de preco escolhida.
 * 'retail'/'wholesale' = consumidor (trava ativa). Tabelas de revenda
 * ('goiania' | 'interior' | 'brasilia') devolvem 0 — sem trava aqui.
 */
export async function minimoParaTabela(priceTable?: string | null): Promise<number> {
  const t = String(priceTable || 'retail').toLowerCase();
  if (t === 'goiania' || t === 'interior' || t === 'brasilia') return 0;
  const min = await getMinimosConsumidor();
  return t === 'wholesale' ? min.atacado : min.varejo;
}

/**
 * Confere o pedido minimo ANTES de cobrar (PIX, cartao, Google Pay).
 *
 * IMPORTANTE — base de calculo: sempre o `subtotal` BRUTO (soma dos itens, SEM
 * cupom e sem desconto de indicacao). O cupom incide DEPOIS que a trava liberou:
 * quem comprou R$ 70 e tem cupom de 10% paga R$ 63 — o desconto reduz o que se
 * paga, nunca serve para atingir o minimo.
 *
 * Por que aqui e nao so na criacao do pedido: PIX e cartao COBRAM primeiro e so
 * depois criam o pedido. Sem esta checagem, um pedido abaixo do minimo seria pago
 * e so entao recusado — dinheiro entrando sem pedido. Devolve `null` quando pode
 * seguir, ou o corpo pronto do 400.
 */
export async function barrarSeAbaixoDoMinimo(
  priceTable: any,
  subtotalBruto: number,
): Promise<null | { message: string; code: string; minimo: number; subtotal: number; faltam: number }> {
  let minimo = 0;
  try {
    minimo = await minimoParaTabela(priceTable);
  } catch {
    return null; // falha ao LER a config nunca derruba uma venda
  }
  const sub = Math.round(Number(subtotalBruto) * 100) / 100;
  if (!(minimo > 0) || sub >= minimo) return null;
  const faltam = Math.round((minimo - sub) * 100) / 100;
  return {
    message: `Pedido mínimo de R$ ${minimo.toFixed(2)}. Faltam R$ ${faltam.toFixed(2)} para finalizar (o desconto de cupom entra depois, sobre o valor já aprovado).`,
    code: 'PEDIDO_MINIMO',
    minimo,
    subtotal: sub,
    faltam,
  };
}

export async function getHotsiteDefaults(): Promise<{ rota: string; dia: string; periodicidade: string; vendedorId: string | null }> {
  const dia = await getSetting('hotsite_novo_dia', 'Dom');
  const per = await getSetting('hotsite_novo_periodicidade', 'mensal');
  return {
    rota: await getSetting('hotsite_novo_rota', 'GOIÂNIA'),
    dia: DIAS_VALIDOS.includes(dia) ? dia : 'Dom',
    periodicidade: PERIODICIDADES.includes(per) ? per : 'mensal',
    vendedorId: (await getSetting('hotsite_novo_vendedor_id', '')) || null,
  };
}

// ------------------------------------------------------------------ acesso
const PODE_VER = ['admin', 'coordinator', 'administrative', 'telemarketing'];
const PODE_EDITAR = ['admin', 'coordinator', 'administrative'];

function podeVer(req: any, res: any, next: any) {
  const u = req.currentUser || req.user;
  if (!u || !PODE_VER.includes(String(u.role))) return res.status(403).json({ message: 'Access denied' });
  next();
}
function podeEditar(req: any, res: any, next: any) {
  const u = req.currentUser || req.user;
  if (!u || !PODE_EDITAR.includes(String(u.role))) return res.status(403).json({ message: 'Access denied' });
  next();
}

// ---------------------------------------------------------------- rotas
export function registerCanaisRoutes(app: Express): void {
  // PUBLICO (a loja consulta antes de liberar o botao de finalizar). Sem dados
  // sensiveis: devolve so os dois patamares do pedido minimo do consumidor.
  app.get('/api/public/canais/minimos', async (_req, res) => {
    try {
      res.json({ ok: true, consumidor: await getMinimosConsumidor() });
    } catch {
      res.json({ ok: true, consumidor: { varejo: MIN_CONSUMIDOR_VAREJO_PADRAO, atacado: MIN_CONSUMIDOR_ATACADO_PADRAO } });
    }
  });

  // ====================== RESUMO (cabecalho da pagina) ======================
  app.get('/api/canais/resumo', authenticateUser, podeVer, async (_req: any, res) => {
    try {
      const q: any = await db.execute(sql`
        SELECT sc.source AS canal,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE (sc.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date
                                      = (now() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS hoje,
               COUNT(*) FILTER (WHERE sc.created_at > now() - interval '7 days')::int AS sete_dias,
               COUNT(*) FILTER (WHERE sc.created_at > now() - interval '30 days')::int AS trinta_dias,
               COALESCE(SUM(sc.sale_value::numeric) FILTER (WHERE sc.created_at > now() - interval '30 days'), 0)::float AS valor_30d,
               COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM billing_pipeline bp WHERE bp.sales_card_id = sc.id)
                                 AND sc.sale_value IS NOT NULL AND sc.sale_value::numeric > 0)::int AS fora_do_pipeline
        FROM sales_cards sc
        WHERE sc.source IN ('hotsite', 'instagram')
        GROUP BY sc.source`);
      const linhas = (q.rows || q || []) as any[];
      const porCanal: any = { hotsite: null, instagram: null };
      for (const l of linhas) porCanal[String(l.canal)] = l;

      // Bloqueados por canal (pedido com venda que foi para a coluna Bloqueados)
      let bloq: any[] = [];
      try {
        const b: any = await db.execute(sql`
          SELECT sc.source AS canal, COUNT(*)::int AS n
          FROM blocked_orders bo JOIN sales_cards sc ON sc.id = bo.sales_card_id
          WHERE bo.status = 'blocked' AND sc.source IN ('hotsite','instagram')
          GROUP BY sc.source`);
        bloq = (b.rows || b || []) as any[];
      } catch { /* tabela pode nao existir */ }
      for (const l of bloq) if (porCanal[String(l.canal)]) porCanal[String(l.canal)].bloqueados = l.n;

      res.json({ ok: true, canais: porCanal });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ====================== PEDIDOS DO CANAL ======================
  app.get('/api/canais/pedidos', authenticateUser, podeVer, async (req: any, res) => {
    try {
      const canal = String(req.query.canal || 'hotsite').toLowerCase();
      if (!['hotsite', 'instagram'].includes(canal)) return res.status(400).json({ message: 'canal invalido' });
      const limite = Math.min(Number(req.query.limit) || 200, 500);
      const q: any = await db.execute(sql`
        SELECT sc.id, sc.created_at, sc.scheduled_date, sc.status, sc.sale_value, sc.payment_method,
               sc.products, sc.notes, sc.customer_id,
               c.name AS cliente, c.fantasy_name AS cliente_fantasia, c.phone AS telefone,
               c.cpf, c.cnpj,
               bp.id AS pipeline_id, bp.stage AS etapa, bp.order_number AS pipeline_numero,
               (SELECT 1 FROM blocked_orders bo WHERE bo.sales_card_id = sc.id AND bo.status='blocked' LIMIT 1) AS bloqueado
        FROM sales_cards sc
        LEFT JOIN customers c ON c.id = sc.customer_id
        LEFT JOIN billing_pipeline bp ON bp.sales_card_id = sc.id
        WHERE sc.source = ${canal}
        ORDER BY sc.created_at DESC
        LIMIT ${limite}`);
      const rows = ((q.rows || q || []) as any[]).map((r) => ({
        ...r,
        numero: (String(r.notes || '').match(/(WEB|IG)-\d+/) || [null])[0],
      }));
      res.json({ ok: true, canal, total: rows.length, pedidos: rows });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ====================== EXCLUIR PEDIDO DO CANAL (SOMENTE ADMIN) ======================
  // Espelha o DELETE /api/hotsite-orders/:id, mas vale para os DOIS canais e e restrito
  // ao papel admin (o do hotsite aceita admin/coordinator/administrative).
  // Acao DELIBERADA de admin sobre UM pedido especifico.
  // ATENCAO (04/ago/2026): storage.deleteSalesCard(id) hoje apaga direto — a blindagem
  // "card com venda e PEDIDO, nao agenda" (28/jul, camada 1) NAO esta mais no storage.ts;
  // sobrou apenas no visitScheduleService. Quando ela for restaurada, este endpoint
  // precisara passar a opcao de force para continuar funcionando.
  // Marca 'deleted_by_admin' no diario para o detector de pedido sumido NAO ressuscitar.
  app.delete('/api/canais/pedidos/:id', authenticateUser, async (req: any, res) => {
    try {
      const u = req.currentUser || req.user;
      if (!u || String(u.role) !== 'admin') {
        return res.status(403).json({ message: 'Somente administradores podem excluir pedidos do canal.' });
      }
      const id = String(req.params.id);
      const { storage } = await import('./storage');
      const card: any = await storage.getSalesCard(id);
      if (!card) return res.status(404).json({ message: 'Pedido não encontrado' });
      if (!['hotsite', 'instagram'].includes(String(card.source || ''))) {
        return res.status(400).json({ message: 'Este pedido não é de um canal digital' });
      }

      // Exclusão deliberada de pedido de canal digital (admin) — passa pela blindagem com force.
      await storage.deleteSalesCard(id, { force: true });
      try {
        const { journalMarkDeleted } = await import('./order-journal');
        await journalMarkDeleted(id, u.email);
      } catch (e: any) { console.warn('[CANAIS-DELETE] journal (segue):', e?.message); }

      console.log(`🗑️ [CANAIS-DELETE] pedido ${id} (${card.source}) excluído por ${u.email}`);
      res.json({ ok: true, message: 'Pedido excluído.' });
    } catch (e: any) {
      console.error('❌ [CANAIS-DELETE]', e?.message || e);
      res.status(500).json({ message: e?.message || String(e) });
    }
  });

  // ====================== HOTSITE — CONFIG ======================
  app.get('/api/canais/hotsite/config', authenticateUser, podeVer, async (_req: any, res) => {
    try {
      const def = await getHotsiteDefaults();
      const { cartaoLojaAtivo } = await import('./hotsite-card');
      let vendedorNome: string | null = null;
      if (def.vendedorId) {
        try {
          const u: any = await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${def.vendedorId} LIMIT 1`);
          const r = (u.rows || u || [])[0];
          if (r) vendedorNome = `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email;
        } catch { /* ignora */ }
      }
      res.json({
        ok: true,
        cartaoAtivo: await cartaoLojaAtivo(),
        clienteNovo: { ...def, vendedorNome },
        // Trava de valor do consumidor (vale para Hotsite E Instagram).
        minimoConsumidor: await getMinimosConsumidor(),
        cadastro: {
          destino: 'INTEGRA 2.0',
          enviaAoOmie: false,
          observacao: 'Cliente do Hotsite e criado somente no Integra 2.0 desde 04/ago/2026.',
        },
        opcoes: { dias: DIAS_VALIDOS, periodicidades: PERIODICIDADES },
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/canais/hotsite/config', authenticateUser, podeEditar, async (req: any, res) => {
    try {
      const by = String((req.currentUser || req.user)?.email || 'admin');
      const b = req.body || {};
      const alterado: string[] = [];

      if (b.cartaoAtivo !== undefined) {
        const { limparCacheCartaoLoja } = await import('./hotsite-card');
        await setSetting('hotsite_cartao_ativo', b.cartaoAtivo === true || String(b.cartaoAtivo) === 'true' ? 'on' : 'off', by);
        limparCacheCartaoLoja();
        alterado.push('cartaoAtivo');
      }
      if (typeof b.rota === 'string' && b.rota.trim()) { await setSetting('hotsite_novo_rota', b.rota.trim(), by); alterado.push('rota'); }
      if (typeof b.dia === 'string' && DIAS_VALIDOS.includes(b.dia)) { await setSetting('hotsite_novo_dia', b.dia, by); alterado.push('dia'); }
      if (typeof b.periodicidade === 'string' && PERIODICIDADES.includes(b.periodicidade)) { await setSetting('hotsite_novo_periodicidade', b.periodicidade, by); alterado.push('periodicidade'); }
      if (b.vendedorId !== undefined) { await setSetting('hotsite_novo_vendedor_id', String(b.vendedorId || ''), by); alterado.push('vendedorId'); }

      // Trava de valor do consumidor — aceita numero ou texto ("70", "70,00").
      const lerValor = (v: any): number | null => {
        if (v === undefined || v === null || String(v).trim() === '') return null;
        const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
      };
      const mv = lerValor(b.minimoVarejo);
      if (mv !== null) { await setSetting('pedido_min_consumidor_varejo', String(mv), by); alterado.push('minimoVarejo'); }
      const ma = lerValor(b.minimoAtacado);
      if (ma !== null) { await setSetting('pedido_min_consumidor_atacado', String(ma), by); alterado.push('minimoAtacado'); }

      const { cartaoLojaAtivo } = await import('./hotsite-card');
      res.json({
        ok: true, alterado, por: by,
        cartaoAtivo: await cartaoLojaAtivo(),
        clienteNovo: await getHotsiteDefaults(),
        minimoConsumidor: await getMinimosConsumidor(),
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // Status REAL dos meios de pagamento da loja. O /api/admin/cielo/diag tem um campo
  // `diagnostico` que da FALSO POSITIVO (le so a 1a sonda, que morre na validacao do
  // numero do cartao antes de autenticar). Aqui a verdade sai do bloco `isolamento`.
  app.get('/api/canais/hotsite/pagamentos', authenticateUser, podeVer, async (_req: any, res) => {
    try {
      const { cartaoLojaAtivo, cieloConfig } = await import('./hotsite-card');
      const ativo = await cartaoLojaAtivo();
      const cfg = cieloConfig();
      const out: any = {
        ok: true,
        pix: { disponivel: true, observacao: 'PIX pela API do BB' },
        boleto: { disponivel: true, observacao: 'Somente pessoa juridica' },
        cartao: {
          ligadoNaLoja: ativo,
          credenciaisConfiguradas: !!(cfg.merchantId && cfg.merchantKey),
          ambiente: cfg.sandbox ? 'SANDBOX' : 'PRODUCAO',
          gatewayOk: null as boolean | null,
          gatewayMensagem: '' as string,
        },
      };
      try {
        const { cieloDiag } = await import('./hotsite-card');
        const d: any = await cieloDiag();
        const sonda = d?.isolamento?.base_capFalse?.ret;
        if (sonda) {
          const rc = String(sonda.ReturnCode || '');
          out.cartao.gatewayOk = rc !== '002';
          out.cartao.gatewayMensagem = `${rc} ${sonda.ReturnMessage || ''}`.trim();
        }
      } catch (e: any) { out.cartao.gatewayMensagem = 'nao foi possivel sondar: ' + (e?.message || e); }
      res.json(out);
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // ====================== INSTAGRAM — CONFIG ======================
  app.get('/api/canais/instagram/config', authenticateUser, podeVer, async (_req: any, res) => {
    try {
      const carteiraId = await getSetting('ia_carteira_padrao', '58f7ba0b-dcd1-4d0e-abc2-458cdddb2794');
      let carteiraNome: string | null = null;
      try {
        const u: any = await db.execute(sql`SELECT first_name, last_name, email FROM users WHERE id = ${carteiraId} LIMIT 1`);
        const r = (u.rows || u || [])[0];
        if (r) carteiraNome = `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email;
      } catch { /* ignora */ }
      res.json({
        ok: true,
        ia: {
          motor: await getSetting('agents_runtime_mode', 'off'),
          frontLine: (await getSetting('ia_front_line', 'off')) === 'on',
          handoffMin: parseInt(await getSetting('ia_handoff_min', '5'), 10) || 5,
          notificaWhatsapp: (await getSetting('ia_notifica_wa', 'on')) === 'on',
          travaAdmin: (await getSetting('ia_trava_admin', 'off')) === 'on',
        },
        clienteNovo: {
          carteiraPadraoId: carteiraId,
          carteiraPadraoNome: carteiraNome,
          periodicidade: 'semanal',
          observacao: 'Cliente novo cadastrado pela IA entra na carteira padrao e nasce como lead.',
        },
        cadastro: {
          destino: 'INTEGRA 2.0',
          enviaAoOmie: false,
          observacao: 'O canal Instagram nunca enviou cadastro ao Omie — segue somente no Integra 2.0.',
        },
      });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  app.post('/api/canais/instagram/config', authenticateUser, podeEditar, async (req: any, res) => {
    try {
      const by = String((req.currentUser || req.user)?.email || 'admin');
      const b = req.body || {};
      const alterado: string[] = [];
      const onOff = (v: any) => (v === true || String(v) === 'true' || String(v) === 'on' ? 'on' : 'off');

      if (b.frontLine !== undefined) { await setSetting('ia_front_line', onOff(b.frontLine), by); alterado.push('frontLine'); }
      if (b.notificaWhatsapp !== undefined) { await setSetting('ia_notifica_wa', onOff(b.notificaWhatsapp), by); alterado.push('notificaWhatsapp'); }
      if (b.travaAdmin !== undefined) { await setSetting('ia_trava_admin', onOff(b.travaAdmin), by); alterado.push('travaAdmin'); }
      if (b.handoffMin !== undefined) {
        const n = Math.max(1, Math.min(120, parseInt(String(b.handoffMin), 10) || 5));
        await setSetting('ia_handoff_min', String(n), by); alterado.push('handoffMin');
      }
      if (typeof b.carteiraPadraoId === 'string' && b.carteiraPadraoId.trim()) {
        await setSetting('ia_carteira_padrao', b.carteiraPadraoId.trim(), by); alterado.push('carteiraPadraoId');
      }
      res.json({ ok: true, alterado, por: by });
    } catch (e: any) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  console.log('📣 [CANAIS] Rotas de Canais (Hotsite + Instagram) registradas');
}
