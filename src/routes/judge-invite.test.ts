/**
 * Judge-invitation workflow regression tests — REAL route module
 * (src/routes/scores.ts) with only the pg pool stubbed (vi.mock), so no
 * database is required.
 *
 * Covers: POST /api/events/:eventId/judges (organizer-only invite by user id
 * or email) and the POST /api/assignments auto-membership bridge that keeps
 * the judge queue (GET /events/:eventId/judge) and GET /api/assignments/mine
 * usable on fresh events.
 *
 * Convention under test: 401 unauthenticated · 404 isolation (never 403) ·
 * 409 already_member/assignment_exists · 422 invalid.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import scoreRoutes, {
  isJudgeSystemRole,
  parseJudgeInviteBody,
} from "./scores.js";

// ── Canned pool state (per-test mutable) ─────────────────────────────

const canned = vi.hoisted(() => ({
  membershipByEvent: {} as Record<string, Array<{ id: string; role: string }>>,
  usersById: {} as Record<string, { id: string; role: string }>,
  usersByEmail: {} as Record<string, { id: string; role: string }>,
  eventExists: true,
  trackValid: true,
  existingMembership: undefined as { role: string } | undefined,
  membershipRow: undefined as Record<string, unknown> | undefined,
  projectRow: undefined as Record<string, unknown> | undefined,
  assignmentRow: undefined as Record<string, unknown> | undefined,
  duplicateMembershipNext: false,
  duplicateAssignmentNext: false,
  inserts: [] as string[],
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("INSERT INTO event_memberships")) {
        canned.inserts.push("membership");
        if (text.includes("ON CONFLICT (event_id, user_id) DO NOTHING")) {
          return { rows: [], rowCount: 0 };
        }
        if (canned.duplicateMembershipNext) {
          canned.duplicateMembershipNext = false;
          throw { code: "23505" };
        }
        const row = canned.membershipRow ?? {
          id: "membership-row-id",
          event_id: String(v[0]),
          user_id: String(v[1]),
          role: "judge",
          track_id: (v[2] as string | null) ?? null,
        };
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes("INSERT INTO judge_assignments")) {
        canned.inserts.push("assignment");
        if (canned.duplicateAssignmentNext) {
          canned.duplicateAssignmentNext = false;
          throw { code: "23505" };
        }
        const row = canned.assignmentRow ?? {
          id: "assignment-row-id",
          event_id: String(v[0]),
          project_id: String(v[1]),
          judge_user_id: String(v[2]),
          track_id: (v[3] as string | null) ?? null,
          status: "active",
        };
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes("SELECT id, role FROM event_memberships")) {
        const rows = canned.membershipByEvent[String(v[1] ?? "")] ?? [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("SELECT role FROM event_memberships")) {
        const rows = canned.existingMembership ? [canned.existingMembership] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM users WHERE id")) {
        const row = canned.usersById[String(v[0] ?? "")];
        const rows = row ? [row] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM users WHERE email")) {
        const row = canned.usersByEmail[String(v[0] ?? "")];
        const rows = row ? [row] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM events WHERE id")) {
        return { rows: canned.eventExists ? [{ "?column?": 1 }] : [], rowCount: canned.eventExists ? 1 : 0 };
      }
      if (text.includes("FROM tracks WHERE id")) {
        return { rows: canned.trackValid ? [{ "?column?": 1 }] : [], rowCount: canned.trackValid ? 1 : 0 };
      }
      if (text.includes("FROM projects WHERE id")) {
        const rows = canned.projectRow ? [canned.projectRow] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM audit_logs") || text.includes("INSERT INTO audit_logs")) {
        return { rows: [{ id: "audit-row", hash: "h" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async (): Promise<never> => {
      throw new Error("no-db-in-judge-invite-tests");
    },
  },
  db: {},
}));

// ── Fixture ids (valid UUIDv4 — guards reject anything else with 422) ──

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRACK_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const JUDGE_1 = "66666666-6666-4666-8666-666666666666";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";
const PARTICIPANT_1 = "88888888-8888-4888-8888-888888888888";
const JUDGE_EMAIL = "judge.one@dogfood.local";

// ── App + helpers ────────────────────────────────────────────────────

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function post(url: string, payload: object, userId?: string): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url,
    payload,
    headers: userId ? { "x-test-user": userId } : {},
  });
}

function expectNoLeak(res: InjectResponse): void {
  expect(res.statusCode).not.toBe(403);
  expect(res.body).not.toMatch(/forbidden/i);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "judge-invite-test", userId } : { id: "judge-invite-test" };
  });
  await app.register(scoreRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.membershipByEvent = {};
  canned.usersById = {};
  canned.usersByEmail = {};
  canned.eventExists = true;
  canned.trackValid = true;
  canned.existingMembership = undefined;
  canned.membershipRow = undefined;
  canned.projectRow = { event_id: EVENT_A };
  canned.assignmentRow = undefined;
  canned.duplicateMembershipNext = false;
  canned.duplicateAssignmentNext = false;
  canned.inserts = [];
});

const organizerIn = (event = EVENT_A): void => {
  canned.membershipByEvent[event] = [{ id: "m-org-1", role: "organizer" }];
};

// ── Validation helpers ───────────────────────────────────────────────

describe("parseJudgeInviteBody", () => {
  it("accepts user_id, judge_user_id, and email forms", () => {
    expect(parseJudgeInviteBody({ user_id: JUDGE_1 }).input?.userId).toBe(JUDGE_1);
    expect(parseJudgeInviteBody({ judge_user_id: JUDGE_1 }).input?.userId).toBe(JUDGE_1);
    expect(parseJudgeInviteBody({ email: JUDGE_EMAIL }).input?.email).toBe(JUDGE_EMAIL);
  });

  it("accepts an optional track_id", () => {
    const parsed = parseJudgeInviteBody({ user_id: JUDGE_1, track_id: TRACK_A });
    expect(parsed.input?.trackId).toBe(TRACK_A);
  });

  it("rejects missing, malformed, and bad-track bodies", () => {
    expect(parseJudgeInviteBody({}).error).toBe("missing_judge");
    expect(parseJudgeInviteBody({ user_id: "nope" }).error).toBe("malformed_judge_id");
    expect(parseJudgeInviteBody({ email: "not-an-email" }).error).toBe("malformed_email");
    expect(parseJudgeInviteBody({ user_id: JUDGE_1, track_id: "bad" }).error).toBe("malformed_track_id");
  });

  it("prefers user_id over email when both are present", () => {
    const parsed = parseJudgeInviteBody({ user_id: JUDGE_1, email: JUDGE_EMAIL });
    expect(parsed.input?.userId).toBe(JUDGE_1);
    expect(parsed.input?.email).toBeUndefined();
  });
});

describe("isJudgeSystemRole", () => {
  it("allows judge/organizer/admin and rejects participant", () => {
    expect(isJudgeSystemRole("judge")).toBe(true);
    expect(isJudgeSystemRole("organizer")).toBe(true);
    expect(isJudgeSystemRole("admin")).toBe(true);
    expect(isJudgeSystemRole("participant")).toBe(false);
    expect(isJudgeSystemRole(undefined)).toBe(false);
  });
});

// ── Invite route ─────────────────────────────────────────────────────

describe("POST /api/events/:eventId/judges", () => {
  it("invites a judge by user id (201)", async () => {
    organizerIn();
    canned.usersById[JUDGE_1] = { id: JUDGE_1, role: "judge" };
    const res = await post(`/api/events/${EVENT_A}/judges`, { user_id: JUDGE_1 }, ORGANIZER_1);
    expect(res.statusCode).toBe(201);
    expectNoLeak(res);
    expect((res.json() as { role?: string }).role).toBe("judge");
  });

  it("invites a judge by email (201)", async () => {
    organizerIn();
    canned.usersByEmail[JUDGE_EMAIL] = { id: JUDGE_1, role: "judge" };
    const res = await post(`/api/events/${EVENT_A}/judges`, { email: JUDGE_EMAIL }, ORGANIZER_1);
    expect(res.statusCode).toBe(201);
    expectNoLeak(res);
  });

  it("rejects unauthenticated invites (401)", async () => {
    const res = await post(`/api/events/${EVENT_A}/judges`, { user_id: JUDGE_1 });
    expect(res.statusCode).toBe(401);
    expectNoLeak(res);
  });

  it("rejects malformed event ids (422) and cross-event callers (404)", async () => {
    organizerIn();
    const bad = await post("/api/events/not-a-uuid/judges", { user_id: JUDGE_1 }, ORGANIZER_1);
    expect(bad.statusCode).toBe(422);
    expectNoLeak(bad);
    const cross = await post(`/api/events/${EVENT_B}/judges`, { user_id: JUDGE_1 }, ORGANIZER_1);
    expect(cross.statusCode).toBe(404);
    expectNoLeak(cross);
  });

  it("rejects unknown users (404) and malformed ids/emails (422)", async () => {
    organizerIn();
    const unknown = await post(`/api/events/${EVENT_A}/judges`, { user_id: JUDGE_1 }, ORGANIZER_1);
    expect(unknown.statusCode).toBe(404);
    expectNoLeak(unknown);
    canned.usersById[JUDGE_1] = { id: JUDGE_1, role: "judge" };
    const malformed = await post(`/api/events/${EVENT_A}/judges`, { user_id: "nope" }, ORGANIZER_1);
    expect(malformed.statusCode).toBe(422);
    const badEmail = await post(`/api/events/${EVENT_A}/judges`, { email: "nope" }, ORGANIZER_1);
    expect(badEmail.statusCode).toBe(422);
    const missing = await post(`/api/events/${EVENT_A}/judges`, {}, ORGANIZER_1);
    expect(missing.statusCode).toBe(422);
  });

  it("rejects participant system roles (422 not_a_judge)", async () => {
    organizerIn();
    canned.usersById[PARTICIPANT_1] = { id: PARTICIPANT_1, role: "participant" };
    const res = await post(`/api/events/${EVENT_A}/judges`, { user_id: PARTICIPANT_1 }, ORGANIZER_1);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error?: string }).error).toBe("not_a_judge");
    expectNoLeak(res);
  });

  it("rejects existing members without privilege change (409 already_member)", async () => {
    organizerIn();
    canned.usersById[ORGANIZER_1] = { id: ORGANIZER_1, role: "organizer" };
    canned.existingMembership = { role: "organizer" };
    const res = await post(`/api/events/${EVENT_A}/judges`, { user_id: ORGANIZER_1 }, ORGANIZER_1);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error?: string }).error).toBe("already_member");
    expectNoLeak(res);
  });

  it("rejects tracks from other events (422 invalid_track)", async () => {
    organizerIn();
    canned.usersById[JUDGE_1] = { id: JUDGE_1, role: "judge" };
    canned.trackValid = false;
    const res = await post(
      `/api/events/${EVENT_A}/judges`,
      { user_id: JUDGE_1, track_id: TRACK_A },
      ORGANIZER_1,
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error?: string }).error).toBe("invalid_track");
    expectNoLeak(res);
  });
});

// ── Assignment auto-membership bridge ────────────────────────────────

describe("POST /api/assignments membership bridge", () => {
  const assignmentBody = {
    event_id: EVENT_A,
    project_id: PROJECT_ID,
    judge_user_id: JUDGE_1,
  };

  it("auto-ensures judge membership then creates the assignment (201)", async () => {
    organizerIn();
    canned.usersById[JUDGE_1] = { id: JUDGE_1, role: "judge" };
    const res = await post("/api/assignments", assignmentBody, ORGANIZER_1);
    expect(res.statusCode).toBe(201);
    expectNoLeak(res);
    expect(canned.inserts).toEqual(["membership", "assignment"]);
  });

  it("rejects participant judges (422 not_a_judge) without inserting", async () => {
    organizerIn();
    canned.usersById[PARTICIPANT_1] = { id: PARTICIPANT_1, role: "participant" };
    const res = await post(
      "/api/assignments",
      { ...assignmentBody, judge_user_id: PARTICIPANT_1 },
      ORGANIZER_1,
    );
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error?: string }).error).toBe("not_a_judge");
    expect(canned.inserts).toEqual([]);
    expectNoLeak(res);
  });

  it("rejects unknown judges (404)", async () => {
    organizerIn();
    const res = await post("/api/assignments", assignmentBody, ORGANIZER_1);
    expect(res.statusCode).toBe(404);
    expectNoLeak(res);
  });

  it("surfaces duplicate assignments (409)", async () => {
    organizerIn();
    canned.usersById[JUDGE_1] = { id: JUDGE_1, role: "judge" };
    canned.duplicateAssignmentNext = true;
    const res = await post("/api/assignments", assignmentBody, ORGANIZER_1);
    expect(res.statusCode).toBe(409);
    expectNoLeak(res);
  });
});
