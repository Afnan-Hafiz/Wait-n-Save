/**
 * One-shot migration runner — reads 001_init.sql and executes it via pg.
 * Run with: npx tsx src/db/migrate.ts
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getPool, closePool } from "./client";

async function migrate(): Promise<void> {
  const rootMigrationPath = join(__dirname, "../../../database/migrations/001_init.sql");
  const localMigrationPath = join(__dirname, "migrations/001_init.sql");
  const migrationPath = existsSync(rootMigrationPath) ? rootMigrationPath : localMigrationPath;

  const sql = readFileSync(migrationPath, "utf8");

  console.log("🔄 Running migration against Neon database...");
  const pool = getPool();
  await pool.query(sql);
  console.log("✅ Migration complete — all tables created.");
  await closePool();
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
