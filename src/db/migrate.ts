import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

const LOCK_KEY = "dogfood_migrate";

/**
 * Advisory-lock-protected, lexicographic-order migration runner.
 *
 * Reads every *.sql file in drizzle/, sorts them lexicographically, and runs
 * each inside its own transaction. Uses a PostgreSQL advisory lock keyed on
 * hashtext('dogfood_migrate') to serialize concurrent containers.
 *
 * Handles:
 *  - Empty migrations directory (no-op)
 *  - Partially-applied migrations (each file is its own txn)
 *  - Concurrent invocations (advisory lock)
 *  - Clean unlock on success or failure (try/finally)
 *  - Loud failure with the offending migration filename
 */
async function migrate(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    // Acquire advisory lock — blocks until acquired; serializes all containers
    console.log(`🔒 Acquiring advisory lock (${LOCK_KEY})...`);
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    console.log("🔒 Advisory lock acquired.");

    // Discover drizzle/*.sql files
    const drizzleDir = join(process.cwd(), "drizzle");
    let files: string[];
    try {
      files = (await readdir(drizzleDir))
        .filter((f) => f.endsWith(".sql"))
        .sort(); // lexicographic — assumes 0000_init.sql, 0001_xxx.sql, etc.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.log("ℹ️  No drizzle/ directory found — skipping migrations.");
        return;
      }
      throw err;
    }

    if (files.length === 0) {
      console.log("ℹ️  No .sql files found in drizzle/ — skipping migrations.");
      return;
    }

    console.log(`📦 Found ${files.length} migration file(s).`);

    // Journal table makes re-boots idempotent: applied filenames are skipped.
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );

    for (const file of files) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if ((applied.rowCount ?? 0) > 0) {
        console.log(`  ⏭  ${file} (already applied, skipping)`);
        continue;
      }

      const filePath = join(drizzleDir, file);
      const sql = await readFile(filePath, "utf-8");

      if (sql.trim() === "") {
        console.log(`  ⏭  ${file} (empty, skipping)`);
        continue;
      }

      // Each migration runs in its own transaction
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`  ✅ ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ Migration failed: ${file}`);
        throw err;
      }
    }

    console.log("✅ All migrations applied successfully.");
  } finally {
    // Always release the advisory lock
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
      console.log("🔓 Advisory lock released.");
    } catch {
      // Lock release best-effort; connection will be closed anyway
    }
    client.release();
    await pool.end();
  }
}

// ── Entry point ─────────────────────────────────────────────────────
migrate().catch((err) => {
  console.error("❌ Migration runner failed:", err);
  process.exit(1);
});
