/**
 * T4 webhook outbox: SSRF-guarded, HMAC-signed, at-least-once delivery.
 *
 * Flow: route handlers call recordWebhookEvents() (one INSERT per matching
 * subscription — cheap, transactional, never throws outward). Delivery is
 * attempted by processDueDeliveries(), which handlers invoke best-effort
 * right after recording (piggyback, capped) plus an organizer-facing retry
 * endpoint for dead rows. No timers, no event bus.
 *
 * Reliability contract: at-least-once per delivery row. Receivers
 * deduplicate on the `X-Dogfood-Delivery` id. Backoff: 5m, 10m, 20m, 40m,
 * 80m; after 5 attempts the row goes `dead` (operator retries explicitly).
 *
 * SSRF posture (fail-closed): http(s) only, no credentials in URL, hostname
 * must DNS-resolve and every resolved address must avoid loopback, RFC1918,
 * link-local, and unspecified ranges. Redirects are NOT followed (3xx =
 * failure, recorded + retried). Set ALLOW_LOOPBACK_WEBHOOKS=1 only for
 * local development/testing — never in production.
 */
import { lookup } from "node:dns/promises";
import { createHmac, randomBytes } from "node:crypto";
import type { PoolLike } from "./audit.js";

export const WEBHOOK_EVENT_TYPES = [
  "vote.cast",
  "comment.create",
  "score.submit",
  "project.submitted",
  "certificate.issued",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_TIMEOUT_MS = 8000;
const RETRY_BASE_MS = 5 * 60 * 1000;

export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

export function newSubscriptionSecret(): string {
  return randomBytes(32).toString("hex");
}

/** HMAC-SHA256 hex signature over the exact delivery body. */
export function signDeliveryBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

// ── SSRF guard (pure pieces unit-tested) ────────────────────────────

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // unspecified
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fe80:")) return true; // link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
  if (low.startsWith("::ffff:")) {
    const mapped = low.slice("::ffff:".length);
    if (mapped.includes(".")) return ipv4Blocked(mapped);
    return true;
  }
  return false;
}

export function isBlockedIp(ip: string): boolean {
  return ip.includes(":") ? ipv6Blocked(ip) : ipv4Blocked(ip);
}

/** Fail-closed URL validation: returns an error code or null when allowed. */
export async function validateWebhookUrl(raw: string): Promise<string | null> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000)
    return "invalid_url";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid_url";
  if (url.username !== "" || url.password !== "") return "invalid_url";
  if (process.env["ALLOW_LOOPBACK_WEBHOOKS"] === "1") return null;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    return "unresolvable_host";
  }
  if (addresses.length === 0) return "unresolvable_host";
  if (addresses.some((a) => isBlockedIp(a.address))) return "blocked_host";
  return null;
}

// ── Outbox ──────────────────────────────────────────────────────────

export interface WebhookEvent {
  type: WebhookEventType;
  eventId: string;
  data: Record<string, unknown>;
}

/**
 * Insert one pending delivery row per active subscription matching the
 * event. Never throws outward — delivery must not break scoring/voting.
 */
export async function recordWebhookEvents(
  db: PoolLike,
  events: WebhookEvent | WebhookEvent[],
): Promise<number> {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return 0;
  let recorded = 0;
  try {
    for (const ev of list) {
      const subs = await db.query(
        `SELECT id FROM webhook_subscriptions
          WHERE event_id = $1 AND is_active = true AND $2 = ANY (events)`,
        [ev.eventId, ev.type],
      );
      for (const sub of subs.rows as Array<{ id: string }>) {
        await db.query(
          `INSERT INTO webhook_deliveries
             (subscription_id, event_id, event_type, payload)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            sub.id,
            ev.eventId,
            ev.type,
            JSON.stringify({
              event_id: ev.eventId,
              type: ev.type,
              occurred_at: new Date().toISOString(),
              data: ev.data,
            }),
          ],
        );
        recorded += 1;
      }
    }
  } catch {
    // Outbox best-effort: a missing table or DB blip never fails the trigger.
  }
  return recorded;
}

export interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
}

/** Exported for regression tests — selects pending runs and due failed retries. */
export async function dueDeliveries(db: PoolLike, limit: number): Promise<DeliveryRow[]> {
  const r = await db.query(
    `SELECT d.id, d.subscription_id, d.event_id, d.event_type, d.payload,
            d.attempts, s.url, s.secret
        FROM webhook_deliveries d
        JOIN webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.status IN ('pending', 'failed') AND d.next_retry_at <= now()
       ORDER BY d.created_at ASC LIMIT $1`,
    [limit],
  );
  return r.rows as unknown as DeliveryRow[];
}

async function markDelivered(db: PoolLike, id: string): Promise<void> {
  await db.query(
    `UPDATE webhook_deliveries
        SET status = 'delivered', delivered_at = now(), last_error = NULL
      WHERE id = $1`,
    [id],
  );
}

export async function markFailed(db: PoolLike, id: string, attempts: number, err: string): Promise<void> {
  const next = attempts + 1;
  if (next >= MAX_DELIVERY_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries
          SET status = 'dead', attempts = $2, last_error = $3
        WHERE id = $1`,
      [id, next, err],
    );
    return;
  }
  await db.query(
    `UPDATE webhook_deliveries
        SET status = 'failed', attempts = $2, last_error = $3,
            next_retry_at = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [id, next, err, retryDelayMs(next) / 1000],
  );
}

async function attemptDelivery(row: DeliveryRow): Promise<string | null> {
  const problem = await validateWebhookUrl(row.url);
  if (problem) return `url_rejected:${problem}`;
  const body = JSON.stringify({
    delivery_id: row.id,
    ...(row.payload as Record<string, unknown>),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dogfood-event": row.event_type,
        "x-dogfood-delivery": row.id,
        "x-dogfood-signature-256": `sha256=${signDeliveryBody(row.secret, body)}`,
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) return null;
    return `http_${res.status}`;
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    return name === "AbortError" ? "timeout" : `fetch_${name}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Process due deliveries (cap per call). Returns {delivered, failed}.
 * Throws outward only on outbox read errors — callers wrap best-effort.
 */
export async function processDueDeliveries(
  db: PoolLike,
  limit = 10,
): Promise<{ delivered: number; failed: number }> {
  const out = { delivered: 0, failed: 0 };
  const due = await dueDeliveries(db, limit);
  for (const row of due) {
    const err = await attemptDelivery(row);
    if (err === null) {
      await markDelivered(db, row.id);
      out.delivered += 1;
    } else {
      await markFailed(db, row.id, row.attempts, err);
      out.failed += 1;
    }
  }
  return out;
}

/** Fire-and-forget sweep for request piggybacking (never rejects). */
export function sweepDueDeliveries(db: PoolLike, limit = 10): void {
  void processDueDeliveries(db, limit).catch(() => {
    // Delivery failures are recorded per-row; nothing to do here.
  });
}

/**
 * Record + opportunistically deliver. Awaits only the outbox INSERTs
 * (one indexed lookup + N inserts); network delivery stays fire-and-forget
 * via the sweep, plus the operator process endpoint. Never throws — call
 * sites place this after their primary mutation + audit emit.
 */
export async function fanoutWebhooks(
  db: PoolLike,
  event: WebhookEvent | WebhookEvent[],
): Promise<void> {
  try {
    const recorded = await recordWebhookEvents(db, event);
    if (recorded > 0) sweepDueDeliveries(db);
  } catch {
    // Webhooks never break scoring, voting, or submissions.
  }
}
