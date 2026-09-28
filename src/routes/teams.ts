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
  leader_user_id: string | null;
  created_by: string | null;
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

export function parseMaxSize(v: unknown): number | undefined {
  if (v === undefined) return 4;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 20) {
    return undefined;
  }
  return v;
}

export type LeaveDecision =
  | { ok: false; error: "not_member" | "has_submission" }
  | { ok: true; dissolved: boolean };

export function leavePolicy(memberCount: number, opts: { isMember: boolean; hasSubmission: boolean }): LeaveDecision {
  if (!opts.isMember) return { ok: false, error: "not_member" };
  if (opts.hasSubmission) return { ok: false, error: "has_submission" };
  return { ok: true, dissolved: memberCount <= 1 };
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

  app.post("/api/events/:eventId/teams", async (req, reply) => {
    const { eventId } = req.params as P;
    if (!eventId || !UUID_RE.test(eventId)) {
      return reply.code(422).send({ error: "malformed_event_id" });
    }
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > MAX_NAME_LEN) return reply.code(422).send({ error: "name_required" });
    const maxSize = parseMaxSize(b.max_size ?? b.maxSize);
    if (maxSize === undefined) return reply.code(422).send({ error: "invalid_max_size" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('team_create_' || $1))`, [eventId + userId]);
      const memRes = await client.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      const sysRes = await client.query<{ role: string }>(
        `SELECT role FROM users WHERE id = $1`, [userId],
      );
      const eventRole = memRes.rows[0]?.role;
      const sysRole = sysRes.rows[0]?.role;
      const isOrganizerish = eventRole === "organizer" || sysRole === "organizer" || sysRole === "admin";
      if (!memRes.rows[0]) {
        await client.query(
          `INSERT INTO event_memberships (event_id, user_id, role) VALUES ($1, $2, 'participant') ON CONFLICT (event_id, user_id) DO NOTHING`,
          [eventId, userId],
        );
      }
      const alreadyRes = await client.query(
        `SELECT team_id FROM team_members WHERE event_id = $1 AND user_id = $2 LIMIT 1`, [eventId, userId],
      );
      if ((alreadyRes.rowCount ?? 0) > 0 && !isOrganizerish) {
        await safeRollback(client);
        return reply.code(409).send({ error: "already_teamed" });
      }
      const token = randomBytes(32).toString("hex");
      let row: TeamRow | undefined;
      try {
        const res = await client.query<TeamRow>(
          `INSERT INTO teams (event_id, name, invite_token, max_size, leader_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [eventId, name, token, maxSize, userId, userId],
        );
        row = res.rows[0];
      } catch (e) {
        if (pgCode(e) === "42703") {
          const res = await client.query<TeamRow>(
            `INSERT INTO teams (event_id, name, invite_token, max_size) VALUES ($1, $2, $3, $4) RETURNING *`,
            [eventId, name, token, maxSize],
          );
          row = res.rows[0];
        } else {
          await safeRollback(client);
          throw e;
        }
      }
      if (!row) { await safeRollback(client); return reply.code(500).send({ error: "create_failed" }); }
      if (!isOrganizerish) {
        try {
          await client.query(
            `INSERT INTO team_members (team_id, event_id, user_id) VALUES ($1, $2, $3)`,
            [row.id, eventId, userId],
          );
        } catch (e) {
          await safeRollback(client);
          if (pgCode(e) === "23505") return reply.code(409).send({ error: "already_teamed" });
          throw e;
        }
      }
      await client.query("COMMIT");
      await emit(req, { eventId, action: "team.create", resourceType: "team", resourceId: row.id, detail: { name } });
      return reply.code(201).send({ ...row, invite_url: inviteUrl(eventId, token) });
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
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

  app.patch("/api/events/:eventId/teams/:teamId", async (req, reply) => {
    const { eventId, teamId } = req.params as TP;
    if (!eventId || !UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    if (!UUID_RE.test(teamId)) return reply.code(422).send({ error: "malformed_team_id" });
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.rotate === true || b.rotate_invite === true) {
      const memRole = await pool.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      if (memRole.rows[0]?.role !== "organizer") return reply.code(404).send({ error: "not_found" });
      const row = await rotateToken(eventId, teamId);
      if (!row) return reply.code(404).send({ error: "not_found" });
      await emit(req, { eventId, action: "admin.action", resourceType: "team", resourceId: teamId, detail: { rotate: true } });
      return reply.send({ ...row, invite_url: inviteUrl(eventId, row.invite_token) });
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const wantsRename = b.name !== undefined || b.max_size !== undefined || b.maxSize !== undefined;
    const wantsLeadership = (b.leader_user_id ?? b.leaderId ?? b.leader) !== undefined;
    if (wantsRename) {
      const memRole = await pool.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      if (memRole.rows[0]?.role !== "organizer") return reply.code(404).send({ error: "not_found" });
    } else if (wantsLeadership) {
      const teamRes = await pool.query<TeamRow>(`SELECT * FROM teams WHERE id = $1 AND event_id = $2`, [teamId, eventId]);
      const team = teamRes.rows[0];
      if (!team) return reply.code(404).send({ error: "not_found" });
      const memRole = await pool.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      const isOrg = memRole.rows[0]?.role === "organizer";
      const isLeader = (team.leader_user_id ?? null) === userId;
      if (!isOrg && !isLeader) return reply.code(404).send({ error: "not_found" });
    } else {
      const memRole = await pool.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      if (memRole.rows[0]?.role !== "organizer") return reply.code(404).send({ error: "not_found" });
    }
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
    const leaderRaw = b.leader_user_id ?? b.leaderId ?? b.leader;
    if (leaderRaw !== undefined) {
      if (typeof leaderRaw !== "string" || !UUID_RE.test(leaderRaw)) {
        return reply.code(422).send({ error: "invalid_leader" });
      }
      const userId = getUserId(req);
      const teamRes = await pool.query<TeamRow>(`SELECT * FROM teams WHERE id = $1 AND event_id = $2`, [teamId, eventId]);
      const team = teamRes.rows[0];
      if (!team) return reply.code(404).send({ error: "not_found" });
      const memRole = await pool.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      const isOrg = memRole.rows[0]?.role === "organizer";
      const isLeader = (team.leader_user_id ?? null) === userId;
      if (!isOrg && !isLeader) return reply.code(404).send({ error: "not_found" });
      const target = await pool.query(
        `SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`, [teamId, leaderRaw],
      );
      if ((target.rowCount ?? 0) === 0) return reply.code(422).send({ error: "leader_not_member" });
      try {
        sets.push(`leader_user_id = $${idx++}`); values.push(leaderRaw);
      } catch {
        return reply.code(404).send({ error: "not_found" });
      }
    }
    if (sets.length === 0) return reply.code(422).send({ error: "no_changes" });
    sets.push(`updated_at = now()`);
    values.push(teamId, eventId);
    let row: TeamRow | undefined;
    try {
      const res = await pool.query<TeamRow>(
        `UPDATE teams SET ${sets.join(", ")} WHERE id = $${idx++} AND event_id = $${idx} RETURNING *`, values,
      );
      row = res.rows[0];
    } catch (e) {
      if (pgCode(e) === "42703") {
        const fallbackSets = sets.filter((s) => !s.startsWith("leader_user_id"));
        if (fallbackSets.length === 1) return reply.code(422).send({ error: "no_changes" });
        const res = await pool.query<TeamRow>(
          `UPDATE teams SET ${fallbackSets.join(", ")} WHERE id = $${idx++} AND event_id = $${idx} RETURNING *`, values,
        );
        row = res.rows[0];
      } else throw e;
    }
    if (!row) return reply.code(404).send({ error: "not_found" });
    await emit(req, { eventId, action: "admin.action", resourceType: "team", resourceId: teamId, detail: { update: true } });
    return reply.send({ ...row, invite_url: inviteUrl(eventId, row.invite_token) });
  });

  app.delete("/api/events/:eventId/teams/:teamId/leave", async (req, reply) => {
    const { eventId, teamId } = req.params as TP;
    if (!eventId || !UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    if (!UUID_RE.test(teamId)) return reply.code(422).send({ error: "malformed_team_id" });
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('team_' || $1))`, [teamId]);
      const teamRes = await client.query<TeamRow>(`SELECT * FROM teams WHERE id = $1 AND event_id = $2 FOR UPDATE`, [teamId, eventId]);
      const team = teamRes.rows[0];
      if (!team) { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      const memRes = await client.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`, [teamId, userId]);
      if ((memRes.rowCount ?? 0) === 0) { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      const subRes = await client.query(`SELECT 1 FROM projects WHERE team_id = $1 AND status = 'submitted' LIMIT 1`, [teamId]);
      if ((subRes.rowCount ?? 0) > 0) { await safeRollback(client); return reply.code(409).send({ error: "has_submission" }); }
      const countRes = await client.query<{ count: string }>(`SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`, [teamId]);
      const count = Number(countRes.rows[0]?.count ?? "0");
      await client.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamId, userId]);
      if (count <= 1) {
        await client.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
        await client.query("COMMIT");
        await emit(req, { eventId, action: "team.leave", resourceType: "team", resourceId: teamId, detail: { dissolved: true } });
        return reply.send({ ok: true, dissolved: true });
      }
      if ((team.leader_user_id ?? null) === userId) {
        const nextRes = await client.query<{ user_id: string }>(
          `SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY created_at ASC LIMIT 1`, [teamId],
        );
        const next = nextRes.rows[0]?.user_id;
        if (next) {
          try {
            await client.query(`UPDATE teams SET leader_user_id = $1, updated_at = now() WHERE id = $2`, [next, teamId]);
          } catch (e) {
            if (pgCode(e) !== "42703") throw e;
          }
        }
      }
      await client.query("COMMIT");
      await emit(req, { eventId, action: "team.leave", resourceType: "team", resourceId: teamId, detail: {} });
      return reply.send({ ok: true });
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });
}
