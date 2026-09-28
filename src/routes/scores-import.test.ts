/**
 * Scores CSV/JSON import regression tests — REAL runImport + REAL
 * POST /api/events/:eventId/import route with only the pg pool stubbed
 * (vi.mock of ../db/index.js), so no database is required.
 *
 * Regression: runImport phase 3 used to
 *   INSERT INTO scores (event_id, project_id, judge_user_id, value)
 * without the NOT NULL assignment_id FK, so every scores import failed.
 * Fixed behavior: resolve-or-create the judge_assignment inside the same
 * transaction and insert with assignment_id + rubric_version; duplicates
 * surface as row-level errors mapped to HTTP 409 (never 500); any error
 * rolls everything back (zero partial writes).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import exportRoutes, { runImport } from "./exports.js";
import { validateScoreRow } from "../lib/csv.js";
import { pool } from "../db/index.js";

// ── Canned pool/client state (per-test mutable) ─────────────────────

const canned = vi.hoisted(() => ({
  membershipByEvent: {} as Record<string, Array<{ id: string; role: string }>>,
  eventExists: true,
  projects: [] as string[],
  users: [] as string[],
  assignments: [] as Array<{ id: string; status: string }>,
  scoredAssignmentIds: [] as string[],
  activeRubricVersion: undefined as number | undefined,
  duplicateNextScore: false,
  duplicateNextAssignment: false,
  poolQueries: [] as string[],
  clientQueries: [] as string[],
  scoreInserts: [] as unknown[][],
  assignmentInserts: [] as unknown[][],
  judgeScopeAllowed: true,
}));

vi.mock("../db/index.js", () => {
  const matchPool = async (text: string, values?: unknown[]) => {
    const v = (values ?? []) as unknown[];
    canned.poolQueries.push(text);
    if (text.includes("SELECT 1 FROM event_memberships m")) {
      return { rows: canned.judgeScopeAllowed ? [{ "?column?": 1 }] : [], rowCount: canned.judgeScopeAllowed ? 1 : 0 };
    }
    if (text.includes("FROM event_memberships") && text.includes("user_id")) {
      const rows = canned.membershipByEvent[String(v[1] ?? "")] ?? [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM events WHERE id")) {
      const rows = canned.eventExists ? [{ "?column?": 1 }] : [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM tracks")) {
      return { rows: [{ id: String((v[1] as string[])[0]) }], rowCount: 1 };
    }
    if (text.includes("FROM projects") && text.includes("event_id")) {
      const wanted = new Set((v[1] as string[]) ?? []);
      const rows = canned.projects.filter((id) => wanted.has(id)).map((id) => ({ id, track_id: "track-a" }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM users")) {
      const wanted = new Set((v[0] as string[]) ?? []);
      const rows = canned.users.filter((id) => wanted.has(id)).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const clientQuery = async (text: string, values?: unknown[]) => {
    const v = (values ?? []) as unknown[];
    canned.clientQueries.push(text);
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK")
      return { rows: [], rowCount: 0 };
    if (text.includes("FROM rubric_versions")) {
      const rows =
        canned.activeRubricVersion === undefined ? [] : [{ version: canned.activeRubricVersion }];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("INSERT INTO judge_assignments")) {
      if (canned.duplicateNextAssignment) {
        canned.duplicateNextAssignment = false;
        throw { code: "23505" };
      }
      canned.assignmentInserts.push(v);
      const row = { id: "created-assignment-id" };
      canned.assignments.push({ id: row.id, status: "active" });
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes("FROM judge_assignments")) {
      const rows = canned.assignments.map((a) => ({ id: a.id, status: a.status }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM scores WHERE assignment_id")) {
      const hit = canned.scoredAssignmentIds.includes(String(v[0] ?? ""));
      return { rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (text.includes("INSERT INTO scores")) {
      if (canned.duplicateNextScore) {
        canned.duplicateNextScore = false;
        throw { code: "23505" };
      }
      canned.scoreInserts.push(v);
      return { rows: [{ id: "score-row-id" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: {
      query: matchPool,
      connect: async () => ({ query: clientQuery, release: (): void => undefined }),
    },
    db: {},
  };
});

// ── Fixture ids ─────────────────────────────────────────────────────

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_P = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JUDGE_J = "66666666-6666-4666-8666-666666666666";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";
const ASSIGNMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TRACK_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const scoreRow = (): Record<string, string> => ({
  event_id: EVENT_A,
  project_id: PROJECT_P,
  judge_user_id: JUDGE_J,
  value: "82",
});

beforeEach(() => {
  canned.membershipByEvent = {};
  canned.eventExists = true;
  canned.projects = [PROJECT_P];
  canned.users = [JUDGE_J];
  canned.assignments = [];
  canned.scoredAssignmentIds = [];
  canned.activeRubricVersion = 3;
  canned.duplicateNextScore = false;
  canned.duplicateNextAssignment = false;
  canned.poolQueries = [];
  canned.clientQueries = [];
  canned.scoreInserts = [];
  canned.assignmentInserts = [];
  canned.judgeScopeAllowed = true;
});

describe("validateScoreRow", () => {
  it("accepts a well-formed scores roundtrip row", () => {
    const { errors, value } = validateScoreRow(scoreRow(), EVENT_A);
    expect(errors).toEqual([]);
    expect(value).toBe(82);
  });

  it("leaves empty-string coercion to the existing validator", () => {
    expect(validateScoreRow({ ...scoreRow(), value: "" }, EVENT_A).value).toBe(0);
  });

  it("rejects out-of-range and non-numeric values", () => {
    for (const bad of ["-1", "101", "abc", "NaN", "Infinity"]) {
      const { errors } = validateScoreRow({ ...scoreRow(), value: bad }, EVENT_A);
      expect(errors).toContain("invalid_value");
    }
  });
});

describe("runImport scores", () => {
  it("roundtrip with existing assignment inserts WITH assignment_id", async () => {
    canned.assignments = [{ id: ASSIGNMENT_ID, status: "active" }];
    const out = await runImport(pool, EVENT_A, "scores", [scoreRow()]);
    expect(out).toEqual({ imported: 1, errors: [] });
    expect(canned.scoreInserts).toHaveLength(1);
    const insertSql = canned.clientQueries.find((t) => t.includes("INSERT INTO scores")) ?? "";
    expect(insertSql).toContain("assignment_id");
    expect(canned.scoreInserts[0]?.[0]).toBe(ASSIGNMENT_ID);
    expect(canned.scoreInserts[0]?.[5]).toBe(1); // version
    expect(canned.scoreInserts[0]?.[6]).toBe(3); // active rubric version
    expect(canned.clientQueries).toContain("COMMIT");
  });

  it("missing assignment is auto-created active, then scored", async () => {
    const out = await runImport(pool, EVENT_A, "scores", [scoreRow()]);
    expect(out).toEqual({ imported: 1, errors: [] });
    expect(canned.assignmentInserts).toHaveLength(1);
    expect(canned.assignmentInserts[0]).toEqual([EVENT_A, PROJECT_P, JUDGE_J]);
    expect(canned.scoreInserts).toHaveLength(1);
    expect(canned.scoreInserts[0]?.[0]).toBe("created-assignment-id");
  });

  it("already-scored assignment gives duplicate_score row error and writes nothing", async () => {
    canned.assignments = [{ id: ASSIGNMENT_ID, status: "active" }];
    canned.scoredAssignmentIds = [ASSIGNMENT_ID];
    const out = await runImport(pool, EVENT_A, "scores", [scoreRow()]);
    expect(out).toEqual({ imported: 0, errors: [{ row: 1, errors: ["duplicate_score"] }] });
    expect(canned.scoreInserts).toHaveLength(0);
    expect(canned.clientQueries).toContain("ROLLBACK");
    expect(canned.clientQueries).not.toContain("COMMIT");
  });

  it("unique violation (23505) becomes row errors, never throws 500", async () => {
    canned.assignments = [{ id: ASSIGNMENT_ID, status: "active" }];
    canned.duplicateNextScore = true;
    const out = await runImport(pool, EVENT_A, "scores", [scoreRow()]);
    expect("errors" in out && out.errors.length).toBeGreaterThan(0);
    expect(canned.clientQueries).toContain("ROLLBACK");
  });

  it("malformed value gives row-level errors with zero writes", async () => {
    const out = await runImport(pool, EVENT_A, "scores", [
      { ...scoreRow(), value: "not-a-number" },
    ]);
    expect(out).toEqual({ imported: 0, errors: [{ row: 1, errors: ["invalid_value"] }] });
    expect(canned.clientQueries).toHaveLength(0);
    expect(canned.scoreInserts).toHaveLength(0);
  });

  it("unknown project gives row-level error with zero writes", async () => {
    canned.projects = [];
    const out = await runImport(pool, EVENT_A, "scores", [scoreRow()]);
    expect(out).toEqual({ imported: 0, errors: [{ row: 1, errors: ["unknown_project"] }] });
    expect(canned.scoreInserts).toHaveLength(0);
  });

  it("rejects assignments/imported scores outside the judge track scope", async () => {
    canned.judgeScopeAllowed = false;
    const result = await runImport(pool, EVENT_A, "assignments", [{
      event_id: EVENT_A,
      project_id: PROJECT_P,
      judge_user_id: JUDGE_J,
      track_id: TRACK_ID,
      status: "active",
    }]);
    expect(result).toEqual({ imported: 0, errors: [{ row: 1, errors: ["judge_track_forbidden"] }] });
    expect(canned.assignmentInserts).toHaveLength(0);
  });
});

// ── Route-level: duplicate must be 4xx, never 500 ───────────────────

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "scores-import-test", userId } : { id: "scores-import-test" };
  });
  await app.register(exportRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("POST /api/events/:eventId/import", () => {
  it("duplicate score import maps to 409 with row errors, not 500", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    canned.assignments = [{ id: ASSIGNMENT_ID, status: "active" }];
    canned.scoredAssignmentIds = [ASSIGNMENT_ID];
    const res: InjectResponse = await app.inject({
      method: "POST",
      url: `/api/events/${EVENT_A}/import?dataset=scores`,
      payload: { rows: [scoreRow()] },
      headers: { "x-test-user": ORGANIZER_1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.statusCode).not.toBe(500);
    const body = res.json() as { imported: number; errors: Array<{ row: number; errors: string[] }> };
    expect(body.imported).toBe(0);
    expect(body.errors[0]?.errors).toContain("duplicate_score");
  });

  it("clean scores import returns 200 with imported count", async () => {
    canned.membershipByEvent[EVENT_A] = [{ id: "m-org-1", role: "organizer" }];
    const res: InjectResponse = await app.inject({
      method: "POST",
      url: `/api/events/${EVENT_A}/import?dataset=scores`,
      payload: { rows: [scoreRow()] },
      headers: { "x-test-user": ORGANIZER_1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ imported: 1, errors: [] });
  });
});
