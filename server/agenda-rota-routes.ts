// server/agenda-rota-routes.ts
// -----------------------------------------------------------------------------
// GESTAO DE CARTEIRAS — aba AGENDA DE ROTA
//
// Quantos atendimentos o vendedor tem em cada SEMANA do mes e no mes inteiro,
// abertos por DIA DA SEMANA e por PERIODICIDADE, separando PRESENCIAL de
// VIRTUAL. O desenho do Flavio (04/10/2026):
//
//              SEGUNDA                       TERCA
//        semanal | quinzenal | mensal | ...
//   PRESENCIAL
//   VIRTUAL
//   TOTAL
//
// mais duas colunas por dia que NAO tem periodicidade — REPESCAGEM e LEADS.
//
// A REGUA E A DA ROTA DO DIA. Nao e' projecao do cadastro: e' a propria agenda
// de visitas (`visit_agenda`) que a Rota do Dia le, com os mesmos filtros de
// storage.getCustomersForDate:
//   • cliente ATIVO (is_active), do vendedor (seller_id);
//   • nao fornecedor, nao lead;
//   • service_start_date nula ou ja comecada;
//   • visita nao cancelada na data.
// Fica de fora so' o filtro "ja comprou no ciclo", que e' uma decisao do DIA
// (tira da rota de hoje quem ja comprou) e nao faz sentido num planejamento do
// mes — ele encolheria o passado toda vez que a tela fosse aberta.
//
// SEMANA DO MES: contada pela SEGUNDA-FEIRA, a mesma regra de
// shared/visitSchedule.ts — a semana pertence ao mes da segunda dela. Por isso
// a 1a semana pode comecar no fim do mes anterior e a ultima invadir o mes
// seguinte. Somar as semanas da exatamente o total do mes.
//
// REPESCAGEM e' sorteada DIA A DIA (repescagem_assignments.draw_date), entao so'
// existe para dias que ja aconteceram: nas semanas futuras a coluna fica zerada,
// e a tela avisa. Repescagem de fase 'telemarketing' conta como VIRTUAL; a de
// vendedor externo, como PRESENCIAL.
//
// LEAD e' sempre PRESENCIAL (regra do Flavio, ago/2026) e entra pela data do
// proximo contato (leads.next_contact_date).
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";

const TZ = "America/Sao_Paulo";

/** 'YYYY-MM' de hoje no horario de Brasilia. */
function mesHoje(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
}
function hojeBrasilia(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** As segundas-feiras de um mes — cada uma abre uma semana. */
function segundasDoMes(ano: number, mes0: number): Date[] {
  const fora: Date[] = [];
  const ultimo = new Date(ano, mes0 + 1, 0).getDate();
  for (let d = 1; d <= ultimo; d++) {
    const data = new Date(ano, mes0, d);
    if (data.getDay() === 1) fora.push(data);
  }
  return fora;
}

export type SemanaMes = {
  /** 1..5 */ n: number;
  /** 'YYYY-MM-DD' da segunda */ ini: string;
  /** 'YYYY-MM-DD' da sexta */ fim: string;
  rotulo: string;
  ultima: boolean;
  atual: boolean;
};

/**
 * As semanas de um mes 'YYYY-MM', de segunda a sexta. A semana e' do mes da
 * segunda dela, entao a ultima pode terminar ja no mes seguinte.
 */
export function semanasDoMes(mes: string): SemanaMes[] {
  const [a, m] = mes.split("-").map(Number);
  const segundas = segundasDoMes(a, (m || 1) - 1);
  const hoje = hojeBrasilia();
  return segundas.map((seg, i) => {
    const sex = new Date(seg); sex.setDate(sex.getDate() + 4);
    const ini = iso(seg), fim = iso(sex);
    return {
      n: i + 1, ini, fim,
      rotulo: `${i + 1}ª semana`,
      ultima: i === segundas.length - 1,
      atual: hoje >= ini && hoje <= fim,
    };
  });
}

const DIAS = ["seg", "ter", "qua", "qui", "sex"] as const;
export type DiaSemana = (typeof DIAS)[number];
/** 1=segunda ... 5=sexta (ISO dow do Postgres). */
const DIA_POR_DOW: Record<number, DiaSemana> = { 1: "seg", 2: "ter", 3: "qua", 4: "qui", 5: "sex" };

const CANAIS = ["presencial", "virtual"] as const;
const TIPOS = ["semanal", "quinzenal", "mensal", "repescagem", "leads"] as const;
export type Tipo = (typeof TIPOS)[number];

type Celula = Record<Tipo, number>;
const celulaVazia = (): Celula => ({ semanal: 0, quinzenal: 0, mensal: 0, repescagem: 0, leads: 0 });

/** chave 'semana|dia|canal' -> contagens por tipo. */
type Mapa = Map<string, Celula>;
const chave = (sem: number, dia: string, canal: string) => `${sem}|${dia}|${canal}`;

function soma(mapa: Mapa, sem: number, dia: DiaSemana, canal: string, tipo: Tipo, n: number) {
  if (!n) return;
  const k = chave(sem, dia, canal);
  const c = mapa.get(k) || celulaVazia();
  c[tipo] += n;
  mapa.set(k, c);
}

/** Em que semana do mes exibido cai a data (0 = fora da janela). */
function semanaDaData(semanas: SemanaMes[], d: string): number {
  for (const s of semanas) if (d >= s.ini && d <= s.fim) return s.n;
  return 0;
}

export function registerAgendaRota(app: Express) {
  // ---------------------------------------------------------------------------
  // GET /api/carteira/agenda-rota?sellerId=...&mes=YYYY-MM
  //
  // Devolve as semanas do mes, a matriz semana x dia x canal x tipo e o total de
  // clientes ativos do vendedor. Sem sellerId, devolve so' a lista de vendedores.
  // ---------------------------------------------------------------------------
  app.get("/api/carteira/agenda-rota", authenticateUser, async (req: Request, res: Response) => {
    try {
      const usuario: any = (req as any)?.currentUser || (req as any)?.user || null;
      const papel = String(usuario?.role || "");
      const restrito = ["vendedor", "telemarketing"].includes(papel);
      // Vendedor so' enxerga a propria agenda, nao importa o que venha na query.
      const sellerId = restrito
        ? String(usuario?.id || "")
        : String(req.query.sellerId || "").replace(/[^A-Za-z0-9_-]/g, "");
      const mes = /^\d{4}-\d{2}$/.test(String(req.query.mes || "")) ? String(req.query.mes) : mesHoje();

      const semanas = semanasDoMes(mes);
      if (!semanas.length) return res.json({ mes, semanas: [], vendedor: null, celulas: [], vendedores: [] });

      // Vendedores com carteira ativa, para o seletor da tela.
      const vendedores = restrito
        ? []
        : ((await db.execute(sql`
            SELECT u.id,
                   NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),'') AS nome,
                   COUNT(c.id)::int AS ativos
            FROM users u
            JOIN customers c
              ON c.seller_id = u.id
             AND c.is_active = true
             AND COALESCE(c.is_supplier,false) = false
             AND COALESCE(c.is_lead,false) = false
            GROUP BY u.id, u.first_name, u.last_name
            HAVING COUNT(c.id) > 0
            ORDER BY 2`)).rows as any[]).map((r) => ({
              id: String(r.id), nome: String(r.nome || r.id), ativos: Number(r.ativos) || 0,
            }));

      if (!sellerId) return res.json({ mes, semanas, vendedor: null, celulas: [], vendedores });

      // Janela do quadro: da segunda da 1a semana a sexta da ultima.
      const ini = semanas[0].ini;
      const fim = semanas[semanas.length - 1].fim;

      // ── 1) CLIENTES NA AGENDA DE VISITAS ─────────────────────────────────
      // Mesma regua de storage.getCustomersForDate (Rota do Dia), menos o filtro
      // "ja comprou no ciclo", que e' decisao do dia e nao do mes.
      const visitas = (await db.execute(sql`
        SELECT to_char(v.scheduled_date,'YYYY-MM-DD')                     AS dia,
               EXTRACT(ISODOW FROM v.scheduled_date)::int                 AS dow,
               LOWER(COALESCE(c.visit_periodicity::text,'semanal'))       AS periodicidade,
               (COALESCE(c.virtual_service,false) = true)                 AS virtual,
               COUNT(DISTINCT c.id)::int                                  AS n
        FROM visit_agenda v
        JOIN customers c ON c.id = v.customer_id
        WHERE v.scheduled_date::date >= ${ini}::date
          AND v.scheduled_date::date <= ${fim}::date
          AND COALESCE(v.visit_status,'pending') <> 'cancelled'
          AND c.seller_id = ${sellerId}
          AND c.is_active = true
          AND COALESCE(c.is_supplier,false) = false
          AND COALESCE(c.is_lead,false) = false
          AND (c.service_start_date IS NULL OR c.service_start_date::date <= v.scheduled_date::date)
          AND EXTRACT(ISODOW FROM v.scheduled_date) BETWEEN 1 AND 5
        GROUP BY 1,2,3,4`)).rows as any[];

      // ── 2) REPESCAGEM (sorteio do dia) ───────────────────────────────────
      // Fase 'telemarketing' e' atendimento VIRTUAL; o resto, presencial.
      const repescagens = (await db.execute(sql`
        SELECT ra.draw_date                                   AS dia,
               EXTRACT(ISODOW FROM ra.draw_date::date)::int    AS dow,
               (COALESCE(ra.phase,'') = 'telemarketing')       AS virtual,
               COUNT(DISTINCT ra.customer_id)::int             AS n
        FROM repescagem_assignments ra
        JOIN customers c ON c.id = ra.customer_id
        WHERE ra.draw_date >= ${ini}
          AND ra.draw_date <= ${fim}
          AND COALESCE(ra.status,'') NOT IN ('cancelled','returned')
          AND COALESCE(c.is_supplier,false) = false
          AND ra.assigned_user_id = ${sellerId}
          AND EXTRACT(ISODOW FROM ra.draw_date::date) BETWEEN 1 AND 5
        GROUP BY 1,2,3`)).rows as any[];

      // ── 3) LEADS (sempre presencial, pela data do proximo contato) ───────
      const leads = (await db.execute(sql`
        SELECT to_char(l.next_contact_date,'YYYY-MM-DD')              AS dia,
               EXTRACT(ISODOW FROM l.next_contact_date)::int          AS dow,
               COUNT(DISTINCT l.id)::int                              AS n
        FROM leads l
        WHERE l.next_contact_date::date >= ${ini}::date
          AND l.next_contact_date::date <= ${fim}::date
          AND l.assigned_to = ${sellerId}
          AND COALESCE(l.status::text,'pending') NOT IN ('converted','discarded')
          AND EXTRACT(ISODOW FROM l.next_contact_date) BETWEEN 1 AND 5
        GROUP BY 1,2`)).rows as any[];

      // ── monta a matriz ───────────────────────────────────────────────────
      const mapa: Mapa = new Map();
      for (const r of visitas) {
        const sem = semanaDaData(semanas, String(r.dia));
        const dia = DIA_POR_DOW[Number(r.dow)];
        if (!sem || !dia) continue;
        const per = String(r.periodicidade);
        const tipo: Tipo = per === "quinzenal" ? "quinzenal" : per === "mensal" ? "mensal" : "semanal";
        soma(mapa, sem, dia, r.virtual === true ? "virtual" : "presencial", tipo, Number(r.n) || 0);
      }
      for (const r of repescagens) {
        const sem = semanaDaData(semanas, String(r.dia));
        const dia = DIA_POR_DOW[Number(r.dow)];
        if (!sem || !dia) continue;
        soma(mapa, sem, dia, r.virtual === true ? "virtual" : "presencial", "repescagem", Number(r.n) || 0);
      }
      for (const r of leads) {
        const sem = semanaDaData(semanas, String(r.dia));
        const dia = DIA_POR_DOW[Number(r.dow)];
        if (!sem || !dia) continue;
        soma(mapa, sem, dia, "presencial", "leads", Number(r.n) || 0);
      }

      // Devolve so' as celulas com algum numero — o resto a tela desenha zerado.
      const celulas: Array<{ semana: number; dia: string; canal: string } & Celula> = [];
      for (const [k, c] of mapa) {
        const [s, d, canal] = k.split("|");
        celulas.push({ semana: Number(s), dia: d, canal, ...c });
      }

      // Clientes ativos do vendedor — o numero que vai ao lado do nome.
      const ativos = (await db.execute(sql`
        SELECT COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE COALESCE(virtual_service,false) = true)::int AS virtuais
        FROM customers
        WHERE seller_id = ${sellerId}
          AND is_active = true
          AND COALESCE(is_supplier,false) = false
          AND COALESCE(is_lead,false) = false`)).rows as any[];

      const nome = (await db.execute(sql`
        SELECT NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')),'') AS nome
        FROM users WHERE id = ${sellerId} LIMIT 1`)).rows as any[];

      res.json({
        mes,
        hoje: hojeBrasilia(),
        semanas,
        dias: DIAS,
        tipos: TIPOS,
        canais: CANAIS,
        vendedor: {
          id: sellerId,
          nome: String(nome?.[0]?.nome || sellerId),
          ativos: Number(ativos?.[0]?.n) || 0,
          ativosVirtuais: Number(ativos?.[0]?.virtuais) || 0,
        },
        celulas,
        vendedores,
        escopo: { restrito, papel },
        fonte: "agenda de visitas (visit_agenda), mesma régua da Rota do Dia; repescagem pelo sorteio do dia; leads pela data do próximo contato",
      });
    } catch (e: any) {
      console.error("[agenda-rota]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/carteira/agenda-rota/atualizar   body: { sellerId }
  //
  // O botao "Atualizar" da aba. REGRAVA a agenda de visitas de cada cliente ativo
  // do vendedor a partir do CADASTRO de agora (dia de rota, periodicidade, semana
  // de atendimento, atendimento virtual), e so' entao a tela recarrega.
  //
  // POR QUE NAO BASTA RELER. Salvar o cliente pela tela de Clientes ja regrava a
  // agenda dele — nesse caminho, reler bastaria. Mas a agenda tambem envelhece por
  // fora: importacao, mudanca direta no banco, e principalmente o HORIZONTE — cada
  // cliente so' tem as 4 proximas visitas gravadas, entao o fim do mes aparece
  // vazio ate alguem regerar. Regravando, o quadro passa a refletir o cadastro.
  //
  // O QUE NAO E TOCADO: visita ja CONCLUIDA e a visita de HOJE ficam como estao —
  // regenerateCustomerAgenda so' apaga pendente de amanha em diante. Logo, rodar
  // este botao nao encolhe a Rota do Dia de ninguem no meio do expediente.
  //
  // ORCAMENTO DE TEMPO: uma carteira grande passa de 200 clientes e a requisicao
  // nao pode ficar pendurada. Processa ate o orcamento acabar e devolve quantos
  // faltaram, para a tela pedir outra rodada em vez de estourar o tempo limite.
  // ---------------------------------------------------------------------------
  app.post("/api/carteira/agenda-rota/atualizar", authenticateUser, async (req: Request, res: Response) => {
    const ORCAMENTO_MS = 40_000;
    try {
      const usuario: any = (req as any)?.currentUser || (req as any)?.user || null;
      const papel = String(usuario?.role || "");
      const restrito = ["vendedor", "telemarketing"].includes(papel);
      const pedido = String((req.body || {}).sellerId || "").replace(/[^A-Za-z0-9_-]/g, "");
      const sellerId = restrito ? String(usuario?.id || "") : pedido;
      if (!sellerId) return res.status(400).json({ ok: false, error: "Escolha um vendedor." });
      if (restrito && pedido && pedido !== sellerId) {
        return res.status(403).json({ ok: false, error: "Você só pode atualizar a sua própria carteira." });
      }

      const alvos = (await db.execute(sql`
        SELECT id FROM customers
        WHERE seller_id = ${sellerId}
          AND is_active = true
          AND COALESCE(is_supplier,false) = false
          AND COALESCE(is_lead,false) = false
        ORDER BY id`)).rows as any[];

      const { regenerateCustomerAgenda } = await import("./visitScheduleService");
      const comeco = Date.now();
      let clientes = 0, visitas = 0, semData = 0, erros = 0, restantes = 0;

      for (let i = 0; i < alvos.length; i++) {
        if (Date.now() - comeco > ORCAMENTO_MS) { restantes = alvos.length - i; break; }
        try {
          const n = await regenerateCustomerAgenda(String(alvos[i].id));
          clientes++;
          if (n > 0) visitas += n; else semData++;
        } catch (e: any) {
          erros++;
          if (erros <= 5) console.warn("[agenda-rota/atualizar]", alvos[i]?.id, e?.message || e);
        }
      }

      console.log(`[agenda-rota/atualizar] vendedor ${sellerId}: ${clientes}/${alvos.length} cliente(s), ${visitas} visita(s), ${semData} sem data, ${erros} erro(s), ${restantes} restante(s) em ${Date.now() - comeco}ms`);
      res.json({
        ok: true, sellerId,
        total: alvos.length, clientes, visitas, semData, erros, restantes,
        completo: restantes === 0,
        segundos: Math.round((Date.now() - comeco) / 100) / 10,
      });
    } catch (e: any) {
      console.error("[agenda-rota/atualizar]", e);
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
