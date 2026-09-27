/**
 * Auth routes — register, login, logout, password change.
 *
 * POST /register       — create account + session → 201
 * POST /login          — authenticate + session    → 200
 * POST /logout         — revoke session             → 200
 * POST /password-change — change password           → 200
 *
 * Isolation convention:
 *   401 — unauthenticated / generic credential error
 *   404 — wrong resource (unused here, reserved)
 *   422 — malformed input
 *
 * Generic error messages prevent email enumeration.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { pool } from "../db/index.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { rateLimit } from "../lib/rateLimit.js";
import { requireAuth } from "../authz/guards.js";

// ── Constants ──────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Identical error for all credential failures (login + register duplicate). */
const GENERIC_AUTH_ERROR = "invalid_credentials";

// ── Body types ─────────────────────────────────────────────────────

interface RegisterBody {
  email?: string;
  password?: string;
  name?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
}

interface PasswordChangeBody {
  currentPassword?: string;
  newPassword?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Insert a new session row. The onSend hook in the session plugin handles
 * cookie signing and setting — the route only needs to set req.session.id.
 */
async function createDbSession(
  userId: string,
  token: string,
): Promise<void> {
  const absoluteExpires = new Date(Date.now() + ABSOLUTE_TIMEOUT_MS);
  await pool.query(
    `INSERT INTO sessions (user_id, token, expires_at, absolute_expires_at, last_seen_at)
     VALUES ($1, $2, NOW() + INTERVAL '24 hours', $3, NOW())`,
    [userId, token, absoluteExpires],
  );
}

/** Dummy scrypt hash with matching parameters for timing-safe comparison. */
const DUMMY_HASH =
  "scrypt$16384$8$1$" +
  "00000000000000000000000000000000$" +
  "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

// ── Routes ─────────────────────────────────────────────────────────

async function authRoutes(app: FastifyInstance): Promise<void> {
  const authThrottle = rateLimit(30, 10 * 60 * 1000);

  // ── POST /register ────────────────────────────────────────────
  app.post("/register", { preHandler: [authThrottle] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as RegisterBody;
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    // ── Validate input (422) ─────────────────────────────────
    if (!email || !password || !name) {
      return reply.code(422).type("application/json").send({
        error: "invalid_input",
      });
    }
    if (!email.includes("@") || email.length > 255) {
      return reply.code(422).type("application/json").send({
        error: "invalid_input",
      });
    }
    if (password.length < 8) {
      return reply.code(422).type("application/json").send({
        error: "invalid_input",
      });
    }

    // ── Check duplicate email (generic 401) ───────────────────
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    if (existing.rows.length > 0) {
      // Run a dummy verify to keep timing consistent with login
      await verifyPassword(password, DUMMY_HASH);
      return reply.code(401).type("application/json").send({
        error: GENERIC_AUTH_ERROR,
      });
    }

    // ── Create user ───────────────────────────────────────────
    const passwordHash = await hashPassword(password);
    const { rows: userRows } = await pool.query<{
      id: string;
      email: string;
      name: string;
      role: string;
    }>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, role`,
      [email, name, passwordHash],
    );

    const user = userRows[0];
    if (!user) {
      return reply.code(500).type("application/json").send({
        error: "internal_error",
      });
    }

    // ── Create session ────────────────────────────────────────
    const token = generateToken();
    await createDbSession(user.id, token);

    // The session plugin's onSend hook signs and sets the cookie.
    req.session = { id: token, userId: user.id };

    return reply.code(201).type("application/json").send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  });

  // ── POST /login ──────────────────────────────────────────────
  app.post("/login", { preHandler: [authThrottle] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as LoginBody;
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    // ── Validate input (422) ─────────────────────────────────
    if (!email || !password) {
      return reply.code(422).type("application/json").send({
        error: "invalid_input",
      });
    }

    // ── Look up user ──────────────────────────────────────────
    const { rows } = await pool.query<{
      id: string;
      email: string;
      name: string;
      role: string;
      password_hash: string;
    }>(
      `SELECT id, email, name, role, password_hash FROM users WHERE email = $1`,
      [email],
    );

    const user = rows[0];

    // Always verify password (even for unknown emails) for timing consistency
    const hashToCheck = user?.password_hash ?? DUMMY_HASH;
    const valid = await verifyPassword(password, hashToCheck);

    if (!user || !valid) {
      return reply.code(401).type("application/json").send({
        error: GENERIC_AUTH_ERROR,
      });
    }

    // ── Create session ────────────────────────────────────────
    const token = generateToken();
    await createDbSession(user.id, token);

    req.session = { id: token, userId: user.id };

    // Browser form posts expect a redirect; API clients expect JSON.
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType.includes("application/x-www-form-urlencoded")) {
      return reply.code(302).redirect("/gallery");
    }

    return reply.code(200).type("application/json").send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  });

  // ── POST /logout ─────────────────────────────────────────────
  app.post(
    "/logout",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Revoke current session in DB
      if (req.session?.id) {
        try {
          await pool.query(
            `UPDATE sessions SET revoked_at = NOW() WHERE token = $1`,
            [req.session.id],
          );
        } catch {
          // Best-effort revocation
        }
      }

      // Clear cookie
      reply.clearCookie("sid", { path: "/" });

      return reply.code(200).type("application/json").send({ ok: true });
    },
  );

  // ── POST /password-change ────────────────────────────────────
  app.post(
    "/password-change",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as PasswordChangeBody;
      const currentPassword =
        typeof body.currentPassword === "string" ? body.currentPassword : "";
      const newPassword =
        typeof body.newPassword === "string" ? body.newPassword : "";

      // ── Validate input (422) ─────────────────────────────
      if (!currentPassword || !newPassword) {
        return reply.code(422).type("application/json").send({
          error: "invalid_input",
        });
      }
      if (newPassword.length < 8) {
        return reply.code(422).type("application/json").send({
          error: "invalid_input",
        });
      }

      // ── Resolve user ────────────────────────────────────
      const userId = req.session.userId;
      if (!userId) {
        return reply.code(401).type("application/json").send({
          error: "unauthorized",
        });
      }

      const { rows } = await pool.query<{
        id: string;
        password_hash: string;
      }>(`SELECT id, password_hash FROM users WHERE id = $1`, [userId]);

      const user = rows[0];
      if (!user) {
        return reply.code(401).type("application/json").send({
          error: "unauthorized",
        });
      }

      // ── Verify current password ────────────────────────
      const valid = await verifyPassword(currentPassword, user.password_hash);
      if (!valid) {
        return reply.code(401).type("application/json").send({
          error: GENERIC_AUTH_ERROR,
        });
      }

      // ── Update password ───────────────────────────────
      const newPasswordHash = await hashPassword(newPassword);
      await pool.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [newPasswordHash, userId],
      );

      // ── Revoke all other sessions for this user ──────
      await pool.query(
        `UPDATE sessions SET revoked_at = NOW()
         WHERE user_id = $1 AND token != $2 AND revoked_at IS NULL`,
        [userId, req.session.id],
      );

      return reply.code(200).type("application/json").send({ ok: true });
    },
  );
}

export default authRoutes;
