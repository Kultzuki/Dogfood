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
      id: m.id,
      name: m.name,
      email: m.email,
      createdAt: m.created_at.toISOString(),
    }));
    const isLeader = team.leader_user_id !== null && team.leader_user_id === userId;
    return reply.view("team_view.njk", {
      eventId,
      eventName: ev?.name ?? "Event",
      team: { id: team.id, name: team.name },
      members,
      memberCount: team.member_count,
      maxSize: team.max_size,
      leaderName: team.leader_name ?? "Unassigned",
      isLeader,
      inviteUrl: `/events/${eventId}/teams/join?token=${team.invite_token}`,
      isOrganizer,
      csrfToken: req.csrfToken(),
      ...flashScope(req),
    });
  });

  app.get("/events/:eventId/teams/new", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const mine = await getMyTeam(eventId, userId);
    return reply.view("team_new.njk", {
      eventId,
      eventName: ev.name,
      alreadyTeamed: mine !== undefined,
      csrfToken: req.csrfToken(),
      error: null,
      ...flashScope(req),
    });
  });

  app.post("/events/:eventId/teams/new", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const fail = async (message: string): Promise<void> => {
      const mine = await getMyTeam(eventId, userId);
      await reply.code(422).view("team_new.njk", {
        eventId,
        eventName: ev.name,
        alreadyTeamed: mine !== undefined,
        csrfToken: req.csrfToken(),
        error: message,
        ...flashScope(req),
      });
    };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > 255) {
      await fail("Enter a team name (max 255 characters).");
      return;
    }
    const maxRaw = b.max_size ?? b.maxSize;
    const maxSize = maxRaw === undefined || maxRaw === "" ? 4 : Number(maxRaw);
    if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 20) {
      await fail("Team size must be a whole number from 1 to 20.");
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('team_create_' || $1))`, [eventId + userId]);
      const memRes = await client.query<{ role: string }>(
        `SELECT role FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId],
      );
      const sysRes = await client.query<{ role: string }>(
        `SELECT role FROM users WHERE id = $1`, [userId],
      );
      const eventRole = memRes.rows[0]?.role;
      const sysRole = sysRes.rows[0]?.role;
      const isOrganizerish = eventRole === "organizer" || sysRole === "organizer" || sysRole === "admin";
      if (!memRes.rows[0]) {
        await client.query(
          `INSERT INTO event_memberships (event_id, user_id, role) VALUES ($1, $2, 'participant') ON CONFLICT (event_id, user_id) DO NOTHING`,
          [eventId, userId],
        );
      }
      if (!isOrganizerish) {
        const already = await client.query(
          `SELECT team_id FROM team_members WHERE event_id = $1 AND user_id = $2 LIMIT 1`, [eventId, userId],
        );
        if ((already.rowCount ?? 0) > 0) {
          await safeRollback(client);
          await fail("You are already on a team in this event. Leave it first to create a new one.");
          return;
        }
      }
      const token = randomBytes(32).toString("hex");
      let teamId: string | undefined;
      try {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO teams (event_id, name, invite_token, max_size, leader_user_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [eventId, name, token, maxSize, userId, userId],
        );
        teamId = ins.rows[0]?.id;
      } catch (e) {
        if (pgCode(e) === "42703") {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO teams (event_id, name, invite_token, max_size) VALUES ($1, $2, $3, $4) RETURNING id`,
            [eventId, name, token, maxSize],
          );
          teamId = ins.rows[0]?.id;
        } else throw e;
      }
      if (!teamId) {
        await safeRollback(client);
        await fail("Could not create the team. Please try again.");
        return;
      }
      if (!isOrganizerish) {
        try {
          await client.query(
            `INSERT INTO team_members (team_id, event_id, user_id) VALUES ($1, $2, $3)`,
            [teamId, eventId, userId],
          );
        } catch (e) {
          await safeRollback(client);
          if (pgCode(e) === "23505") {
            await fail("You are already on a team in this event. Leave it first to create a new one.");
            return;
          }
          throw e;
        }
      }
      await client.query("COMMIT");
      setFlash(req, "success", `Team "${name}" created — you are the leader.`);
      return reply.code(302).redirect(`/events/${eventId}/my-team`);
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/events/:eventId/my-team/leave", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const team = await getMyTeam(eventId, userId);
    if (!team) {
      setFlash(req, "error", "You are not on a team in this event.");
      return reply.code(302).redirect(`/events/${eventId}/dashboard`);
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('team_' || $1))`, [team.id]);
      const sub = await client.query(`SELECT 1 FROM projects WHERE team_id = $1 AND status = 'submitted' LIMIT 1`, [team.id]);
      if ((sub.rowCount ?? 0) > 0) {
        await safeRollback(client);
        setFlash(req, "error", "You cannot leave — this team has a submitted project.");
        return reply.code(302).redirect(`/events/${eventId}/my-team`);
      }
      const c = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM team_members WHERE team_id = $1`, [team.id],
      );
      const count = Number(c.rows[0]?.count ?? "0");
      await client.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, userId]);
      if (count <= 1) {
        await client.query(`DELETE FROM teams WHERE id = $1`, [team.id]);
        await client.query("COMMIT");
        setFlash(req, "success", "You left the team. It had no other members, so it was dissolved.");
        return reply.code(302).redirect(`/events/${eventId}/dashboard`);
      }
      if (team.leader_user_id === userId) {
        const next = await client.query<{ user_id: string }>(
          `SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY created_at ASC LIMIT 1`, [team.id],
        );
        const nextId = next.rows[0]?.user_id;
        if (nextId) {
          try {
            await client.query(`UPDATE teams SET leader_user_id = $1, updated_at = now() WHERE id = $2`, [nextId, team.id]);
          } catch (e) {
            if (pgCode(e) !== "42703") throw e;
          }
        }
      }
      await client.query("COMMIT");
      setFlash(req, "success", "You left the team.");
      return reply.code(302).redirect(`/events/${eventId}/dashboard`);
    } catch (e) {
      await safeRollback(client);
      throw e;
    } finally {
      client.release();
    }
  });

  app.post("/events/:eventId/my-team/leader", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId } = req.params as EventParams;
    if (!UUID_RE.test(eventId)) return reply.code(422).send({ error: "malformed_event_id" });
    const team = await getMyTeam(eventId, userId);
    if (!team) return reply.code(404).send({ error: "not_found" });
    const role = await pool.query<{ role: string }>(
      `SELECT role FROM event_memberships WHERE user_id = $1 AND event_id = $2 LIMIT 1`, [userId, eventId],
    );
    const isOrg = role.rows[0]?.role === "organizer";
    if (!isOrg && team.leader_user_id !== userId) {
      setFlash(req, "error", "Only the team leader or an organizer can transfer leadership.");
      return reply.code(302).redirect(`/events/${eventId}/my-team`);
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const target = typeof b.leader_user_id === "string" ? b.leader_user_id : typeof b.leader === "string" ? b.leader : "";
    if (!UUID_RE.test(target)) {
      setFlash(req, "error", "Choose a valid team member.");
      return reply.code(302).redirect(`/events/${eventId}/my-team`);
    }
    const mem = await pool.query(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1`, [team.id, target]);
    if ((mem.rowCount ?? 0) === 0) {
      setFlash(req, "error", "The new leader must be a member of this team.");
      return reply.code(302).redirect(`/events/${eventId}/my-team`);
    }
    try {
      await pool.query(`UPDATE teams SET leader_user_id = $1, updated_at = now() WHERE id = $2`, [target, team.id]);
    } catch (e) {
      if (pgCode(e) === "42703") {
        setFlash(req, "error", "Leadership transfer is unavailable on this database.");
        return reply.code(302).redirect(`/events/${eventId}/my-team`);
      }
      throw e;
    }
    setFlash(req, "success", "Team leadership transferred.");
    return reply.code(302).redirect(`/events/${eventId}/my-team`);
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
