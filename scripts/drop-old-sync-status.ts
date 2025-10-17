import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function dropOldSyncStatus() {
  try {
    console.log("Dropping old sync_status enum type...");
    await db.execute(sql`DROP TYPE IF EXISTS sync_status CASCADE;`);
    console.log("✅ Old enum dropped");

    console.log("Dropping sync_status table if exists...");
    await db.execute(sql`DROP TABLE IF EXISTS sync_status CASCADE;`);
    console.log("✅ Old table dropped");

    console.log("\n🎉 Cleanup completed!");
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
  process.exit(0);
}

dropOldSyncStatus();
