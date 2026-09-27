/**
 * Judge pages — queue + ballot (Nunjucks, PRG, server-side composite).
 *
 * Routes:
 *   GET  /events/:eventId/judge          — own assignments, progress "x of y (z%)"
 *   GET  /judge/assignments/:assignmentId — ballot (project left, rubric form right)
 *   POST /judge/assignments/:assignmentId — submit criteria → composite → score/rescore
 *
 * Active rubric weights (src/routes/rubrics.ts, fallback Technical 30 /
 * Innovation 25 / Impact 25 / Polish 20 when no version exists yet).
 * Composite = Σ (weight/100 × criterion), rounded to 2dp, range 0..100. Computed server-side; the template exposes
 * data-criterion/data-weight/data-composite-output attributes so the assets
 * worker's /static/js/ui.js can show a live preview (progressive
 * enhancement — the form works without JS).
 *
 * CRITERIA BREAKDOWNS ARE NOT PERSISTED. The backend stores only the scalar
 * composite in scores.value (same semantics as POST /api/scores and
 * POST /api/scores/:id/rescore in src/routes/scores.ts). Persisting the
 * per-criterion breakdown is an explicit Wave 4 schema change (new columns
 * or table) and must not be smuggled into these handlers.
 *
 * Notes: templates are self-contained (BEM classes only, autoescape on,
 * no | safe, no inline JS); flash uses the canonical session helper in
 * src/lib/flash.ts (PRG pattern).
 * Guards: requireAuth + requireEventRole + requireAssignment +
 * requireTrackScope → 401 unauthenticated, 404 isolation, 422 malformed
 * (never 403; CSRF failures stay 403 from the global plugin).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import {
  requireAuth,
  requireAssignment,
  requireEventRole,
  requireTrackScope,
} from "../../authz/guards.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ["technical", "innovation", "impact", "polish"] as const;
type Field = (typeof FIELDS)[number];

import { consumeFlash, setFlash } from "../../lib/flash.js";
import { compositeFor, fetchActiveRubric, type ActiveRubric } from "../rubrics.js";
interface QueueRow {
  assignment_id: string; project_title: string; project_tagline: string | null;
  track_name: string | null; score_id: string | null;
  score_value: string | number | null; score_version: number | null;
}
interface BallotRow {
  id: string; event_id: string; project_id: string; judge_user_id: string;
  assignment_track: string | null; status: string; title: string;
  tagline: string | null; description: string; tech_tags: string[] | null;
  project_track: string | null; project_status: string; track_name: string | null;
  score_id: string | null; score_value: string | number | null; score_version: number | null;
}
interface UploadView { id: string; originalName: string; mime: string; sizeBytes: number }
interface LockRow { id: string; event_id: string; project_id: string; judge_user_id: string; status: string }
interface CurRow { id: string; version: number }

function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}
/** Canonical flash ({kind, message} | null) adapted to the {ok, err} template shape. */
function takeFlash(req: FastifyRequest): { ok?: string; err?: string } {
  const f = consumeFlash(req);
  if (!f) return {};
  return f.kind === "success" ? { ok: f.message } : { err: f.message };
}
function parseCriterion(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}
function compositeOf(c: Record<Field, number>, weights: Record<Field, number>): number {
  return compositeFor(weights, c);
}

/** Load + authorize a ballot row plus the event's active rubric. Sends 404/422 (guards send their own) and returns undefined when blocked. */
async function loadBallot(req: FastifyRequest, reply: FastifyReply, assignmentId: string, userId: string): Promise<{ row: BallotRow; rubric: ActiveRubric } | undefined> {
  const r = await pool.query<BallotRow>(
    `SELECT a.id, a.event_id, a.project_id, a.judge_user_id, a.track_id AS assignment_track, a.status,
       p.title, p.tagline, p.description, p.tech_tags, p.track_id AS project_track, p.status AS project_status,
       t.name AS track_name, s.id AS score_id, s.value AS score_value, s.version AS score_version
     FROM judge_assignments a JOIN projects p ON p.id = a.project_id
     LEFT JOIN tracks t ON t.id = COALESCE(a.track_id, p.track_id)
     LEFT JOIN scores s ON s.assignment_id = a.id AND s.is_current = true WHERE a.id = $1`,
    [assignmentId],
  );
  const row = r.rows[0];
  if (row === undefined || row.judge_user_id !== userId || row.status !== "active") {
    await reply.code(404).send({ error: "not_found" });
    return undefined;
  }
  await requireEventRole(() => row.event_id, "participant", "judge", "organizer")(req, reply);
  if (reply.sent) return undefined;
  await requireAssignment(() => row.event_id)(req, reply);
  if (reply.sent) return undefined;
  const eff = row.assignment_track ?? row.project_track;
  if (eff === null) {
    const m = await pool.query<{ track_id: string | null }>(`SELECT track_id FROM event_memberships WHERE id = $1`, [req.eventMembershipId]);
    if (m.rows[0]?.track_id !== null) { await reply.code(404).send({ error: "not_found" }); return undefined; }
  } else {
    await requireTrackScope(() => eff)(req, reply);
    if (reply.sent) return undefined;
  }
  return { row, rubric: await fetchActiveRubric(row.event_id) };
}
async function loadUploads(projectId: string): Promise<UploadView[]> {
  try {
    const r = await pool.query(`SELECT id, original_name, mime, size_bytes FROM uploads WHERE project_id = $1 ORDER BY created_at ASC`, [projectId]);
    return r.rows.map((u) => {
      const row = u as { id: string; original_name: string; mime: string; size_bytes: number };
      return { id: row.id, originalName: row.original_name, mime: row.mime, sizeBytes: row.size_bytes };
    });
  } catch { return []; }
}

export async function registerJudgePages(app: FastifyInstance): Promise<void> {
  const eventIdOf = (req: FastifyRequest): string | undefined => (req.params as { eventId?: string }).eventId;
  const queueGuards = [
    requireAuth,
    requireEventRole(eventIdOf, "participant", "judge", "organizer"),
    requireAssignment(eventIdOf),
  ];

  app.get("/events/:eventId/judge", { preHandler: queueGuards }, async (req, reply) => {
    const { eventId } = req.params as { eventId: string };
    const userId = getUserId(req);
    if (userId === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const r = await pool.query<QueueRow>(
      `SELECT a.id AS assignment_id, p.title AS project_title, p.tagline AS project_tagline,
         t.name AS track_name, s.id AS score_id, s.value AS score_value, s.version AS score_version
       FROM judge_assignments a
       JOIN event_memberships m ON m.event_id = a.event_id AND m.user_id = $2
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN tracks t ON t.id = COALESCE(a.track_id, p.track_id)
       LEFT JOIN scores s ON s.assignment_id = a.id AND s.is_current = true
       WHERE a.event_id = $1 AND a.judge_user_id = $2 AND a.status = 'active'
         AND (m.track_id IS NULL OR COALESCE(a.track_id, p.track_id) = m.track_id)
       ORDER BY a.id ASC`,
      [eventId, userId],
    );
    const mem = await pool.query<{ track_id: string | null; name: string | null }>(
      `SELECT m.track_id, t.name FROM event_memberships m LEFT JOIN tracks t ON t.id = m.track_id
       WHERE m.user_id = $1 AND m.event_id = $2 LIMIT 1`, [userId, eventId],
    );
    const scopeTrack = mem.rows[0]?.track_id ?? null;
    const items = r.rows.map((row) => ({
      assignmentId: row.assignment_id, projectTitle: row.project_title,
      projectTagline: row.project_tagline, trackName: row.track_name,
      state: row.score_id === null ? "PENDING" : "SCORED",
      version: row.score_version, value: row.score_value === null ? null : Number(row.score_value),
    }));
    const scored = items.filter((i) => i.state === "SCORED").length;
    const total = items.length;
    return reply.view("judge_queue.njk", {
      csrfToken: req.csrfToken(), flash: takeFlash(req), eventId, items,
      scored, total, pct: total > 0 ? Math.round((scored / total) * 100) : 100,
      scopeLabel: scopeTrack === null ? "All tracks" : (mem.rows[0]?.name ?? "Assigned track"),
    });
  });

  app.get("/judge/assignments/:assignmentId", { preHandler: [requireAuth] }, async (req, reply) => {
    const { assignmentId } = req.params as { assignmentId: string };
    if (!UUID_RE.test(assignmentId ?? "")) return reply.code(422).send({ error: "malformed_assignment_id" });
    const userId = getUserId(req);
    if (userId === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const ballot = await loadBallot(req, reply, assignmentId, userId);
    if (ballot === undefined) return;
    const { row, rubric } = ballot;
    return reply.view("judge_ballot.njk", {
      csrfToken: req.csrfToken(), flash: takeFlash(req), eventId: row.event_id,
      assignment: { id: row.id },
      project: { title: row.title, tagline: row.tagline, description: row.description, techTags: row.tech_tags ?? [], status: row.project_status },
      trackName: row.track_name, uploads: await loadUploads(row.project_id),
      score: row.score_id === null ? null : { version: row.score_version, value: Number(row.score_value) },
      rubric: { version: rubric.version, weights: rubric.weights },
      values: { technical: "", innovation: "", impact: "", polish: "" }, errors: {}, compositePreview: "",
    });
  });

  app.post("/judge/assignments/:assignmentId", { preHandler: [requireAuth] }, async (req, reply) => {
    const { assignmentId } = req.params as { assignmentId: string };
    if (!UUID_RE.test(assignmentId ?? "")) return reply.code(422).send({ error: "malformed_assignment_id" });
    const userId = getUserId(req);
    if (userId === undefined) return reply.code(401).send({ error: "unauthenticated" });
    const ballot = await loadBallot(req, reply, assignmentId, userId);
    if (ballot === undefined) return;
    const { row, rubric } = ballot;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: Partial<Record<Field, string>> = {};
    const parsed: Partial<Record<Field, number>> = {};
    const echo: Record<Field, string> = { technical: "", innovation: "", impact: "", polish: "" };
    for (const f of FIELDS) {
      const raw = body[f];
      echo[f] = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
      const n = parseCriterion(raw);
      if (n === undefined) errors[f] = "Enter a number from 0 to 100."; else parsed[f] = n;
    }
    const base = {
      csrfToken: req.csrfToken(), eventId: row.event_id, assignment: { id: row.id },
      project: { title: row.title, tagline: row.tagline, description: row.description, techTags: row.tech_tags ?? [], status: row.project_status },
      trackName: row.track_name, uploads: await loadUploads(row.project_id),
      score: row.score_id === null ? null : { version: row.score_version, value: Number(row.score_value) },
      rubric: { version: rubric.version, weights: rubric.weights },
    };
    if (errors.technical !== undefined || errors.innovation !== undefined || errors.impact !== undefined || errors.polish !== undefined) {
      return reply.code(422).view("judge_ballot.njk", { ...base, flash: takeFlash(req), values: echo, errors, compositePreview: "" });
    }
    const value = compositeOf(parsed as Record<Field, number>, rubric.weights);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('score_' || $1))`, [assignmentId]);
      const la = (await client.query<LockRow>(`SELECT * FROM judge_assignments WHERE id = $1 FOR UPDATE`, [assignmentId])).rows[0];
      if (la === undefined || la.judge_user_id !== userId || la.status !== "active") {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "not_found" });
      }
      const cur = (await client.query<CurRow>(`SELECT id, version FROM scores WHERE assignment_id = $1 AND is_current = true LIMIT 1 FOR UPDATE`, [assignmentId])).rows[0];
      let version = 1;
      if (cur === undefined) {
        const ins = await client.query<CurRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, rubric_version) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, version`,
          [assignmentId, la.event_id, la.project_id, userId, value, rubric.version]);
        version = ins.rows[0]?.version ?? 1;
      } else {
        const ins = await client.query<CurRow>(`INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, version, supersedes_id, rubric_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, version`,
          [la.id, la.event_id, la.project_id, userId, value, cur.version + 1, cur.id, rubric.version]);
        await client.query(`UPDATE scores SET is_current = false WHERE id = $1`, [cur.id]);
        version = ins.rows[0]?.version ?? cur.version + 1;
      }
      await client.query("COMMIT");
      setFlash(req, "success", `Score saved (v${version}, composite ${value}).`);
      return reply.code(302).redirect(`/judge/assignments/${assignmentId}`);
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* keep original error */ }
      throw err;
    } finally { client.release(); }
  });
}

export default registerJudgePages;
