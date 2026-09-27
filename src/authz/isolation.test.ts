/**
 * T2.03 isolation matrix — runs on every commit (vitest, part of `npm test`).
 *
 * Exercises the REAL route modules (scores / audit / exports) plus the REAL
 * guard factories (requireEventRole / requireTrackScope / requireAssignment
 * status codes). Only the pg pool is stubbed (vi.mock of ../db/index.js),
 * so no database is required.
 *
 * Convention under test: 401 unauthenticated · 404 wrong-resource
 * (never 403 cross-event, never leaks existence) · 422 malformed id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import scoreRoutes from "../routes/scores.js";
import auditRoutes from "../routes/audit.js";
import exportRoutes from "../routes/exports.js";

// ── Canned pool state (per-test mutable) ─────────────────────────────

const canned = vi.hoisted(() => ({
  membershipByEvent: {} as Record<string, Array<{ id: string; role: string }>>,
  trackScopeByTrack: {} as Record<string, Array<{ id: string }>>,
  scoreRow: undefined as Record<string, unknown> | undefined,
  ctxRow: undefined as Record<string, unknown> | undefined,
  projectRow: undefined as Record<string, unknown> | undefined,
  projectScores: [] as Array<Record<string, unknown>>,
  eventExists: true,
  auditRows: [] as Array<Record<string, unknown>>,
  exportRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("FROM event_memberships") && text.includes("user_id")) {
        const rows = canned.membershipByEvent[String(v[1] ?? "")] ?? [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM event_memberships") && text.includes("track_id")) {
        const rows = canned.trackScopeByTrack[String(v[1] ?? "")] ?? [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM scores WHERE id")) {
        const rows = canned.scoreRow ? [canned.scoreRow] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM judge_assignments a JOIN projects")) {
        const rows = canned.ctxRow ? [canned.ctxRow] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM projects WHERE id")) {
        const rows = canned.projectRow ? [canned.projectRow] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM scores WHERE project_id")) {
        return { rows: canned.projectScores, rowCount: canned.projectScores.length };
      }
      if (text.includes("FROM events WHERE id")) {
        const rows = canned.eventExists ? [{ "?column?": 1 }] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM audit_logs")) {
        return { rows: canned.auditRows, rowCount: canned.auditRows.length };
      }
      if (text.includes("WHERE event_id = $1 ORDER BY")) {
        return { rows: canned.exportRows, rowCount: canned.exportRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async (): Promise<never> => {
      throw new Error("no-db-in-isolation-tests");
    },
  },
  db: {},
}));

// ── Fixture ids (valid UUIDv4 — guards reject anything else with 422) ──

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRACK_A = "11111111-1111-4111-8111-111111111111";
const TRACK_B = "22222222-2222-4222-8222-222222222222";
const SCORE_ID = "33333333-3333-4333-8333-333333333333";
const ASSIGN_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const JUDGE_1 = "66666666-6666-4666-8666-666666666666";
const JUDGE_2 = "77777777-7777-4777-8777-777777777777";
const PARTICIPANT_1 = "88888888-8888-4888-8888-888888888888";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";

const peerScore = (): Record<string, unknown> => ({
  id: SCORE_ID, assignment_id: ASSIGN_ID, event_id: EVENT_A,
  project_id: PROJECT_ID, judge_user_id: JUDGE_2, value: "85",
  version: 1, supersedes_id: null, is_current: true,
});

const assignCtx = (judgeId: string, track: string): Record<string, unknown> => ({
  id: ASSIGN_ID, event_id: EVENT_A, project_id: PROJECT_ID,
  judge_user_id: judgeId, track_id: track, status: "active",
  project_track: track,
});

// ── App + helpers ────────────────────────────────────────────────────

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function get(url: string, userId?: string): Promise<InjectResponse> {
  return app.inject({
    method: "GET",
    url,
    headers: userId ? { "x-test-user": userId } : {},
  });
}

/** Every isolation response must hide existence: 403 (or "forbidden") is a leak. */
function expectNoLeak(res: InjectResponse): void {
  expect(res.statusCode).not.toBe(403);
  expect(res.body).not.toMatch(/forbidden/i);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  // Test-only session seam: guards read req.session.userId for real.
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "isolation-test", userId } : { id: "isolation-test" };
  });
  await app.register(scoreRoutes);
  await app.register(auditRoutes);
  await app.register(exportRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.membershipByEvent = {};
  canned.trackScopeByTrack = { [TRACK_A]: [{ id: "m-judge-1" }] };
  canned.scoreRow = peerScore();
  canned.ctxRow = assignCtx(JUDGE_2, TRACK_A);
  canned.projectRow = { event_id: EVENT_A };
  canned.projectScores = [peerScore()];
  canned.eventExists = true;
  canned.auditRows = [{ id: "a1", seq: 1, event_id: EVENT_A, action: "score.submit" }];
  canned.exportRows = [{
    id: SCORE_ID, event_id: EVENT_A, project_id: PROJECT_ID,
    judge_user_id: JUDGE_2, value: "85", version: 1,
    is_current: true, created_at: "2026-01-01T00:00:00.000Z",
  }];
});

describe("T2.03 isolation matrix", () => {
  it("judge cannot read peer score → 404", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-judge-1", role: "judge" }];
    const res = await get(`/api/scores/${SCORE_ID}`, JUDGE_1);
    expect(res.statusCode).toBe(404);
    expectNoLeak(res);
  });

  it("track-scoped judge cannot read other-track resource → 404", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-judge-1", role: "judge" }];
    canned.scoreRow = { ...peerScore(), judge_user_id: JUDGE_1 };
    canned.ctxRow = assignCtx(JUDGE_1, TRACK_B);
    canned.trackScopeByTrack = {}; // scoped to TRACK_A only, not TRACK_B
    const res = await get(`/api/scores/${SCORE_ID}`, JUDGE_1);
    expect(res.statusCode).toBe(404);
    expectNoLeak(res);
  });

  it("participant cannot read any score → 404", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-part-1", role: "participant" }];
    const res = await get(`/api/scores/${SCORE_ID}`, PARTICIPANT_1);
    expect(res.statusCode).toBe(404);
    expectNoLeak(res);
  });

  it("organizer reads own-event scores, audit, and exports → 200-shape", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    const scores = await get(`/api/projects/${PROJECT_ID}/scores`, ORGANIZER_1);
    expect(scores.statusCode).toBe(200);
    expectNoLeak(scores);
    expect(Array.isArray((scores.json() as { scores?: unknown }).scores)).toBe(true);
    const audit = await get(`/api/events/${EVENT_A}/audit`, ORGANIZER_1);
    expect(audit.statusCode).toBe(200);
    expectNoLeak(audit);
    expect(Array.isArray(audit.json() as unknown[])).toBe(true);
    const exp = await get(`/api/events/${EVENT_A}/export?dataset=scores-raw`, ORGANIZER_1);
    expect(exp.statusCode).toBe(200);
    expectNoLeak(exp);
    expect(String(exp.headers["content-type"])).toContain("text/csv");
    expect(exp.body.length).toBeGreaterThan(0);
  });

  it("cross-event judge cannot reach other event → 404", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-judge-1", role: "judge" }];
    const res = await get(`/api/events/${EVENT_B}/export?dataset=scores-raw`, JUDGE_1);
    expect(res.statusCode).toBe(404);
    expectNoLeak(res);
  });

  it("unauthenticated requests → 401", async () => {
    const res = await get(`/api/scores/${SCORE_ID}`);
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error?: string }).error).toBe("unauthenticated");
    expectNoLeak(res);
  });

  it("malformed ids → 422", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-judge-1", role: "judge" }];
    const badScore = await get("/api/scores/not-a-uuid", JUDGE_1);
    expect(badScore.statusCode).toBe(422);
    expectNoLeak(badScore);
    const badEvent = await get("/api/events/not-a-uuid/audit", JUDGE_1);
    expect(badEvent.statusCode).toBe(422);
    expectNoLeak(badEvent);
  });
});
