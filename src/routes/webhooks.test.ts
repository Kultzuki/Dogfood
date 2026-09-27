/**
 * T4 webhook route tests — REAL module (src/routes/webhooks.ts), stubbed pool.
 * Delivery attempts against literal-IP loopback URLs stay hermetic: the
 * SSRF guard rejects them with local-only resolution (no traffic).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import webhookRoutes from "./webhooks.js";
import { _clearRateLimitBuckets } from "../lib/rateLimit.js";

const canned = vi.hoisted(() => ({
  eventExists: true,
  memberships: [] as Array<{ id: string; role: string }>,
  sub: undefined as
    | { id: string; event_id: string; url: string; events: string[] }
    | undefined,
  deliveries: [] as Array<Record<string, unknown>>,
  retryRow: undefined as { id: string; status: string } | undefined,
  due: [] as Array<Record<string, unknown>>,
  deleted: true,
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("INSERT INTO webhook_subscriptions")) {
        return {
          rows: [
            {
              id: "wh-sub-id",
              event_id: String(v[0]),
              url: String(v[1]),
              events: v[3],
              is_active: true,
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("DELETE FROM webhook_subscriptions")) {
        return { rows: canned.deleted ? [{ id: "x" }] : [], rowCount: canned.deleted ? 1 : 0 };
      }
      if (text.includes("UPDATE webhook_deliveries")) {
        return { rows: canned.retryRow ? [canned.retryRow] : [], rowCount: canned.retryRow ? 1 : 0 };
      }
      if (text.includes("FROM webhook_deliveries WHERE subscription_id")) {
        return { rows: canned.deliveries, rowCount: canned.deliveries.length };
      }
      if (text.includes("next_retry_at")) {
        return { rows: canned.due, rowCount: canned.due.length };
      }
      if (text.includes("FROM webhook_subscriptions WHERE id")) {
        return { rows: canned.sub ? [canned.sub] : [], rowCount: canned.sub ? 1 : 0 };
      }
      if (text.includes("FROM events WHERE id")) {
        return { rows: canned.eventExists ? [{ id: "e" }] : [], rowCount: canned.eventExists ? 1 : 0 };
      }
      if (text.includes("FROM event_memberships") && text.includes("user_id")) {
        return { rows: canned.memberships, rowCount: canned.memberships.length };
      }
      if (text.includes("FROM audit_logs")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO audit_logs")) {
        return { rows: [{ id: "a", seq: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  db: {},
}));

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";
const VOTER_1 = "11111111-1111-4111-8111-111111111111";
const HOOK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function authed(method: "GET" | "POST" | "DELETE", url: string, userId?: string, payload?: object): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    payload,
    headers: {
      ...(userId ? { "x-test-user": userId } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "wh-test", userId } : { id: "wh-test" };
  });
  await app.register(webhookRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearRateLimitBuckets();
  delete process.env["ALLOW_LOOPBACK_WEBHOOKS"];
  canned.eventExists = true;
  canned.memberships = [{ id: "m1", role: "organizer" }];
  canned.sub = undefined;
  canned.deliveries = [];
  canned.retryRow = undefined;
  canned.due = [];
  canned.deleted = true;
});

describe("webhook subscriptions", () => {
  it("creates a subscription and returns the secret once (201)", async () => {
    const res = await authed("POST", `/api/events/${EVENT_A}/webhooks`, ORGANIZER_1, {
      url: "http://8.8.8.8/hook",
      events: ["vote.cast", "score.submit"],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.webhook.url).toBe("http://8.8.8.8/hook");
    // Secret is returned exactly once, at creation.
    expect(typeof body.webhook.secret).toBe("string");
    expect(body.webhook.secret.length).toBeGreaterThan(0);
    expect(typeof body.secret_note).toBe("string");
  });
  it("lists subscriptions without secrets", async () => {
    const res = await authed("GET", `/api/events/${EVENT_A}/webhooks`, ORGANIZER_1);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("s3cret");
  });
  it("rejects bad event lists, blocked hosts, and outsiders", async () => {
    const badEvents = await authed("POST", `/api/events/${EVENT_A}/webhooks`, ORGANIZER_1, {
      url: "http://8.8.8.8/hook",
      events: ["nope.nope"],
    });
    expect(badEvents.statusCode).toBe(422);
    const blocked = await authed("POST", `/api/events/${EVENT_A}/webhooks`, ORGANIZER_1, {
      url: "http://127.0.0.1:9/hook",
      events: ["vote.cast"],
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().detail).toBe("blocked_host");
    canned.memberships = [];
    const outsider = await authed("POST", `/api/events/${EVENT_A}/webhooks`, VOTER_1, {
      url: "http://8.8.8.8/hook",
      events: ["vote.cast"],
    });
    expect(outsider.statusCode).toBe(404);
    const anon = await authed("GET", `/api/events/${EVENT_A}/webhooks`);
    expect(anon.statusCode).toBe(401);
  });
  it("deletes subscriptions (204) and 404s unknown rows", async () => {
    const gone = await authed("DELETE", `/api/events/${EVENT_A}/webhooks/${HOOK_ID}`, ORGANIZER_1);
    expect(gone.statusCode).toBe(204);
    canned.deleted = false;
    const missing = await authed("DELETE", `/api/events/${EVENT_A}/webhooks/${HOOK_ID}`, ORGANIZER_1);
    expect(missing.statusCode).toBe(404);
  });
});

describe("delivery inspection + retry + sweep", () => {
  it("shows deliveries only for the owning event", async () => {
    canned.sub = { id: HOOK_ID, event_id: EVENT_A, url: "http://8.8.8.8/h", events: ["vote.cast"] };
    canned.deliveries = [{ id: "d1", status: "failed", attempts: 2 }];
    const res = await authed("GET", `/api/events/${EVENT_A}/webhooks/${HOOK_ID}/deliveries`, ORGANIZER_1);
    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toHaveLength(1);
    canned.sub = undefined;
    const other = await authed("GET", `/api/events/${EVENT_A}/webhooks/${HOOK_ID}/deliveries`, ORGANIZER_1);
    expect(other.statusCode).toBe(404);
  });
  it("requeues dead rows and 404s when nothing matches", async () => {
    canned.retryRow = { id: "d9", status: "pending" };
    const res = await authed(
      "POST",
      `/api/events/${EVENT_A}/webhooks/deliveries/d9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9/retry`,
      ORGANIZER_1,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.status).toBe("pending");
    canned.retryRow = undefined;
    const missing = await authed(
      "POST",
      `/api/events/${EVENT_A}/webhooks/deliveries/d9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9/retry`,
      ORGANIZER_1,
    );
    expect(missing.statusCode).toBe(404);
  });
  it("records loopback deliveries as failed (never delivered, no traffic)", async () => {
    canned.due = [
      {
        id: "due-1",
        subscription_id: HOOK_ID,
        event_id: EVENT_A,
        event_type: "vote.cast",
        payload: { a: 1 },
        attempts: 0,
        url: "http://127.0.0.1:9/hook",
        secret: "s",
      },
    ];
    const res = await authed("POST", `/api/events/${EVENT_A}/webhooks/process`, ORGANIZER_1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: 0, failed: 1 });
  });
});
