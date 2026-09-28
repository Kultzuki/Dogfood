/**
 * Projects: draft → edit → submit (server-time deadline) + append-only versions.
 * 401 unauthenticated · 404 not-found (never 403) · 409 resubmit · 422 invalid/deadline
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { requireAuth } from "../authz/guards.js";
import { isHttpUrl } from "../lib/url.js";

interface ProjectRow {
  id: string; event_id: string; team_id: string; track_id: string | null;
  title: string; tagline: string | null; description: string;
  tech_tags: string[]; status: string;
}
interface ProjectBody {
  title?: unknown; tagline?: unknown; description?: unknown;
  techTags?: unknown; tech_tags?: unknown; trackId?: unknown; track_id?: unknown;
  repo_url?: unknown; demo_url?: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function safeRollback(client: PoolClient): Promise<void> {
  try { await client.query("ROLLBACK"); } catch { /* dead connection; keep original error */ }
}

function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  await requireAuth(req, reply);
  if (reply.sent) return undefined;
  const userId = getUserId(req);
  if (!userId) { await reply.code(401).send({ error: "unauthenticated" }); return undefined; }
  return userId;
}

async function isTeamMember(teamId: string, userId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`, [teamId, userId]);
  return (r.rowCount ?? r.rows.length) > 0;
}

function fieldErr(body: ProjectBody, needTitle: boolean): string | undefined {
  if (body.title !== undefined || needTitle) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (t.length === 0 || t.length > 255) return "invalid_title";
  }
  if (body.tagline !== undefined && body.tagline !== null && (typeof body.tagline !== "string" || body.tagline.length > 255)) return "invalid_tagline";
  const tags = body.techTags ?? body.tech_tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((x: unknown) => typeof x === "string"))) return "invalid_tech_tags";
  const tr = body.trackId ?? body.track_id;
  if (tr !== undefined && tr !== null && (typeof tr !== "string" || !UUID_RE.test(tr))) return "invalid_track";
  for (const key of ["repo_url", "demo_url"] as const) {
    const value = body[key];
    if (value !== undefined && value !== null && value !== "") {
      if (typeof value !== "string" || !isHttpUrl(value)) return `invalid_${key}`;
    }
  }
  return undefined;
}

function norm(body: ProjectBody): { tagline: string | null; description: string; techTags: string[]; trackId: string | null } {
  const tags = body.techTags ?? body.tech_tags;
  const tr = body.trackId ?? body.track_id;
  return {
    tagline: typeof body.tagline === "string" ? body.tagline : null,
    description: typeof body.description === "string" ? body.description : "",
    techTags: Array.isArray(tags) ? (tags as string[]) : [],
    trackId: typeof tr === "string" ? tr : null,
  };
}

async function snapVersion(client: PoolClient, p: ProjectRow): Promise<void> {
  const n = await client.query("SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM project_versions WHERE project_id = $1", [p.id]);
  const no = Number((n.rows[0] as { n: unknown }).n);
  await client.query("INSERT INTO project_versions (project_id, version_no, title, tagline, description, tech_tags, status) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [p.id, no, p.title, p.tagline, p.description, p.tech_tags, p.status]);
}

async function loadProject(eventId: string, projectId: string, userId: string): Promise<ProjectRow | undefined> {
  const r = await pool.query("SELECT * FROM projects WHERE id = $1 AND event_id = $2", [projectId, eventId]);
  const p = r.rows[0] as ProjectRow | undefined;
  if (!p || !(await isTeamMember(p.team_id, userId))) return undefined;
  return p;
}

export default async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/events/:eventId/teams/:teamId/projects", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const { eventId, teamId } = req.params as { eventId: string; teamId: string };
    if (!UUID_RE.test(eventId ?? "") || !UUID_RE.test(teamId ?? "")) return reply.code(422).send({ error: "invalid_input" });
    const body = (req.body ?? {}) as ProjectBody;
    const err = fieldErr(body, true);
    if (err) return reply.code(422).send({ error: err });
    if (!(await isTeamMember(teamId, userId))) return reply.code(404).send({ error: "not_found" });
    try {
      const tm = await pool.query("SELECT t.event_id FROM teams t JOIN team_members m ON m.team_id = t.id WHERE t.id = $1 AND m.user_id = $2", [teamId, userId]);
      const teamEvent = (tm.rows[0] as { event_id: string } | undefined)?.event_id;
      if (!teamEvent || teamEvent !== eventId) return reply.code(404).send({ error: "not_found" });
    } catch {
      if (!(await isTeamMember(teamId, userId))) return reply.code(404).send({ error: "not_found" });
    }
    const f = norm(body);
    if (f.trackId) {
      const t = await pool.query("SELECT 1 FROM tracks WHERE id = $1 AND event_id = $2", [f.trackId, eventId]);
      if ((t.rowCount ?? 0) === 0) return reply.code(422).send({ error: "invalid_track" });
    }
    // DB-clock deadline gate (mirrors edit/submit): NULL bounds = open.
    {
      const dl = await pool.query("SELECT state, ((submissions_open_at IS NULL OR now() >= submissions_open_at) AND (submissions_close_at IS NULL OR now() <= submissions_close_at)) AS open FROM events WHERE id = $1", [eventId]);
      if ((dl.rowCount ?? 0) === 0) return reply.code(404).send({ error: "not_found" });
      if ((dl.rows[0] as { state: string; open: boolean }).state !== "SUBMISSIONS_OPEN" || !(dl.rows[0] as { open: boolean }).open) return reply.code(422).send({ error: "submissions_closed" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let project: ProjectRow;
      try {
        const ins = await client.query("INSERT INTO projects (event_id, team_id, track_id, title, tagline, description, tech_tags, repo_url, demo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
          [eventId, teamId, f.trackId, (body.title as string).trim(), f.tagline, f.description, f.techTags, body.repo_url || null, body.demo_url || null]);
        project = ins.rows[0] as ProjectRow;
      } catch (e) {
        await safeRollback(client);
        if (pgCode(e) === "23503") return reply.code(404).send({ error: "not_found" });
        throw e;
      }
      await snapVersion(client, project);
      await client.query("COMMIT");
      return reply.code(201).send({ project });
    } catch (e) { await safeRollback(client); throw e; } finally { client.release(); }
  });

  app.patch("/api/events/:eventId/projects/:projectId", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const { eventId, projectId } = req.params as { eventId: string; projectId: string };
    if (!UUID_RE.test(eventId ?? "") || !UUID_RE.test(projectId ?? "")) return reply.code(422).send({ error: "invalid_input" });
    const body = (req.body ?? {}) as ProjectBody;
    const err = fieldErr(body, false);
    if (err) return reply.code(422).send({ error: err });
    if (body.title === undefined && body.tagline === undefined && body.description === undefined && body.techTags === undefined && body.tech_tags === undefined && body.trackId === undefined && body.track_id === undefined && body.repo_url === undefined && body.demo_url === undefined) {
      return reply.code(422).send({ error: "invalid_input" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query("SELECT p.*, e.state AS event_state, ((e.submissions_open_at IS NOT NULL AND now() < e.submissions_open_at) OR (e.submissions_close_at IS NOT NULL AND now() > e.submissions_close_at)) AS past_due FROM projects p JOIN events e ON e.id = p.event_id WHERE p.id = $1 AND p.event_id = $2 FOR UPDATE OF p, e", [projectId, eventId]);
      const row = cur.rows[0] as (ProjectRow & { event_state: string; past_due: boolean }) | undefined;
      if (!row) { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      if (!(await isTeamMember(row.team_id, userId))) { await safeRollback(client); return reply.code(404).send({ error: "not_found" }); }
      if (row.event_state !== "SUBMISSIONS_OPEN" || row.past_due) { await safeRollback(client); return reply.code(422).send({ error: "submissions_closed" }); }
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (body.title !== undefined) { sets.push(`title = $${vals.length + 1}`); vals.push((body.title as string).trim()); }
      if (body.tagline !== undefined) { sets.push(`tagline = $${vals.length + 1}`); vals.push(typeof body.tagline === "string" ? body.tagline : null); }
      if (body.description !== undefined) { sets.push(`description = $${vals.length + 1}`); vals.push(typeof body.description === "string" ? body.description : ""); }
      const tags = body.techTags ?? body.tech_tags;
      if (tags !== undefined) { sets.push(`tech_tags = $${vals.length + 1}`); vals.push(tags); }
      const tr = body.trackId ?? body.track_id;
      if (tr !== undefined) { sets.push(`track_id = $${vals.length + 1}`); vals.push(typeof tr === "string" ? tr : null); }
      for (const key of ["repo_url", "demo_url"] as const) if (body[key] !== undefined) { sets.push(`${key} = $${vals.length + 1}`); vals.push(body[key] || null); }
      sets.push("updated_at = now()");
      vals.push(projectId);
      let updated: ProjectRow;
      try {
        const up = await client.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals);
        updated = up.rows[0] as ProjectRow;
      } catch (e) {
        await safeRollback(client);
        if (pgCode(e) === "23503") return reply.code(422).send({ error: "invalid_track" });
        throw e;
      }
      await snapVersion(client, updated);
      await client.query("COMMIT");
      return reply.send({ project: updated });
    } catch (e) { await safeRollback(client); throw e; } finally { client.release(); }
  });

  app.post("/api/events/:eventId/projects/:projectId/submit", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const { eventId, projectId } = req.params as { eventId: string; projectId: string };
    if (!UUID_RE.test(eventId ?? "") || !UUID_RE.test(projectId ?? "")) return reply.code(422).send({ error: "invalid_input" });
    if (!(await loadProject(eventId, projectId, userId))) return reply.code(404).send({ error: "not_found" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const up = await client.query("UPDATE projects SET status = 'submitted', updated_at = now() WHERE id = $1 AND status = 'draft' AND (SELECT e.state = 'SUBMISSIONS_OPEN' AND (e.submissions_open_at IS NULL OR now() >= e.submissions_open_at) AND (e.submissions_close_at IS NULL OR now() <= e.submissions_close_at) FROM events e WHERE e.id = $2) RETURNING *", [projectId, eventId]);
      const done = up.rows[0] as ProjectRow | undefined;
      if (!done) {
        const again = await client.query("SELECT status, ((SELECT e.submissions_open_at IS NOT NULL AND now() < e.submissions_open_at FROM events e WHERE e.id = $2) OR (SELECT e.submissions_close_at IS NOT NULL AND now() > e.submissions_close_at FROM events e WHERE e.id = $2)) AS past_due FROM projects WHERE id = $1", [projectId, eventId]);
        const cur2 = again.rows[0] as { status: string; past_due: boolean | null } | undefined;
        await safeRollback(client);
        if (!cur2) return reply.code(404).send({ error: "not_found" });
        if (cur2.status !== "draft") return reply.code(409).send({ error: "already_submitted" });
        if (cur2.past_due) return reply.code(422).send({ error: "deadline_passed" });
        return reply.code(422).send({ error: "deadline_passed" });
      }
      await snapVersion(client, done);
      await client.query("COMMIT");
      return reply.send({ project: done });
    } catch (e) { await safeRollback(client); throw e; } finally { client.release(); }
  });

  app.get("/api/events/:eventId/projects/:projectId", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const { eventId, projectId } = req.params as { eventId: string; projectId: string };
    if (!UUID_RE.test(eventId ?? "") || !UUID_RE.test(projectId ?? "")) return reply.code(422).send({ error: "invalid_input" });
    const p = await loadProject(eventId, projectId, userId);
    if (!p) return reply.code(404).send({ error: "not_found" });
    return reply.send({ project: p });
  });

  app.get("/api/events/:eventId/projects/:projectId/versions", async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (userId === undefined) return;
    const { eventId, projectId } = req.params as { eventId: string; projectId: string };
    if (!UUID_RE.test(eventId ?? "") || !UUID_RE.test(projectId ?? "")) return reply.code(422).send({ error: "invalid_input" });
    if (!(await loadProject(eventId, projectId, userId))) return reply.code(404).send({ error: "not_found" });
    const v = await pool.query("SELECT * FROM project_versions WHERE project_id = $1 ORDER BY version_no ASC", [projectId]);
    return reply.send({ versions: v.rows });
  });
}
