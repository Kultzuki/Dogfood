/**
 * LOCAL / DEMO TEST ACCOUNTS (opt-in, local development only).
 *
 * WHAT THIS IS
 *   Four fixed, password-loginable accounts that exist so a human can drive
 *   the browser UI during local QA without hand-crafting signed session
 *   cookies. They are created through the SAME `users` table + scrypt
 *   password hash that POST /register uses — there is no backdoor, no
 *   pre-minted session token, no alternate login route, and no auth/CSRF/
 *   authorization bypass of any kind. Logging in as a demo account exercises
 *   the real POST /login → scrypt verify → DB session → signed cookie path.
 *
 * WHAT THIS IS NOT
 *   - Not the official acceptance fixture identities (stuff/fixtures.json +
 *     src/db/seed-fixtures.ts own those, unchanged).
 *   - Not production-safe. Four accounts share one published password.
 *   - Not referenced by .dogfood.toml.
 *
 * GATE
 *   Runs only when DOGFOOD_DEMO_ACCOUNTS=1. Any other value (including unset)
 *   is a silent no-op, so a deployment that never sets the flag can never
 *   have these accounts created. compose.yaml enables it for the local
 *   quick-start; set DOGFOOD_DEMO_ACCOUNTS=0 in .env to turn it off.
 *
 * IDEMPOTENCE
 *   Upserts by email and re-asserts the role on every boot, so the four
 *   documented credentials always work after `docker compose down -v`.
 *   Never touches fixture users: the demo emails are all under
 *   @dogfood.local and none of them appear in stuff/fixtures.json.
 */
import { Pool } from "pg";
import { hashPassword } from "../lib/password.js";

export type DemoRole = "participant" | "judge" | "organizer" | "admin";

export interface DemoAccount {
  email: string;
  name: string;
  role: DemoRole;
}

/**
 * The demo roster. One role per account — deliberately NOT a superuser, so
 * cross-role isolation tests are meaningful.
 */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: "test.organizer@dogfood.local", name: "Demo Organizer", role: "organizer" },
  { email: "test.judgea@dogfood.local", name: "Demo Judge A", role: "judge" },
  { email: "test.judgeb@dogfood.local", name: "Demo Judge B", role: "judge" },
  { email: "test.participant@dogfood.local", name: "Demo Participant", role: "participant" },
] as const;

/** Default shared demo password. Overridable for local variety, never logged as a secret elsewhere. */
export const DEFAULT_DEMO_PASSWORD = "DogfoodTest123!";

/** True only when the deployment explicitly opted in. */
export function demoAccountsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["DOGFOOD_DEMO_ACCOUNTS"] === "1";
}

export function demoPassword(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["DOGFOOD_DEMO_PASSWORD"];
  return typeof override === "string" && override.length >= 8
    ? override
    : DEFAULT_DEMO_PASSWORD;
}

async function upsertDemoUser(
  pool: Pool,
  account: DemoAccount,
  passwordHash: string,
): Promise<"created" | "updated"> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [account.email],
  );
  if (existing.rows[0]) {
    // Re-assert role + password so the documented credentials keep working
    // after a volume reset, and so a demoted account cannot linger.
    await pool.query(
      `UPDATE users SET role = $1, name = $2, password_hash = $3, updated_at = NOW() WHERE email = $4`,
      [account.role, account.name, passwordHash, account.email],
    );
    return "updated";
  }
  await pool.query(
    `INSERT INTO users (email, name, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [account.email, account.name, passwordHash, account.role],
  );
  return "created";
}

export function banner(password: string): string {
  const lines = [
    "",
    "  ============================================================",
    "   ⚠️  DEMO TEST ACCOUNTS — LOCAL USE ONLY — NOT FOR PRODUCTION",
    "  ============================================================",
    "   Enabled by DOGFOOD_DEMO_ACCOUNTS=1 (local / demo environment).",
    "   These four accounts share one published password. Set",
    "   DOGFOOD_DEMO_ACCOUNTS=0 to disable them.",
    "  ------------------------------------------------------------",
  ];
  for (const a of DEMO_ACCOUNTS) {
    lines.push(`   ${a.role.padEnd(11)} ${a.email}`);
  }
  lines.push("  ------------------------------------------------------------");
  lines.push(`   password (all four): ${password}`);
  lines.push("   Log in normally at / — no special URL, no backdoor.");
  lines.push("  ============================================================");
  lines.push("");
  return lines.join("\n");
}

async function seedDemo(): Promise<void> {
  if (!demoAccountsEnabled()) {
    console.log("ℹ️  DOGFOOD_DEMO_ACCOUNTS is not '1' — demo accounts skipped.");
    return;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is not set.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const password = demoPassword();
  try {
    const passwordHash = await hashPassword(password);
    for (const account of DEMO_ACCOUNTS) {
      const outcome = await upsertDemoUser(pool, account, passwordHash);
      console.log(`🧪 DEMO ONLY: ${account.email} ${outcome} (role=${account.role}).`);
    }
    console.log(banner(password));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  seedDemo().catch((err) => {
    console.error("❌ Demo account seed failed:", err);
    process.exit(1);
  });
}
