import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyFormbody from "@fastify/formbody";
import fastifyView from "@fastify/view";
import nunjucks from "nunjucks";
import { join } from "node:path";
import authRoutes from "./auth.js";
import pageRoutes from "./pages.js";
import csrfPlugin from "../plugins/csrf.js";
import { hashPassword } from "../lib/password.js";

const cannedUser = {
  id: "u-1",
  email: "organizer@dogfood.local",
  name: "Organizer One",
  role: "organizer",
  password_hash: "",
};

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("FROM users WHERE email")) {
        if (v[0] === cannedUser.email) {
          return { rows: [cannedUser], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM users WHERE id")) {
        return { rows: [cannedUser], rowCount: 1 };
      }
      if (text.includes("INSERT INTO sessions")) {
        return { rows: [{ id: "sess-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));

describe("Auth & CSRF error distinction & login routing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    cannedUser.password_hash = await hashPassword("DogfoodTest123!");

    app = Fastify();
    await app.register(fastifyFormbody);

    const templatesDir = join(process.cwd(), "templates");
    await app.register(fastifyView, {
      engine: { nunjucks },
      templates: templatesDir,
      options: { autoescape: true },
    });

    // Mock session middleware
    const sessionStore = new Map<string, Record<string, unknown>>();
    app.addHook("onRequest", async (req, reply) => {
      const sid = (req.headers["x-test-sid"] as string) || "test-session";
      if (!sessionStore.has(sid)) {
        sessionStore.set(sid, { id: sid });
      }
      req.session = sessionStore.get(sid) as unknown as import("../plugins/session.js").SessionData;
      reply.locals = {} as unknown as import("./pages/shell.js").ShellLocals;
    });

    await app.register(csrfPlugin);
    await app.register(pageRoutes);
    await app.register(authRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /login redirects with 302 to /", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/login",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
  });

  it("Form POST /login with stale/invalid CSRF returns 403 with friendly message", async () => {
    // Prime session
    const getRes = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-test-sid": "s-1" },
    });
    expect(getRes.statusCode).toBe(200);

    const postRes = await app.inject({
      method: "POST",
      url: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-test-sid": "s-1",
      },
      payload: "email=organizer@dogfood.local&password=DogfoodTest123!&_csrf=bad-csrf-token",
    });

    expect(postRes.statusCode).toBe(403);
    expect(postRes.body).toContain("Security token expired or invalid");
  });

  it("Form POST /login with wrong password returns 401 with Invalid email or password", async () => {
    // Prime session and get real CSRF token
    const getRes = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-test-sid": "s-2" },
    });
    const match = getRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
    const csrfToken = match && match[1] ? match[1] : "";
    expect(csrfToken.length).toBeGreaterThan(0);

    const postRes = await app.inject({
      method: "POST",
      url: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-test-sid": "s-2",
      },
      payload: `email=organizer@dogfood.local&password=WrongPassword!&_csrf=${csrfToken}`,
    });

    expect(postRes.statusCode).toBe(401);
    expect(postRes.body).toContain("Invalid email or password.");
  });

  it("JSON POST /login with wrong password returns 401 JSON invalid_credentials", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-test-sid": "s-3" },
    });
    const match = getRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
    const csrfToken = match && match[1] ? match[1] : "";

    const postRes = await app.inject({
      method: "POST",
      url: "/login",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "x-test-sid": "s-3",
      },
      payload: JSON.stringify({
        email: "organizer@dogfood.local",
        password: "WrongPassword!",
      }),
    });

    expect(postRes.statusCode).toBe(401);
    const body = JSON.parse(postRes.body);
    expect(body.error).toBe("invalid_credentials");
  });

  it("rejects passwords over 128 characters before verification", async () => {
    const getRes = await app.inject({ method: "GET", url: "/", headers: { "x-test-sid": "s-long" } });
    const token = getRes.body.match(/name="_csrf"\s+value="([^"]+)"/)?.[1] ?? "";
    const res = await app.inject({
      method: "POST", url: "/login",
      headers: { "content-type": "application/json", "x-csrf-token": token, "x-test-sid": "s-long" },
      payload: { email: cannedUser.email, password: "x".repeat(129) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "invalid_input" });
  });

  it("Form POST /login with valid credentials & valid CSRF redirects to /dashboard", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: "/",
      headers: { "x-test-sid": "s-4" },
    });
    const match = getRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
    const csrfToken = match && match[1] ? match[1] : "";

    const postRes = await app.inject({
      method: "POST",
      url: "/login",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-test-sid": "s-4",
      },
      payload: `email=organizer@dogfood.local&password=DogfoodTest123!&_csrf=${csrfToken}`,
    });

    expect(postRes.statusCode).toBe(302);
    expect(postRes.headers.location).toBe("/dashboard");
  });
});
