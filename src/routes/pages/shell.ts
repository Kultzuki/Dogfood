/**
 * Shell pages — UI shell wiring (server-rendered, zero external assets, PRG forms).
 *
 * - Shared template locals hook: `currentUser` ({id, role} | null),
 *   one-shot `flash`, and `csrfToken` for every non-static request.
 *   Role comes from the users table only — eventRole-free by design.
 * - GET /register — renders register.njk (authed users → 302 /gallery).
 * - POST /register (HTML forms only) — validates, creates user + session,
 *   then 302 /gallery with a flash notice. Field failures re-render
 *   (422); duplicate email re-renders with a generic error (401) so
 *   accounts cannot be enumerated.
 * - Content-negotiated errors: 404.njk / 500.njk render only when the
 *   request Accepts text/html, otherwise a JSON error body is returned.
 *
 * NOTE (accepted duplication): POST /register mirrors the validation +
 * INSERT + session creation in src/routes/auth.ts (~30 lines). The JSON API
 * cannot be reused directly: HTML forms post urlencoded bodies and need
 * 302/flash/re-render behaviour while the API returns JSON. A urlencoded
 * constraint keeps both handlers on POST /register without a duplicated-
 * route conflict (verified: constrained wins for forms, plain JSON posts
 * still reach the API). Keep both in sync when auth rules change.
 */
import type {
  FastifyError,
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import "@fastify/view";
import fp from "fastify-plugin";
import { randomBytes } from "node:crypto";
import { pool } from "../../db/index.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { consumeFlash, setFlash, type FlashMessage } from "../../lib/flash.js";
import { rateLimit } from "../../lib/rateLimit.js";

declare module "fastify" {
  interface FastifyReply {
    locals: ShellLocals | undefined;
  }
}

export interface CurrentUser {
  id: string;
  role: string;
  name?: string;
  email?: string;
}

export interface ShellLocals {
  currentUser: CurrentUser | null;
  flash: FlashMessage | null;
  csrfToken: string;
}

interface RegisterBody {
  name?: unknown;
  email?: unknown;
  password?: unknown;
}

interface RegisterViewModel {
  csrfToken: string;
  values: { name: string; email: string };
  errors: { name: string; email: string; password: string };
  error: string | null;
}

const FORM_URLENCODED = "application/x-www-form-urlencoded";
const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Dummy scrypt hash for timing-safe duplicate-email responses (mirror). */
const DUMMY_HASH =
  "scrypt$16384$8$1$" +
  "00000000000000000000000000000000$" +
  "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

/** Handler type stored by the content-type constraint (derived, no new dep). */
type ConstraintStore = ReturnType<
  Parameters<FastifyInstance["addConstraintStrategy"]>[0]["storage"]
>;
type ConstrainedHandler = Parameters<ConstraintStore["set"]>[1];

function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function blankView(csrfToken: string): RegisterViewModel {
  return {
    csrfToken,
    values: { name: "", email: "" },
    errors: { name: "", email: "", password: "" },
    error: null,
  };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isAuthed(req: FastifyRequest): boolean {
  return typeof req.session.userId === "string" && req.session.userId.length > 0;
}

export const registerShellPages = fp(async function registerShellPages(
  app: FastifyInstance,
): Promise<void> {
  // Urlencoded POSTs land here; other content types fall through to the JSON API.
  if (!app.hasConstraintStrategy("contentType")) {
    app.addConstraintStrategy({
      name: "contentType",
      storage(): ConstraintStore {
        const handlers = new Map<string, ConstrainedHandler>();
        return {
          get: (v: string): ConstrainedHandler | null => handlers.get(v) ?? null,
          set: (v: string, h: ConstrainedHandler): void => {
            handlers.set(v, h);
          },
        };
      },
      deriveConstraint(req): string {
        const raw = req.headers["content-type"];
        const header = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
        return header.split(";")[0]?.trim().toLowerCase() ?? "";
      },
    });
  }

  // ── Shared locals: currentUser (users table only), flash, csrfToken. ──
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith("/static/")) return;
    const csrf = typeof req.csrfToken === "function" ? req.csrfToken() : "";
    const flash = consumeFlash(req);
    let currentUser: CurrentUser | null = null;
    const userId = req.session.userId;
    if (typeof userId === "string" && userId.length > 0) {
      try {
        const { rows } = await pool.query<{ id: string; role: string; name: string; email: string }>(
          `SELECT id, role, name, email FROM users WHERE id = $1`,
          [userId],
        );
        const row = rows[0];
        if (row) currentUser = { id: row.id, role: row.role, name: row.name, email: row.email };
      } catch {
        currentUser = null;
      }
    }
    reply.locals = { currentUser, flash, csrfToken: csrf };
  });

  app.get("/register", async (req: FastifyRequest, reply: FastifyReply) => {
    if (isAuthed(req)) return reply.code(302).redirect("/gallery");
    return reply.view("register.njk", blankView(req.csrfToken()));
  });

  // ── POST /register (HTML forms only; see NOTE above) ────────────
  const registerThrottle = rateLimit(30, 10 * 60 * 1000);
  app.post(
    "/register",
    {
      constraints: { contentType: FORM_URLENCODED },
      preHandler: [registerThrottle],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as RegisterBody;
      const name = asText(body.name).trim();
      const email = asText(body.email).trim().toLowerCase();
      const password = asText(body.password);

      const view = blankView(req.csrfToken());
      view.values = { name: asText(body.name).trim(), email: asText(body.email).trim() };

      let invalid = false;
      if (!name) {
        view.errors.name = "Enter your display name.";
        invalid = true;
      }
      if (!email || !email.includes("@") || email.length > 255) {
        view.errors.email = "Enter a valid email address.";
        invalid = true;
      }
      if (password.length < 8) {
        view.errors.password = "Password must be at least 8 characters.";
        invalid = true;
      }
      if (invalid) return reply.code(422).view("register.njk", view);

      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [email],
      );
      if (existing.rows.length > 0) {
        await verifyPassword(password, DUMMY_HASH);
        view.error = "Registration failed. Please try again.";
        return reply.code(401).view("register.njk", view);
      }

      const passwordHash = await hashPassword(password);
      const { rows: userRows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [email, name, passwordHash],
      );
      const user = userRows[0];
      if (!user) {
        view.error = "Registration failed. Please try again.";
        return reply.code(500).view("register.njk", view);
      }

      const token = generateToken();
      await pool.query(
        `INSERT INTO sessions (user_id, token, expires_at, absolute_expires_at, last_seen_at)
         VALUES ($1, $2, NOW() + INTERVAL '24 hours', $3, NOW())`,
        [user.id, token, new Date(Date.now() + ABSOLUTE_TIMEOUT_MS)],
      );
      req.session = { id: token, userId: user.id };
      setFlash(req, "success", "Account created. Welcome to Dogfood.");
      return reply.code(302).redirect("/gallery");
    },
  );

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (!wantsHtml(req)) {
      return reply.code(404).type("application/json").send({ error: "not_found" });
    }
    return reply.code(404).view("404.njk", {});
  });

  app.setErrorHandler(
    (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
      if (reply.sent) return;
      const code = err.statusCode ?? 500;
      const status = code >= 400 && code < 600 ? code : 500;
      if (!wantsHtml(req)) {
        if (status >= 500) {
          req.log.error(err);
          return reply.code(500).type("application/json").send({ error: "internal_error" });
        }
        return reply.code(status).type("application/json").send({ error: "bad_request" });
      }
      if (status === 404) return reply.code(404).view("404.njk", {});
      if (status >= 500) req.log.error(err);
      return reply.code(status).view("500.njk", {});
    },
  );
});
