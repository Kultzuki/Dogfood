/**
 * Session plugin — DB-backed sessions with signed cookie.
 *
 * Cookie: `sid`, httpOnly, sameSite=Lax, path=/, secure=auto.
 * Session data stored in PostgreSQL with idle (24 h) and absolute (30 d) expiry.
 * Revocation supported via revoked_at column.
 * Ephemeral per-session data (CSRF tokens) kept in a server-side Map.
 */
import fp from "fastify-plugin";
import { randomBytes, createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db/index.js";

// Ensure @fastify/cookie type augmentations (req.cookies, reply.setCookie)
import "@fastify/cookie";

// ── Types ──────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    session: SessionData;
  }
}

export interface SessionData {
  id: string;
  userId?: string;
  [key: string]: unknown;
}

interface SessionRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date | null;
  absolute_expires_at: Date | null;
  revoked_at: Date | null;
}

// ── Constants ──────────────────────────────────────────────────────

export const SESSION_SECRET = resolveSessionSecret();

function resolveSessionSecret(): string {
  const raw = process.env.SESSION_SECRET;
  const weak = !raw || raw.length < 32 || raw === "change-me-in-production";
  if (!weak) return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be set to >= 32 chars (and not the default) in production",
    );
  }
  console.warn("SESSION_SECRET missing or weak — using ephemeral random (dev only).");
  return randomBytes(32).toString("hex");
}
const COOKIE_NAME = "sid";
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_MAX_AGE_S = IDLE_TIMEOUT_MS / 1000;

// ── Ephemeral session data (CSRF tokens, etc.) ─────────────────────
// Single-instance, best-effort only: entries expire after 24h and the map
// is capped, so restarts/replicas lose pre-login CSRF state by design.

interface EphemeralEntry {
  data: Record<string, unknown>;
  createdAt: number;
}

const ephemeralStore = new Map<string, EphemeralEntry>();
const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EPHEMERAL = 5000;

function ephemeralGet(token: string): Record<string, unknown> | undefined {
  const entry = ephemeralStore.get(token);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > EPHEMERAL_TTL_MS) {
    ephemeralStore.delete(token);
    return undefined;
  }
  return entry.data;
}

function ephemeralSet(token: string, data: Record<string, unknown>): void {
  if (ephemeralStore.size >= MAX_EPHEMERAL) {
    const now = Date.now();
    for (const [key, entry] of ephemeralStore) {
      if (now - entry.createdAt > EPHEMERAL_TTL_MS) ephemeralStore.delete(key);
    }
    if (ephemeralStore.size >= MAX_EPHEMERAL) {
      const oldest = ephemeralStore.keys().next();
      if (!oldest.done) ephemeralStore.delete(oldest.value);
    }
  }
  ephemeralStore.set(token, { data, createdAt: Date.now() });
}

// ── Cookie helpers ─────────────────────────────────────────────────

function sign(value: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function unsign(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value, secret);
  // Constant-time compare
  if (expected.length !== signed.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signed.charCodeAt(i);
  }
  return mismatch === 0 ? value : null;
}

export function signSessionValue(value: string): string {
  return sign(value, SESSION_SECRET);
}

function generateId(): string {
  return randomBytes(18).toString("base64url");
}

// ── Plugin ─────────────────────────────────────────────────────────

async function sessionPlugin(app: FastifyInstance): Promise<void> {
  // ── onRequest: restore session from DB or create ephemeral ───────
  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    const raw = req.cookies?.[COOKIE_NAME];

    if (raw) {
      const token = unsign(raw, SESSION_SECRET);
      if (token) {
        // 1. Try DB-backed session
        try {
          const { rows } = await pool.query<SessionRow>(
            `SELECT id, user_id, token, expires_at, created_at,
                    last_seen_at, absolute_expires_at, revoked_at
             FROM sessions WHERE token = $1`,
            [token],
          );

          const row = rows[0];
          if (row) {
            // ── Check revocation ───────────────────────────────
            if (row.revoked_at) {
              // Revoked — clear cookie and fall through
              ephemeralStore.delete(token);
            } else {
              // ── Check absolute expiry ────────────────────────
              if (
                row.absolute_expires_at &&
                row.absolute_expires_at < new Date()
              ) {
                await pool
                  .query(`UPDATE sessions SET revoked_at = NOW() WHERE id = $1`, [row.id])
                  .catch(() => {});
                ephemeralStore.delete(token);
              } else {
                // ── Check idle expiry ──────────────────────────
                const lastSeen = row.last_seen_at ?? row.created_at;
                const idleDeadline = new Date(
                  lastSeen.getTime() + IDLE_TIMEOUT_MS,
                );
                if (idleDeadline < new Date()) {
                  await pool
                    .query(
                      `UPDATE sessions SET revoked_at = NOW() WHERE id = $1`,
                      [row.id],
                    )
                    .catch(() => {});
                  ephemeralStore.delete(token);
                } else {
                  // ── Valid DB session — refresh last_seen_at ──
                  pool.query(
                    `UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`,
                    [row.id],
                  ).catch(() => {});

                  const ephemeral = ephemeralGet(token) ?? {};
                  req.session = {
                    id: token,
                    userId: row.user_id,
                    ...ephemeral,
                  };
                  return;
                }
              }
            }
          }
        } catch {
          // DB error — fall through to ephemeral / new session
        }

        // 2. Try ephemeral store (pre-login session with CSRF)
        const ephData = ephemeralGet(token);
        if (ephData) {
          req.session = { id: token, ...ephData };
          return;
        }
      }
    }

    // 3. No valid session — create ephemeral
    const id = generateId();
    req.session = { id };
    ephemeralSet(id, {});
  });

  // ── onSend: persist ephemeral data, update last_seen_at, set cookie ─
  app.addHook(
    "onSend",
    async (req: FastifyRequest, reply: FastifyReply, payload) => {
      if (req.session?.id) {
        // Extract ephemeral data (everything except id and userId)
        const meta: Record<string, unknown> = {};
        const sessionObj = req.session as Record<string, unknown>;
        for (const key of Object.keys(sessionObj)) {
          if (key !== "id" && key !== "userId") {
            meta[key] = sessionObj[key];
          }
        }
        ephemeralSet(req.session.id, meta);

        // Best-effort DB touch (no-op for ephemeral sessions)
        pool.query(
          `UPDATE sessions SET last_seen_at = NOW() WHERE token = $1`,
          [req.session.id],
        ).catch(() => {});

        // Set cookie
        const signed = sign(req.session.id, SESSION_SECRET);
        reply.setCookie(COOKIE_NAME, signed, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: reply.request.protocol === "https",
          maxAge: COOKIE_MAX_AGE_S,
        });
      }
      return payload;
    },
  );
}

export default fp(sessionPlugin, {
  name: "session",
});
