/**
 * Audit read route — organizer only.
 *
 * GET /api/events/:eventId/audit → rows ordered by seq asc.
 * 401 unauthenticated · 404 not-found (incl. non-organizers) · 422 malformed id
 */
import type { FastifyInstance } from "fastify";
import { pool } from "../db/index.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";

type P = { eventId: string };

const resolveEventId = (req: { params: unknown }): string | undefined =>
  (req.params as P).eventId;
const organizeEvent = requireEventRole(resolveEventId, "organizer");

async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get("/api/events/:eventId/audit", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const r = await pool.query(
      `SELECT id, seq, event_id, track_id, actor_user_id, action,
              resource_type, resource_id, detail, prev_hash, hash, created_at
         FROM audit_logs WHERE event_id = $1 ORDER BY seq ASC`,
      [eventId],
    );
    return reply.send(r.rows);
  });
}
