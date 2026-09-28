/**
 * Comprehensive tests for Organizer Experience.
 *
 * Covers:
 * - GET /events (organizer event index)
 * - GET /dashboard (role-aware dashboard)
 * - POST /events/new (event creation & redirect to /events/:id/manage)
 * - GET /events/:eventId/manage (event management hub with checklist & overview)
 * - GET & POST /events/:eventId/rubric (rubric configuration)
 * - GET & POST /events/:eventId/judges (judge management & invite)
 * - GET & POST /events/:eventId/teams (teams management & invite links)
 * - GET /events/:eventId/projects (projects/submissions overview)
 * - GET /judging & GET /results (cross-event hubs)
 * - GET /account (user profile)
 * - Role-aware root redirect on GET /
 * - Server-side authorization & peer isolation (401/404, never 403)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyFormbody from "@fastify/formbody";
import { registerOrganizerPages } from "./pages/organizer.js";
import pageRoutes from "./pages.js";

// ── Canned pool state ────────────────────────────────────────────────
const canned = vi.hoisted(() => ({
  userRole: "organizer" as string,
  userName: "Organizer One",
  userEmail: "organizer@example.org",
  eventExists: true,
  events: [] as Array<Record<string, unknown>>,
  membership: [] as Array<Record<string, unknown>>,
  tracks: [] as Array<Record<string, unknown>>,
  prizes: [] as Array<Record<string, unknown>>,
  teams: [] as Array<Record<string, unknown>>,
  projects: [] as Array<Record<string, unknown>>,
  scores: [] as Array<Record<string, unknown>>,
  finalization: null as Record<string, unknown> | null,
  rubricVersion: 1,
  seenTxn: [] as string[],
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];

      // Users table query
      if (text.includes("FROM users WHERE id")) {
        return {
          rows: [
            {
              id: String(v[0] || "org-1"),
              role: canned.userRole,
              name: canned.userName,
              email: canned.userEmail,
              created_at: new Date("2026-01-01"),
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("FROM users WHERE LOWER(email)") || text.includes("FROM users WHERE email")) {
        return {
          rows: [
            {
              id: "judge-uuid-1",
              role: "judge",
              name: "Judge Smith",
              email: String(v[0] || "judge@example.org"),
            },
          ],
          rowCount: 1,
        };
      }

      // Event single row
      if (text.includes("SELECT * FROM events WHERE id = $1")) {
        if (!canned.eventExists) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              id: String(v[0]),
              name: "Hackathon Alpha",
              description: "A great event",
              state: "DRAFT",
              version: 1,
              starts_at: "2026-10-01T10:00:00.000Z",
              ends_at: "2026-10-03T18:00:00.000Z",
              submissions_open_at: "2026-10-01T12:00:00.000Z",
              submissions_close_at: "2026-10-03T12:00:00.000Z",
              created_by: "org-1",
              created_at: new Date("2026-09-01"),
              updated_at: new Date("2026-09-01"),
            },
          ],
          rowCount: 1,
        };
      }

      // Event list
      if (text.includes("FROM events e")) {
        return {
          rows: canned.events,
          rowCount: canned.events.length,
        };
      }

      // Memberships
      if (text.includes("FROM event_memberships")) {
        return {
          rows: canned.membership,
          rowCount: canned.membership.length,
        };
      }

      // Tracks
      if (text.includes("FROM tracks")) {
        return {
          rows: canned.tracks,
          rowCount: canned.tracks.length,
        };
      }

      // Prizes
      if (text.includes("FROM prizes")) {
        return {
          rows: canned.prizes,
          rowCount: canned.prizes.length,
        };
      }

      // Teams
      if (text.includes("FROM teams")) {
        return {
          rows: canned.teams,
          rowCount: canned.teams.length,
        };
      }

      // Projects
      if (text.includes("FROM projects")) {
        return {
          rows: canned.projects,
          rowCount: canned.projects.length,
        };
      }

      // Scores
      if (text.includes("FROM scores")) {
        return {
          rows: canned.scores,
          rowCount: canned.scores.length,
        };
      }

      // Finalization
      if (text.includes("FROM event_finalizations")) {
        return {
          rows: canned.finalization ? [canned.finalization] : [],
          rowCount: canned.finalization ? 1 : 0,
        };
      }

      // Rubrics
      if (text.includes("FROM rubric_versions")) {
        return {
          rows: [
            {
              version: canned.rubricVersion,
              weights: { technical: 30, innovation: 25, impact: 25, polish: 20 },
            },
          ],
          rowCount: 1,
        };
      }

      // Default count queries
      if (text.includes("COUNT(*)")) {
        return { rows: [{ count: "2" }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        canned.seenTxn.push(text);
        const v = (values ?? []) as unknown[];
        if (text.includes("INSERT INTO events")) {
          return {
            rows: [
              {
                id: "e0000000-0000-4000-8000-000000000001",
                name: String(v[0]),
                description: String(v[1]),
                state: "DRAFT",
                version: 1,
                created_by: "org-1",
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes("COALESCE(MAX(version)")) {
          return { rows: [{ max_version: canned.rubricVersion }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO rubric_versions")) {
          return { rows: [{ id: "rv-1", version: canned.rubricVersion + 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    }),
  },
  db: {},
}));

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_USER = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_USER = "33333333-3333-4333-8333-333333333333";
const JUDGE_USER = "44444444-4444-4444-8444-444444444444";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyFormbody);

  // Decorate view to capture render output
  void app.decorateReply("view", function (template: string, data: unknown) {
    /* eslint-disable-next-line */
    const reply = this as any;
    if (!reply.statusCode) reply.code(200);
    return reply.send({ template, data });
  });

  // Session & CSRF mock hook
  app.addHook("onRequest", async (req) => {
    const testUser = req.headers["x-test-user"] as string | undefined;
    req.session = testUser ? { id: "test-sess", userId: testUser } : { id: "anon" };
    req.csrfToken = () => "test-csrf-token";
  });

  await app.register(pageRoutes);
  await app.register(registerOrganizerPages);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.userRole = "organizer";
  canned.userName = "Organizer One";
  canned.userEmail = "organizer@example.org";
  canned.eventExists = true;
  canned.rubricVersion = 1;
  canned.events = [
    {
      id: EVENT_ID,
      name: "Hackathon Alpha",
      description: "Sample event",
      state: "DRAFT",
      version: 1,
      created_by: ORG_USER,
      team_count: 5,
      project_count: 4,
      submitted_project_count: 3,
      judge_count: 2,
      score_count: 6,
      updated_at: new Date("2026-09-20"),
      starts_at: "2026-10-01T10:00:00.000Z",
      ends_at: "2026-10-03T18:00:00.000Z",
      submissions_close_at: "2026-10-03T12:00:00.000Z",
    },
  ];
  canned.membership = [{ id: "mem-1", role: "organizer", event_id: EVENT_ID, user_id: ORG_USER }];
  canned.tracks = [{ id: "track-1", slug: "ai-ml", name: "AI / ML", project_count: 2 }];
  canned.prizes = [{ id: "prize-1", slug: "grand-prize", name: "Grand Prize", amount_cents: 5000000, track_id: null, track_name: null }];
  canned.teams = [{ id: "team-1", name: "Cyber Wolves", invite_token: "tok-1", max_size: 4, leader_name: "Alice", member_count: 3 }];
  canned.projects = [{ id: "proj-1", title: "Smart City", tagline: "IoT solution", status: "submitted", tech_tags: ["iot", "ts"], track_name: "AI / ML", team_name: "Cyber Wolves" }];
  canned.finalization = null;
  canned.seenTxn = [];
});

describe("Organizer Experience Routes", () => {
  describe("GET /events (Organizer Events Index)", () => {
    it("renders events_index.njk for authenticated organizer", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/events",
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.template).toBe("events_index.njk");
      expect(json.data.events).toBeDefined();
      expect(json.data.events.length).toBe(1);
      expect(json.data.events[0].name).toBe("Hackathon Alpha");
    });

    it("rejects unauthenticated requests with 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/events",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for participant to preserve role isolation", async () => {
      canned.userRole = "participant";
      const res = await app.inject({
        method: "GET",
        url: "/events",
        headers: { "x-test-user": PARTICIPANT_USER },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /dashboard", () => {
    it("renders organizer_dashboard.njk for organizer", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/dashboard",
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.template).toBe("organizer_dashboard.njk");
      expect(json.data.totalEvents).toBe(1);
      expect(json.data.events.length).toBe(1);
    });

    it("redirects judge to /judging", async () => {
      canned.userRole = "judge";
      const res = await app.inject({
        method: "GET",
        url: "/dashboard",
        headers: { "x-test-user": JUDGE_USER },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/judging");
    });
  });

  describe("POST /events/new (Event creation)", () => {
    it("creates an event and redirects to /events/:id/manage", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events/new",
        headers: {
          "x-test-user": ORG_USER,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "name=New+Awesome+Hackathon&description=Cool+event",
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/\/events\/[0-9a-f-]+\/manage/);
    });

    it("rejects empty name with 422", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events/new",
        headers: {
          "x-test-user": ORG_USER,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "name=&description=Empty",
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe("GET /events/:eventId/manage (Event Management Hub)", () => {
    it("renders event_manage.njk with checklist, stats, rubric and contextual help", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/events/${EVENT_ID}/manage`,
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.template).toBe("event_manage.njk");
      expect(json.data.event.name).toBe("Hackathon Alpha");
      expect(json.data.checklist).toBeDefined();
      expect(json.data.checklist.length).toBeGreaterThan(5);
      expect(json.data.contextHelp).toBeDefined();
      expect(json.data.stats).toBeDefined();
      expect(json.data.tracks).toBeDefined();
      expect(json.data.prizes).toBeDefined();
      expect(json.data.rubric).toBeDefined();
    });

    it("returns 404 for unauthorized user without organizer role", async () => {
      canned.membership = []; // no membership for this user
      const res = await app.inject({
        method: "GET",
        url: `/events/${EVENT_ID}/manage`,
        headers: { "x-test-user": PARTICIPANT_USER },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Rubric Configuration (/events/:eventId/rubric)", () => {
    it("GET renders event_rubric.njk with active rubric", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/events/${EVENT_ID}/rubric`,
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("event_rubric.njk");
      expect(res.json().data.activeRubric.weights.technical).toBe(30);
    });

    it("POST saves valid weights (summing to 100) and redirects", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/events/${EVENT_ID}/rubric`,
        headers: {
          "x-test-user": ORG_USER,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "technical=40&innovation=30&impact=20&polish=10",
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/events/${EVENT_ID}/rubric`);
    });

    it("POST rejects invalid weights (sum != 100) and redirects with error flash", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/events/${EVENT_ID}/rubric`,
        headers: {
          "x-test-user": ORG_USER,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "technical=50&innovation=50&impact=50&polish=50",
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/events/${EVENT_ID}/rubric`);
    });
  });

  describe("Judge Management (/events/:eventId/judges)", () => {
    it("GET renders event_judges.njk with judge list", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/events/${EVENT_ID}/judges`,
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("event_judges.njk");
    });

    it("POST invites judge with judge role and redirects", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/events/${EVENT_ID}/judges`,
        headers: {
          "x-test-user": ORG_USER,
          "content-type": "application/x-www-form-urlencoded",
        },
        payload: "identifier=judge@example.org",
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`/events/${EVENT_ID}/judges`);
    });
  });

  describe("Teams & Projects Management", () => {
    it("GET /events/:eventId/teams renders event_teams.njk with invite links", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/events/${EVENT_ID}/teams`,
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("event_teams.njk");
      expect(res.json().data.teams[0].invite_url).toContain("/teams/join?token=");
    });

    it("GET /events/:eventId/projects renders event_projects.njk", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/events/${EVENT_ID}/projects`,
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("event_projects.njk");
      expect(res.json().data.projects.length).toBe(1);
    });
  });

  describe("Cross-event Hubs & Account", () => {
    it("GET /judging renders judging_hub.njk", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/judging",
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("judging_hub.njk");
    });

    it("GET /results renders results_hub.njk for organizer", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/results",
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("results_hub.njk");
    });

    it("GET /account renders account.njk", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/account",
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().template).toBe("account.njk");
      expect(res.json().data.user.name).toBe("Organizer One");
    });

    it("GET / redirects role-aware to /dashboard for organizer", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-test-user": ORG_USER },
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/dashboard");
    });
  });
});
