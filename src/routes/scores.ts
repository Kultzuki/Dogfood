/**
 * Minimal judged-score domain: assignments + scores with rescore chain.
 * 401 unauthenticated · 404 isolation (never 403) · 409 conflict · 422 invalid.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { fetchActiveRubric, compositeFor, RUBRIC_KEYS } from "./rubrics.js";
import { requireAuth, requireEventRole, requireAssignment, requireTrackScope } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";
import { fanoutWebhooks } from "../lib/webhooks.js";
import { canWriteJudgeBallot } from "../lib/eventTransitions.js";

/** Best-effort audit emit: logs and never fails the primary mutation. */
async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Minimal email shape check — rejects garbage before it hits the database. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** System roles allowed to judge: judge/organizer/admin (never participant). */
export function isJudgeSystemRole(role: unknown): boolean {
  return role === "judge" || role === "organizer" || role === "admin";
}
export interface JudgeInviteInput { userId?: string; email?: string; trackId?: string | null }
/**
 * Validate a judge-invite body. Accepts {user_id}|{judge_user_id} or {email}
 * plus optional {track_id}. Returns {input} on success, else {error} with the
 * 422 error code to send (missing_judge | malformed_judge_id |
 * malformed_email | malformed_track_id).
 */
export function parseJudgeInviteBody(body: Record<string, unknown>): { input?: JudgeInviteInput; error?: string } {
  const userId = pick(body.user_id ?? body.judge_user_id ?? body.judgeUserId ?? body.judge_id ?? body.judgeId);
  const email = pick(body.email);
  const trackRaw = pick(body.track_id ?? body.trackId);
  if (trackRaw !== undefined && !UUID_RE.test(trackRaw)) return { error: "malformed_track_id" };
  const trackId = trackRaw ?? null;
  if (userId !== undefined) {
    if (!UUID_RE.test(userId)) return { error: "malformed_judge_id" };
    return { input: { userId, trackId } };
  }
  if (email !== undefined) {
    if (!EMAIL_RE.test(email)) return { error: "malformed_email" };
    return { input: { email, trackId } };
  }
  return { error: "missing_judge" };
}
interface AssignmentRow { id: string; event_id: string; project_id: string; judge_user_id: string; track_id: string | null; status: string }
interface ScoreRow { id: string; assignment_id: string; event_id: string; project_id: string; judge_user_id: string; value: string | number; version: number; supersedes_id: string | null; is_current: boolean; rubric_version: number | null; criteria: unknown }
interface Ctx { a: AssignmentRow; projectTrack: string | null }
type Role = "participant" | "judge" | "organizer";

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}
async function safeRollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* keep original error */ }
}
function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}
const pick = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const bodyOf = (req: FastifyRequest): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
export function parseValue(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}
export function parseCriteria(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const rec = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of RUBRIC_KEYS) {
    const n = rec[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) return undefined;
    out[k] = n;
  }
  return out;
}
const outScore = (r: ScoreRow): Record<string, unknown> => ({ ...r, value: Number(r.value) });
/** requireEventRole with an eventId known only after a DB lookup. True = blocked. */
async function denyUnless(req: FastifyRequest, reply: FastifyReply, eventId: string, ...roles: Role[]): Promise<boolean> {
  await requireEventRole(() => eventId, ...roles)(req, reply);
  return reply.sent;
}
/** Explicit allowed-track check; NULL is never an implicit wildcard for judges. */
async function scopeBlocked(req: FastifyRequest, reply: FastifyReply, trackId: string | null): Promise<boolean> {
  if (trackId === null) {
    if (req.eventRole !== "organizer") { await reply.code(404).send({ error: "not_found" }); return true; }
    return false;
  }
  await requireTrackScope(() => trackId)(req, reply);
  return reply.sent;
}
async function judgeHasTrackScope(eventId: string, judgeId: string, trackId: string | null): Promise<boolean> {
  if (trackId === null) return false;
  const r = await pool.query(
    `SELECT 1 FROM event_memberships m
      WHERE m.event_id = $1 AND m.user_id = $2
        AND (m.role IN ('organizer','admin') OR (m.role = 'judge' AND (m.track_scope_all OR m.track_id = $3
          OR EXISTS (SELECT 1 FROM event_membership_tracks mt WHERE mt.membership_id = m.id AND mt.track_id = $3))))
      LIMIT 1`, [eventId, judgeId, trackId],
  );
  return (r.rowCount ?? r.rows.length) > 0;
}
async function loadCtx(assignmentId: string): Promise<Ctx | undefined> {
  const r = await pool.query<AssignmentRow & { project_track: string | null }>(`SELECT a.*, p.track_id AS project_track FROM judge_assignments a JOIN projects p ON p.id = a.project_id WHERE a.id = $1`, [assignmentId]);
  const row = r.rows[0];
  if (!row) return undefined;
  return { a: { id: row.id, event_id: row.event_id, project_id: row.project_id, judge_user_id: row.judge_user_id, track_id: row.track_id, status: row.status }, projectTrack: row.project_track };
}
const effTrack = (c: Ctx): string | null => c.a.track_id ?? c.projectTrack;
const bodyEventId = (req: FastifyRequest): string | undefined => pick(bodyOf(req).event_id ?? bodyOf(req).eventId);
const organizeBodyEvent = requireEventRole(bodyEventId, "organizer");

export default async function scoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);
  app.post("/api/assignments", { preHandler: [organizeBodyEvent] }, async (req, reply) => {
    const b = bodyOf(req);
    const eventId = pick(b.event_id ?? b.eventId);
    const projectId = pick(b.project_id ?? b.projectId);
    const judgeId = pick(b.judge_user_id ?? b.judgeUserId ?? b.judge_id ?? b.judgeId);
    const trackRaw = pick(b.track_id ?? b.trackId);
    if (!eventId || !UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    if (!projectId || !UUID_RE.test(projectId)) return reply.code(422).send({ error: "malformed_project_id" });
    if (!judgeId || !UUID_RE.test(judgeId)) return reply.code(422).send({ error: "malformed_judge_id" });
    if (trackRaw !== undefined && !UUID_RE.test(trackRaw)) return reply.code(422).send({ error: "malformed_track_id" });
    const p = await pool.query<{ event_id: string; track_id: string | null; needs_review?: boolean }>(`SELECT event_id, track_id, needs_review FROM projects WHERE id = $1`, [projectId]);
    if (!p.rows[0] || p.rows[0].event_id !== eventId) return reply.code(404).send({ error: "not_found" });
    if (p.rows[0].needs_review) return reply.code(409).send({ error: "project_needs_review" });
    if (trackRaw !== undefined) {
      const t = await pool.query(`SELECT 1 FROM tracks WHERE id = $1 AND event_id = $2`, [trackRaw, eventId]);
      if ((t.rowCount ?? 0) === 0) return reply.code(422).send({ error: "invalid_track" });
    }
    const judgeRow = (await pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [judgeId])).rows[0];
    if (!judgeRow) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!isJudgeSystemRole(judgeRow.role)) {
      return reply.code(422).send({ error: "not_a_judge" });
    }
    const projectTrackId = p.rows[0].track_id;
    const scopedMembership = await pool.query<{ role: string }>(
      `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, judgeId],
    );
    // A new judge membership is scoped to this project's track. Existing
    // memberships must already authorize the project and any explicit track.
    if (scopedMembership.rows.length === 0 && projectTrackId !== null) {
      await pool.query(
        `INSERT INTO event_memberships (event_id, user_id, role, track_id) VALUES ($1, $2, 'judge', $3) ON CONFLICT (event_id, user_id) DO NOTHING`,
        [eventId, judgeId, projectTrackId],
      );
    }
    if (!(await judgeHasTrackScope(eventId, judgeId, projectTrackId)) ||
        (trackRaw !== undefined && !(await judgeHasTrackScope(eventId, judgeId, trackRaw)))) {
      return reply.code(422).send({ error: "judge_track_forbidden" });
    }
    // Auto-ensure judge membership so the judge queue (GET /events/:eventId/judge)
    // and GET /api/assignments/mine — both of which JOIN event_memberships —
    // work on fresh events without a separate invite call. ON CONFLICT DO NOTHING
    // never overwrites an existing membership (e.g. organizer stays organizer).
    // Explicit invites remain available via POST /api/events/:eventId/judges.
    try {
      const ins = await pool.query<AssignmentRow>(`INSERT INTO judge_assignments (event_id, project_id, judge_user_id, track_id) VALUES ($1, $2, $3, $4) RETURNING *`, [eventId, projectId, judgeId, trackRaw ?? null]);
      const row = ins.rows[0];
      if (!row) return reply.code(500).send({ error: "create_failed" });
      await emit(req, { eventId, action: "assignment.create", resourceType: "assignment", resourceId: row.id, detail: { projectId, judgeId } });
      return reply.code(201).send(row);
    } catch (err) {
      if (pgCode(err) === "23505") return reply.code(409).send({ error: "assignment_exists" });
      if (pgCode(err) === "23503") return reply.code(404).send({ error: "not_found" });
      throw err;
    }
  });
  const inviteParamEvent = (req: FastifyRequest): string | undefined => (req.params as { eventId?: string }).eventId;
  const inviteJudgeGuard = requireEventRole(inviteParamEvent, "organizer");
  app.post("/api/events/:eventId/judges", { preHandler: [inviteJudgeGuard] }, async (req, reply) => {
    const { eventId } = req.params as { eventId: string };
    const parsed = parseJudgeInviteBody(bodyOf(req));
    if (!parsed.input) return reply.code(422).send({ error: parsed.error ?? "malformed_judge_id" });
    const { userId, email, trackId } = parsed.input;
    const target = userId !== undefined
      ? (await pool.query<{ id: string; role: string }>(`SELECT id, role FROM users WHERE id = $1`, [userId])).rows[0]
      : (await pool.query<{ id: string; role: string }>(`SELECT id, role FROM users WHERE email = $1`, [email])).rows[0];
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!isJudgeSystemRole(target.role)) return reply.code(422).send({ error: "not_a_judge" });
    if (((await pool.query(`SELECT 1 FROM events WHERE id = $1`, [eventId])).rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (trackId !== null) {
      const t = await pool.query(`SELECT 1 FROM tracks WHERE id = $1 AND event_id = $2`, [trackId, eventId]);
      if ((t.rowCount ?? 0) === 0) return reply.code(422).send({ error: "invalid_track" });
    }
    const existing = (await pool.query<{ role: string }>(
      `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, target.id],
    )).rows[0];
    if (existing) return reply.code(409).send({ error: "already_member" });
    try {
      const ins = await pool.query(
        `INSERT INTO event_memberships (event_id, user_id, role, track_id) VALUES ($1, $2, 'judge', $3) RETURNING *`,
        [eventId, target.id, trackId],
      );
      const row = ins.rows[0];
      if (!row) return reply.code(500).send({ error: "create_failed" });
      await emit(req, { eventId, action: "judge.invite", resourceType: "membership", resourceId: row.id, detail: { judgeId: target.id } });
      return reply.code(201).send(row);
    } catch (err) {
      if (pgCode(err) === "23505") return reply.code(409).send({ error: "already_member" });
      if (pgCode(err) === "23503") return reply.code(404).send({ error: "not_found" });
      throw err;
    }
  });
  app.get("/api/assignments/mine", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const q = (req.query ?? {}) as Record<string, unknown>;
    const eventFilter = pick(q.event_id ?? q.eventId);
    if (eventFilter !== undefined && !UUID_RE.test(eventFilter)) return reply.code(422).send({ error: "malformed_event_id" });
    if (eventFilter !== undefined && await denyUnless(req, reply, eventFilter, "participant", "judge", "organizer")) return;
    const vals: unknown[] = [userId];
    if (eventFilter !== undefined) vals.push(eventFilter);
    const r = await pool.query<AssignmentRow>(`SELECT a.* FROM judge_assignments a JOIN event_memberships m ON m.event_id = a.event_id AND m.user_id = $1 JOIN projects p ON p.id = a.project_id WHERE a.judge_user_id = $1 AND a.status = 'active' AND (m.role IN ('organizer','admin') OR m.track_scope_all OR m.track_id = COALESCE(a.track_id, p.track_id) OR EXISTS (SELECT 1 FROM event_membership_tracks mt WHERE mt.membership_id = m.id AND mt.track_id = COALESCE(a.track_id, p.track_id)))${eventFilter !== undefined ? ` AND a.event_id = $2` : ``} ORDER BY a.id ASC`, vals);
    return reply.send({ assignments: r.rows });
  });
  app.post("/api/scores", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const b = bodyOf(req);
    const assignmentId = pick(b.assignment_id ?? b.assignmentId);
    if (!assignmentId || !UUID_RE.test(assignmentId)) return reply.code(422).send({ error: "malformed_assignment_id" });
    const hasScalar = b.value !== undefined || b.score !== undefined;
    const criteriaRaw = b.criteria ?? b.marks;
    if (criteriaRaw === undefined) {
      return reply.code(422).send({ error: "invalid_criteria" });
    }
    const criteria = parseCriteria(criteriaRaw);
    if (criteria === undefined) {
      return reply.code(422).send({ error: "invalid_criteria" });
    }
    if (hasScalar) {
      return reply.code(422).send({ error: "conflicting_input" });
    }
    const ctx = await loadCtx(assignmentId);
    if (!ctx) return reply.code(404).send({ error: "not_found" });
    if (await denyUnless(req, reply, ctx.a.event_id, "participant", "judge", "organizer")) return;
    await requireAssignment(() => ctx.a.event_id)(req, reply);
    if (reply.sent) return;
    if (await scopeBlocked(req, reply, effTrack(ctx))) return;
    if (ctx.a.judge_user_id !== userId || ctx.a.status !== "active") return reply.code(404).send({ error: "not_found" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const event = (await client.query<{ state: string }>(`SELECT state FROM events WHERE id = (SELECT event_id FROM judge_assignments WHERE id = $1) FOR UPDATE`, [assignmentId])).rows[0];
      if (!event || !canWriteJudgeBallot(event.state)) { await safeRollback(client); return reply.code(409).send({ error: "judging_closed" }); }
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('score_' || $1))`, [assignmentId]);
      const la = (await client.query<AssignmentRow>(`SELECT * FROM judge_assignments WHERE id = $1 FOR UPDATE`, [assignmentId])).rows[0];
      if (!la || la.judge_user_id !== userId || la.status !== "active") { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      if ((((await client.query(`SELECT 1 FROM scores WHERE assignment_id = $1 AND is_current = true LIMIT 1`, [assignmentId])).rowCount) ?? 0) > 0) { await safeRollback(client); return reply.code(409).send({ error: "already_scored" }); }
      const rubric = await fetchActiveRubric(ctx.a.event_id);
      const value = compositeFor(rubric.weights, criteria as Record<"technical" | "innovation" | "impact" | "polish", number>);
      const criteriaJson = JSON.stringify(criteria);
      let row: ScoreRow | undefined;
      try {
        row = (await client.query<ScoreRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, rubric_version, criteria) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`, [assignmentId, la.event_id, la.project_id, userId, value, rubric.version, criteriaJson])).rows[0];
      } catch (e) {
        if (pgCode(e) === "42703") {
          row = (await client.query<ScoreRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, rubric_version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [assignmentId, la.event_id, la.project_id, userId, value, rubric.version])).rows[0];
        } else throw e;
      }
      await client.query("COMMIT");
      if (!row) return reply.code(500).send({ error: "create_failed" });
      await emit(req, { eventId: row.event_id, action: "score.submit", resourceType: "score", resourceId: row.id, detail: { assignmentId, value } });
      await fanoutWebhooks(pool as unknown as PoolLike, { type: "score.submit", eventId: row.event_id, data: { score_id: row.id, project_id: row.project_id, value: Number(row.value) } });
      return reply.code(201).send(outScore(row));
    } catch (err) { await safeRollback(client); throw err; } finally { client.release(); }
  });
  app.post("/api/scores/:id/rescore", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    if (!id || !UUID_RE.test(id)) return reply.code(422).send({ error: "malformed_score_id" });
    const b = bodyOf(req);
    const hasScalar = b.value !== undefined || b.score !== undefined;
    const criteriaRaw = b.criteria ?? b.marks;
    if (criteriaRaw === undefined) {
      return reply.code(422).send({ error: "invalid_criteria" });
    }
    const criteria = parseCriteria(criteriaRaw);
    if (criteria === undefined) {
      return reply.code(422).send({ error: "invalid_criteria" });
    }
    if (hasScalar) {
      return reply.code(422).send({ error: "conflicting_input" });
    }
    const old = (await pool.query<ScoreRow>(`SELECT * FROM scores WHERE id = $1`, [id])).rows[0];
    if (!old) return reply.code(404).send({ error: "not_found" });
    const ctx = await loadCtx(old.assignment_id);
    if (!ctx) return reply.code(404).send({ error: "not_found" });
    if (await denyUnless(req, reply, ctx.a.event_id, "participant", "judge", "organizer")) return;
    await requireAssignment(() => ctx.a.event_id)(req, reply);
    if (reply.sent) return;
    if (await scopeBlocked(req, reply, effTrack(ctx))) return;
    if (old.judge_user_id !== userId || ctx.a.judge_user_id !== userId || ctx.a.status !== "active") return reply.code(404).send({ error: "not_found" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const event = (await client.query<{ state: string }>(`SELECT state FROM events WHERE id = (SELECT event_id FROM judge_assignments WHERE id = $1) FOR UPDATE`, [old.assignment_id])).rows[0];
      if (!event || !canWriteJudgeBallot(event.state)) { await safeRollback(client); return reply.code(409).send({ error: "judging_closed" }); }
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('score_' || $1))`, [old.assignment_id]);
      const la = (await client.query<AssignmentRow>(`SELECT * FROM judge_assignments WHERE id = $1 FOR UPDATE`, [old.assignment_id])).rows[0];
      const lc = (await client.query<ScoreRow>(`SELECT * FROM scores WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!la || la.judge_user_id !== userId || la.status !== "active" || !lc || !lc.is_current) {
        await safeRollback(client);
        return reply.code(!lc || !lc.is_current ? 409 : 404).send({ error: !lc || !lc.is_current ? "superseded" : "not_found" });
      }
      const rubric = await fetchActiveRubric(ctx.a.event_id);
      const value = compositeFor(rubric.weights, criteria as Record<"technical" | "innovation" | "impact" | "polish", number>);
      const criteriaJson = JSON.stringify(criteria);
      let row: ScoreRow | undefined;
      try {
        row = (await client.query<ScoreRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, version, supersedes_id, rubric_version, criteria) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`, [la.id, la.event_id, la.project_id, userId, value, lc.version + 1, lc.id, rubric.version, criteriaJson])).rows[0];
      } catch (e) {
        if (pgCode(e) === "42703") {
          row = (await client.query<ScoreRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, version, supersedes_id, rubric_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [la.id, la.event_id, la.project_id, userId, value, lc.version + 1, lc.id, rubric.version])).rows[0];
        } else throw e;
      }
      await client.query(`UPDATE scores SET is_current = false WHERE id = $1`, [lc.id]);
      await client.query("COMMIT");
      if (!row) return reply.code(500).send({ error: "create_failed" });
      await emit(req, { eventId: row.event_id, action: "score.rescore", resourceType: "score", resourceId: row.id, detail: { assignmentId: row.assignment_id, supersedesId: lc.id, value } });
      return reply.code(201).send(outScore(row));
    } catch (err) { await safeRollback(client); throw err; } finally { client.release(); }
  });
  app.get("/api/scores/:id", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    if (!id || !UUID_RE.test(id)) return reply.code(422).send({ error: "malformed_score_id" });
    const eventRow = (await pool.query<{ event_id: string }>(`SELECT event_id FROM scores WHERE id = $1`, [id])).rows[0];
    if (!eventRow) return reply.code(404).send({ error: "not_found" });
    if (await denyUnless(req, reply, eventRow.event_id, "participant", "judge", "organizer")) return;
    const row = (await pool.query<ScoreRow>(`SELECT * FROM scores WHERE id = $1`, [id])).rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    const ctx = await loadCtx(row.assignment_id);
    if (!ctx) return reply.code(404).send({ error: "not_found" });
    if (req.eventRole !== "organizer") {
      if (row.judge_user_id !== userId) return reply.code(404).send({ error: "not_found" });
      if (await scopeBlocked(req, reply, effTrack(ctx))) return;
    }
    return reply.send(outScore(row));
  });
  app.get("/api/projects/:projectId/scores", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { projectId } = req.params as { projectId: string };
    if (!projectId || !UUID_RE.test(projectId)) return reply.code(422).send({ error: "malformed_project_id" });
    const proj = (await pool.query<{ event_id: string }>(`SELECT event_id FROM projects WHERE id = $1`, [projectId])).rows[0];
    if (!proj) return reply.code(404).send({ error: "not_found" });
    if (await denyUnless(req, reply, proj.event_id, "organizer")) return;
    const r = await pool.query<ScoreRow>(`SELECT * FROM scores WHERE project_id = $1 ORDER BY created_at ASC`, [projectId]);
    return reply.send({ scores: r.rows.map(outScore) });
  });
}
