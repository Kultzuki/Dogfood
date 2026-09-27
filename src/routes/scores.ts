/**
 * Minimal judged-score domain: assignments + scores with rescore chain.
 * 401 unauthenticated · 404 isolation (never 403) · 409 conflict · 422 invalid.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { fetchActiveRubric } from "./rubrics.js";
import { requireAuth, requireEventRole, requireAssignment, requireTrackScope } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";

/** Best-effort audit emit: logs and never fails the primary mutation. */
async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface AssignmentRow { id: string; event_id: string; project_id: string; judge_user_id: string; track_id: string | null; status: string }
interface ScoreRow { id: string; assignment_id: string; event_id: string; project_id: string; judge_user_id: string; value: string | number; version: number; supersedes_id: string | null; is_current: boolean; rubric_version: number | null }
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
function parseValue(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}
const outScore = (r: ScoreRow): Record<string, unknown> => ({ ...r, value: Number(r.value) });
/** requireEventRole with an eventId known only after a DB lookup. True = blocked. */
async function denyUnless(req: FastifyRequest, reply: FastifyReply, eventId: string, ...roles: Role[]): Promise<boolean> {
  await requireEventRole(() => eventId, ...roles)(req, reply);
  return reply.sent;
}
/** Track scope; null work-track passes only for unscoped members. True = blocked. */
async function scopeBlocked(req: FastifyRequest, reply: FastifyReply, trackId: string | null): Promise<boolean> {
  if (trackId === null) {
    const r = await pool.query<{ track_id: string | null }>(`SELECT track_id FROM event_memberships WHERE id = $1`, [req.eventMembershipId]);
    if (r.rows[0]?.track_id !== null) { await reply.code(404).send({ error: "not_found" }); return true; }
    return false;
  }
  await requireTrackScope(() => trackId)(req, reply);
  return reply.sent;
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
    const p = await pool.query<{ event_id: string }>(`SELECT event_id FROM projects WHERE id = $1`, [projectId]);
    if (!p.rows[0] || p.rows[0].event_id !== eventId) return reply.code(404).send({ error: "not_found" });
    if (trackRaw !== undefined) {
      const t = await pool.query(`SELECT 1 FROM tracks WHERE id = $1 AND event_id = $2`, [trackRaw, eventId]);
      if ((t.rowCount ?? 0) === 0) return reply.code(422).send({ error: "invalid_track" });
    }
    if (((await pool.query(`SELECT 1 FROM users WHERE id = $1`, [judgeId])).rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "not_found" });
    }
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
  app.get("/api/assignments/mine", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const q = (req.query ?? {}) as Record<string, unknown>;
    const eventFilter = pick(q.event_id ?? q.eventId);
    if (eventFilter !== undefined && !UUID_RE.test(eventFilter)) return reply.code(422).send({ error: "malformed_event_id" });
    if (eventFilter !== undefined && await denyUnless(req, reply, eventFilter, "participant", "judge", "organizer")) return;
    const vals: unknown[] = [userId];
    if (eventFilter !== undefined) vals.push(eventFilter);
    const r = await pool.query<AssignmentRow>(`SELECT a.* FROM judge_assignments a JOIN event_memberships m ON m.event_id = a.event_id AND m.user_id = $1 JOIN projects p ON p.id = a.project_id WHERE a.judge_user_id = $1 AND a.status = 'active' AND (m.track_id IS NULL OR COALESCE(a.track_id, p.track_id) = m.track_id)${eventFilter !== undefined ? ` AND a.event_id = $2` : ``} ORDER BY a.id ASC`, vals);
    return reply.send({ assignments: r.rows });
  });
  app.post("/api/scores", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const b = bodyOf(req);
    const assignmentId = pick(b.assignment_id ?? b.assignmentId);
    const value = parseValue(b.value ?? b.score);
    if (!assignmentId || !UUID_RE.test(assignmentId)) return reply.code(422).send({ error: "malformed_assignment_id" });
    if (value === undefined) return reply.code(422).send({ error: "invalid_score" });
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
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('score_' || $1))`, [assignmentId]);
      const la = (await client.query<AssignmentRow>(`SELECT * FROM judge_assignments WHERE id = $1 FOR UPDATE`, [assignmentId])).rows[0];
      if (!la || la.judge_user_id !== userId || la.status !== "active") { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      if ((((await client.query(`SELECT 1 FROM scores WHERE assignment_id = $1 AND is_current = true LIMIT 1`, [assignmentId])).rowCount) ?? 0) > 0) { await safeRollback(client); return reply.code(409).send({ error: "already_scored" }); }
      const rubric = await fetchActiveRubric(ctx.a.event_id);
      const row = (await client.query<ScoreRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, rubric_version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [assignmentId, la.event_id, la.project_id, userId, value, rubric.version])).rows[0];
      await client.query("COMMIT");
      if (!row) return reply.code(500).send({ error: "create_failed" });
      await emit(req, { eventId: row.event_id, action: "score.submit", resourceType: "score", resourceId: row.id, detail: { assignmentId, value } });
      return reply.code(201).send(outScore(row));
    } catch (err) { await safeRollback(client); throw err; } finally { client.release(); }
  });
  app.post("/api/scores/:id/rescore", async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = req.params as { id: string };
    if (!id || !UUID_RE.test(id)) return reply.code(422).send({ error: "malformed_score_id" });
    const b = bodyOf(req);
    const value = parseValue(b.value ?? b.score);
    if (value === undefined) return reply.code(422).send({ error: "invalid_score" });
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
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('score_' || $1))`, [old.assignment_id]);
      const la = (await client.query<AssignmentRow>(`SELECT * FROM judge_assignments WHERE id = $1 FOR UPDATE`, [old.assignment_id])).rows[0];
      const lc = (await client.query<ScoreRow>(`SELECT * FROM scores WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!la || la.judge_user_id !== userId || la.status !== "active" || !lc || !lc.is_current) {
        await safeRollback(client);
        return reply.code(!lc || !lc.is_current ? 409 : 404).send({ error: !lc || !lc.is_current ? "superseded" : "not_found" });
      }
      const rubric = await fetchActiveRubric(ctx.a.event_id);
      const row = (await client.query<ScoreRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, version, supersedes_id, rubric_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [la.id, la.event_id, la.project_id, userId, value, lc.version + 1, lc.id, rubric.version])).rows[0];
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
