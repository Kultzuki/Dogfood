/**
 * Participant submit + versions pages. Submit uses a server-side GET confirm
 * step (no JS modal); the POST performs the same atomic server-time submit
 * as routes/projects.ts. Failures re-render the confirm page (409 already
 * submitted, 422 deadline passed); success is 302 (PRG).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth } from "../../authz/guards.js";
import { setFlash } from "../../lib/flash.js";
import {
  UUID_RE,
  deadlineBanner,
  flashScope,
  getEvent,
  getUserId,
  safeRollback,
  snapProjectVersion,
  type ProjectInfo,
} from "./participantShared.js";
import { loadProject } from "./participantProjectForm.js";
import { fanoutWebhooks } from "../../lib/webhooks.js";
import type { PoolLike } from "../../lib/audit.js";

type ProjectParams = { eventId: string; projectId: string };

async function renderConfirm(
  req: FastifyRequest,
  reply: FastifyReply,
  eventId: string,
  eventName: string,
  project: ProjectInfo | null,
  closeAt: string | null,
  error: string | null,
  status: number,
): Promise<void> {
  const banner = deadlineBanner(closeAt);
  return reply.code(status).view("project_form.njk", {
    mode: "confirm",
    eventId,
    eventName,
    project: project ? {
      id: project.id,
      title: project.title,
      tagline: project.tagline ?? "",
      description: project.description,
      status: project.status,
    } : null,
    submitAction: `/events/${eventId}/projects/${(project?.id ?? "")}/submit`,
    deadlineText: banner.text,
    csrfToken: req.csrfToken(),
    error,
    ...flashScope(req),
  });
}

export async function registerParticipantSubmitPages(
  app: FastifyInstance,
): Promise<void> {
  app.get("/events/:eventId/projects/:projectId/submit", { preHandler: [requireAuth] }, async (req, reply) => {
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
    if (project.status !== "draft") {
      setFlash(req, "info", "This project has already been submitted.");
      return reply.code(302).redirect(`/events/${eventId}/projects/${projectId}/edit`);
    }
    await renderConfirm(req, reply, eventId, ev.name, project, ev.submissions_close_at, null, 200);
  });

  app.post("/events/:eventId/projects/:projectId/submit", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId, projectId } = req.params as ProjectParams;
    if (!UUID_RE.test(eventId) || !UUID_RE.test(projectId)) {
      return reply.code(422).send({ error: "invalid_input" });
    }
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    if (!(await loadProject(eventId, projectId, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const up = await client.query<ProjectInfo>(
        `UPDATE projects SET status = 'submitted', updated_at = now()
          WHERE id = $1 AND status = 'draft'
            AND (SELECT COALESCE(now() <= submissions_close_at, true) FROM events WHERE id = $2)
          RETURNING *`,
        [projectId, eventId],
      );
      const done = up.rows[0];
      if (!done) {
        const again = await client.query(
          `SELECT status, (SELECT now() > e.submissions_close_at FROM events e WHERE e.id = $2) AS past_due
             FROM projects WHERE id = $1`, [projectId, eventId],
        );
        const cur = again.rows[0] as { status: string; past_due: boolean | null } | undefined;
        await safeRollback(client);
        if (!cur) return reply.code(404).send({ error: "not_found" });
        const project = await loadProject(eventId, projectId, userId);
        if (cur.status !== "draft") {
          await renderConfirm(req, reply, eventId, ev.name, project ?? null,
            ev.submissions_close_at, "This project has already been submitted.", 409);
          return;
        }
        await renderConfirm(req, reply, eventId, ev.name, project ?? null,
          ev.submissions_close_at, "The submission deadline has passed.", 422);
        return;
      }
      await snapProjectVersion(client, done);
      await client.query("COMMIT");
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
    await fanoutWebhooks(pool as unknown as PoolLike, {
      type: "project.submitted",
      eventId,
      data: { project_id: projectId },
    });
    setFlash(req, "success", "Project submitted.");
    return reply.code(302).redirect(`/events/${eventId}/projects/${projectId}/edit`);
  });

  app.get("/events/:eventId/projects/:projectId/versions", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId, projectId } = req.params as ProjectParams;
    if (!UUID_RE.test(eventId) || !UUID_RE.test(projectId)) {
      return reply.code(422).send({ error: "invalid_input" });
    }
    if (!(await getEvent(eventId))) return reply.code(404).send({ error: "not_found" });
    const project = await loadProject(eventId, projectId, userId);
    if (!project) return reply.code(404).send({ error: "not_found" });
    const v = await pool.query(
      `SELECT version_no, title, tagline, description, tech_tags, status, created_at
         FROM project_versions WHERE project_id = $1 ORDER BY version_no ASC`, [projectId],
    );
    interface VersionRow {
      version_no: number; title: string; tagline: string | null; description: string;
      tech_tags: string[]; status: string; created_at: Date;
    }
    const versions = (v.rows as VersionRow[]).map((row) => ({
      versionNo: row.version_no,
      title: row.title,
      tagline: row.tagline,
      description: row.description,
      techTags: row.tech_tags,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
    return reply.view("project_versions.njk", {
      eventId,
      project: { id: project.id, title: project.title },
      versions,
      ...flashScope(req),
    });
  });
}
