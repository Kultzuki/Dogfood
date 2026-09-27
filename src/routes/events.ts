/**
 * Event CRUD + lifecycle transition routes.
 * POST /events · GET /events/:id · PUT /events/:id · POST /events/:id/transition
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db/index.js";
import {
  isValidTransition,
  isEventState,
  canCreate,
  canTransition,
  requiresSystemRole,
} from "../lib/eventTransitions.js";
import { requireAuth } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";

async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}

interface EventRow {
  id: string;
  name: string;
  description: string | null;
  state: string;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}
interface RoleRow { role: string }
interface CreateBody { name?: string; description?: string }
interface TransitionBody { toState?: string; expectedVersion?: number }
interface UpdateBody { name?: string; description?: string }

// ── Helpers ───────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LEN = 255;

async function safeRollback(
  client: { query: (sql: string) => Promise<unknown> },
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Connection may already be dead; never mask the original error.
  }
}

/** Extract userId from session (handles both session.userId and session.user.id). */
function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && "id" in u && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  await requireAuth(req, reply);
  if (reply.sent) return undefined;
  const userId = getUserId(req);
  if (!userId) { await reply.code(401).send({ error: "unauthenticated" }); return undefined; }
  return userId;
}

async function getSystemRole(userId: string): Promise<string> {
  const res = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
  return (res.rows[0] as RoleRow | undefined)?.role ?? "participant";
}

async function getEventRole(eventId: string, userId: string): Promise<string | null> {
  const res = await pool.query(
    "SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2",
    [eventId, userId],
  );
  return (res.rows[0] as RoleRow | undefined)?.role ?? null;
}

async function isMember(eventId: string, userId: string): Promise<boolean> {
  const res = await pool.query(
    "SELECT 1 FROM event_memberships WHERE event_id = $1 AND user_id = $2",
    [eventId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Routes ────────────────────────────────────────────────────────────

async function eventRoutes(app: FastifyInstance): Promise<void> {
  /** POST /events — create (system organizer/admin). */
  app.post("/events", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const body = (req.body ?? {}) as CreateBody;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LEN) return reply.code(422).send({ error: "invalid_input" });
    const description = typeof body.description === "string" ? body.description : null;
    if (!canCreate(await getSystemRole(userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO events (name, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [name, description, userId],
      );
      const event = res.rows[0] as EventRow;
      await client.query(
        `INSERT INTO event_memberships (event_id, user_id, role) VALUES ($1, $2, 'organizer')`,
        [event.id, userId],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ event });
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  });

  /** GET /events/:id — read (public for PUBLISHED, members otherwise). */
  app.get("/events/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!id || !UUID_RE.test(id)) return reply.code(422).send({ error: "invalid_input" });
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const res = await pool.query(`SELECT * FROM events WHERE id = $1`, [id]);
    const event = res.rows[0] as EventRow | undefined;
    if (!event) return reply.code(404).send({ error: "not_found" });
    if (event.state !== "PUBLISHED" && !await isMember(id, userId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.send({ event });
  });

  /** PUT /events/:id — update (event organizer/admin or system admin). */
  app.put("/events/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!id || !UUID_RE.test(id)) return reply.code(422).send({ error: "invalid_input" });
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const memRole = await getEventRole(id, userId);
    const sysRole = await getSystemRole(userId);
    const isEventOrganizer = memRole === "organizer" || memRole === "admin";
    const isSystemPrivileged = sysRole === "admin" || sysRole === "organizer";
    if (!isEventOrganizer && !isSystemPrivileged) {
      return reply.code(404).send({ error: "not_found" });
    }
    const body = (req.body ?? {}) as UpdateBody;
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (typeof body.name === "string") {
      const n = body.name.trim();
      if (!n || n.length > MAX_NAME_LEN) return reply.code(422).send({ error: "invalid_input" });
      sets.push(`name = $${idx++}`); values.push(n);
    }
    if (typeof body.description === "string" || body.description === null) {
      sets.push(`description = $${idx++}`); values.push(body.description);
    }
    if (sets.length === 0) return reply.code(422).send({ error: "invalid_input" });
    sets.push(`updated_at = now()`); values.push(id);
    const res = await pool.query(
      `UPDATE events SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, values,
    );
    const event = res.rows[0] as EventRow | undefined;
    if (!event) return reply.code(404).send({ error: "not_found" });
    return reply.send({ event });
  });

  /** POST /events/:id/transition — lifecycle state change (advisory lock + optimistic version). */
  app.post("/events/:id/transition", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!id || !UUID_RE.test(id)) return reply.code(422).send({ error: "invalid_input" });
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const body = (req.body ?? {}) as TransitionBody;
    const toState = typeof body.toState === "string" ? body.toState.trim() : "";
    if (!toState) return reply.code(422).send({ error: "invalid_input" });
    if (!isEventState(toState)) return reply.code(422).send({ error: "invalid_transition" });

    const evRes = await pool.query(`SELECT id, state, version FROM events WHERE id = $1`, [id]);
    const ev = evRes.rows[0] as { id: string; state: string; version: number } | undefined;
    if (!ev) return reply.code(404).send({ error: "not_found" });
    if (!isValidTransition(ev.state, toState)) {
      return reply.code(422).send({ error: "invalid_transition" });
    }

    // Permission: system role for PUBLISHED/ARCHIVED targets, per-event otherwise
    if (requiresSystemRole(toState)) {
      if (!canTransition(await getSystemRole(userId), toState)) {
        return reply.code(404).send({ error: "not_found" });
      }
    } else {
      const mr = await getEventRole(id, userId);
      if (!mr || !canTransition(mr, toState)) return reply.code(404).send({ error: "not_found" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('event_' || $1))`, [id]);
      const lockRes = await client.query(`SELECT state, version FROM events WHERE id = $1 FOR UPDATE`, [id]);
      const locked = lockRes.rows[0] as { state: string; version: number } | undefined;
      if (!locked) { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      if (!isValidTransition(locked.state, toState)) {
        await safeRollback(client);
        return reply.code(422).send({ error: "invalid_transition" });
      }
      if (typeof body.expectedVersion === "number" && body.expectedVersion !== locked.version) {
        await safeRollback(client);
        return reply.code(409).send({ error: "version_conflict" });
      }
      await client.query(
        `UPDATE events SET state = $1, version = version + 1, updated_at = now() WHERE id = $2`,
        [toState, id],
      );
      await client.query("COMMIT");
      const nextVersion = locked.version + 1;
      app.log.info(
        { eventId: id, from: locked.state, to: toState, by: userId, version: nextVersion },
        "event_transition",
      );
      const action = toState === "RESULTS_FINAL" ? "event.finalize" : toState === "PUBLISHED" ? "event.publish" : "admin.action";
      await emit(req, { eventId: id, action, resourceType: "event", resourceId: id, detail: { from: locked.state, to: toState, version: nextVersion } });
      return reply.send({ event: { id, state: toState, version: nextVersion } });
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  });
}

export default eventRoutes;
