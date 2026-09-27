/**
 * Gallery embed framing regression test — REAL app (buildApp with global
 * @fastify/helmet), stubbed pool.
 *
 * GET /gallery/embed must be iframe-embeddable cross-origin:
 *   - NO blocking `x-frame-options` (absent or ALLOWALL-equivalent;
 *     never SAMEORIGIN/DENY)
 *   - CSP contains `frame-ancestors *`
 * Every other route (spot-checked via GET /gallery) must keep the strict
 * anti-framing defaults: `frame-ancestors 'none'` + x-frame-options present.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../db/index.js", () => ({
  pool: {
    query: async () => ({ rows: [], rowCount: 0 }),
  },
  db: {},
}));

const { buildApp } = await import("../app.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("gallery embed framing headers", () => {
  it("GET /gallery/embed is cross-origin iframe-embeddable", async () => {
    const res = await app.inject({ method: "GET", url: "/gallery/embed" });
    expect([200, 503]).toContain(res.statusCode);
    const xfo = res.headers["x-frame-options"];
    expect(
      xfo,
      "embed must not send a blocking X-Frame-Options header",
    ).toSatisfy(
      (v: unknown) =>
        v === undefined ||
        String(v).toUpperCase() === "ALLOWALL" ||
        (!/SAMEORIGIN/i.test(String(v)) && !/DENY/i.test(String(v))),
    );
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toMatch(/frame-ancestors\s+\*/);
  });

  it("GET /gallery keeps strict anti-framing headers", async () => {
    const res = await app.inject({ method: "GET", url: "/gallery" });
    expect([200, 503]).toContain(res.statusCode);
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toMatch(/frame-ancestors\s+'none'/);
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(String(res.headers["x-frame-options"])).toMatch(
      /SAMEORIGIN|DENY/i,
    );
  });
});
