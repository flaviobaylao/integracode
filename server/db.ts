import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool, schema });

// Função para garantir que índices críticos existam (executa na inicialização)
async function ensureCriticalIndexes() {
  try {
    // Criar índice único para prevenir duplicatas de cards por cliente/data
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_date 
      ON sales_cards (customer_id, (date(scheduled_date)))
    `);
    console.log('✅ Índice único unique_customer_date verificado/criado');
  } catch (error) {
    console.error('⚠️  Erro ao criar índice único:', error);
    // Não falha a aplicação se o índice já existir ou houver outro problema não-crítico
  }
}

// Executar na inicialização do módulo
ensureCriticalIndexes().catch(console.error);