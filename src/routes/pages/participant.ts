/**
 * Participant-facing pages for the Dogfood Fastify+Nunjucks app.
 *
 * Dashboard / team join + roster / project drafts + submit confirm /
 * version history / public project showcase. Every page POST handler does
 * its own validation + pool work + 302/flash — forms never POST to /api/*.
 * Guards are requireAuth / requireEventRole (401/404/422, never 403).
 *
 * Multipart note: this scope registers @fastify/multipart with
 * attachFieldsToBody:"keyValues" + onFile so the upload form's _csrf field
 * stays visible to the global CSRF hook (preHandler streaming cannot do
 * that). Files are bounded by the parser fileSize limit and validated via
 * uploadStore helpers in participantUploads.ts.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import multipart, { type MultipartFile } from "@fastify/multipart";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth } from "../../authz/guards.js";
import { MAX_FILE_BYTES } from "../../lib/uploadStore.js";
import {
  UUID_RE,
  flashScope,
  getEvent,
  getMyTeam,
  getUserId,
  type ParsedUpload,
} from "./participantShared.js";
import { registerParticipantTeamPages } from "./participantTeams.js";
import { registerParticipantProjectPages } from "./participantProjects.js";
import { registerParticipantSubmitPages } from "./participantProjectSubmit.js";
import { registerParticipantUploadPages } from "./participantUploads.js";

async function onFile(this: FastifyRequest, part: MultipartFile): Promise<void> {
  const buf = await part.toBuffer();
  (part as unknown as { value: unknown }).value = {
    data: buf,
    filename: part.filename,
    mimetype: part.mimetype,
  } satisfies ParsedUpload;
}

const SHOWCASE_STATES = [
  "SUBMISSIONS_CLOSED",
  "JUDGING",
  "RESULTS_FINAL",
  "PUBLISHED",
];

export async function registerParticipantPages(
  app: FastifyInstance,
): Promise<void> {
  await app.register(multipart, {
    attachFieldsToBody: "keyValues",
    onFile,
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20, fieldSize: 1_048_576 },
  });

  await registerParticipantTeamPages(app);
  await registerParticipantProjectPages(app);
  await registerParticipantSubmitPages(app);
  await registerParticipantUploadPages(app);

  app.get("/events/:eventId/dashboard", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as { eventId: string };
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const team = await getMyTeam(eventId, userId);
    interface DashProject { id: string; title: string; status: string }
    let projects: DashProject[] = [];
    if (team) {
      const r = await pool.query<DashProject>(
        `SELECT id, title, status FROM projects WHERE team_id = $1 ORDER BY updated_at DESC`,
        [team.id],
      );
      projects = r.rows;
    }
    return reply.view("participant_dashboard.njk", {
      eventId,
      eventName: ev.name,
      team: team ? { id: team.id, name: team.name, memberCount: team.member_count } : null,
      projects,
      ...flashScope(req),
    });
  });

  app.get("/gallery/:projectId", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!UUID_RE.test(projectId)) return reply.code(422).send({ error: "invalid_input" });
    interface DetailRow {
      id: string; title: string; tagline: string | null; description: string; repo_url: string | null; demo_url: string | null;
      tech_tags: string[] | null; status: string; event_name: string;
      track_name: string | null; team_name: string | null;
    }
    const r = await pool.query<DetailRow>(
      `SELECT p.id, p.title, p.tagline, p.description, p.repo_url, p.demo_url, p.tech_tags, p.status,
              e.name AS event_name, t.name AS track_name, tm.name AS team_name
         FROM projects p JOIN events e ON e.id = p.event_id
         LEFT JOIN tracks t ON t.id = p.track_id
         LEFT JOIN teams tm ON tm.id = p.team_id
        WHERE p.id = $1 AND p.status = 'submitted' AND p.needs_review = false AND e.state IN ($2, $3, $4, $5)`,
      [projectId, ...SHOWCASE_STATES],
    );
    const row = r.rows[0];
    if (!row) return reply.code(404).send({ error: "not_found" });
    // T3 community signals (best-effort: fallbacks keep the 200 shape).
    let voteCount: number | null = null;
    let votingOpen = false;
    let userVoted = false;
    let detailEventId = "";
    let comments: { body: string; author: string; created_at: unknown }[] = [];
    try {
      const w = await pool.query<{
        active: boolean;
        n: string;
        event_id: string;
      }>(
        `SELECT (e.voting_opens_at IS NOT NULL AND e.voting_opens_at <= now()
                 AND (e.voting_closes_at IS NULL OR e.voting_closes_at > now())) AS active,
                (SELECT COUNT(*)::int FROM community_votes WHERE project_id = $1) AS n,
                e.id AS event_id
           FROM projects p JOIN events e ON e.id = p.event_id
          WHERE p.id = $1 AND p.status = 'submitted'`,
        [projectId],
      );
      const info = w.rows[0];
      if (info) {
        votingOpen = info.active;
        detailEventId = info.event_id;
        voteCount = info.active ? null : Number(info.n);
        const userId = getUserId(req);
        if (userId) {
          const v = await pool.query(
            `SELECT 1 FROM community_votes WHERE project_id = $1 AND user_id = $2 LIMIT 1`,
            [projectId, userId],
          );
          userVoted = (v.rowCount ?? 0) > 0;
        }
      }
    } catch {
      voteCount = null;
      votingOpen = false;
      userVoted = false;
    }
    try {
      const c = await pool.query<{
        body: string;
        author: string;
        created_at: unknown;
      }>(
        `SELECT c.body, c.created_at, COALESCE(u.name, 'deleted user') AS author
           FROM project_comments c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.project_id = $1
          ORDER BY c.created_at ASC LIMIT 100`,
        [projectId],
      );
      comments = c.rows;
    } catch {
      comments = [];
    }
    return reply.view("project_detail.njk", {
      project: {
        title: row.title,
        tagline: row.tagline ?? "",
        description: row.description,
        repoUrl: row.repo_url,
        demoUrl: row.demo_url,
        techTags: row.tech_tags ?? [],
      },
      trackName: row.track_name ?? "",
      teamName: row.team_name ?? "",
      eventName: row.event_name,
      projectId,
      eventId: detailEventId,
      voteCount,
      votingOpen,
      userVoted,
      comments,
    });
  });
}
