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
//
// DOIS CALENDARIOS, UMA MATRIZ (Flavio, 22/10/2026). Cada celula carrega os
// dois numeros ao mesmo tempo: quantos CLIENTES caem ali e quantos R$ eles
// POTENCIALMENTE compram. A tela so' escolhe qual mostrar. Dois numeros na
// mesma consulta e' o que garante que o calendario de R$ e o de clientes
// estejam sempre falando do mesmo conjunto de atendimentos — se fossem duas
// rotas, bastaria uma mudar de filtro para os totais passarem a divergir sem
// ninguem perceber.
//
// POTENCIAL DE UM ATENDIMENTO = TICKET PONDERADO POR RECENCIA: media do valor
// das NF-e de venda do cliente na janela, com peso crescente para as mais
// recentes (a 1a nota pesa 1, a 2a pesa 2...). E' a MESMA conta do termometro
// do dia no Dashboard (computeDailyThermometer), de proposito: o vendedor ve o
// mesmo numero nas duas telas. Quem nao tem nota na janela entra como R$ 0 —
// nada e' estimado — e a tela diz quantos sao, para o total ser lido sabendo o
// quanto esta subestimado. LEAD e' sempre R$ 0: nunca comprou.
// -----------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { authenticateUser } from "./authMiddleware";
import { cteNotasVenda, MES_NFE_INTEGRA } from "./faturamento-carteira";

const TZ = "America/Sao_Paulo";

/** Quantos dias de historico entram no ticket ponderado. */
const JANELA_TICKET_DIAS = 180;

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

/** Uma celula guarda os DOIS calendarios: `n` = clientes, `v` = R$ potencial. */
type Celula = { n: Record<Tipo, number>; v: Record<Tipo, number> };
const zeros = (): Record<Tipo, number> => ({ semanal: 0, quinzenal: 0, mensal: 0, repescagem: 0, leads: 0 });
const celulaVazia = (): Celula => ({ n: zeros(), v: zeros() });

/** chave 'semana|dia|canal' -> contagens e valores por tipo. */
type Mapa = Map<string, Celula>;
const chave = (sem: number, dia: string, canal: string) => `${sem}|${dia}|${canal}`;

function soma(mapa: Mapa, sem: number, dia: DiaSemana, canal: string, tipo: Tipo, n: number, v: number) {
  if (!n && !v) return;
  const k = chave(sem, dia, canal);
  const c = mapa.get(k) || celulaVazia();
  c.n[tipo] += n;
  c.v[tipo] += v;
  mapa.set(k, c);
}

/** 'YYYY-MM-DD' de `dias` dias antes de hoje (hoje de Brasilia). */
function diasAtras(dias: number): string {
  const [a, m, d] = hojeBrasilia().split("-").map(Number);
  return iso(new Date(a, m - 1, d - dias));
}

/** 'YYYY-MM-DD' de amanha — fim EXCLUSIVO de uma janela que termina hoje. */
function amanha(): string {
  const [a, m, d] = hojeBrasilia().split("-").map(Number);
  return iso(new Date(a, m - 1, d + 1));
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
  // clientes ativos.
  //
  // SEM sellerId o quadro e' de TODOS os vendedores somados (Flavio, 22/10/2026)
  // — a visao da operacao inteira, que e' a pergunta de quem abre a tela sem ter
  // um vendedor em mente. "Todos" e' exatamente a soma dos vendedores que o
  // seletor lista, nem um a mais: assim da' para somar o seletor na mao e bater
  // com o total. Quem vir uma carteira que nao devia estar nessa conta resolve
  // tirando o vendedor do seletor (zerando a carteira dele), nao com um filtro
  // escondido aqui dentro.
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

      // ESCOPO DA CONSULTA. Um vendedor escolhido -> so' ele. Nenhum -> todos os
      // do seletor. Um fragmento SQL so', usado por todas as consultas abaixo,
      // para nao existir a chance de uma delas filtrar por um escopo e outra
      // por outro — que e' como um total deixa de fechar com as suas partes.
      const todos = !sellerId;
      const idsEscopo = todos ? vendedores.map((v) => v.id) : [sellerId];
      if (!idsEscopo.length) {
        return res.json({ mes, semanas, vendedor: null, celulas: [], vendedores, escopo: { restrito, papel } });
      }
      const listaIds = sql.join(idsEscopo.map((x) => sql`${x}`), sql`, `);

      // Janela do quadro: da segunda da 1a semana a sexta da ultima.
      const ini = semanas[0].ini;
      const fim = semanas[semanas.length - 1].fim;

      // ── 1) CLIENTES NA AGENDA DE VISITAS ─────────────────────────────────
      // Mesma regua de storage.getCustomersForDate (Rota do Dia), menos o filtro
      // "ja comprou no ciclo", que e' decisao do dia e nao do mes.
      //
      // Uma linha por CLIENTE por DIA (DISTINCT), nao a contagem ja' somada: o
      // valor de cada atendimento depende de QUAL cliente e', entao a soma tem
      // que acontecer com o cliente na mao. O DISTINCT faz aqui o papel que o
      // COUNT(DISTINCT c.id) fazia antes — visita duplicada no mesmo dia nao
      // conta duas vezes, nem em cliente nem em R$.
      const visitas = (await db.execute(sql`
        SELECT DISTINCT
               to_char(v.scheduled_date,'YYYY-MM-DD')                     AS dia,
               EXTRACT(ISODOW FROM v.scheduled_date)::int                 AS dow,
               LOWER(COALESCE(c.visit_periodicity::text,'semanal'))       AS periodicidade,
               (COALESCE(c.virtual_service,false) = true)                 AS virtual,
               c.id                                                       AS cid,
               NULLIF(regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g'),'') AS doc
        FROM visit_agenda v
        JOIN customers c ON c.id = v.customer_id
        WHERE v.scheduled_date::date >= ${ini}::date
          AND v.scheduled_date::date <= ${fim}::date
          AND COALESCE(v.visit_status,'pending') <> 'cancelled'
          AND c.seller_id IN (${listaIds})
          AND c.is_active = true
          AND COALESCE(c.is_supplier,false) = false
          AND COALESCE(c.is_lead,false) = false
          AND (c.service_start_date IS NULL OR c.service_start_date::date <= v.scheduled_date::date)
          AND EXTRACT(ISODOW FROM v.scheduled_date) BETWEEN 1 AND 5`)).rows as any[];

      // ── 2) REPESCAGEM (sorteio do dia) ───────────────────────────────────
      // Fase 'telemarketing' e' atendimento VIRTUAL; o resto, presencial.
      const repescagens = (await db.execute(sql`
        SELECT DISTINCT
               ra.draw_date                                   AS dia,
               EXTRACT(ISODOW FROM ra.draw_date::date)::int    AS dow,
               (COALESCE(ra.phase,'') = 'telemarketing')       AS virtual,
               LOWER(COALESCE(c.visit_periodicity::text,'semanal')) AS periodicidade,
               ra.customer_id                                  AS cid,
               NULLIF(regexp_replace(COALESCE(c.cnpj,c.cpf,''),'[^0-9]','','g'),'') AS doc
        FROM repescagem_assignments ra
        JOIN customers c ON c.id = ra.customer_id
        WHERE ra.draw_date >= ${ini}
          AND ra.draw_date <= ${fim}
          AND COALESCE(ra.status,'') NOT IN ('cancelled','returned')
          AND COALESCE(c.is_supplier,false) = false
          AND ra.assigned_user_id IN (${listaIds})
          AND EXTRACT(ISODOW FROM ra.draw_date::date) BETWEEN 1 AND 5`)).rows as any[];

      // ── 3) LEADS (sempre presencial, pela data do proximo contato) ───────
      const leads = (await db.execute(sql`
        SELECT to_char(l.next_contact_date,'YYYY-MM-DD')              AS dia,
               EXTRACT(ISODOW FROM l.next_contact_date)::int          AS dow,
               COUNT(DISTINCT l.id)::int                              AS n
        FROM leads l
        WHERE l.next_contact_date::date >= ${ini}::date
          AND l.next_contact_date::date <= ${fim}::date
          AND l.assigned_to IN (${listaIds})
          AND COALESCE(l.status::text,'pending') NOT IN ('converted','discarded')
          AND EXTRACT(ISODOW FROM l.next_contact_date) BETWEEN 1 AND 5
        GROUP BY 1,2`)).rows as any[];

      // ── 4) TICKET PONDERADO POR RECENCIA, dos clientes QUE ESTAO NO QUADRO ──
      // Media do valor das NF-e de venda na janela, com peso crescente para as
      // mais recentes. Mesma conta do termometro do dia (dashboard-history.ts).
      // A janela nunca comeca antes de abr/2026 porque antes disso o faturamento
      // nao mora em NF-e e sim em titulo — misturar as duas fontes aqui daria um
      // ticket que nao bate com nenhuma outra tela.
      //
      // O ESCOPO SAO OS CLIENTES DO QUADRO, nao a carteira do vendedor. A conta
      // nasceu (22/10/2026) buscando o ticket de `customers WHERE seller_id = o
      // vendedor` — e a REPESCAGEM derrubou isso no mesmo dia: cliente sorteado
      // para um vendedor normalmente pertence a carteira de OUTRO, entao a busca
      // nao achava a nota dele e ele entrava no quadro como R$ 0. O vendedor via
      // um potencial menor do que o real, e a soma de todos os vendedores nao
      // batia com o quadro de todos (R$ 514 mil contra R$ 565 mil em out/26).
      // Perguntando pelos docs que estao no quadro, o escopo e' o mesmo em
      // qualquer recorte — por construcao, nao por coincidencia.
      const iniTicket = [diasAtras(JANELA_TICKET_DIAS), `${MES_NFE_INTEGRA}-01`].sort().reverse()[0];
      const fimTicketExcl = amanha();
      const docsQuadro = Array.from(new Set(
        [...visitas, ...repescagens]
          .map((r: any) => String(r.doc || "").replace(/[^0-9]/g, ""))
          .filter(Boolean),
      ));
      const listaDocs = docsQuadro.map((d) => `'${d}'`).join(",") || `''`;
      const tickets = docsQuadro.length
        ? ((await db.execute(sql.raw(`
            WITH ${cteNotasVenda(iniTicket, fimTicketExcl)},
            pesos AS (
              -- peso = ordem cronologica da nota: a mais antiga pesa 1, a seguinte 2...
              -- O desempate por valor so' existe para a conta nao mudar de resultado
              -- entre duas aberturas da tela quando o cliente tem 2 notas no mesmo dia.
              SELECT n.doc, n.v, ROW_NUMBER() OVER (PARTITION BY n.doc ORDER BY n.dia, n.v) AS w
              FROM notas n
              WHERE n.doc IN (${listaDocs})
            )
            SELECT doc,
                   (SUM(v * w) / NULLIF(SUM(w),0))::float AS t,
                   COUNT(*)::int                          AS notas
            FROM pesos GROUP BY doc`))).rows as any[])
        : [];
      /** doc (so' digitos) -> R$ esperado num atendimento. */
      const ticketPorDoc = new Map<string, number>();
      for (const r of tickets) {
        const t = Number(r.t) || 0;
        if (t > 0) ticketPorDoc.set(String(r.doc), t);
      }
      const ticketDe = (doc: any) => ticketPorDoc.get(String(doc || "")) || 0;

      // ── UM TICKET POR CICLO DE COMPRA, nao por atendimento ────────────────
      // Flavio, 25/10/2026. O potencial do mes vinha 2,1x o faturamento real
      // (R$ 603 mil contra ~R$ 285 mil) e a razao nao era o ticket — era a
      // CONTAGEM. Medido nas 3 semanas fechadas de out/26: R$ 250 de potencial
      // por atendimento e R$ 250 de faturamento real por nota emitida, mas 2,63
      // atendimentos para cada nota. O cliente e' TOCADO 2,6 vezes no mes e
      // COMPRA uma vez por ciclo:
      //   • cliente virtual hibrido (439 dos 941 ativos) recebe a cadencia
      //     virtual MAIS uma visita presencial de reforco por mes — dois
      //     atendimentos, um pedido (ver visitScheduleService: gera a presencial
      //     e, se segue virtual, continua na cadencia virtual);
      //   • repescagem e' segunda tentativa do MESMO ciclo de quem nao comprou,
      //     nao um pedido a mais;
      //   • cliente com dois dias de rota na semana.
      // Entao o ticket entra UMA vez por ciclo: o primeiro atendimento do ciclo
      // leva o valor cheio, os seguintes entram com R$ 0 e continuam contando
      // como atendimento no calendario de Clientes. A visita de reforco nao
      // sumiu da rota — ela so' deixou de valer como segundo pedido.
      const JANELA_CICLO: Record<string, number> = { semanal: 5, quinzenal: 11, mensal: 24 };
      const diasEntre = (a: string, b: string) =>
        Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

      type Atendimento = {
        dia: string; sem: number; diaSem: DiaSemana; canal: string;
        tipo: Tipo; cid: string; doc: string; per: string;
      };
      const atendimentos: Atendimento[] = [];
      const empilha = (r: any, tipo: Tipo | null) => {
        const sem = semanaDaData(semanas, String(r.dia));
        const diaSem = DIA_POR_DOW[Number(r.dow)];
        if (!sem || !diaSem) return;
        const per = String(r.periodicidade || "semanal");
        atendimentos.push({
          dia: String(r.dia), sem, diaSem,
          canal: r.virtual === true ? "virtual" : "presencial",
          tipo: tipo || (per === "quinzenal" ? "quinzenal" : per === "mensal" ? "mensal" : "semanal"),
          cid: String(r.cid), doc: String(r.doc || ""), per,
        });
      };
      for (const r of visitas) empilha(r, null);
      for (const r of repescagens) empilha(r, "repescagem");
      // Em ordem de data: o PRIMEIRO atendimento do ciclo e' o que leva o valor.
      atendimentos.sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));

      // ── monta a matriz ───────────────────────────────────────────────────
      // `semHistorico` conta CLIENTE, nao atendimento: quem aparece 4x no mes
      // sem nota nenhuma e' um cliente faltando no total de R$, nao quatro.
      const mapa: Mapa = new Map();
      const semHistorico = new Set<string>();
      const comHistorico = new Set<string>();
      /** cliente -> dia do ultimo atendimento que ja' levou o ticket. */
      const cobradoEm = new Map<string, string>();
      let repetidosNoCiclo = 0;
      for (const a of atendimentos) {
        const cheio = ticketDe(a.doc);
        if (cheio > 0) comHistorico.add(a.cid); else semHistorico.add(a.cid);
        let t = cheio;
        if (cheio > 0) {
          const ultimo = cobradoEm.get(a.cid);
          const minimo = JANELA_CICLO[a.per] ?? JANELA_CICLO.semanal;
          if (ultimo && diasEntre(ultimo, a.dia) < minimo) { t = 0; repetidosNoCiclo++; }
          else cobradoEm.set(a.cid, a.dia);
        }
        soma(mapa, a.sem, a.diaSem, a.canal, a.tipo, 1, t);
      }
      let totalLeads = 0;
      for (const r of leads) {
        const sem = semanaDaData(semanas, String(r.dia));
        const dia = DIA_POR_DOW[Number(r.dow)];
        if (!sem || !dia) continue;
        // Lead nunca comprou: entra no calendario de clientes e fica zerado no
        // de R$. Inventar um ticket para ele seria colocar venda que nao existe
        // dentro de um numero que o vendedor usa para se cobrar.
        const n = Number(r.n) || 0;
        totalLeads += n;
        soma(mapa, sem, dia, "presencial", "leads", n, 0);
      }

      // Devolve so' as celulas com algum numero — o resto a tela desenha zerado.
      //
      // O R$ sai daqui ARREDONDADO PARA REAL INTEIRO, que e' como a tela mostra.
      // Guardar os centavos e arredondar so' na hora de desenhar fazia cada total
      // arredondar por conta propria, e as quatro semanas somavam R$ 1 a menos
      // que o mes (565.144 contra 565.145 em out/26). Um real de diferenca nao
      // muda decisao nenhuma, mas poe em duvida a tela inteira: quem confere uma
      // soma que nao fecha para de confiar no resto. Arredondando na celula — a
      // menor coisa que aparece na tela — celula + celula fecha o dia, os dias
      // fecham a semana e as semanas fecham o mes, exatamente.
      const inteiro = (r: Record<Tipo, number>): Record<Tipo, number> => {
        const fora = zeros();
        for (const t of TIPOS) fora[t] = Math.round(r[t]);
        return fora;
      };
      const celulas: Array<{ semana: number; dia: string; canal: string } & Celula> = [];
      for (const [k, c] of mapa) {
        const [s, d, canal] = k.split("|");
        celulas.push({ semana: Number(s), dia: d, canal, n: c.n, v: inteiro(c.v) });
      }

      // Clientes ativos do vendedor — o numero que vai ao lado do nome.
      const ativos = (await db.execute(sql`
        SELECT COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE COALESCE(virtual_service,false) = true)::int AS virtuais
        FROM customers
        WHERE seller_id IN (${listaIds})
          AND is_active = true
          AND COALESCE(is_supplier,false) = false
          AND COALESCE(is_lead,false) = false`)).rows as any[];

      const nome = todos
        ? []
        : ((await db.execute(sql`
            SELECT NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')),'') AS nome
            FROM users WHERE id = ${sellerId} LIMIT 1`)).rows as any[]);

      res.json({
        mes,
        hoje: hojeBrasilia(),
        semanas,
        dias: DIAS,
        tipos: TIPOS,
        canais: CANAIS,
        vendedor: {
          id: sellerId,
          nome: todos ? `Todos os vendedores (${vendedores.length})` : String(nome?.[0]?.nome || sellerId),
          ativos: Number(ativos?.[0]?.n) || 0,
          ativosVirtuais: Number(ativos?.[0]?.virtuais) || 0,
          /** true = o quadro e' a soma de todos os vendedores do seletor. */
          todos,
        },
        celulas,
        vendedores,
        escopo: { restrito, papel },
        // Tudo o que a tela precisa para explicar o calendario de R$ sem que
        // ninguem tenha que abrir o codigo para saber de onde veio o numero.
        potencial: {
          de: iniTicket,
          ate: hojeBrasilia(),
          dias: JANELA_TICKET_DIAS,
          clientesComTicket: comHistorico.size,
          semHistorico: semHistorico.size,
          leads: totalLeads,
          /** Atendimentos que caíram no mesmo ciclo de um anterior e entraram com R$ 0. */
          repetidosNoCiclo,
          regra: "ticket ponderado por recência: média do valor das NF-e de venda do cliente na janela, com peso maior para as mais recentes (mesma conta do termômetro do dia no Dashboard). O ticket entra uma vez por ciclo de compra do cliente — o segundo atendimento dentro do mesmo ciclo (visita presencial de reforço do cliente virtual, repescagem de quem já está na rota) conta como atendimento e não como novo pedido",
        },
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
