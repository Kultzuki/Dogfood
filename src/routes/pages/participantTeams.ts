/**
 * Participant team pages — invite-link join + my-team roster view.
 *
 * GET  /events/:eventId/teams/join?token= — team name/capacity + Join button
 * POST /events/:eventId/teams/join        — transactional join, then 302
 * GET  /events/:eventId/my-team           — roster + PAGE-URL invite link
 * POST /events/:eventId/my-team/rotate    — organizer-only token rotation
 *
 * Join mirrors the invite-token transaction in routes/teams.ts (advisory
 * lock, size cap, 409 team_full / already_teamed as re-rendered alerts).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth, requireEventRole } from "../../authz/guards.js";
import { setFlash } from "../../lib/flash.js";
import {
  UUID_RE,
  eventExists,
  flashScope,
  getEvent,
  getMyTeam,
  getUserId,
  pgCode,
  safeRollback,
} from "./participantShared.js";

type EventParams = { eventId: string };

const resolveEventId = (req: FastifyRequest): string | undefined =>
  (req.params as EventParams).eventId;
const organizerOnly = requireEventRole(resolveEventId, "organizer");

interface InviteTeam {
  id: string;
  event_id: string;
  name: string;
  max_size: number;
}

async function memberCount(teamId: string): Promise<number> {
  const r = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`,
    [teamId],
  );
  return Number(r.rows[0]?.count ?? "0");
}

async function renderJoin(
  reply: FastifyReply,
  req: FastifyRequest,
  eventId: string,
  eventName: string,
  team: InviteTeam,
  token: string,
  userId: string,
  error: string | null,
  status: number,
): Promise<void> {
  const count = await memberCount(team.id);
  const mine = await getMyTeam(eventId, userId);
  return reply.code(status).view("team_join.njk", {
    eventId,
    eventName,
    team: { name: team.name, memberCount: count, maxSize: team.max_size },
    token,
    alreadyMember: mine !== undefined,
    csrfToken: req.csrfToken(),
    error,
    ...flashScope(req),
  });
}

export async function registerParticipantTeamPages(
  app: FastifyInstance,
): Promise<void> {
  app.get("/events/:eventId/teams/join", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const q = (req.query ?? {}) as Record<string, unknown>;
    const token = typeof q.token === "string" ? q.token : "";
    if (!token) return reply.code(422).send({ error: "token_required" });
    const found = await pool.query<InviteTeam>(
      `SELECT id, event_id, name, max_size FROM teams WHERE invite_token = $1`,
      [token],
    );
    const team = found.rows[0];
    if (!team || team.event_id !== eventId) {
      return reply.code(404).send({ error: "not_found" });
    }
    await renderJoin(reply, req, eventId, ev.name, team, token, userId, null, 200);
  });

  app.post("/events/:eventId/teams/join", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const raw = b.invite_token ?? b.token;
    if (typeof raw !== "string" || raw.length === 0) {
      return reply.code(422).send({ error: "token_required" });
    }
    const found = await pool.query<InviteTeam>(
      `SELECT id, event_id, name, max_size FROM teams WHERE invite_token = $1`,
      [raw],
    );
    const team = found.rows[0];
    if (!team || team.event_id !== eventId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('team_' || $1))`, [team.id]);
      const locked = (await client.query<Pick<InviteTeam, "id" | "event_id" | "max_size">>(
        `SELECT id, event_id, max_size FROM teams WHERE id = $1 FOR UPDATE`, [team.id],
      )).rows[0];
      if (!locked) {
        await safeRollback(client);
        return reply.code(404).send({ error: "not_found" });
      }
      const c = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`, [locked.id],
      );
      if (Number(c.rows[0]?.count ?? "0") >= locked.max_size) {
        await safeRollback(client);
        await renderJoin(reply, req, eventId, ev.name, team, raw, userId, "This team is full.", 409);
        return;
      }
      await client.query(
        `INSERT INTO team_members (team_id, event_id, user_id) VALUES ($1, $2, $3)`,
        [locked.id, locked.event_id, userId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await safeRollback(client);
      if (pgCode(err) === "23505") {
        await renderJoin(reply, req, eventId, ev.name, team, raw, userId,
          "You are already on a team in this event.", 409);
        return;
      }
      throw err;
    } finally {
      client.release();
    }
    setFlash(req, "success", `You joined ${team.name}.`);
    return reply.code(302).redirect(`/events/${eventId}/my-team`);
  });

  app.get("/events/:eventId/my-team", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const ev = await getEvent(eventId);
    const team = await getMyTeam(eventId, userId);
    if (!team) return reply.code(404).send({ error: "not_found" });
    const roster = await pool.query(
      `SELECT u.id, u.name, u.email, m.created_at FROM team_members m
         JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY m.created_at ASC`,
      [team.id],
    );
    let isOrganizer = false;
    try {
      const role = await pool.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE user_id = $1 AND event_id = $2 LIMIT 1`,
        [userId, eventId],
      );
      isOrganizer = role.rows[0]?.role === "organizer";
    } catch {
      isOrganizer = false;
    }
    interface RosterRow { id: string; name: string; email: string; created_at: Date }
    const members = (roster.rows as RosterRow[]).map((m) => ({
      name: m.name,
      email: m.email,
      createdAt: m.created_at.toISOString(),
    }));
    return reply.view("team_view.njk", {
      eventId,
      eventName: ev?.name ?? "Event",
      team: { name: team.name },
      members,
      memberCount: team.member_count,
      maxSize: team.max_size,
      inviteUrl: `/events/${eventId}/teams/join?token=${team.invite_token}`,
      isOrganizer,
      csrfToken: req.csrfToken(),
      ...flashScope(req),
    });
  });

  app.post("/events/:eventId/my-team/rotate", { preHandler: [organizerOnly] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    const team = await getMyTeam(eventId, userId);
    if (!team) return reply.code(404).send({ error: "not_found" });
    const token = randomBytes(32).toString("hex");
    await pool.query(
      `UPDATE teams SET invite_token = $1, updated_at = now() WHERE id = $2`,
      [token, team.id],
    );
    setFlash(req, "success", "Invite link rotated. The previous link no longer works.");
    return reply.code(302).redirect(`/events/${eventId}/my-team`);
  });
}
