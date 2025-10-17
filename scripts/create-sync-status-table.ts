import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function createSyncStatusTable() {
  try {
    console.log("Creating sync_status_enum type...");
    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE sync_status_enum AS ENUM ('success', 'error', 'in_progress');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    console.log("✅ Enum created or already exists");

    console.log("Creating sync_status table...");
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sync_status (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        sync_type VARCHAR NOT NULL UNIQUE,
        last_sync_at TIMESTAMP NOT NULL,
        status sync_status_enum NOT NULL DEFAULT 'success',
        message TEXT,
        records_processed INTEGER,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("✅ Table sync_status created successfully");

    console.log("Creating index on sync_type...");
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_sync_status_sync_type ON sync_status(sync_type);
    `);
    console.log("✅ Index created successfully");

    console.log("\n🎉 Sync status table setup completed!");
  } catch (error) {
    console.error("❌ Error creating sync_status table:", error);
    process.exit(1);
  }
  process.exit(0);
}

createSyncStatusTable();
