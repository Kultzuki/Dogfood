import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import teamRoutes from "./teams.js";

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_1 = "11111111-1111-4111-8111-111111111111";
const USER_1 = "66666666-6666-4666-8666-666666666666";
const TOKEN = "tok-abc-123";

const canned = vi.hoisted(() => ({
  team: null as null | { id: string; event_id: string; max_size: number },
  memberCount: 0,
  insertError: null as null | { code: string },
  joined: [] as string[],
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("SELECT 1 FROM events WHERE id")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (text.includes("FROM teams WHERE invite_token")) {
        if (!canned.team) return { rows: [], rowCount: 0 };
        return {
          rows: [{ id: canned.team.id, event_id: canned.team.event_id, max_size: canned.team.max_size }],
          rowCount: 1,
        };
      }
      if (text.includes("SELECT role FROM event_memberships")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT role FROM users")) {
        return { rows: [{ role: "participant" }], rowCount: 0 };
      }
      if (text.includes("SELECT team_id FROM team_members")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("audit_logs")) {
        return { rows: [{ id: "audit-1" }], rowCount: 1 };
      }
      void v;
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        if (
          text === "BEGIN" ||
          text === "COMMIT" ||
          text === "ROLLBACK" ||
          text.includes("pg_advisory_xact_lock")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("FROM teams WHERE id")) {
          if (!canned.team) return { rows: [], rowCount: 0 };
          return {
            rows: [{ id: canned.team.id, event_id: canned.team.event_id, max_size: canned.team.max_size }],
            rowCount: 1,
          };
        }
        if (text.includes("SELECT COUNT(*) AS count FROM team_members")) {
          return { rows: [{ count: String(canned.memberCount) }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO team_members")) {
          if (canned.insertError) throw canned.insertError;
          canned.joined.push(String((values ?? [])[2] ?? ""));
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

function join(token: unknown, userId = USER_1): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: `/api/events/${EVENT_A}/teams/join`,
    payload: { invite_token: token },
    headers: { "x-test-user": userId },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "teams-join-test", userId } : { id: "teams-join-test" };
  });
  await app.register(teamRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.team = { id: TEAM_1, event_id: EVENT_A, max_size: 5 };
  canned.memberCount = 4;
  canned.insertError = null;
  canned.joined = [];
});

describe("team join concurrency guards", () => {
  it("admits the 5th member when max_size = 5", async () => {
    const res = await join(TOKEN);
    expect(res.statusCode).toBe(201);
    expect(canned.joined).toEqual([USER_1]);
  });

  it("rejects the 6th join with 409 team_full", async () => {
    canned.memberCount = 5;
    const res = await join(TOKEN);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("team_full");
    expect(canned.joined).toHaveLength(0);
  });

  it("maps a duplicate-membership race to 409 already_teamed", async () => {
    canned.insertError = { code: "23505" };
    const res = await join(TOKEN);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe("already_teamed");
  });

  it("rejects unknown invite tokens with 404", async () => {
    canned.team = null;
    const res = await join(TOKEN);
    expect(res.statusCode).toBe(404);
  });

  it("requires a token with 422", async () => {
    const res = await join(undefined);
    expect(res.statusCode).toBe(422);
  });
});
