/**
 * T3 community voting + comments tests — REAL route modules
 * (src/routes/community.ts + src/routes/pages/community.ts) with only the
 * pg pool stubbed (vi.mock), so no database is required.
 *
 * Convention under test: 401 unauthenticated · 404 isolation/hidden
 * (never 403) · 409 duplicate vote · 422 invalid · 429 limited.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import communityRoutes, {
  ballotOrder,
  castVote,
  isVotingActive,
  validateCommentBody,
  COMMENT_MAX,
} from "./community.js";
import { registerCommunityPages } from "./pages/community.js";
import { _clearRateLimitBuckets } from "../lib/rateLimit.js";

// ── Canned pool state (per-test mutable) ─────────────────────────────

const canned = vi.hoisted(() => ({
  project: undefined as { id: string; event_id: string } | undefined,
  event: undefined as {
    id: string;
    voting_opens_at: string | null;
    voting_closes_at: string | null;
  } | undefined,
  windowActive: false,
  memberships: [] as Array<{ id: string; role: string }>,
  userRole: "participant",
  velocity: 0,
  voted: false,
  count: 0,
  duplicateNext: false,
  comments: [] as Array<{
    id: string;
    body: string;
    author: string;
    created_at: string;
  }>,
  ballotProjects: [] as Array<{ id: string; title: string }>,
  votedIds: [] as string[],
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("INSERT INTO community_votes")) {
        if (canned.duplicateNext) {
          canned.duplicateNext = false;
          throw { code: "23505" };
        }
        return {
          rows: [
            {
              id: "vote-row-id",
              event_id: String(v[0]),
              project_id: String(v[1]),
              user_id: String(v[2]),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("INTERVAL '1 hour'")) {
        return { rows: [{ n: canned.velocity }], rowCount: 1 };
      }
      if (text.includes("SELECT 1 FROM community_votes WHERE project_id")) {
        return { rows: canned.voted ? [{}] : [], rowCount: canned.voted ? 1 : 0 };
      }
      if (text.includes("SELECT project_id FROM community_votes WHERE event_id")) {
        return {
          rows: canned.votedIds.map((project_id) => ({ project_id })),
          rowCount: canned.votedIds.length,
        };
      }
      if (text.includes("FROM community_votes") && text.includes("GROUP BY")) {
        return {
          rows: [{ project_id: String(v[0]) , n: canned.count }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM community_votes")) {
        return { rows: [{ n: canned.count }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO project_comments")) {
        return {
          rows: [
            { id: "comment-row-id", body: String(v[3]), created_at: "2026-01-01T00:00:00.000Z" },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("FROM project_comments")) {
        return { rows: canned.comments, rowCount: canned.comments.length };
      }
      if (text.includes("UPDATE events SET voting_opens_at")) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("AS active")) {
        return {
          rows: [
            {
              voting_opens_at: canned.event?.voting_opens_at ?? null,
              voting_closes_at: canned.event?.voting_closes_at ?? null,
              active: canned.windowActive,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("FROM projects") && text.includes("status = 'submitted'")) {
        if (text.includes("WHERE event_id")) {
          return { rows: canned.ballotProjects, rowCount: canned.ballotProjects.length };
        }
        return { rows: canned.project ? [canned.project] : [], rowCount: canned.project ? 1 : 0 };
      }
      if (text.includes("FROM events WHERE id")) {
        return { rows: canned.event ? [canned.event] : [], rowCount: canned.event ? 1 : 0 };
      }
      if (text.includes("FROM event_memberships") && text.includes("user_id")) {
        return { rows: canned.memberships, rowCount: canned.memberships.length };
      }
      if (text.includes("SELECT role FROM users WHERE id")) {
        return { rows: [{ role: canned.userRole }], rowCount: 1 };
      }
      if (text.includes("FROM audit_logs")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO audit_logs")) {
        return {
          rows: [{ id: "audit-row", seq: 1, hash: "h", prev_hash: "GENESIS" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  db: {},
}));

// ── Fixture ids (UUID-shaped; guards reject anything else with 422) ──

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_A = "55555555-5555-4555-8555-555555555555";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VOTER_1 = "11111111-1111-4111-8111-111111111111";
const VOTER_2 = "22222222-2222-4222-8222-222222222222";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";

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

function post(
  url: string,
  payload: object,
  userId?: string,
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url,
    payload,
    headers: userId ? { "x-test-user": userId } : {},
  });
}

function windowFor(opens: string | null, closes: string | null): void {
  canned.event = { id: EVENT_A, voting_opens_at: opens, voting_closes_at: closes };
  canned.windowActive =
    opens !== null &&
    Date.parse(opens) <= Date.now() &&
    (closes === null || Date.now() < Date.parse(closes));
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId =
      typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "community-test", userId } : { id: "community-test" };
  });
  // No template engine in tests: stub reply.view as JSON so page routes
  // can be exercised for status codes, redirects, and rendered data.
  void app.decorateReply("view", function (template: string, data: unknown) {
    return (this as any).code(200).send({ template, data });
  });
  await app.register(communityRoutes);
  await app.register(registerCommunityPages);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearRateLimitBuckets();
  canned.project = { id: PROJECT_A, event_id: EVENT_A };
  canned.event = { id: EVENT_A, voting_opens_at: null, voting_closes_at: null };
  canned.windowActive = false;
  canned.memberships = [];
  canned.userRole = "participant";
  canned.velocity = 0;
  canned.voted = false;
  canned.count = 0;
  canned.duplicateNext = false;
  canned.comments = [];
  canned.ballotProjects = [];
  canned.votedIds = [];
});

// ── Pure helpers ─────────────────────────────────────────────────────

describe("voting window predicate", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  it("is never active without an opening time", () => {
    expect(isVotingActive(null, null, now)).toBe(false);
    expect(isVotingActive(undefined, null, now)).toBe(false);
  });
  it("opens at opens_at and closes at closes_at (half-open)", () => {
    expect(
      isVotingActive("2026-06-01T12:00:00.000Z", "2026-06-02T12:00:00.000Z", now),
    ).toBe(true);
    expect(
      isVotingActive("2026-06-01T12:00:01.000Z", "2026-06-02T12:00:00.000Z", now),
    ).toBe(false);
    expect(
      isVotingActive("2026-05-01T12:00:00.000Z", "2026-06-01T12:00:00.000Z", now),
    ).toBe(false);
  });
  it("stays open with no close and rejects garbage", () => {
    expect(isVotingActive("2026-05-01T12:00:00.000Z", null, now)).toBe(true);
    expect(isVotingActive("not-a-date", null, now)).toBe(false);
    expect(isVotingActive("2026-05-01T12:00:00.000Z", "garbage", now)).toBe(false);
  });
});

describe("ballot ordering", () => {
  const ids = [PROJECT_A, PROJECT_B, PROJECT_C];
  it("is deterministic and a full permutation", () => {
    const a = ballotOrder(VOTER_1, ids);
    expect(ballotOrder(VOTER_1, ids)).toEqual(a);
    expect([...a].sort()).toEqual([...ids].sort());
  });
  it("differs per voter (uncorrelated ballots)", () => {
    expect(ballotOrder(VOTER_1, ids)).not.toEqual(ballotOrder(VOTER_2, ids));
  });
  it("does not mutate its input", () => {
    const input = [...ids];
    ballotOrder(VOTER_1, input);
    expect(input).toEqual(ids);
  });
});

describe("comment validation", () => {
  it("accepts plain text within the limit", () => {
    expect(validateCommentBody("Nice work!")).toBe(null);
    expect(validateCommentBody("x".repeat(COMMENT_MAX))).toBe(null);
  });
  it("rejects empty, overlong, and non-text bodies", () => {
    expect(validateCommentBody("")).not.toBe(null);
    expect(validateCommentBody("   ")).not.toBe(null);
    expect(validateCommentBody("x".repeat(COMMENT_MAX + 1))).not.toBe(null);
    expect(validateCommentBody(null)).not.toBe(null);
    expect(validateCommentBody(42)).not.toBe(null);
  });
});

// ── Vote API ─────────────────────────────────────────────────────────

describe("POST /api/projects/:id/vote", () => {
  it("records a valid vote (201)", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    const res = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
    expect(res.statusCode).toBe(201);
    expect(res.json().vote.project_id).toBe(PROJECT_A);
  });
  it("rejects unauthenticated votes (401)", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    const res = await post(`/api/projects/${PROJECT_A}/vote`, {});
    expect(res.statusCode).toBe(401);
  });
  it("rejects malformed ids (422) and unknown projects (404)", async () => {
    const bad = await post(`/api/projects/not-a-uuid/vote`, {}, VOTER_1);
    expect(bad.statusCode).toBe(422);
    canned.project = undefined;
    const missing = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
    expect(missing.statusCode).toBe(404);
  });
  it("refuses votes outside the window (422 voting_closed)", async () => {
    windowFor(null, null);
    const never = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
    expect(never.statusCode).toBe(422);
    expect(never.json().error).toBe("voting_closed");
    windowFor("2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z");
    const over = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
    expect(over.statusCode).toBe(422);
  });
  it("rejects duplicate votes (409)", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    canned.duplicateNext = true;
    const res = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("duplicate_vote");
  });
  it("rejects excessive per-user velocity (429)", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    canned.velocity = 101;
    const res = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
    expect(res.statusCode).toBe(429);
  });
  it("rate-limits burst voting (429 rate_limited)", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const res = await post(`/api/projects/${PROJECT_A}/vote`, {}, VOTER_1);
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});

// ── Hidden results ───────────────────────────────────────────────────

describe("GET /api/projects/:id/votes", () => {
  it("hides counts from non-organizers while voting is active (404)", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    const res = await get(`/api/projects/${PROJECT_A}/votes`, VOTER_1);
    expect(res.statusCode).toBe(404);
  });
  it("shows counts to organizers while voting is active", async () => {
    windowFor("2020-01-01T00:00:00.000Z", null);
    canned.memberships = [{ id: "m1", role: "organizer" }];
    canned.count = 7;
    const res = await get(`/api/projects/${PROJECT_A}/votes`, ORGANIZER_1);
    expect(res.statusCode).toBe(200);
    expect(res.json().votes).toBe(7);
  });
  it("shows counts publicly once the window closes", async () => {
    windowFor("2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z");
    canned.count = 3;
    const res = await get(`/api/projects/${PROJECT_A}/votes`);
    expect(res.statusCode).toBe(200);
    expect(res.json().votes).toBe(3);
  });
});

// ── Comments ─────────────────────────────────────────────────────────

describe("project comments", () => {
  it("creates a comment for authenticated users (201)", async () => {
    const res = await post(
      `/api/projects/${PROJECT_A}/comments`,
      { body: "Great demo!" },
      VOTER_1,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().comment.body).toBe("Great demo!");
  });
  it("rejects unauthenticated posting (401)", async () => {
    const res = await post(`/api/projects/${PROJECT_A}/comments`, {
      body: "hi",
    });
    expect(res.statusCode).toBe(401);
  });
  it("validates bodies (422) and unknown projects (404)", async () => {
    const empty = await post(
      `/api/projects/${PROJECT_A}/comments`,
      { body: "  " },
      VOTER_1,
    );
    expect(empty.statusCode).toBe(422);
    const long = await post(
      `/api/projects/${PROJECT_A}/comments`,
      { body: "x".repeat(COMMENT_MAX + 1) },
      VOTER_1,
    );
    expect(long.statusCode).toBe(422);
    canned.project = undefined;
    const missing = await post(
      `/api/projects/${PROJECT_A}/comments`,
      { body: "hi" },
      VOTER_1,
    );
    expect(missing.statusCode).toBe(404);
  });
  it("lists comments publicly in chronological order", async () => {
    canned.comments = [
      { id: "c1", body: "First", author: "Ada", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "c2", body: "Second", author: "Bob", created_at: "2026-01-02T00:00:00.000Z" },
    ];
    const res = await get(`/api/projects/${PROJECT_A}/comments`);
    expect(res.statusCode).toBe(200);
    expect(res.json().comments.map((c: { body: string }) => c.body)).toEqual([
      "First",
      "Second",
    ]);
  });
});

// ── Voting window config ─────────────────────────────────────────────

describe("POST /api/events/:id/voting-window", () => {
  it("lets organizers open a window", async () => {
    canned.memberships = [{ id: "m1", role: "organizer" }];
    const res = await post(
      `/api/events/${EVENT_A}/voting-window`,
      { opens_at: "2026-01-01T00:00:00.000Z", closes_at: null },
      ORGANIZER_1,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().voting.opens_at).toBe("2026-01-01T00:00:00.000Z");
  });
  it("rejects non-organizers (404) and bad windows (422)", async () => {
    const outsider = await post(
      `/api/events/${EVENT_A}/voting-window`,
      { opens_at: "2026-01-01T00:00:00.000Z" },
      VOTER_1,
    );
    expect(outsider.statusCode).toBe(404);
    canned.memberships = [{ id: "m1", role: "organizer" }];
    const bad = await post(
      `/api/events/${EVENT_A}/voting-window`,
      { opens_at: "2026-02-01T00:00:00.000Z", closes_at: "2026-01-01T00:00:00.000Z" },
      ORGANIZER_1,
    );
    expect(bad.statusCode).toBe(422);
    const garbage = await post(
      `/api/events/${EVENT_A}/voting-window`,
      { opens_at: "not-a-date" },
      ORGANIZER_1,
    );
    expect(garbage.statusCode).toBe(422);
  });
});

// ── Ballot page ──────────────────────────────────────────────────────

describe("GET /events/:id/ballot", () => {
  it("renders every eligible project in a stable order", async () => {
    canned.event = {
      id: EVENT_A,
      voting_opens_at: "2020-01-01T00:00:00.000Z",
      voting_closes_at: null,
    };
    canned.ballotProjects = [
      { id: PROJECT_A, title: "Alpha" },
      { id: PROJECT_B, title: "Beta" },
      { id: PROJECT_C, title: "Gamma" },
    ];
    const first = await get(`/events/${EVENT_A}/ballot`, VOTER_1);
    const second = await get(`/events/${EVENT_A}/ballot`, VOTER_1);
    expect(first.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      expect(first.body).toContain(title);
    }
  });
  it("requires authentication (401)", async () => {
    const res = await get(`/events/${EVENT_A}/ballot`);
    expect(res.statusCode).toBe(401);
  });
  it("records votes from the ballot form (302 PRG)", async () => {
    canned.event = {
      id: EVENT_A,
      voting_opens_at: "2020-01-01T00:00:00.000Z",
      voting_closes_at: null,
    };
    const res = await post(
      `/events/${EVENT_A}/ballot`,
      { project_id: PROJECT_A },
      VOTER_1,
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/events/${EVENT_A}/ballot`);
  });
});

// ── Shared mutation ──────────────────────────────────────────────────

describe("castVote", () => {
  it("returns structured errors without a server", async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    expect(await castVote(db, VOTER_1, "nope")).toEqual({
      ok: false,
      error: "invalid_project_id",
    });
  });
});
