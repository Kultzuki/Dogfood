/**
 * T3 community pages — ballot + detail comment form (server-rendered, PRG).
 *
 * Forms never POST to /api/*. Page POST handlers do their own validation +
 * pool work + 302/flash, reusing the shared castVote() mutation so the HTML
 * and JSON flows enforce identical predicates. Guards answer 401 / 404 /
 * 422 and never 403 (CSRF failures excepted).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth } from "../../authz/guards.js";
import { setFlash } from "../../lib/flash.js";
import { rateLimit } from "../../lib/rateLimit.js";
import {
  appendAuditForRequest,
  type PoolLike,
} from "../../lib/audit.js";
import {
  ballotOrder,
  castVote,
  isVotingActive,
  validateCommentBody,
  COMMENT_MAX,
} from "../community.js";
import {
  UUID_RE,
  flashScope,
  getEvent,
  getUserId,
} from "./participantShared.js";

const db = pool as unknown as PoolLike;

interface BallotProject {
  id: string;
  title: string;
}

async function ballotProjects(eventId: string): Promise<BallotProject[]> {
  try {
    const r = await pool.query<BallotProject>(
      `SELECT id, title FROM projects
        WHERE event_id = $1 AND status = 'submitted' ORDER BY title`,
      [eventId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

async function votedIds(eventId: string, userId: string): Promise<Set<string>> {
  try {
    const r = await pool.query<{ project_id: string }>(
      `SELECT project_id FROM community_votes WHERE event_id = $1 AND user_id = $2`,
      [eventId, userId],
    );
    return new Set(r.rows.map((x) => x.project_id));
  } catch {
    return new Set();
  }
}

async function voteCounts(
  projectIds: string[],
): Promise<Record<string, number>> {
  if (projectIds.length === 0) return {};
  try {
    const r = await pool.query<{ project_id: string; n: string }>(
      `SELECT project_id, COUNT(*)::int AS n FROM community_votes
        WHERE project_id = ANY($1) GROUP BY project_id`,
      [projectIds],
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.project_id] = Number(row.n);
    return out;
  } catch {
    return {};
  }
}

async function emit(
  req: FastifyRequest,
  entry: Omit<
    Parameters<typeof appendAuditForRequest>[2],
    "actorUserId"
  >,
): Promise<void> {
  try {
    await appendAuditForRequest(
      pool as unknown as PoolLike,
      req as unknown as { session?: Record<string, unknown> },
      entry,
    );
  } catch (err) {
    req.log.warn({ err }, "audit_emit_failed");
  }
}

const ballotThrottle = rateLimit(60, 60 * 60 * 1000);
const commentFormThrottle = rateLimit(30, 10 * 60 * 1000);

export async function registerCommunityPages(
  app: FastifyInstance,
): Promise<void> {
  // ── Community ballot (deterministic per-voter order) ───────────────
  app.get(
    "/events/:eventId/ballot",
    { preHandler: [requireAuth] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getUserId(req);
      if (!userId) return reply.code(401).send({ error: "unauthenticated" });
      const { eventId } = req.params as { eventId: string };
      if (!UUID_RE.test(eventId))
        return reply.code(422).send({ error: "malformed_event_id" });
      const ev = await getEvent(eventId);
      if (!ev) return reply.code(404).send({ error: "not_found" });
      const projects = await ballotProjects(eventId);
      const ordered = ballotOrder(userId, projects.map((p) => p.id));
      const byId = new Map(projects.map((p) => [p.id, p]));
      const voted = await votedIds(eventId, userId);
      const active = isVotingActive(
        ev.voting_opens_at ?? null,
        ev.voting_closes_at ?? null,
        Date.now(),
      );
      const counts = active ? {} : await voteCounts(ordered);
      return reply.view("ballot.njk", {
        eventId,
        eventName: ev.name,
        votingActive: active,
        items: ordered.map((id) => ({
          id,
          title: byId.get(id)?.title ?? id,
          voted: voted.has(id),
          votes: active ? null : (counts[id] ?? 0),
        })),
        ...flashScope(req),
      });
    },
  );

  // ── Ballot vote (HTML form → PRG back to the ballot) ───────────────
  app.post(
    "/events/:eventId/ballot",
    { preHandler: [requireAuth, ballotThrottle] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getUserId(req);
      if (!userId) return reply.code(401).send({ error: "unauthenticated" });
      const { eventId } = req.params as { eventId: string };
      if (!UUID_RE.test(eventId))
        return reply.code(422).send({ error: "malformed_event_id" });
      const ev = await getEvent(eventId);
      if (!ev) return reply.code(404).send({ error: "not_found" });
      const back = (kind: "success" | "error", message: string): FastifyReply => {
        setFlash(req, kind, message);
        return reply.code(302).redirect(`/events/${eventId}/ballot`);
      };
      const b = (req.body ?? {}) as Record<string, unknown>;
      const projectId =
        typeof b["project_id"] === "string" ? b["project_id"] : "";
      const res = await castVote(db, userId, projectId);
      if (!res.ok) {
        const message =
          res.error === "duplicate_vote"
            ? "You already voted for this project."
            : res.error === "voting_closed"
              ? "Voting is not open for this project."
              : res.error === "vote_velocity"
                ? "Too many votes in the last hour. Slow down."
                : "That vote could not be recorded.";
        return back("error", message);
      }
      await emit(req, {
        eventId: res.vote.event_id,
        action: "vote.cast",
        resourceType: "vote",
        resourceId: res.vote.id,
        detail: { project_id: res.vote.project_id, via: "ballot-form" },
      });
      return back("success", "Vote recorded.");
    },
  );

  // ── Detail-page comment form (HTML form → PRG back to the project) ─
  app.post(
    "/gallery/:projectId/comments",
    { preHandler: [requireAuth, commentFormThrottle] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getUserId(req);
      if (!userId) return reply.code(401).send({ error: "unauthenticated" });
      const { projectId } = req.params as { projectId: string };
      if (!UUID_RE.test(projectId))
        return reply.code(422).send({ error: "invalid_input" });
      const b = (req.body ?? {}) as Record<string, unknown>;
      const problem = validateCommentBody(b["body"]);
      if (problem) {
        setFlash(req, "error", `Comment not posted: ${problem} (max ${COMMENT_MAX} characters).`);
        return reply.code(302).redirect(`/gallery/${projectId}`);
      }
      let scope: { id: string; event_id: string } | undefined;
      try {
        const r = await pool.query<{ id: string; event_id: string }>(
          `SELECT id, event_id FROM projects WHERE id = $1 AND status = 'submitted'`,
          [projectId],
        );
        scope = r.rows[0];
      } catch {
        scope = undefined;
      }
      if (!scope) return reply.code(404).send({ error: "not_found" });
      try {
        const ins = await pool.query<{ id: string }>(
          `INSERT INTO project_comments (event_id, project_id, user_id, body)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [scope.event_id, projectId, userId, b["body"]],
        );
        const row = ins.rows[0];
        if (row) {
          await emit(req, {
            eventId: scope.event_id,
            action: "comment.create",
            resourceType: "comment",
            resourceId: row.id,
            detail: { project_id: projectId, via: "detail-form" },
          });
        }
      } catch {
        setFlash(req, "error", "Comment could not be posted. Try again.");
        return reply.code(302).redirect(`/gallery/${projectId}`);
      }
      setFlash(req, "success", "Comment posted.");
      return reply.code(302).redirect(`/gallery/${projectId}`);
    },
  );
}
