import { randomBytes, scryptSync } from "node:crypto";
import { Pool } from "pg";

/**
 * Idempotent seed: checks if the `users` table has any rows.
 * - If rows > 0 → skips ("seed skipped (idempotent)")
 * - If rows = 0 → inserts one admin with ADMIN_BOOTSTRAP_PASSWORD or a random one-time password
 */
async function seed(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Check if users already exist (idempotent guard)
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users"
    );
    const count = parseInt(result.rows[0]?.count ?? "0", 10);

    if (count > 0) {
      console.log(`ℹ️  Users table has ${count} row(s) — seed skipped (idempotent).`);
      return;
    }

    const configuredPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (configuredPassword !== undefined && (configuredPassword.length < 12 || configuredPassword.length > 128)) {
      throw new Error("ADMIN_BOOTSTRAP_PASSWORD must be 12–128 characters.");
    }
    const adminPassword = configuredPassword ?? randomBytes(32).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(adminPassword, salt, 64).toString("hex");
    const passwordHash = `${salt}:${hash}`;

    // Insert admin user
    await pool.query(
      `INSERT INTO users (email, name, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      ["admin@dogfood.local", "Admin", passwordHash, "admin"]
    );

    console.log("🌱 Seeded admin user: admin@dogfood.local");
    if (!configuredPassword) console.log(`One-time bootstrap password: ${adminPassword}`);
  } finally {
    await pool.end();
  }
}

// ── Entry point ─────────────────────────────────────────────────────
seed().catch((err) => {
  console.error("❌ Seed runner failed:", err);
  process.exit(1);
});
