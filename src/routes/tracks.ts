/**
 * Tracks & Prizes routes — full CRUD nested under events.
 *
 * 401 unauthenticated · 404 not-found (never 403) · 409 slug_conflict · 422 invalid_slug
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../db/index.js";
import { tracks, prizes } from "../db/tracks.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";

async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}

const SLUG_RE = /^[a-z0-9-]{1,100}$/;
const db = drizzle(pool);

const resolveEventId = (req: { params: unknown }): string | undefined =>
  (req.params as P).eventId;
const memberOfEvent = requireEventRole(
  resolveEventId,
  "participant",
  "judge",
  "organizer",
);
const organizeEvent = requireEventRole(resolveEventId, "organizer");

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

type P = { eventId: string };
type TP = { eventId: string; trackId: string };
type PP = { eventId: string; prizeId: string };

export default async function trackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // ── Tracks ──────────────────────────────────────────────────────

  app.post("/api/events/:eventId/tracks", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const slug = String(b.slug ?? "");
    const name = String(b.name ?? "");
    if (!SLUG_RE.test(slug)) return reply.code(422).send({ error: "invalid_slug" });
    if (!name) return reply.code(422).send({ error: "name_required" });
    try {
      const [row] = await db.insert(tracks).values({
        eventId, slug, name,
        description: typeof b.description === "string" ? b.description : null,
      }).returning();
      if (row) await emit(req, { eventId, action: "admin.action", resourceType: "track", resourceId: row.id, detail: { slug } });
      return reply.code(201).send(row);
    } catch (err: unknown) {
      if (pgCode(err) === "23505") return reply.code(409).send({ error: "slug_conflict" });
      throw err;
    }
  });

  app.get("/api/events/:eventId/tracks", { preHandler: [memberOfEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    return reply.send(await db.select().from(tracks).where(eq(tracks.eventId, eventId)));
  });

  app.get("/api/events/:eventId/tracks/:trackId", { preHandler: [memberOfEvent] }, async (req, reply) => {
    const { eventId, trackId } = req.params as TP;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const [row] = await db.select().from(tracks)
      .where(and(eq(tracks.eventId, eventId), eq(tracks.id, trackId)));
    return row ? reply.send(row) : reply.code(404).send({ error: "not_found" });
  });

  app.patch("/api/events/:eventId/tracks/:trackId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, trackId } = req.params as TP;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.slug !== undefined) {
      const s = String(b.slug);
      if (!SLUG_RE.test(s)) return reply.code(422).send({ error: "invalid_slug" });
      u.slug = s;
    }
    if (b.name !== undefined) u.name = String(b.name);
    if (b.description !== undefined)
      u.description = typeof b.description === "string" ? b.description : null;
    if (Object.keys(u).length === 1) return reply.code(422).send({ error: "no_changes" });
    try {
      const [row] = await db.update(tracks).set(u)
        .where(and(eq(tracks.eventId, eventId), eq(tracks.id, trackId))).returning();
      return row ? reply.send(row) : reply.code(404).send({ error: "not_found" });
    } catch (err: unknown) {
      if (pgCode(err) === "23505") return reply.code(409).send({ error: "slug_conflict" });
      throw err;
    }
  });

  app.delete("/api/events/:eventId/tracks/:trackId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, trackId } = req.params as TP;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    try {
      const [row] = await db.delete(tracks)
        .where(and(eq(tracks.eventId, eventId), eq(tracks.id, trackId))).returning();
      if (!row) return reply.code(404).send({ error: "not_found" });
      await emit(req, { eventId, action: "admin.action", resourceType: "track", resourceId: row.id, detail: {} });
      return reply.code(204).send();
    } catch (err: unknown) {
      if (pgCode(err) === "23503") return reply.code(422).send({ error: "track_in_use" });
      throw err;
    }
  });

  // ── Prizes ──────────────────────────────────────────────────────

  app.post("/api/events/:eventId/prizes", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const slug = String(b.slug ?? "");
    const name = String(b.name ?? "");
    if (!SLUG_RE.test(slug)) return reply.code(422).send({ error: "invalid_slug" });
    if (!name) return reply.code(422).send({ error: "name_required" });
    const amt = typeof b.amountCents === "number" ? b.amountCents : null;
    if (amt !== null && amt < 0) return reply.code(422).send({ error: "invalid_amount" });
    try {
      const [row] = await db.insert(prizes).values({
        eventId, slug, name,
        trackId: typeof b.trackId === "string" ? b.trackId : null,
        amountCents: amt,
      }).returning();
      if (row) await emit(req, { eventId, action: "admin.action", resourceType: "prize", resourceId: row.id, detail: { slug } });
      return reply.code(201).send(row);
    } catch (err: unknown) {
      const c = pgCode(err);
      if (c === "23505") return reply.code(409).send({ error: "slug_conflict" });
      if (c === "23503") return reply.code(422).send({ error: "invalid_track" });
      throw err;
    }
  });

  app.get("/api/events/:eventId/prizes", { preHandler: [memberOfEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    return reply.send(await db.select().from(prizes).where(eq(prizes.eventId, eventId)));
  });

  app.get("/api/events/:eventId/prizes/:prizeId", { preHandler: [memberOfEvent] }, async (req, reply) => {
    const { eventId, prizeId } = req.params as PP;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const [row] = await db.select().from(prizes)
      .where(and(eq(prizes.eventId, eventId), eq(prizes.id, prizeId)));
    return row ? reply.send(row) : reply.code(404).send({ error: "not_found" });
  });

  app.patch("/api/events/:eventId/prizes/:prizeId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, prizeId } = req.params as PP;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const u: Record<string, unknown> = { updatedAt: new Date() };
    if (b.slug !== undefined) {
      const s = String(b.slug);
      if (!SLUG_RE.test(s)) return reply.code(422).send({ error: "invalid_slug" });
      u.slug = s;
    }
    if (b.name !== undefined) u.name = String(b.name);
    if (b.trackId !== undefined)
      u.trackId = typeof b.trackId === "string" ? b.trackId : null;
    if (b.amountCents !== undefined) {
      const a = b.amountCents;
      if (typeof a === "number" && a < 0) return reply.code(422).send({ error: "invalid_amount" });
      u.amountCents = typeof a === "number" ? a : null;
    }
    if (Object.keys(u).length === 1) return reply.code(422).send({ error: "no_changes" });
    try {
      const [row] = await db.update(prizes).set(u)
        .where(and(eq(prizes.eventId, eventId), eq(prizes.id, prizeId))).returning();
      return row ? reply.send(row) : reply.code(404).send({ error: "not_found" });
    } catch (err: unknown) {
      const c = pgCode(err);
      if (c === "23505") return reply.code(409).send({ error: "slug_conflict" });
      if (c === "23503") return reply.code(422).send({ error: "invalid_track" });
      throw err;
    }
  });

  app.delete("/api/events/:eventId/prizes/:prizeId", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, prizeId } = req.params as PP;
    if (!(await eventExists(eventId)))
      return reply.code(404).send({ error: "not_found" });
    const [row] = await db.delete(prizes)
      .where(and(eq(prizes.eventId, eventId), eq(prizes.id, prizeId))).returning();
    if (!row) return reply.code(404).send({ error: "not_found" });
    await emit(req, { eventId, action: "admin.action", resourceType: "prize", resourceId: row.id, detail: {} });
    return reply.code(204).send();
  });
}
