/**
 * Public gallery + custom-question admin + custom-answer submission.
 * GET /gallery is public (no auth). Question admin requires organizer role.
 */
import type { FastifyInstance } from "fastify";
import "@fastify/view";
import { pool } from "../db/index.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";
import {
  searchGallery,
  validateAnswerValue,
  type QuestionRow,
} from "../db/gallery.js";

const KEY_RE = /^[a-z0-9-]{1,100}$/;
const QTYPES = ["text", "number", "choice"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type P = { eventId: string };
type QP = { eventId: string; questionId: string };
type PP = { projectId: string };

const resolveEventId = (req: { params: unknown }): string | undefined =>
  (req.params as P).eventId;
const organizeEvent = requireEventRole(resolveEventId, "organizer");

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Extract userId from session (mirrors routes/projects.ts). */
function getUserId(req: { session: Record<string, unknown> }): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session["user"] as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && typeof u["id"] === "string" && (u["id"] as string).length > 0) {
    return u["id"] as string;
  }
  return undefined;
}

/** Team-membership check (mirrors the isTeamMember pattern in routes/projects.ts). */
async function isTeamMember(teamId: string, userId: string): Promise<boolean> {
  for (const table of ["team_members", "team_memberships"]) {
    try {
      const r = await pool.query(`SELECT 1 FROM ${table} WHERE team_id = $1 AND user_id = $2 LIMIT 1`, [teamId, userId]);
      if ((r.rowCount ?? 0) > 0) return true;
    } catch { /* table may not exist yet — try the next name */ }
  }
  return false;
}

function checkQuestionBody(b: Record<string, unknown>): string | null {
  const key = String(b.key ?? "");
  const label = String(b.label ?? "");
  const qtype = String(b.qtype ?? "");
  if (!KEY_RE.test(key)) return "invalid_key";
  if (!label || label.length > 255) return "invalid_label";
  if (!QTYPES.includes(qtype as (typeof QTYPES)[number]))
    return "invalid_qtype";
  if (qtype === "choice") {
    if (!Array.isArray(b.options) || b.options.length === 0 ||
      !b.options.every((o) => typeof o === "string" && o.length > 0))
      return "invalid_options";
  }
  return null;
}

export default async function galleryRoutes(app: FastifyInstance): Promise<void> {
  // ── Public gallery (no auth) ─────────────────────────────────────
  app.get("/gallery", async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const q = typeof query.q === "string" ? query.q : "";
    const track = typeof query.track === "string" ? query.track : "";
    const tag = typeof query.tag === "string" ? query.tag : "";
    // Garbage `track` values (non-UUID) must not reach the DB: the
    // track_id column is UUID-typed, so Postgres throws 22P02 and the
    // catch-all below would turn it into a 503. Ignore the filter
    // instead and show unfiltered results.
    const trackId = track && UUID_RE.test(track) ? track : undefined;
    try {
      const projects = await searchGallery({
        q,
        trackId,
        tag: tag || undefined,
      });
      return reply.view("gallery.njk", { q, track, tag, projects });
    } catch {
      return reply
        .code(503)
        .view("gallery.njk", { q, track, tag, projects: [], dbDown: true });
    }
  });

  // ── Question admin (organizers only) ─────────────────────────────
  app.post("/api/events/:eventId/questions", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const err = checkQuestionBody(b);
    if (err) return reply.code(422).send({ error: err });
    try {
      const r = await pool.query(
        `INSERT INTO custom_questions (event_id, "key", label, qtype, required, options)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [eventId, String(b.key), String(b.label), String(b.qtype),
          b.required === true, b.qtype === "choice" ? JSON.stringify(b.options) : null],
      );
      return reply.code(201).send(r.rows[0]);
    } catch (e: unknown) {
      if (pgCode(e) === "23505") return reply.code(409).send({ error: "key_conflict" });
      throw e;
    }
  });

  app.patch("/api/events/:eventId/questions/:questionId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, questionId } = req.params as QP;
    if (!UUID_RE.test(questionId)) return reply.code(422).send({ error: "invalid_id" });
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (b.label !== undefined) {
      const l = String(b.label);
      if (!l || l.length > 255) return reply.code(422).send({ error: "invalid_label" });
      sets.push(`label = $${i++}`); vals.push(l);
    }
    if (b.required !== undefined) {
      if (typeof b.required !== "boolean") return reply.code(422).send({ error: "invalid_required" });
      sets.push(`required = $${i++}`); vals.push(b.required);
    }
    if (b.options !== undefined) {
      sets.push(`options = $${i++}`);
      vals.push(b.options === null ? null : JSON.stringify(b.options));
    }
    if (sets.length === 0) return reply.code(422).send({ error: "no_changes" });
    sets.push(`updated_at = now()`);
    vals.push(eventId, questionId);
    const r = await pool.query(
      `UPDATE custom_questions SET ${sets.join(", ")} WHERE event_id = $${i++} AND id = $${i} RETURNING *`, vals,
    );
    const row = r.rows[0] as QuestionRow | undefined;
    return row ? reply.send(row) : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/api/events/:eventId/questions/:questionId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, questionId } = req.params as QP;
    if (!UUID_RE.test(questionId)) return reply.code(422).send({ error: "invalid_id" });
    const r = await pool.query(
      `DELETE FROM custom_questions WHERE event_id = $1 AND id = $2 RETURNING id`, [eventId, questionId],
    );
    return (r.rowCount ?? 0) > 0
      ? reply.code(204).send()
      : reply.code(404).send({ error: "not_found" });
  });

  // ── Custom answers (team members only; per-qtype validation) ────
  app.post("/api/projects/:projectId/answers", { preHandler: [requireAuth] }, async (req, reply) => {
    const { projectId } = req.params as PP;
    if (!UUID_RE.test(projectId)) return reply.code(422).send({ error: "invalid_id" });
    const proj = await pool.query(`SELECT event_id, team_id FROM projects WHERE id = $1`, [projectId]);
    const prow = proj.rows[0] as { event_id: string; team_id: string } | undefined;
    if (!prow) return reply.code(404).send({ error: "not_found" });
    const userId = getUserId(req as unknown as { session: Record<string, unknown> });
    if (!userId || !(await isTeamMember(prow.team_id, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const eventId = prow.event_id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const items = Array.isArray(b.answers) ? b.answers as Record<string, unknown>[] : null;
    if (!items) return reply.code(422).send({ error: "answers_required" });
    const qr = await pool.query(`SELECT * FROM custom_questions WHERE event_id = $1`, [eventId]);
    const byId = new Map((qr.rows as QuestionRow[]).map((q) => [q.id, q]));
    // A question that exists but belongs to another event must not leak: 404.
    for (const a of items) {
      if (typeof a.questionId === "string" && UUID_RE.test(a.questionId) && !byId.has(a.questionId)) {
        try {
          const other = await pool.query(`SELECT event_id FROM custom_questions WHERE id = $1`, [a.questionId]);
          const ownerEvent = (other.rows[0] as { event_id: string } | undefined)?.event_id;
          if (ownerEvent && ownerEvent !== eventId) return reply.code(404).send({ error: "not_found" });
        } catch { /* question lookup failed — fall through to validation below */ }
      }
    }
    const fields: { field: string; message: string }[] = [];
    for (const a of items) {
      const q = typeof a.questionId === "string" ? byId.get(a.questionId) : undefined;
      if (!q) { fields.push({ field: String(a.questionId ?? "?"), message: "unknown question" }); continue; }
      const msg = validateAnswerValue(q, a.value);
      if (msg) fields.push({ field: q.key, message: msg });
    }
    if (fields.length > 0)
      return reply.code(422).send({ error: "invalid_answers", fields });
    for (const a of items) {
      await pool.query(
        `INSERT INTO custom_answers (project_id, question_id, value, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (project_id, question_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [projectId, String(a.questionId), JSON.stringify(a.value ?? null)],
      );
    }
    return reply.code(201).send({ answers: items.length });
  });
}
