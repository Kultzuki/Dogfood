/**
 * Invite-link teams — creation, transactional size-capped join, token rotation.
 *
 * 401 unauthenticated · 404 not-found (never 403) · 409 team_full / already_teamed
 * 422 malformed ids and invalid input. Organizer creates (POST), any
 * authenticated user joins via invite token (POST …/join), organizer rotates
 * the token (PATCH …/rotate) which invalidates old links.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { pool } from "../db/index.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";

async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LEN = 255;

interface TeamRow {
  id: string;
  event_id: string;
  name: string;
  invite_token: string;
  max_size: number;
  created_at: Date;
  updated_at: Date;
}
interface MemberRow { user_id: string; created_at: Date }

type P = { eventId: string };
type TP = { eventId: string; teamId: string };

const resolveEventId = (req: FastifyRequest): string | undefined =>
  (req.params as P).eventId;
const memberOfEvent = requireEventRole(
  resolveEventId, "participant", "judge", "organizer",
);
const organizeEvent = requireEventRole(resolveEventId, "organizer");

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function safeRollback(
  client: { query: (sql: string) => Promise<unknown> },
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Connection may already be dead; never mask the original error.
  }
}

function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && "id" in u
    && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

function parseMaxSize(v: unknown): number | undefined {
  if (v === undefined) return 4;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 20) {
    return undefined;
  }
  return v;
}

/**
 * Browser-openable invite link handed to organizers.
 *
 * The join PAGE is `GET /events/:eventId/teams/join` (see
 * src/routes/pages/participantTeams.ts). The JSON sibling
 * `POST /api/events/:eventId/teams/join` is not a link a human can open —
 * GETting the /api path 404s, so pointing invite_url at it shipped every
 * organizer a dead link.
 */
function inviteUrl(eventId: string, token: string): string {
  return `/events/${eventId}/teams/join?token=${token}`;
}

export default async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.post("/api/events/:eventId/teams", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > MAX_NAME_LEN) return reply.code(422).send({ error: "name_required" });
    const maxSize = parseMaxSize(b.max_size ?? b.maxSize);
    if (maxSize === undefined) return reply.code(422).send({ error: "invalid_max_size" });
    const token = randomBytes(32).toString("hex");
    const res = await pool.query<TeamRow>(
      `INSERT INTO teams (event_id, name, invite_token, max_size) VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventId, name, token, maxSize],
    );
    const row = res.rows[0];
    if (!row) return reply.code(500).send({ error: "create_failed" });
    return reply.code(201).send({ ...row, invite_url: inviteUrl(eventId, token) });
  });

  app.get("/api/events/:eventId/teams", { preHandler: [memberOfEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const res = await pool.query<TeamRow>(
      `SELECT * FROM teams WHERE event_id = $1 ORDER BY created_at ASC`, [eventId],
    );
    return reply.send({ teams: res.rows });
  });

  app.get("/api/events/:eventId/teams/:teamId", { preHandler: [memberOfEvent] }, async (req, reply) => {
    const { eventId, teamId } = req.params as TP;
    if (!UUID_RE.test(teamId)) return reply.code(422).send({ error: "malformed_team_id" });
    const t = await pool.query<TeamRow>(
      `SELECT * FROM teams WHERE id = $1 AND event_id = $2`, [teamId, eventId],
    );
    const team = t.rows[0];
    if (!team) return reply.code(404).send({ error: "not_found" });
    const m = await pool.query<MemberRow>(
      `SELECT user_id, created_at FROM team_members WHERE team_id = $1 ORDER BY created_at ASC`, [teamId],
    );
    return reply.send({ ...team, members: m.rows });
  });

  app.post("/api/events/:eventId/teams/join", async (req, reply) => {
    const { eventId } = req.params as P;
    if (!eventId || !UUID_RE.test(eventId)) {
      return reply.code(422).send({ error: "malformed_event_id" });
    }
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const token = b.invite_token ?? b.token ?? q.token;
    if (typeof token !== "string" || token.length === 0) {
      return reply.code(422).send({ error: "token_required" });
    }
    const found = await pool.query<TeamRow>(
      `SELECT * FROM teams WHERE invite_token = $1`, [token],
    );
    const team = found.rows[0];
    if (!team || team.event_id !== eventId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('team_' || $1))`, [team.id]);
      const lockedRes = await client.query<Pick<TeamRow, "id" | "event_id" | "max_size">>(
        `SELECT id, event_id, max_size FROM teams WHERE id = $1 FOR UPDATE`, [team.id],
      );
      const locked = lockedRes.rows[0];
      if (!locked) { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`, [locked.id],
      );
      if (Number(countRes.rows[0]?.count ?? "0") >= locked.max_size) {
        await safeRollback(client);
        return reply.code(409).send({ error: "team_full" });
      }
      await client.query(
        `INSERT INTO team_members (team_id, event_id, user_id) VALUES ($1, $2, $3)`,
        [locked.id, locked.event_id, userId],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ team_id: locked.id, event_id: locked.event_id, user_id: userId });
    } catch (err) {
      await safeRollback(client);
      if (pgCode(err) === "23505") return reply.code(409).send({ error: "already_teamed" });
      throw err;
    } finally {
      client.release();
    }
  });

  async function rotateToken(eventId: string, teamId: string) {
    const token = randomBytes(32).toString("hex");
    const res = await pool.query<TeamRow>(
      `UPDATE teams SET invite_token = $1, updated_at = now() WHERE id = $2 AND event_id = $3 RETURNING *`,
      [token, teamId, eventId],
    );
    return res.rows[0];
  }

  app.patch("/api/events/:eventId/teams/:teamId/rotate", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, teamId } = req.params as TP;
    if (!UUID_RE.test(teamId)) return reply.code(422).send({ error: "malformed_team_id" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const row = await rotateToken(eventId, teamId);
    if (!row) return reply.code(404).send({ error: "not_found" });
    await emit(req, { eventId, action: "admin.action", resourceType: "team", resourceId: teamId, detail: { rotate: true } });
    return reply.send({ ...row, invite_url: inviteUrl(eventId, row.invite_token) });
  });

  app.patch("/api/events/:eventId/teams/:teamId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, teamId } = req.params as TP;
    if (!UUID_RE.test(teamId)) return reply.code(422).send({ error: "malformed_team_id" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.rotate === true || b.rotate_invite === true) {
      const row = await rotateToken(eventId, teamId);
      if (!row) return reply.code(404).send({ error: "not_found" });
      await emit(req, { eventId, action: "admin.action", resourceType: "team", resourceId: teamId, detail: { rotate: true } });
      return reply.send({ ...row, invite_url: inviteUrl(eventId, row.invite_token) });
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (b.name !== undefined) {
      const n = typeof b.name === "string" ? b.name.trim() : "";
      if (!n || n.length > MAX_NAME_LEN) return reply.code(422).send({ error: "name_required" });
      sets.push(`name = $${idx++}`); values.push(n);
    }
    if (b.max_size !== undefined || b.maxSize !== undefined) {
      const m = parseMaxSize(b.max_size ?? b.maxSize);
      if (m === undefined) return reply.code(422).send({ error: "invalid_max_size" });
      sets.push(`max_size = $${idx++}`); values.push(m);
    }
    if (sets.length === 0) return reply.code(422).send({ error: "no_changes" });
    sets.push(`updated_at = now()`);
    values.push(teamId, eventId);
    const res = await pool.query<TeamRow>(
      `UPDATE teams SET ${sets.join(", ")} WHERE id = $${idx++} AND event_id = $${idx} RETURNING *`, values,
    );
    const row = res.rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ...row, invite_url: inviteUrl(eventId, row.invite_token) });
  });
}
