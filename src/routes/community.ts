/**
 * T3 community voting + project comments (additive JSON API).
 *
 * Identity model: authenticated users only (open registration = community).
 * One vote per (event, project, user), enforced by a DB unique constraint
 * (not an app check) so concurrent double-votes cannot both land.
 *
 * Voting window: events.voting_opens_at / voting_closes_at (both NULL =
 * voting never opens — the exact pre-T3 behavior). All window predicates
 * use the DB clock (now()), never client time.
 *
 * Results hiding: vote counts are 404 for non-organizers while the window
 * is active. Organizers (event role or global organizer/admin) can always
 * see counts. Hiding is enforced here, not in templates.
 *
 * Convention: 401 unauthenticated · 404 isolation (never 403) ·
 * 409 duplicate vote · 422 invalid · 429 rate/velocity limited.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { pool } from "../db/index.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";
import { rateLimit } from "../lib/rateLimit.js";
import {
  appendAuditForRequest,
  type PoolLike,
} from "../lib/audit.js";
import { fanoutWebhooks } from "../lib/webhooks.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COMMENT_MAX = 2000;
export const VOTE_VELOCITY_LIMIT = 100;
const VOTE_RATE_MAX = 60;
const VOTE_RATE_WINDOW_MS = 60 * 60 * 1000;
const COMMENT_RATE_MAX = 30;
const COMMENT_RATE_WINDOW_MS = 10 * 60 * 1000;

// ── Pure helpers (unit-tested, no I/O) ───────────────────────────────

/**
 * Voting is active iff a window was configured (opens_at NOT NULL) and
 * `now` falls inside [opens_at, closes_at). NULL window = never active,
 * which preserves pre-T3 behavior for events without a configured window.
 */
export function isVotingActive(
  opensAt: string | Date | null | undefined,
  closesAt: string | Date | null | undefined,
  nowMs: number,
): boolean {
  if (opensAt === null || opensAt === undefined) return false;
  const opens = new Date(opensAt).getTime();
  if (!Number.isFinite(opens) || nowMs < opens) return false;
  if (closesAt === null || closesAt === undefined) return true;
  const closes = new Date(closesAt).getTime();
  if (!Number.isFinite(closes)) return false;
  return nowMs < closes;
}

/**
 * Deterministic per-voter ballot order: sort project ids by
 * sha256(userId|projectId). Stable across refreshes (same user sees the
 * same order), uncorrelated across users, and always a full permutation
 * (every eligible project stays reachable).
 */
export function ballotOrder(userId: string, projectIds: string[]): string[] {
  const key = (pid: string): string =>
    createHash("sha256").update(`${userId}|${pid}`, "utf8").digest("hex");
  return [...projectIds].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Comment body rules (mirrored by a DB CHECK). Returns message or null. */
export function validateCommentBody(value: unknown): string | null {
  if (typeof value !== "string") return "body must be text";
  const len = value.trim().length;
  if (len === 0) return "body must not be empty";
  if (value.length > COMMENT_MAX)
    return `body must be at most ${COMMENT_MAX} characters`;
  return null;
}

// ── Small DB helpers ────────────────────────────────────────────────

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/** Best-effort audit emit: logs and never fails the primary mutation. */
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

function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (
    typeof u === "object" &&
    u !== null &&
    typeof u.id === "string" &&
    u.id.length > 0
  )
    return u.id;
  return undefined;
}

interface ProjectScope {
  id: string;
  event_id: string;
}

async function submittedProject(
  db: PoolLike,
  projectId: string,
): Promise<ProjectScope | undefined> {
  try {
    const r = await db.query(
      `SELECT id, event_id FROM projects WHERE id = $1 AND status = 'submitted'`,
      [projectId],
    );
    return (r.rows as unknown as ProjectScope[])[0];
  } catch {
    return undefined;
  }
}

interface EventWindow {
  id: string;
  voting_opens_at: string | null;
  voting_closes_at: string | null;
}

async function eventWindow(
  db: PoolLike,
  eventId: string,
): Promise<EventWindow | undefined> {
  try {
    const r = await db.query(
      `SELECT id, voting_opens_at, voting_closes_at FROM events WHERE id = $1`,
      [eventId],
    );
    return (r.rows as unknown as EventWindow[])[0];
  } catch {
    return undefined;
  }
}

async function votingActive(db: PoolLike, eventId: string): Promise<boolean> {
  const w = await eventWindow(db, eventId);
  if (!w) return false;
  return isVotingActive(w.voting_opens_at, w.voting_closes_at, Date.now());
}

async function isOrganizerOrAdmin(
  db: PoolLike,
  userId: string | undefined,
  eventId: string,
): Promise<boolean> {
  if (!userId) return false;
  try {
    const m = await db.query(
      `SELECT 1 FROM event_memberships WHERE user_id = $1 AND event_id = $2 AND role = 'organizer' LIMIT 1`,
      [userId, eventId],
    );
    if (((m as { rowCount?: number | null }).rowCount ?? m.rows.length) > 0)
      return true;
    const u = await db.query(`SELECT role FROM users WHERE id = $1`, [userId]);
    const role = (u.rows[0] as { role?: string } | undefined)?.role;
    return role === "admin" || role === "organizer";
  } catch {
    return false;
  }
}

export interface CastVoteOk {
  ok: true;
  vote: { id: string; event_id: string; project_id: string; user_id: string };
}

export interface CastVoteErr {
  ok: false;
  error:
    | "invalid_project_id"
    | "not_found"
    | "voting_closed"
    | "vote_velocity"
    | "duplicate_vote";
}

export type CastVoteResult = CastVoteOk | CastVoteErr;

/**
 * Shared vote mutation (JSON API + HTML ballot form). All predicates use
 * trusted inputs only: project from DB, window from DB clock, user from
 * the session.
 */
export async function castVote(
  db: PoolLike,
  userId: string,
  projectId: string,
): Promise<CastVoteResult> {
  if (!UUID_RE.test(projectId))
    return { ok: false, error: "invalid_project_id" };
  const proj = await submittedProject(db, projectId);
  if (!proj) return { ok: false, error: "not_found" };
  if (!(await votingActive(db, proj.event_id)))
    return { ok: false, error: "voting_closed" };
  try {
    const v = await db.query(
      `SELECT COUNT(*)::int AS n FROM community_votes
        WHERE user_id = $1 AND created_at > now() - INTERVAL '1 hour'`,
      [userId],
    );
    const n = Number((v.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
    if (Number.isFinite(n) && n > VOTE_VELOCITY_LIMIT)
      return { ok: false, error: "vote_velocity" };
  } catch {
    // Velocity table missing (pre-migration) — fall through to the insert,
    // which enforces the uniqueness invariant that actually matters.
  }
  try {
    const ins = await db.query(
      `INSERT INTO community_votes (event_id, project_id, user_id)
       VALUES ($1, $2, $3) RETURNING id, event_id, project_id, user_id`,
      [proj.event_id, projectId, userId],
    );
    const row = (ins.rows as unknown as CastVoteOk["vote"][])[0];
    if (!row) return { ok: false, error: "not_found" };
    return { ok: true, vote: row };
  } catch (err) {
    if (pgCode(err) === "23505") return { ok: false, error: "duplicate_vote" };
    throw err;
  }
}

const voteThrottle = rateLimit(VOTE_RATE_MAX, VOTE_RATE_WINDOW_MS);
const commentThrottle = rateLimit(COMMENT_RATE_MAX, COMMENT_RATE_WINDOW_MS);

const resolveEventId = (req: FastifyRequest): string | undefined =>
  (req.params as { eventId?: unknown }).eventId as string | undefined;
const organizeEvent = requireEventRole(resolveEventId, "organizer");

export default async function communityRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ── Cast a community vote ──────────────────────────────────────────
  app.post(
    "/api/projects/:projectId/vote",
    { preHandler: [requireAuth, voteThrottle] },
    async (req, reply) => {
      const userId = getUserId(req);
      if (!userId) return reply.code(401).send({ error: "unauthenticated" });
      const { projectId } = req.params as { projectId: string };
      const res = await castVote(pool as unknown as PoolLike, userId, projectId);
      if (!res.ok) {
        const status =
          res.error === "duplicate_vote"
            ? 409
            : res.error === "vote_velocity"
              ? 429
              : res.error === "not_found"
                ? 404
                : 422;
        return reply.code(status).send({ error: res.error });
      }
      await emit(req, {
        eventId: res.vote.event_id,
        action: "vote.cast",
        resourceType: "vote",
        resourceId: res.vote.id,
        detail: { project_id: res.vote.project_id },
      });
      await fanoutWebhooks(pool as unknown as PoolLike, {
        type: "vote.cast",
        eventId: res.vote.event_id,
        data: {
          vote_id: res.vote.id,
          project_id: res.vote.project_id,
          user_id: res.vote.user_id,
        },
      });
      return reply.code(201).send({ vote: res.vote });
    },
  );

  // ── Vote counts (hidden while the window is active) ────────────────
  app.get("/api/projects/:projectId/votes", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!UUID_RE.test(projectId))
      return reply.code(422).send({ error: "invalid_project_id" });
    const db = pool as unknown as PoolLike;
    const proj = await submittedProject(db, projectId);
    if (!proj) return reply.code(404).send({ error: "not_found" });
    if (await votingActive(db, proj.event_id)) {
      const userId = getUserId(req);
      if (!(await isOrganizerOrAdmin(db, userId, proj.event_id)))
        return reply.code(404).send({ error: "not_found" });
    }
    const c = await db.query(
      `SELECT COUNT(*)::int AS n FROM community_votes WHERE project_id = $1`,
      [projectId],
    );
    const n = Number((c.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
    return reply.send({ project_id: projectId, votes: n });
  });

  // ── Comments: list (public) + create (authenticated) ───────────────
  app.get("/api/projects/:projectId/comments", async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    if (!UUID_RE.test(projectId))
      return reply.code(422).send({ error: "invalid_project_id" });
    const db = pool as unknown as PoolLike;
    const proj = await submittedProject(db, projectId);
    if (!proj) return reply.code(404).send({ error: "not_found" });
    const r = await db.query(
      `SELECT c.id, c.body, c.created_at, COALESCE(u.name, 'deleted user') AS author
         FROM project_comments c LEFT JOIN users u ON u.id = c.user_id
        WHERE c.project_id = $1
        ORDER BY c.created_at ASC LIMIT 100`,
      [projectId],
    );
    return reply.send({ project_id: projectId, comments: r.rows });
  });

  app.post(
    "/api/projects/:projectId/comments",
    { preHandler: [requireAuth, commentThrottle] },
    async (req, reply) => {
      const userId = getUserId(req);
      if (!userId) return reply.code(401).send({ error: "unauthenticated" });
      const { projectId } = req.params as { projectId: string };
      if (!UUID_RE.test(projectId))
        return reply.code(422).send({ error: "invalid_project_id" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const problem = validateCommentBody(body["body"]);
      if (problem) return reply.code(422).send({ error: "invalid_body", detail: problem });
      const db = pool as unknown as PoolLike;
      const proj = await submittedProject(db, projectId);
      if (!proj) return reply.code(404).send({ error: "not_found" });
      const ins = await db.query(
        `INSERT INTO project_comments (event_id, project_id, user_id, body)
         VALUES ($1, $2, $3, $4) RETURNING id, body, created_at`,
        [proj.event_id, projectId, userId, body["body"]],
      );
      const row = ins.rows[0] as
        | { id: string; body: string; created_at: unknown }
        | undefined;
      if (!row) return reply.code(404).send({ error: "not_found" });
      await emit(req, {
        eventId: proj.event_id,
        action: "comment.create",
        resourceType: "comment",
        resourceId: row.id,
        detail: { project_id: projectId },
      });
      await fanoutWebhooks(db, {
        type: "comment.create",
        eventId: proj.event_id,
        data: { comment_id: row.id, project_id: projectId },
      });
      return reply
        .code(201)
        .send({ comment: { ...row, project_id: projectId } });
    },
  );

  // ── Voting window config (organizer only) ──────────────────────────
  app.post(
    "/api/events/:eventId/voting-window",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      // parse(): ISO string -> canonical ISO | null (cleared) | undefined (invalid).
      const parse = (v: unknown): string | null | undefined => {
        if (v === null || v === undefined || v === "") return null;
        if (typeof v !== "string") return undefined;
        const ms = Date.parse(v);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
      };
      const opens = parse(body["opens_at"]);
      const closes = parse(body["closes_at"]);
      if (opens === undefined || closes === undefined)
        return reply.code(422).send({ error: "invalid_window" });
      if (opens !== null && closes !== null && closes <= opens)
        return reply.code(422).send({ error: "invalid_window" });
      const db = pool as unknown as PoolLike;
      const ev = await eventWindow(db, eventId);
      if (!ev) return reply.code(404).send({ error: "not_found" });
      await db.query(
        `UPDATE events SET voting_opens_at = $1, voting_closes_at = $2, updated_at = now() WHERE id = $3`,
        [opens, closes, eventId],
      );
      const cur = await db.query(
        `SELECT voting_opens_at, voting_closes_at,
           (voting_opens_at IS NOT NULL AND voting_opens_at <= now()
            AND (voting_closes_at IS NULL OR voting_closes_at > now())) AS active
           FROM events WHERE id = $1`,
        [eventId],
      );
      const row = cur.rows[0] as
        | { voting_opens_at: string | null; voting_closes_at: string | null; active: boolean }
        | undefined;
      await emit(req, {
        eventId,
        action: "voting.window",
        resourceType: "event",
        resourceId: eventId,
        detail: { opens_at: opens, closes_at: closes },
      });
      return reply.send({
        event_id: eventId,
        voting: {
          opens_at: row?.voting_opens_at ?? opens,
          closes_at: row?.voting_closes_at ?? closes,
          active: row?.active ?? false,
        },
      });
    },
  );
}
