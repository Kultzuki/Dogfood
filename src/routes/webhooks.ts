/**
 * T4 webhook subscriptions (organizer-only JSON API).
 *
 * Subscriptions are per-event: an event's triggers only fan out to that
 * event's active subscriptions. Secrets are write-only (returned once at
 * creation, never listed). Delivery state is inspectable per subscription;
 * dead rows are requeued explicitly — nothing redelivers silently.
 *
 * Convention: 401 unauthenticated · 404 isolation (never 403) ·
 * 422 invalid · 204 on delete.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/index.js";
import { requireEventRole } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";
import {
  WEBHOOK_EVENT_TYPES,
  newSubscriptionSecret,
  processDueDeliveries,
  validateWebhookUrl,
  type WebhookEventType,
} from "../lib/webhooks.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const resolveEventId = (req: FastifyRequest): string | undefined =>
  (req.params as { eventId?: unknown }).eventId as string | undefined;
const organizeEvent = requireEventRole(resolveEventId, "organizer");

interface SubscriptionRow {
  id: string;
  event_id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: unknown;
}

const outSubscription = (r: SubscriptionRow): Record<string, unknown> => ({
  id: r.id,
  event_id: r.event_id,
  url: r.url,
  events: r.events,
  is_active: r.is_active,
  created_at: r.created_at,
});

async function eventExists(db: PoolLike, eventId: string): Promise<boolean> {
  try {
    const r = await db.query(`SELECT 1 FROM events WHERE id = $1`, [eventId]);
    return (r.rows.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export default async function webhookRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ── List subscriptions (secrets never listed) ──────────────────────
  app.get(
    "/api/events/:eventId/webhooks",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const db = pool as unknown as PoolLike;
      if (!(await eventExists(db, eventId)))
        return reply.code(404).send({ error: "not_found" });
      const r = await db.query(
        `SELECT id, event_id, url, events, is_active, created_at
           FROM webhook_subscriptions WHERE event_id = $1 ORDER BY created_at`,
        [eventId],
      );
      return reply.send({
        webhooks: (r.rows as unknown as SubscriptionRow[]).map(outSubscription),
      });
    },
  );

  // ── Create subscription (secret returned once) ─────────────────────
  app.post(
    "/api/events/:eventId/webhooks",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const db = pool as unknown as PoolLike;
      if (!(await eventExists(db, eventId)))
        return reply.code(404).send({ error: "not_found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const url = typeof body["url"] === "string" ? body["url"] : "";
      const events = Array.isArray(body["events"])
        ? body["events"].filter((e): e is string => typeof e === "string")
        : [];
      const known = new Set<string>(WEBHOOK_EVENT_TYPES);
      if (
        events.length === 0 ||
        events.length > 10 ||
        !events.every((e) => known.has(e))
      )
        return reply.code(422).send({ error: "invalid_events" });
      const urlProblem = await validateWebhookUrl(url);
      if (urlProblem)
        return reply.code(422).send({ error: "invalid_url", detail: urlProblem });
      const secret =
        typeof body["secret"] === "string" && body["secret"].length >= 16
          ? body["secret"]
          : newSubscriptionSecret();
      const ins = await db.query(
        `INSERT INTO webhook_subscriptions (event_id, url, secret, events)
         VALUES ($1, $2, $3, $4) RETURNING id, event_id, url, events, is_active, created_at`,
        [eventId, url, secret, events],
      );
      const row = (ins.rows as unknown as SubscriptionRow[])[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      await emit(req, {
        eventId,
        action: "webhook.create",
        resourceType: "webhook",
        resourceId: row.id,
        detail: { url, events },
      });
      return reply.code(201).send({
        webhook: { ...outSubscription(row), secret },
        secret_note: "Store this secret now — it is never shown again.",
      });
    },
  );

  // ── Delete subscription (deliveries cascade) ───────────────────────
  app.delete(
    "/api/events/:eventId/webhooks/:webhookId",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId, webhookId } = req.params as {
        eventId: string;
        webhookId: string;
      };
      if (!UUID_RE.test(webhookId))
        return reply.code(422).send({ error: "invalid_id" });
      const db = pool as unknown as PoolLike;
      const r = await db.query(
        `DELETE FROM webhook_subscriptions WHERE id = $1 AND event_id = $2 RETURNING id`,
        [webhookId, eventId],
      );
      if ((r.rows.length ?? 0) === 0)
        return reply.code(404).send({ error: "not_found" });
      await emit(req, {
        eventId,
        action: "webhook.delete",
        resourceType: "webhook",
        resourceId: webhookId,
        detail: {},
      });
      return reply.code(204).send();
    },
  );

  // ── Inspect deliveries (operator view into failures) ───────────────
  app.get(
    "/api/events/:eventId/webhooks/:webhookId/deliveries",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId, webhookId } = req.params as {
        eventId: string;
        webhookId: string;
      };
      if (!UUID_RE.test(webhookId))
        return reply.code(422).send({ error: "invalid_id" });
      const db = pool as unknown as PoolLike;
      const sub = await db.query(
        `SELECT id FROM webhook_subscriptions WHERE id = $1 AND event_id = $2`,
        [webhookId, eventId],
      );
      if ((sub.rows.length ?? 0) === 0)
        return reply.code(404).send({ error: "not_found" });
      const r = await db.query(
        `SELECT id, event_type, status, attempts, next_retry_at, last_error,
                created_at, delivered_at
           FROM webhook_deliveries WHERE subscription_id = $1
           ORDER BY created_at DESC LIMIT 50`,
        [webhookId],
      );
      return reply.send({ deliveries: r.rows });
    },
  );

  // ── Requeue a dead/failed delivery ─────────────────────────────────
  app.post(
    "/api/events/:eventId/webhooks/deliveries/:deliveryId/retry",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId, deliveryId } = req.params as {
        eventId: string;
        deliveryId: string;
      };
      if (!UUID_RE.test(deliveryId))
        return reply.code(422).send({ error: "invalid_id" });
      const db = pool as unknown as PoolLike;
      const r = await db.query(
        `UPDATE webhook_deliveries d SET status = 'pending', next_retry_at = now()
          FROM webhook_subscriptions s
         WHERE d.id = $1 AND d.subscription_id = s.id AND s.event_id = $2
           AND d.status IN ('failed', 'dead')
         RETURNING d.id, d.status`,
        [deliveryId, eventId],
      );
      const row = (r.rows as unknown as Array<{ id: string; status: string }>)[0];
      if (!row) return reply.code(404).send({ error: "not_found" });
      return reply.send({ delivery: row });
    },
  );

  // ── Run the due-delivery sweep on demand (operators / tests) ───────
  app.post(
    "/api/events/:eventId/webhooks/process",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const db = pool as unknown as PoolLike;
      if (!(await eventExists(db, eventId)))
        return reply.code(404).send({ error: "not_found" });
      const out = await processDueDeliveries(db, 25);
      return reply.send(out);
    },
  );
}

export type { WebhookEventType };
