/**
 * Fastify preHandler guards for authorization.
 *
 * Convention (isolation-safe — no 403 for cross-event):
 *   401 — unauthenticated (no session userId)
 *   404 — wrong resource / no membership (never distinguishes "wrong event" from "not a member")
 *   422 — malformed identifier (e.g. invalid UUID)
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db/index.js";
import type { EventRole } from "./roles.js";

// ── Augment FastifyRequest with membership decorations ─────────────────
declare module "fastify" {
  interface FastifyRequest {
    /** The user's role for the resolved event (set by requireEventRole). */
    eventRole?: EventRole;
    /** The membership row PK (set by requireEventRole). */
    eventMembershipId?: string;
  }
}

// ── Types ──────────────────────────────────────────────────────────────

/** Resolver that extracts an event ID string from the incoming request. */
export type EventIdResolver = (req: FastifyRequest) => string | undefined;

/** Resolver that extracts a track ID string from the incoming request. */
export type TrackIdResolver = (req: FastifyRequest) => string | undefined;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Loose UUID v4 check — rejects garbage before it hits the database.
 * Not cryptographically strict but sufficient for input validation.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Read the userId from the session.
 *
 * The session plugin decorates `req.session` as `SessionData` which carries
 * `{ id: string; [key: string]: unknown }`.  A successful login sets
 * `req.session.userId` to the authenticated user's PK.
 */
function getSessionUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  return undefined;
}

// ── Guards ─────────────────────────────────────────────────────────────

/**
 * requireAuth — ensures the request carries an authenticated session.
 *
 * Returns 401 `{ error: 'unauthenticated' }` when no `req.session.userId`.
 */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!getSessionUserId(req)) {
    return reply.code(401).send({ error: "unauthenticated" });
  }
}

/**
 * requireEventRole — ensures the authenticated user holds one of the
 * `allowedRoles` for the event resolved by `resolveEventId`.
 *
 * | Condition                              | Response                          |
 * |----------------------------------------|-----------------------------------|
 * | No session userId                      | 401 `{ error: 'unauthenticated' }`|
 * | eventId undefined or malformed         | 422 `{ error: 'malformed_event_id' }` |
 * | No matching membership row             | 404 `{ error: 'not_found' }`      |
 * | Membership exists but role not allowed | 404 `{ error: 'not_found' }`      |
 *
 * On success the request is decorated with `eventRole` and `eventMembershipId`.
 */
export function requireEventRole(
  resolveEventId: EventIdResolver,
  ...allowedRoles: EventRole[]
) {
  return async function eventRoleGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // 1. Authentication
    const userId = getSessionUserId(req);
    if (!userId) {
      return reply.code(401).send({ error: "unauthenticated" });
    }

    // 2. Resolve event ID
    const eventId = resolveEventId(req);
    if (eventId === undefined || eventId === "") {
      return reply.code(422).send({ error: "malformed_event_id" });
    }
    if (!isValidUuid(eventId)) {
      return reply.code(422).send({ error: "malformed_event_id" });
    }

    // 3. Membership lookup (defensive — table may not exist yet)
    try {
      const result = await pool.query(
        `SELECT id, role FROM event_memberships
         WHERE user_id = $1 AND event_id = $2
         LIMIT 1`,
        [userId, eventId],
      );

      const row = result.rows[0] as
        | { id: string; role: string }
        | undefined;

      if (!row || !allowedRoles.includes(row.role as EventRole)) {
        return reply.code(404).send({ error: "not_found" });
      }

      req.eventRole = row.role as EventRole;
      req.eventMembershipId = row.id;
    } catch {
      // Table likely doesn't exist yet → treat as "no membership"
      return reply.code(404).send({ error: "not_found" });
    }
  };
}

/**
 * requireTrackScope — ensures the event membership (set by requireEventRole)
 * includes the required track scope.
 *
 * | Condition                              | Response                          |
 * |----------------------------------------|-----------------------------------|
 * | No session userId                      | 401 `{ error: 'unauthenticated' }`|
 * | trackId undefined or malformed         | 422 `{ error: 'malformed_track_id' }` |
 * | No membership or no track scope match  | 404 `{ error: 'not_found' }`      |
 */
export function requireTrackScope(resolveTrackId: TrackIdResolver) {
  return async function trackScopeGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // 1. Authentication
    const userId = getSessionUserId(req);
    if (!userId) {
      return reply.code(401).send({ error: "unauthenticated" });
    }

    // 2. Resolve track ID
    const trackId = resolveTrackId(req);
    if (trackId === undefined || trackId === "") {
      return reply.code(422).send({ error: "malformed_track_id" });
    }
    if (!isValidUuid(trackId)) {
      return reply.code(422).send({ error: "malformed_track_id" });
    }

    // 3. Verify membership was resolved first
    const membershipId = req.eventMembershipId;
    if (!membershipId) {
      return reply.code(404).send({ error: "not_found" });
    }

    // 4. Track scope check (defensive — table may not exist yet)
    try {
      const result = await pool.query(
        `SELECT id FROM event_memberships
         WHERE id = $1 AND (track_id = $2 OR track_id IS NULL)`,
        [membershipId, trackId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  };
}

/**
 * requireAssignment — ensures the authenticated judge has an active
 * assignment in `judge_assignments` for the resolved event.
 *
 * | Condition                              | Response                          |
 * |----------------------------------------|-----------------------------------|
 * | No session userId                      | 401 `{ error: 'unauthenticated' }`|
 * | eventId undefined or malformed         | 422 `{ error: 'malformed_event_id' }` |
 * | No matching active assignment          | 404 `{ error: 'not_found' }`      |
 */
export function requireAssignment(resolveEventId: EventIdResolver) {
  return async function assignmentGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // 1. Authentication
    const userId = getSessionUserId(req);
    if (!userId) {
      return reply.code(401).send({ error: "unauthenticated" });
    }

    // 2. Resolve event ID
    const eventId = resolveEventId(req);
    if (eventId === undefined || eventId === "") {
      return reply.code(422).send({ error: "malformed_event_id" });
    }
    if (!isValidUuid(eventId)) {
      return reply.code(422).send({ error: "malformed_event_id" });
    }

    // 3. Assignment lookup (defensive — table may not exist yet)
    try {
      const result = await pool.query(
        `SELECT id FROM judge_assignments
         WHERE judge_user_id = $1 AND event_id = $2 AND status = 'active'
         LIMIT 1`,
        [userId, eventId],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
    } catch {
      // Table likely doesn't exist yet → treat as "no assignment"
      return reply.code(404).send({ error: "not_found" });
    }
  };
}
