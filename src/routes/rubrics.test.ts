/**
 * Rubric versioning tests — REAL route module (registerRubricRoutes) plus
 * pure validators. Only the pg pool is stubbed (vi.mock of ../db/index.js),
 * so no database is required.
 *
 * Convention under test: 401 unauthenticated · 404 wrong-resource
 * (organizer-only writes, never 403) · 422 malformed id / invalid weights.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerRubricRoutes,
  validateWeights,
  nextRubricVersion,
  compositeFor,
  DEFAULT_WEIGHTS,
} from "./rubrics.js";

// ── Canned pool state (per-test mutable) ─────────────────────────────

const canned = vi.hoisted(() => ({
  membershipByEvent: {} as Record<string, Array<{ id: string; role: string }>>,
  eventExists: true,
  activeRubric: undefined as { version: number; weights: unknown } | undefined,
  maxVersion: 0,
  seenTxn: [] as string[],
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("FROM event_memberships") && text.includes("user_id")) {
        const rows = canned.membershipByEvent[String(v[1] ?? "")] ?? [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM events WHERE id")) {
        const rows = canned.eventExists ? [{ "?column?": 1 }] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM rubric_versions") && text.includes("is_active")) {
        const rows = canned.activeRubric ? [canned.activeRubric] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        const v = (values ?? []) as unknown[];
        canned.seenTxn.push(text);
        if (text.includes("COALESCE(MAX(version)")) {
          return { rows: [{ max_version: canned.maxVersion }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO rubric_versions")) {
          const row = {
            id: "rubric-row-id",
            event_id: String(v[0]),
            version: Number(v[1]),
            weights: typeof v[2] === "string" ? JSON.parse(v[2] as string) : v[2],
            is_active: true,
            created_by: String(v[3]),
            created_at: "2026-01-01T00:00:00.000Z",
          };
          canned.maxVersion = row.version;
          return { rows: [row], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: (): void => undefined,
    }),
  },
  db: {},
}));

// ── Fixture ids (valid UUIDv4 — guards reject anything else with 422) ──

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";
const JUDGE_1 = "66666666-6666-4666-8666-666666666666";

// ── App + helpers ────────────────────────────────────────────────────

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function get(url: string, userId?: string): Promise<InjectResponse> {
  return app.inject({ method: "GET", url, headers: userId ? { "x-test-user": userId } : {} });
}

function post(url: string, payload: object, userId?: string): Promise<InjectResponse> {
  return app.inject({
    method: "POST", url, payload,
    headers: userId ? { "x-test-user": userId } : {},
  });
}

/** Every response must hide existence: 403 (or "forbidden") is a leak. */
function expectNoLeak(res: InjectResponse): void {
  expect(res.statusCode).not.toBe(403);
  expect(res.body).not.toMatch(/forbidden/i);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "rubric-test", userId } : { id: "rubric-test" };
  });
  await app.register(registerRubricRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.membershipByEvent = {};
  canned.eventExists = true;
  canned.activeRubric = { version: 2, weights: { technical: 40, innovation: 20, impact: 20, polish: 20 } };
  canned.maxVersion = 2;
  canned.seenTxn = [];
});

describe("rubric weight validation", () => {
  it("accepts exact keys summing to 100", () => {
    const r = validateWeights({ technical: 40, innovation: 20, impact: 20, polish: 20 });
    expect(r.ok).toBe(true);
  });

  it("rejects wrong sum, missing/extra keys, out-of-range, non-finite", () => {
    expect(validateWeights({ technical: 30, innovation: 25, impact: 25, polish: 10 }).ok).toBe(false);
    expect(validateWeights({ technical: 50, innovation: 25, impact: 25 }).ok).toBe(false);
    expect(validateWeights({ technical: 30, innovation: 25, impact: 25, polish: 20, extra: 0 }).ok).toBe(false);
    expect(validateWeights({ technical: 101, innovation: 0, impact: 0, polish: -1 }).ok).toBe(false);
    expect(validateWeights({ technical: "30", innovation: 25, impact: 25, polish: 20 }).ok).toBe(false);
    expect(validateWeights(null).ok).toBe(false);
  });

  it("increments versions from max (null → 1)", () => {
    expect(nextRubricVersion(null)).toBe(1);
    expect(nextRubricVersion(0)).toBe(1);
    expect(nextRubricVersion(2)).toBe(3);
  });

  it("default composite matches the legacy hardcoded weights", () => {
    const criteria = { technical: 80, innovation: 70, impact: 60, polish: 50 };
    expect(compositeFor(DEFAULT_WEIGHTS, criteria)).toBe(66.5);
  });
});

describe("rubric routes", () => {
  it("member reads the active version → 200-shape", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-judge-1", role: "judge" }];
    const res = await get(`/api/events/${EVENT_A}/rubric`, JUDGE_1);
    expect(res.statusCode).toBe(200);
    expectNoLeak(res);
    expect(res.json()).toEqual({
      event_id: EVENT_A, version: 2,
      weights: { technical: 40, innovation: 20, impact: 20, polish: 20 },
      is_active: true,
    });
  });

  it("falls back to defaults when no rubric row exists → 200", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    canned.activeRubric = undefined;
    const res = await get(`/api/events/${EVENT_A}/rubric`, ORGANIZER_1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      event_id: EVENT_A, version: 1, weights: { ...DEFAULT_WEIGHTS }, is_active: true,
    });
  });

  it("organizer publishes max+1 and deactivates previous in one txn → 201", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    const res = await post(
      `/api/events/${EVENT_A}/rubrics`,
      { weights: { technical: 40, innovation: 20, impact: 20, polish: 20 } },
      ORGANIZER_1,
    );
    expect(res.statusCode).toBe(201);
    expectNoLeak(res);
    const body = res.json() as { version: number; weights: unknown };
    expect(body.version).toBe(3);
    expect(body.weights).toEqual({ technical: 40, innovation: 20, impact: 20, polish: 20 });
    expect(canned.seenTxn.some((t) => t.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(canned.seenTxn.some((t) => t.includes("SET is_active = false"))).toBe(true);
    expect(canned.seenTxn).toContain("COMMIT");
  });

  it("rejects bad weights → 422", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    for (const weights of [
      { technical: 30, innovation: 25, impact: 25, polish: 10 },
      { technical: 50, innovation: 25, impact: 25 },
      { technical: 30, innovation: 25, impact: 25, polish: 20, extra: 0 },
      { technical: -1, innovation: 25, impact: 25, polish: 51 },
    ]) {
      const res = await post(`/api/events/${EVENT_A}/rubrics`, { weights }, ORGANIZER_1);
      expect(res.statusCode).toBe(422);
      expectNoLeak(res);
    }
  });

  it("non-organizer write → 404, unauthenticated → 401, malformed → 422", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-judge-1", role: "judge" }];
    const forbidden = await post(
      `/api/events/${EVENT_A}/rubrics`,
      { weights: { ...DEFAULT_WEIGHTS } },
      JUDGE_1,
    );
    expect(forbidden.statusCode).toBe(404);
    expectNoLeak(forbidden);
    const anon = await get(`/api/events/${EVENT_A}/rubric`);
    expect(anon.statusCode).toBe(401);
    expectNoLeak(anon);
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    const bad = await get("/api/events/not-a-uuid/rubric", ORGANIZER_1);
    expect(bad.statusCode).toBe(422);
    expectNoLeak(bad);
  });
});
