// server/painel-atendimento-routes.ts
// -----------------------------------------------------------------------------
// GESTAO — PAINEL DE ATENDIMENTO (tela /painel-atendimento)
//
// Um unico endpoint read-only, por DIA (padrao: hoje em Brasilia), com uma linha
// por vendedor. A tela consulta a cada 30 s (polling), entao a consulta precisa
// ser barata: todas as agregacoes rodam no banco, agrupadas por usuario, e o
// merge final e feito em memoria.
//
// Acesso: SOMENTE admin e administrative (requireRole). Sem corte por carteira —
// e um painel da gestao, nao do vendedor.
//
// REGUAS (todas reaproveitadas de telas que ja existem, para os numeros fecharem):
//   * VISITA       = check-in presencial no dia. Fonte = route_checkpoints
//                    (checkpoint_type='check_in', fora 'cancelled') UNIAO
//                    sales_cards.check_in_time (check-in sem GPS nao gera
//                    checkpoint — sem a uniao esses sumiriam). Contada por
//                    CLIENTE distinto: dois check-ins no mesmo cliente = 1 visita.
//   * ATENDIMENTO  = cliente distinto atendido no dia por QUALQUER canal:
//                    visita (acima) OU registro em virtual_service_logs OU
//                    pedido no dia. E a regua composta da Repescagem
//                    (repescagem-routes.ts, "atendido = log OU check-in OU pedido").
//                    Logo, atendimentos >= visitas, sempre.
//   * PEDIDO       = billing_pipeline fora da lixeira, operation_type venda,
//                    dia = COALESCE(scheduled_billing_date, dia BR de created_at)
//                    — mesma regua da repescagem. Valor = SUM(sale_value).
//   * REPESCAGEM   = clientes EM REPESCAGEM no dia (alocacao do sorteio do dia
//                    — draw_date — ou alocacao legada aberta no dia) que foram
//                    ATENDIDOS nesse dia (visita, virtual ou pedido), contados
//                    por QUEM atendeu. `repescagemAlocados` = quantos clientes
//                    do sorteio do dia cairam com cada vendedor.
//                    Nao usa completed_at: o fechamento automatico conclui em
//                    lote alocacoes antigas e inflaria o numero do dia.
//   * FATURADO     = sqlFaturamentoPorVendedor(dia, dia+1) de faturamento-oficial.ts
//                    (NF-e autorizada de venda, deduplicada, vendedor = quem
//                    implantou o pedido).
//   * KM RODADO    = daily_routes.total_actual_distance do dia (route_date e
//                    DATA DE CALENDARIO — compara com ::date puro). Se a rota
//                    ainda nao fechou o total, cai na soma de
//                    route_checkpoints.distance_from_previous do dia.
//   * 1o/ULTIMO CHECK-IN = MIN/MAX da hora de parede BR sobre a mesma uniao de
//                    check-ins da VISITA.
//   * EVOLUTIVO REPESCAGEM (grafico, ultimos N dias ate o dia escolhido):
//                    por dia de SORTEIO (draw_date; alocacoes antigas sem
//                    draw_date caem no dia BR de assigned_at), fora 'cancelled':
//                    EM REPESCAGEM = clientes distintos sorteados no dia;
//                    ATENDIDOS     = desses, os que fecharam 'completed'.
//                    Coorte por dia de sorteio, de proposito: a taxa do dia e
//                    "dos que sairam no sorteio, quantos foram atendidos".
//
// Vendedor = users.id. seller_id "sintetico" (omie_vendor_code, omie-vendor-<cod>,
// omie_vendor_codes) e resolvido pelo mesmo join usado no resto do sistema.
// Todo vendedor ATIVO (role vendedor/telemarketing) aparece, mesmo zerado — o
// painel existe justamente para mostrar quem ainda nao fez check-in.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser, requireRole } from "./authMiddleware";
import { sqlFaturamentoPorVendedor } from "./faturamento-oficial";
import { sqlDiaBR, sqlParedeBR } from "@shared/tempo";

const TZ = "America/Sao_Paulo";
const PAPEIS_PAINEL = ["admin", "administrative"];

/** 'YYYY-MM-DD' de hoje no fuso de Brasilia. */
function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

/** Soma dias a 'YYYY-MM-DD' sem passar pelo fuso local. */
function addDias(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Resolve um seller_id (id, omie_vendor_code, omie-vendor-<cod> ou um dos
 *  omie_vendor_codes) para users.id. Subquery escalar: 1 usuario ou NULL. */
function userIdDe(expr: string): string {
  return `(SELECT u.id FROM users u
            WHERE u.id = ${expr}
               OR u.omie_vendor_code = ${expr}
               OR u.omie_vendor_code = REPLACE(COALESCE(${expr},''),'omie-vendor-','')
               OR ${expr} IN (SELECT value FROM jsonb_each_text(
                                CASE WHEN jsonb_typeof(u.omie_vendor_codes)='object'
                                     THEN u.omie_vendor_codes ELSE '{}'::jsonb END))
            ORDER BY (u.id = ${expr}) DESC, u.is_active DESC
            LIMIT 1)`;
}

export type LinhaVendedor = {
  vendedorId: string;
  vendedor: string;
  papel: string | null;
  ativo: boolean;
  visitas: number;
  atendimentos: number;
  pedidos: number;
  valorPedidos: number;
  repescagem: number;
  repescagemAlocados: number;
  faturado: number;
  notas: number;
  km: number | null;
  kmFonte: "rota" | "checkpoints" | null;
  primeiroCheckIn: string | null; // 'HH:MM'
  ultimoCheckIn: string | null;   // 'HH:MM'
};

export function registerPainelAtendimento(app: Express) {
  // GET /api/gestao/painel-atendimento?dia=YYYY-MM-DD   (padrao: hoje BR)
  app.get(
    "/api/gestao/painel-atendimento",
    authenticateUser,
    requireRole(PAPEIS_PAINEL),
    async (req: Request, res: Response) => {
      try {
        const hoje = hojeBR();
        const m = String(req.query.dia || "").match(/^\d{4}-\d{2}-\d{2}$/);
        const dia = m ? m[0] : hoje;
        const diaSeguinte = addDias(dia, 1);
        const D = `DATE '${dia}'`;
        const diasEvolutivo = Math.min(120, Math.max(7, Number(req.query.dias) || 30));
        const inicioEvolutivo = addDias(dia, -(diasEvolutivo - 1));

        const q = async (text: string) => (await db.execute(sql.raw(text))).rows as any[];

        // ── Check-ins do dia (uniao checkpoints + sales_cards) ─────────────────
        // Uma linha por (vendedor, cliente, instante). O vendedor ja sai como
        // users.id; quem nao resolve para usuario vai para 'sem-vendedor'.
        const CTE_CHECKINS = `checkins AS (
          SELECT COALESCE(${userIdDe("rc.seller_id")}, 'sem-vendedor') AS uid,
                 rc.customer_id AS cid,
                 ${sqlParedeBR("rc.checkpoint_time")} AS hora
          FROM route_checkpoints rc
          WHERE rc.checkpoint_type = 'check_in'
            AND COALESCE(rc.validation_status,'pending') <> 'cancelled'
            AND ${sqlDiaBR("rc.checkpoint_time")} = ${D}
          UNION ALL
          SELECT COALESCE(${userIdDe("sc.seller_id")}, 'sem-vendedor') AS uid,
                 sc.customer_id AS cid,
                 ${sqlParedeBR("sc.check_in_time")} AS hora
          FROM sales_cards sc
          WHERE sc.check_in_time IS NOT NULL
            AND ${sqlDiaBR("sc.check_in_time")} = ${D}
        )`;

        // ── Pedidos do dia ─────────────────────────────────────────────────────
        const CTE_PEDIDOS = `pedidos AS (
          SELECT COALESCE(${userIdDe("bp.seller_id")}, 'sem-vendedor') AS uid,
                 bp.customer_id AS cid,
                 COALESCE(bp.sale_value,0)::numeric AS valor
          FROM billing_pipeline bp
          WHERE bp.stage::text <> 'lixeira'
            AND LOWER(COALESCE(NULLIF(bp.operation_type::text,''),'venda')) = 'venda'
            AND COALESCE(bp.scheduled_billing_date::date, ${sqlDiaBR("bp.created_at")}) = ${D}
        )`;

        // ── Atendimentos virtuais do dia ───────────────────────────────────────
        const CTE_VIRTUAIS = `virtuais AS (
          SELECT COALESCE(${userIdDe("vl.attendant_id")}, 'sem-vendedor') AS uid,
                 vl.customer_id AS cid
          FROM virtual_service_logs vl
          WHERE ${sqlDiaBR("vl.attendance_date")} = ${D}
        )`;

        // ── Clientes em repescagem no dia ──────────────────────────────────────
        const CTE_REPESC = `repesc AS (
          SELECT DISTINCT ra.customer_id AS cid, ra.assigned_user_id AS uid_aloc
          FROM repescagem_assignments ra
          WHERE ra.status <> 'cancelled'
            AND (
              (ra.draw_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND ra.draw_date::date = ${D})
              OR (COALESCE(ra.draw_date,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  AND ${sqlDiaBR("ra.assigned_at")} <= ${D}
                  AND (ra.completed_at IS NULL OR ${sqlDiaBR("ra.completed_at")} >= ${D}))
            )
        )`;

        const [visitas, atendimentos, pedidos, repescagem, faturado, km, vendedores, evolutivo, alocados] = await Promise.all([
          // 1) Visitas + 1o/ultimo check-in
          q(`WITH ${CTE_CHECKINS}
             SELECT uid,
                    COUNT(DISTINCT cid)::int            AS visitas,
                    to_char(MIN(hora),'HH24:MI')        AS primeiro,
                    to_char(MAX(hora),'HH24:MI')        AS ultimo
             FROM checkins GROUP BY uid`),

          // 2) Atendimentos = clientes distintos com visita OU log OU pedido
          q(`WITH ${CTE_CHECKINS}, ${CTE_PEDIDOS}, ${CTE_VIRTUAIS}
             SELECT uid, COUNT(DISTINCT cid)::int AS atendimentos FROM (
               SELECT uid, cid FROM checkins WHERE cid IS NOT NULL
               UNION SELECT uid, cid FROM virtuais WHERE cid IS NOT NULL
               UNION SELECT uid, cid FROM pedidos  WHERE cid IS NOT NULL
             ) t GROUP BY uid`),

          // 3) Pedidos: quantidade e valor
          q(`WITH ${CTE_PEDIDOS}
             SELECT uid, COUNT(*)::int AS pedidos, COALESCE(SUM(valor),0)::float AS valor
             FROM pedidos GROUP BY uid`),

          // 4) Repescagem atendida no dia: cliente em repescagem + atendimento no dia, por quem atendeu
          q(`WITH ${CTE_CHECKINS}, ${CTE_PEDIDOS}, ${CTE_VIRTUAIS}, ${CTE_REPESC}
             SELECT t.uid, COUNT(DISTINCT t.cid)::int AS repescagem FROM (
               SELECT uid, cid FROM checkins WHERE cid IS NOT NULL
               UNION SELECT uid, cid FROM virtuais WHERE cid IS NOT NULL
               UNION SELECT uid, cid FROM pedidos  WHERE cid IS NOT NULL
             ) t JOIN repesc r ON r.cid = t.cid GROUP BY t.uid`),

          // 5) Faturado (NF-e de venda) — regua oficial
          q(sqlFaturamentoPorVendedor(dia, diaSeguinte)),

          // 6) KM rodado: total da rota do dia, fallback soma das pernas
          q(`SELECT dr.seller_id AS uid,
                    dr.total_actual_distance::float AS km_rota,
                    (SELECT COALESCE(SUM(rc.distance_from_previous),0)::float
                       FROM route_checkpoints rc
                      WHERE rc.daily_route_id = dr.id
                        AND rc.checkpoint_type = 'check_in'
                        AND COALESCE(rc.validation_status,'pending') <> 'cancelled') AS km_pernas
             FROM daily_routes dr
             WHERE dr.route_date::date = ${D}`),

          // 7) Vendedores ativos (aparecem mesmo zerados)
          q(`SELECT u.id, u.role::text AS role, COALESCE(u.is_active,true) AS ativo,
                    NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),'') AS nome
             FROM users u
             WHERE u.role IN ('vendedor','telemarketing') AND COALESCE(u.is_active,true) = true`),

          // 8) Evolutivo da repescagem: sorteados x atendidos por dia de sorteio
          q(`WITH ra AS (
               SELECT COALESCE(CASE WHEN ra.draw_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ra.draw_date::date END,
                               ${sqlDiaBR("ra.assigned_at")}) AS d,
                      ra.customer_id AS cid,
                      ra.status
               FROM repescagem_assignments ra
               WHERE ra.status <> 'cancelled'
             ),
             dias AS (
               SELECT generate_series(DATE '${inicioEvolutivo}', ${D}, INTERVAL '1 day')::date AS d
             )
             SELECT to_char(dias.d,'YYYY-MM-DD') AS dia,
                    COUNT(DISTINCT ra.cid)::int AS sorteados,
                    COUNT(DISTINCT ra.cid) FILTER (WHERE ra.status = 'completed')::int AS atendidos
             FROM dias LEFT JOIN ra ON ra.d = dias.d
             GROUP BY dias.d ORDER BY dias.d`),

          // 9) Repescagem alocada no dia, por vendedor (assigned_user_id ja e users.id)
          q(`WITH ${CTE_REPESC}
             SELECT uid_aloc AS uid, COUNT(DISTINCT cid)::int AS alocados FROM repesc
             WHERE uid_aloc IS NOT NULL GROUP BY 1`),
        ]);

        // ── Merge em memoria ───────────────────────────────────────────────────
        const linhas = new Map<string, LinhaVendedor>();
        const linha = (uid: string): LinhaVendedor => {
          let l = linhas.get(uid);
          if (!l) {
            l = {
              vendedorId: uid, vendedor: uid === "sem-vendedor" ? "Sem vendedor" : uid, papel: null, ativo: true,
              visitas: 0, atendimentos: 0, pedidos: 0, valorPedidos: 0, repescagem: 0, repescagemAlocados: 0, faturado: 0, notas: 0,
              km: null, kmFonte: null, primeiroCheckIn: null, ultimoCheckIn: null,
            };
            linhas.set(uid, l);
          }
          return l;
        };

        for (const v of vendedores) {
          const l = linha(v.id);
          l.vendedor = v.nome || v.id;
          l.papel = v.role;
          l.ativo = !!v.ativo;
        }
        for (const r of visitas) {
          const l = linha(r.uid);
          l.visitas = Number(r.visitas) || 0;
          l.primeiroCheckIn = r.primeiro || null;
          l.ultimoCheckIn = r.ultimo || null;
        }
        for (const r of atendimentos) linha(r.uid).atendimentos = Number(r.atendimentos) || 0;
        for (const r of pedidos) {
          const l = linha(r.uid);
          l.pedidos = Number(r.pedidos) || 0;
          l.valorPedidos = Number(r.valor) || 0;
        }
        for (const r of repescagem) if (r.uid) linha(r.uid).repescagem = Number(r.repescagem) || 0;
        for (const r of alocados) if (r.uid) linha(r.uid).repescagemAlocados = Number(r.alocados) || 0;
        for (const r of faturado) {
          const l = linha(r.vendedor_id || "sem-vendedor");
          l.faturado = Number(r.faturamento) || 0;
          l.notas = Number(r.notas) || 0;
        }
        for (const r of km) {
          if (!r.uid) continue;
          const l = linha(r.uid);
          const rota = r.km_rota === null || r.km_rota === undefined ? null : Number(r.km_rota);
          const pernas = Number(r.km_pernas) || 0;
          if (rota !== null && rota > 0) { l.km = (l.km || 0) + rota; l.kmFonte = "rota"; }
          else if (pernas > 0) { l.km = (l.km || 0) + pernas; l.kmFonte = l.kmFonte || "checkpoints"; }
        }

        // Nome/papel de quem teve atividade mas nao esta na lista de ativos
        // (ex.: usuario inativado hoje, admin que implantou pedido).
        const semNome = Array.from(linhas.values())
          .filter((l) => l.papel === null && l.vendedorId !== "sem-vendedor")
          .map((l) => l.vendedorId);
        if (semNome.length) {
          const ids = semNome.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
          const extras = await q(`SELECT u.id, u.role::text AS role, COALESCE(u.is_active,true) AS ativo,
                    NULLIF(TRIM(COALESCE(u.first_name,'')||' '||COALESCE(u.last_name,'')),'') AS nome
             FROM users u WHERE u.id IN (${ids})`);
          for (const v of extras) {
            const l = linha(v.id);
            l.vendedor = v.nome || v.id;
            l.papel = v.role;
            l.ativo = !!v.ativo;
          }
        }

        const rows = Array.from(linhas.values())
          // Sem atividade e sem cadastro de vendedor: nao polui o painel.
          .filter((l) => l.papel !== null || l.visitas || l.atendimentos || l.pedidos || l.faturado || l.repescagem || l.repescagemAlocados || l.km)
          .sort((a, b) =>
            (a.vendedorId === "sem-vendedor" ? 1 : 0) - (b.vendedorId === "sem-vendedor" ? 1 : 0)
            || b.faturado - a.faturado || b.valorPedidos - a.valorPedidos || b.visitas - a.visitas
            || a.vendedor.localeCompare(b.vendedor, "pt-BR"));

        const totais = rows.reduce((t, l) => ({
          vendedores: t.vendedores + (l.papel ? 1 : 0),
          emCampo: t.emCampo + ((l.visitas > 0 || l.atendimentos > 0 || l.pedidos > 0) && l.papel ? 1 : 0),
          visitas: t.visitas + l.visitas,
          atendimentos: t.atendimentos + l.atendimentos,
          pedidos: t.pedidos + l.pedidos,
          valorPedidos: t.valorPedidos + l.valorPedidos,
          repescagem: t.repescagem + l.repescagem,
          repescagemAlocados: t.repescagemAlocados + l.repescagemAlocados,
          faturado: t.faturado + l.faturado,
          notas: t.notas + l.notas,
          km: t.km + (l.km || 0),
        }), { vendedores: 0, emCampo: 0, visitas: 0, atendimentos: 0, pedidos: 0, valorPedidos: 0, repescagem: 0, repescagemAlocados: 0, faturado: 0, notas: 0, km: 0 });

        // O middleware global ja e no-cache; reforca para o polling nunca pegar
        // resposta velha de proxy.
        res.setHeader("Cache-Control", "no-store");
        res.json({
          dia,
          hoje,
          ehHoje: dia === hoje,
          geradoEm: new Date().toISOString(),
          totais,
          vendedores: rows,
          evolutivoRepescagem: {
            de: inicioEvolutivo,
            ate: dia,
            dias: evolutivo.map((r) => ({
              dia: r.dia,
              sorteados: Number(r.sorteados) || 0,
              atendidos: Number(r.atendidos) || 0,
            })),
          },
        });
      } catch (e: any) {
        console.error("GET /api/gestao/painel-atendimento", e);
        res.status(500).json({ error: e?.message || "erro" });
      }
    },
  );
}
