import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import scoreRoutes from "./scores.js";

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_P = "55555555-5555-4555-8555-555555555555";
const JUDGE_1 = "66666666-6666-4666-8666-666666666666";
const ASSIGN_1 = "77777777-7777-4777-8777-777777777777";
const ASSIGN_2 = "88888888-8888-4888-8888-888888888888";
const SCORE_1 = "99999999-9999-4999-8999-999999999999";

const CRITERIA = { technical: 80, innovation: 90, impact: 70, polish: 85 };

const canned = vi.hoisted(() => ({
  rubric: null as null | { version: number; weights: Record<string, number> },
  alreadyScored: false,
  oldScore: null as null | Record<string, unknown>,
  inserted: [] as Array<Record<string, unknown>>,
}));

function assignmentRow(id: string): Record<string, unknown> {
  return {
    id,
    event_id: EVENT_A,
    project_id: PROJECT_P,
    judge_user_id: JUDGE_1,
    track_id: null,
    status: "active",
    project_track: null,
  };
}

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("FROM judge_assignments a JOIN projects")) {
        const id = String(v[0] ?? "");
        return { rows: [assignmentRow(id)], rowCount: 1 };
      }
      if (text.includes("SELECT id, role FROM event_memberships")) {
        return { rows: [{ id: "m-1", role: "judge" }], rowCount: 1 };
      }
      if (text.includes("FROM judge_assignments") && text.includes("judge_user_id = $1")) {
        return { rows: [{ id: ASSIGN_1 }], rowCount: 1 };
      }
      if (text.includes("SELECT track_id FROM event_memberships")) {
        return { rows: [{ track_id: null }], rowCount: 1 };
      }
      if (text.includes("FROM rubric_versions")) {
        if (canned.rubric) {
          return {
            rows: [{ version: canned.rubric.version, weights: canned.rubric.weights }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT * FROM scores WHERE id")) {
        const rows = canned.oldScore ? [canned.oldScore] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("FROM webhook_subscriptions")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM webhook_deliveries")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("audit_logs")) {
        return { rows: [{ id: "audit-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        const vals = (values ?? []) as unknown[];
        if (
          text === "BEGIN" ||
          text === "COMMIT" ||
          text === "ROLLBACK" ||
          text.includes("pg_advisory_xact_lock")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("SELECT * FROM judge_assignments WHERE id")) {
          return { rows: [assignmentRow(String(vals[0] ?? ASSIGN_1))], rowCount: 1 };
        }
        if (text.includes("SELECT 1 FROM scores WHERE assignment_id")) {
          const rows = canned.alreadyScored ? [{ "?column?": 1 }] : [];
          return { rows, rowCount: rows.length };
        }
        if (text.includes("SELECT * FROM scores WHERE id")) {
          const rows = canned.oldScore ? [canned.oldScore] : [];
          return { rows, rowCount: rows.length };
        }
        if (text.includes("INSERT INTO scores")) {
          const row: Record<string, unknown> = {
            id: "score-new",
            assignment_id: vals[0],
            event_id: vals[1],
            project_id: vals[2],
            judge_user_id: vals[3],
            value: vals[4],
            version: vals.length > 7 ? vals[5] : 1,
            supersedes_id: vals.length > 7 ? vals[6] : null,
            is_current: true,
            rubric_version: vals.length > 7 ? vals[7] : vals[5],
            criteria: vals.length > 7 ? vals[vals.length - 1] : vals[6],
          };
          canned.inserted.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (text.includes("UPDATE scores SET is_current = false")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    }),
  },
  db: {},
}));

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function post(url: string, payload: object, userId = JUDGE_1): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url,
    payload,
    headers: { "x-test-user": userId },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "scores-bypass-test", userId } : { id: "scores-bypass-test" };
  });
  await app.register(scoreRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.rubric = null;
  canned.alreadyScored = false;
  canned.oldScore = null;
  canned.inserted = [];
});

describe("judge scoring rubric bypass closure", () => {
  it("accepts valid criteria and computes the composite server-side (default 30/25/25/20)", async () => {
    const res = await post("/api/scores", { assignment_id: ASSIGN_1, criteria: CRITERIA });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { value: number; rubric_version: number };
    expect(body.value).toBe(81);
    expect(body.rubric_version).toBe(1);
  });

  it("rejects scalar-only submissions with 422 invalid_criteria", async () => {
    const res = await post("/api/scores", { assignment_id: ASSIGN_1, value: 100 });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("invalid_criteria");
  });

  it("rejects missing criteria with 422 invalid_criteria", async () => {
    const res = await post("/api/scores", { assignment_id: ASSIGN_1 });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("invalid_criteria");
  });

  it("rejects invalid criteria (missing key, out-of-range, wrong type)", async () => {
    for (const bad of [
      { technical: 80, innovation: 90, impact: 70 },
      { technical: 80, innovation: 90, impact: 70, polish: 101 },
      { technical: -1, innovation: 90, impact: 70, polish: 85 },
      { technical: "80", innovation: 90, impact: 70, polish: 85 },
    ]) {
      const res = await post("/api/scores", { assignment_id: ASSIGN_1, criteria: bad });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: string }).error).toBe("invalid_criteria");
    }
  });

  it("rejects conflicting scalar + criteria instead of letting the scalar win", async () => {
    const res = await post("/api/scores", {
      assignment_id: ASSIGN_1,
      value: 20,
      criteria: CRITERIA,
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("conflicting_input");
    expect(canned.inserted).toHaveLength(0);
  });

  it("rescore also requires criteria (scalar rejected, criteria accepted)", async () => {
    canned.oldScore = {
      id: SCORE_1,
      assignment_id: ASSIGN_1,
      event_id: EVENT_A,
      project_id: PROJECT_P,
      judge_user_id: JUDGE_1,
      value: 81,
      version: 1,
      supersedes_id: null,
      is_current: true,
      rubric_version: 1,
    };
    const scalarRes = await post(`/api/scores/${SCORE_1}/rescore`, { value: 95 });
    expect(scalarRes.statusCode).toBe(422);
    const ok = await post(`/api/scores/${SCORE_1}/rescore`, { criteria: CRITERIA });
    expect(ok.statusCode).toBe(201);
    const body = ok.json() as { version: number; rubric_version: number; value: number };
    expect(body.version).toBe(2);
    expect(body.value).toBe(81);
  });

  it("preserves rubric versioning: v1 scores keep v1, new scores pin v2 with new weights", async () => {
    canned.rubric = {
      version: 1,
      weights: { technical: 40, innovation: 25, impact: 20, polish: 15 },
    };
    const first = await post("/api/scores", { assignment_id: ASSIGN_1, criteria: CRITERIA });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { value: number; rubric_version: number };
    expect(firstBody.rubric_version).toBe(1);
    expect(firstBody.value).toBeCloseTo(81.25, 2);

    canned.rubric = {
      version: 2,
      weights: { technical: 30, innovation: 30, impact: 20, polish: 20 },
    };
    const second = await post("/api/scores", { assignment_id: ASSIGN_2, criteria: CRITERIA });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { value: number; rubric_version: number };
    expect(secondBody.rubric_version).toBe(2);
    expect(secondBody.value).toBeCloseTo(82, 2);
    expect(firstBody.value).not.toBe(secondBody.value);
  });
});
