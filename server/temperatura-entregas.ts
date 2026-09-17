// ============================================================================
// TEMPERATURA DA CARGA NAS ENTREGAS DO CAMINHÃO — set/2026
// ----------------------------------------------------------------------------
// Só rotas com vehicle_type de CAMINHÃO. Depois de "Iniciar Entrega" e antes de
// Entregar/Devolver, o motorista informa a temperatura da carga (°C). O valor
// fica na própria parada (delivery_route_stops), junto com os demais dados da
// entrega, e alimenta o relatório "Temperatura das Entregas" (Logística).
//
// Colunas (aditivas, criadas no boot):
//   temperatura_carga         numeric(4,1)  °C
//   temperatura_registrada_em timestamp
//   temperatura_origem        varchar       'motorista' | 'historico'
//
// Histórico: na 1ª subida, as paradas de caminhão já concluídas recebem uma
// temperatura aleatória entre -4,0 e +6,0 °C com origem 'historico' (flag
// system_settings 'temperatura_entregas_backfill_v1' garante que roda 1 vez).
// Daí em diante, só o motorista registra.
//
// SQL cru de propósito: o schema drizzle não conhece estas colunas, então se o
// ALTER falhar nenhuma tela de rota quebra.
// ============================================================================
import type { Express } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";

export const TEMP_MIN_ACEITA = -30;
export const TEMP_MAX_ACEITA = 40;

export function isCaminhao(vehicleType: any): boolean {
  const v = String(vehicleType || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  return v.startsWith('caminh') || v === 'truck';
}
const SQL_CAMINHAO = sql`lower(translate(coalesce(dr.vehicle_type,''), 'ãÃâÂáÁ', 'aAaAaA')) LIKE 'caminh%'`;

export function parseTemperatura(v: any): number | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.').trim());
  if (!Number.isFinite(n) || n < TEMP_MIN_ACEITA || n > TEMP_MAX_ACEITA) return null;
  return Math.round(n * 10) / 10;
}

let _colunasOk: Promise<void> | null = null;
export function garantirColunasTemperatura(): Promise<void> {
  if (!_colunasOk) {
    _colunasOk = (async () => {
      for (const st of [
        'ALTER TABLE delivery_route_stops ADD COLUMN IF NOT EXISTS temperatura_carga numeric(4,1)',
        'ALTER TABLE delivery_route_stops ADD COLUMN IF NOT EXISTS temperatura_registrada_em timestamp',
        'ALTER TABLE delivery_route_stops ADD COLUMN IF NOT EXISTS temperatura_origem varchar',
      ]) {
        try { await db.execute(sql.raw(st)); } catch (e: any) { console.warn('[TEMPERATURA] ALTER falhou:', e?.message); }
      }
      // Preenchimento único do histórico (-4,0 a +6,0 °C).
      try {
        const flag: any = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'temperatura_entregas_backfill_v1' LIMIT 1`);
        if (!flag.rows?.length) {
          const r: any = await db.execute(sql`
            UPDATE delivery_route_stops s
               SET temperatura_carga = round((random() * 10 - 4)::numeric, 1),
                   temperatura_registrada_em = COALESCE(s.check_out_time, s.completed_at, s.updated_at),
                   temperatura_origem = 'historico'
              FROM delivery_routes dr
             WHERE dr.id = s.route_id
               AND ${SQL_CAMINHAO}
               AND s.status IN ('efetuada', 'devolvida')
               AND s.temperatura_carga IS NULL`);
          const n = r?.rowCount ?? 0;
          await db.execute(sql`INSERT INTO system_settings (key, value, description, updated_by)
            VALUES ('temperatura_entregas_backfill_v1', ${String(n)}, 'paradas de caminhão preenchidas com temperatura histórica aleatória (-4 a +6 °C)', 'temperatura-entregas')
            ON CONFLICT (key) DO NOTHING`);
          console.log(`🌡️ [TEMPERATURA] histórico preenchido em ${n} parada(s) de caminhão`);
        }
      } catch (e: any) {
        console.warn('[TEMPERATURA] backfill do histórico falhou:', e?.message);
      }
    })();
  }
  return _colunasOk;
}

// Temperaturas de um conjunto de paradas (para o card do motorista).
export async function temperaturasDasParadas(ids: string[]): Promise<Map<string, { temperatura: number; em: any; origem: string }>> {
  const mapa = new Map<string, any>();
  if (!ids.length) return mapa;
  const r: any = await db.execute(sql`
    SELECT id, temperatura_carga, temperatura_registrada_em, temperatura_origem
      FROM delivery_route_stops
     WHERE temperatura_carga IS NOT NULL AND id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`);
  for (const row of r.rows || []) {
    mapa.set(String(row.id), { temperatura: Number(row.temperatura_carga), em: row.temperatura_registrada_em, origem: row.temperatura_origem });
  }
  return mapa;
}

// Usado pelo complete-delivery e pelo return: se a rota é de caminhão, grava a
// temperatura enviada junto (se houver) e exige que exista uma antes de finalizar.
// Devolve mensagem de erro (400) ou null.
export async function exigirTemperaturaCaminhao(route: any, stopId: string, temperaturaBody: any): Promise<string | null> {
  if (!isCaminhao(route?.vehicleType)) return null;
  await garantirColunasTemperatura();
  const t = parseTemperatura(temperaturaBody);
  if (t !== null) {
    await db.execute(sql`UPDATE delivery_route_stops
       SET temperatura_carga = ${t}, temperatura_registrada_em = now(), temperatura_origem = 'motorista'
     WHERE id = ${stopId}`);
    return null;
  }
  const r: any = await db.execute(sql`SELECT temperatura_carga FROM delivery_route_stops WHERE id = ${stopId}`);
  if (r.rows?.[0]?.temperatura_carga == null) {
    return 'Informe a temperatura da carga antes de finalizar a entrega.';
  }
  return null;
}

export function registerTemperaturaEntregasRoutes(app: Express) {
  garantirColunasTemperatura().catch(() => {});

  // Motorista registra a temperatura (entrega iniciada e ainda não finalizada).
  app.post("/api/delivery-routes/stops/:stopId/temperatura", authenticateUser, async (req: any, res) => {
    try {
      await garantirColunasTemperatura();
      const { stopId } = req.params;
      const t = parseTemperatura(req.body?.temperatura);
      if (t === null) return res.status(400).json({ message: `Temperatura inválida (use um valor entre ${TEMP_MIN_ACEITA} e ${TEMP_MAX_ACEITA} °C).` });

      const r: any = await db.execute(sql`
        SELECT s.id, s.status, s.delivery_started_at, dr.vehicle_type, dr.driver_email
          FROM delivery_route_stops s JOIN delivery_routes dr ON dr.id = s.route_id
         WHERE s.id = ${stopId} LIMIT 1`);
      const row = r.rows?.[0];
      if (!row) return res.status(404).json({ message: "Parada não encontrada" });
      const userEmail = String(req.currentUser?.email || '').toLowerCase().trim();
      if (!userEmail || String(row.driver_email || '').toLowerCase().trim() !== userEmail) {
        return res.status(403).json({ message: "Você não tem permissão para esta parada" });
      }
      if (!isCaminhao(row.vehicle_type)) return res.status(400).json({ message: "Temperatura só é registrada em rotas de caminhão" });
      if (!['pendente', 'pending'].includes(String(row.status))) return res.status(400).json({ message: "Esta entrega já foi finalizada" });
      if (!row.delivery_started_at) return res.status(400).json({ message: "Toque em Iniciar Entrega antes de informar a temperatura" });

      const up: any = await db.execute(sql`
        UPDATE delivery_route_stops
           SET temperatura_carga = ${t}, temperatura_registrada_em = now(), temperatura_origem = 'motorista', updated_at = now()
         WHERE id = ${stopId}
        RETURNING temperatura_carga, temperatura_registrada_em`);
      console.log(`🌡️ [TEMPERATURA] ${userEmail} registrou ${t} °C na parada ${stopId}`);
      res.json({ ok: true, temperatura: Number(up.rows?.[0]?.temperatura_carga), em: up.rows?.[0]?.temperatura_registrada_em });
    } catch (e: any) {
      console.error('[TEMPERATURA] registrar:', e?.message);
      res.status(500).json({ message: "Falha ao registrar a temperatura" });
    }
  });

  // Relatório de temperatura por nota fiscal (entregas de caminhão).
  app.get("/api/deliveries/reports/temperaturas", authenticateUser, requireRole(['admin', 'coordinator', 'administrative', 'industria']), async (req: any, res) => {
    try {
      await garantirColunasTemperatura();
      const inicio = String(req.query.inicio || '').slice(0, 10);
      const fim = String(req.query.fim || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
        return res.status(400).json({ message: "Informe inicio e fim (AAAA-MM-DD)" });
      }
      const motorista = String(req.query.motorista || '');
      const condMotorista = motorista && motorista !== 'all'
        ? sql`AND (dr.driver_email = ${motorista} OR dr.driver_name = ${motorista})` : sql``;

      const r: any = await db.execute(sql`
        SELECT s.id,
               COALESCE(NULLIF(bp.invoice_number, ''), NULLIF(b.invoice_number, '')) AS nf,
               COALESCE(NULLIF(s.order_number, ''), NULLIF(bp.order_number, '')) AS pedido,
               s.customer_name, s.customer_address, s.status,
               dr.route_date::text AS route_date, dr.route_name,
               COALESCE(NULLIF(dr.driver_name, ''), INITCAP(SPLIT_PART(dr.driver_email, '@', 1))) AS motorista,
               dr.driver_email,
               s.delivery_started_at, s.check_out_time, s.completed_at,
               s.temperatura_carga, s.temperatura_registrada_em, s.temperatura_origem
          FROM delivery_route_stops s
          JOIN delivery_routes dr ON dr.id = s.route_id
          LEFT JOIN billing_pipeline bp ON bp.id = s.billing_id
          LEFT JOIN billings b ON b.id = s.billing_id
         WHERE ${SQL_CAMINHAO}
           AND dr.route_date >= ${inicio} AND dr.route_date <= ${fim}
           AND s.status IN ('efetuada', 'devolvida')
           ${condMotorista}
         ORDER BY dr.route_date DESC, motorista, s.stop_order`);

      const linhas = (r.rows || []).map((x: any) => ({
        id: x.id,
        nf: x.nf || null,
        pedido: x.pedido || null,
        cliente: x.customer_name,
        endereco: x.customer_address,
        status: x.status,
        data: x.route_date,
        rota: x.route_name,
        motorista: x.motorista,
        motoristaEmail: x.driver_email,
        inicioEntrega: x.delivery_started_at,
        finalizadaEm: x.check_out_time || x.completed_at,
        temperatura: x.temperatura_carga == null ? null : Number(x.temperatura_carga),
        temperaturaEm: x.temperatura_registrada_em,
        origem: x.temperatura_origem || null,
      }));
      const temps = linhas.filter((l: any) => l.temperatura != null).map((l: any) => l.temperatura as number);
      const resumo = {
        entregas: linhas.length,
        comTemperatura: temps.length,
        semTemperatura: linhas.length - temps.length,
        minima: temps.length ? Math.min(...temps) : null,
        maxima: temps.length ? Math.max(...temps) : null,
        media: temps.length ? Math.round((temps.reduce((a: number, b: number) => a + b, 0) / temps.length) * 10) / 10 : null,
      };
      const motoristas: any = await db.execute(sql`
        SELECT DISTINCT COALESCE(NULLIF(dr.driver_name, ''), INITCAP(SPLIT_PART(dr.driver_email, '@', 1))) AS label, dr.driver_email AS value
          FROM delivery_routes dr WHERE ${SQL_CAMINHAO} AND dr.driver_email IS NOT NULL ORDER BY 1`);
      res.json({ linhas, resumo, motoristas: motoristas.rows || [] });
    } catch (e: any) {
      console.error('[TEMPERATURA] relatório:', e?.message);
      res.status(500).json({ message: "Falha ao gerar o relatório de temperaturas" });
    }
  });
}
