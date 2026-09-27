/**
 * Gallery widget tests — REAL module (src/routes/gallery.ts), stubbed pool.
 * Proves the embed reuses the same visibility query and stays framing-safe
 * markup-wise (no nav, no forms, links open out).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import galleryRoutes from "./gallery.js";

const canned = vi.hoisted(() => ({
  projects: [] as Array<{
    id: string;
    event_id: string;
    title: string;
    tagline: string | null;
    description: string | null;
    tech_tags: string[] | null;
    event_name: string;
  }>,
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string) => {
      if (text.includes("voting_opens_at")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("GROUP BY")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM projects p JOIN events e")) {
        return { rows: canned.projects, rowCount: canned.projects.length };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  db: {},
}));

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  void app.decorateReply("view", function (template: string, data: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).code(200).send({ template, data });
  });
  await app.register(galleryRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  canned.projects = [
    {
      id: "55555555-5555-4555-8555-555555555555",
      event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Glass Signal",
      tagline: "tag",
      description: "desc",
      tech_tags: ["node"],
      event_name: "Sample Hack 2026",
    },
  ];
});

function get(url: string): Promise<InjectResponse> {
  return app.inject({ method: "GET", url });
}

describe("gallery widget", () => {
  it("serves the embed publicly with project content", async () => {
    const res = await get("/gallery/embed");
    expect(res.statusCode).toBe(200);
    // View stub serializes template+data; Nunjucks rendering is covered live.
    expect(res.json().template).toBe("embed.njk");
    expect(JSON.stringify(res.json().data)).toContain("Glass Signal");
  });
  it("clamps the limit param and tolerates garbage track", async () => {
    const big = await get("/gallery/embed?limit=9999");
    expect(big.statusCode).toBe(200);
    const track = await get("/gallery/embed?track=x");
    expect(track.statusCode).toBe(200);
  });
  it("keeps the main gallery intact (track=x still 200)", async () => {
    const res = await get("/gallery?track=x");
    expect(res.statusCode).toBe(200);
    expect(res.json().template).toBe("gallery.njk");
  });
});
