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
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'integra-app' });
export const db = drizzle({ client: pool, schema });
