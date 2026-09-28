/**
 * Participant project draft pages — create + Save Draft. Validation, pool
 * work and version snapshots mirror routes/projects.ts; success is 302
 * (PRG), failures re-render the form with an alert.
 */
import type { FastifyInstance } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth } from "../../authz/guards.js";
import { setFlash } from "../../lib/flash.js";
import {
  UUID_RE,
  getEvent,
  getMyTeam,
  getUserId,
  isTeamMember,
  pgCode,
  safeRollback,
  snapProjectVersion,
  type ProjectInfo,
} from "./participantShared.js";
import {
  loadProject,
  loadQuestions,
  parseAnswers,
  readFields,
  renderProjectForm,
} from "./participantProjectForm.js";

type EventParams = { eventId: string };
type ProjectParams = { eventId: string; projectId: string };

async function trackBelongs(eventId: string, trackId: string): Promise<boolean> {
  const t = await pool.query(`SELECT 1 FROM tracks WHERE id = $1 AND event_id = $2`,
    [trackId, eventId]);
  return (t.rowCount ?? 0) > 0;
}

export async function registerParticipantProjectPages(
  app: FastifyInstance,
): Promise<void> {
  app.get("/events/:eventId/projects/new", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    if (!(await getMyTeam(eventId, userId))) return reply.code(404).send({ error: "not_found" });
    await renderProjectForm(req, reply, eventId, ev.name, "new", null, { error: null, status: 200 });
  });

  app.post("/events/:eventId/projects/new", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const team = await getMyTeam(eventId, userId);
    if (!team) return reply.code(404).send({ error: "not_found" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = async (message: string): Promise<void> => {
      await renderProjectForm(req, reply, eventId, ev.name, "new", null,
        { error: message, status: 422, body });
    };
    const parsed = readFields(body);
    if (parsed.error) {
      await fail(parsed.error);
      return;
    }
    if (parsed.values.trackId && !(await trackBelongs(eventId, parsed.values.trackId))) {
      await fail("Select a valid track.");
      return;
    }
    const { rows: questions } = await loadQuestions(eventId);
    const answers = parseAnswers(questions, body);
    if (answers.error) {
      await fail(answers.error);
      return;
    }
    // DB-clock deadline gate (mirrors edit/submit): NULL submissions_close_at = open.
    {
      const dl = await pool.query(
        "SELECT state, ((submissions_open_at IS NULL OR now() >= submissions_open_at) AND (submissions_close_at IS NULL OR now() <= submissions_close_at)) AS open FROM events WHERE id = $1",
        [eventId],
      );
      if ((dl.rowCount ?? 0) === 0) return reply.code(404).send({ error: "not_found" });
      if ((dl.rows[0] as { state: string; open: boolean }).state !== "SUBMISSIONS_OPEN" || !(dl.rows[0] as { open: boolean }).open) {
        await fail("The submission deadline has passed.");
        return;
      }
    }
    const client = await pool.connect();
    let project: ProjectInfo;
    try {
      await client.query("BEGIN");
      try {
        const ins = await client.query<ProjectInfo>(
          `INSERT INTO projects (event_id, team_id, track_id, title, tagline, description, tech_tags, repo_url, demo_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [eventId, team.id, parsed.values.trackId || null, parsed.values.title,
            parsed.values.tagline, parsed.values.description, parsed.techTags, parsed.values.repoUrl || null, parsed.values.demoUrl || null],
        );
        const row = ins.rows[0];
        if (!row) throw new Error("create_failed");
        project = row;
      } catch (e) {
        await safeRollback(client);
        if (pgCode(e) === "23503") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
      await snapProjectVersion(client, project);
      for (const a of answers.items) {
        await client.query(
          `INSERT INTO custom_answers (project_id, question_id, value, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (project_id, question_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [project.id, a.questionId, JSON.stringify(a.value)],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
    setFlash(req, "success", "Draft created.");
    return reply.code(302).redirect(`/events/${eventId}/projects/${project.id}/edit`);
  });

  app.get("/events/:eventId/projects/:projectId/edit", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId, projectId } = req.params as ProjectParams;
    if (!UUID_RE.test(eventId) || !UUID_RE.test(projectId)) {
      return reply.code(422).send({ error: "invalid_input" });
    }
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const project = await loadProject(eventId, projectId, userId);
    if (!project) return reply.code(404).send({ error: "not_found" });
    await renderProjectForm(req, reply, eventId, ev.name, "edit", project, { error: null, status: 200 });
  });

  app.post("/events/:eventId/projects/:projectId/edit", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId, projectId } = req.params as ProjectParams;
    if (!UUID_RE.test(eventId) || !UUID_RE.test(projectId)) {
      return reply.code(422).send({ error: "invalid_input" });
    }
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const current = await loadProject(eventId, projectId, userId);
    if (!current) return reply.code(404).send({ error: "not_found" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = async (message: string): Promise<void> => {
      await renderProjectForm(req, reply, eventId, ev.name, "edit", current,
        { error: message, status: 422, body });
    };
    const parsed = readFields(body);
    if (parsed.error) {
      await fail(parsed.error);
      return;
    }
    if (parsed.values.trackId && !(await trackBelongs(eventId, parsed.values.trackId))) {
      await fail("Select a valid track.");
      return;
    }
    const { rows: questions } = await loadQuestions(eventId);
    const answers = parseAnswers(questions, body);
    if (answers.error) {
      await fail(answers.error);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query(
        `SELECT p.*, e.state AS event_state, ((e.submissions_open_at IS NOT NULL AND now() < e.submissions_open_at) OR (e.submissions_close_at IS NOT NULL AND now() > e.submissions_close_at)) AS past_due
           FROM projects p JOIN events e ON e.id = p.event_id WHERE p.id = $1 AND p.event_id = $2 FOR UPDATE OF p, e`, [projectId, eventId],
      );
      const row = cur.rows[0] as (ProjectInfo & { event_state: string; past_due: boolean }) | undefined;
      if (!row) {
        await safeRollback(client);
        return reply.code(404).send({ error: "not_found" });
      }
      if (!(await isTeamMember(row.team_id, userId))) {
        await safeRollback(client);
        return reply.code(404).send({ error: "not_found" });
      }
      if (row.event_state !== "SUBMISSIONS_OPEN" || row.past_due) {
        await safeRollback(client);
        await fail("The submission deadline has passed.");
        return;
      }
      let updated: ProjectInfo;
      try {
        const up = await client.query<ProjectInfo>(
          `UPDATE projects SET title = $1, tagline = $2, description = $3, tech_tags = $4,
                  repo_url = $5, demo_url = $6, track_id = $7, updated_at = now() WHERE id = $8 RETURNING *`,
          [parsed.values.title, parsed.values.tagline, parsed.values.description,
            parsed.techTags, parsed.values.repoUrl || null, parsed.values.demoUrl || null, parsed.values.trackId || null, projectId],
        );
        const u = up.rows[0];
        if (!u) throw new Error("update_failed");
        updated = u;
      } catch (e) {
        await safeRollback(client);
        if (pgCode(e) === "23503") {
          await fail("Select a valid track.");
          return;
        }
        throw e;
      }
      await snapProjectVersion(client, updated);
      for (const a of answers.items) {
        await client.query(
          `INSERT INTO custom_answers (project_id, question_id, value, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (project_id, question_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [projectId, a.questionId, JSON.stringify(a.value)],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
    setFlash(req, "success", "Draft saved.");
    return reply.code(302).redirect(`/events/${eventId}/projects/${projectId}/edit`);
  });
}
