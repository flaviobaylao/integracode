import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
    throw new Error(
          "DATABASE_URL must be set. Did you forget to provision a database?",
        );
}

// application_name identifica a aplicacao nas trilhas do banco. Sem isto, tudo
// que a aplicacao faz aparece no trigger de log (bank_statement_item_status_log)
// e no pg_stat_activity como `postgres` com aplicacao em branco — indistinguivel
// de um SQL rodado a mao no console. Com o nome, da para separar "veio da
// aplicacao" de "veio de fora", que foi o que faltou para apurar as conciliacoes
// desfeitas em 06/08.
// lock_timeout: nenhuma consulta espera mais de 15s por um LOCK. Nao afeta
// consulta demorada — so o TEMPO PARADO na fila de lock.
//
// Em 06/08 a aplicacao ficou ~1h fora por causa disto: um SELECT longo em
// `customers` segurou a fila, atras dele entrou o `ALTER TABLE customers ADD
// COLUMN IF NOT EXISTS segmento` do boot (precisa de ACCESS EXCLUSIVE) e, no
// Postgres, ALTER parado na fila bloqueia TODO MUNDO que vier depois, inclusive
// leitura. O boot pendurava, o healthcheck falhava, o Railway reiniciava, o novo
// boot enfileirava OUTRO ALTER — a fila so crescia. Cinco deploys morreram nisso
// e o servico so voltou quando cancelamos os backends na mao.
//
// Com o teto, o ALTER do boot desiste em 15s (o .catch dele ja engole o erro; a
// coluna entra no proximo boot) e a aplicacao sobe. 15s e folgado: consulta sadia
// nao espera nem 1s por lock; quem espera 15 ja e sintoma de fila.
// statement_timeout (06/10/2026): teto de tempo para UMA consulta. Em 06/10 o escopo por
// vendedor do Dashboard levava >10 min e cada abertura de tela enfileirava outra copia:
// 16 conexoes presas na mesma consulta, pool esgotado, sistema inteiro lento. A causa foi
// corrigida (indice + subquery), mas sem teto a PROXIMA consulta ruim derruba tudo de novo.
// 120 s e folgado: nenhuma tela legitima espera 2 min por uma consulta; migracoes do boot
// e exportacoes grandes rodam em segundos. Ajustavel por env (PG_STATEMENT_TIMEOUT_MS).
// work_mem: 4 MB (padrao) mandava para disco a ordenacao da deduplicacao de NF-e
// (temp_files somava 694 GB). 16 MB por operacao de sort/hash e seguro com pool de 10.
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS || 120_000);
const WORK_MEM = process.env.PG_WORK_MEM || '16MB';
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: 'integra-app',
  options: `-c lock_timeout=15s -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c work_mem=${WORK_MEM}`,
});

// O pg emite 'error' no POOL quando um cliente OCIOSO cai sozinho — a rede
// oscilou, o banco reiniciou, o provedor derrubou a conexao parada. Sem ninguem
// escutando esse evento, o Node trata como excecao nao capturada e MATA O
// PROCESSO. Ou seja: o banco pisca por um segundo e o sistema inteiro sai do ar,
// sem uma linha de log dizendo por que.
//
// Reproduzido: com a aplicacao no ar, derrubar o Postgres encerra o processo em
// pg-pool/index.js:45. Nao existe ponto de defesa no meio do caminho.
//
// E pior do que parece por causa do railway.json: restartPolicyMaxRetries e 10.
// Se o banco demora mais do que dez reinicios para voltar, o Railway desiste e o
// servico fica em 502 ate alguem entrar e mandar subir na mao.
//
// Escutar aqui NAO esconde erro de consulta: cada query continua rejeitando a
// promessa dela e quem chamou trata como sempre. O que muda e so o destino da
// conexao ociosa que morreu — vira log em vez de fim do processo, e o proximo
// pedido pega uma conexao nova, que o pool recria sozinho.
pool.on('error', (err: any) => {
  console.error('[DB] conexao ociosa caiu; o pool se recupera sozinho:', err?.message || err);
});

export const db = drizzle({ client: pool, schema });
