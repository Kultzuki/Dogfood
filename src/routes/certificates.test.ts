/**
 * T4 certificate tests — REAL module (src/routes/certificates.ts), stubbed
 * pool, isolated Ed25519 key via RECORD_SIGNING_KEY. No database required.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { generateKeyPairSync } from "node:crypto";
import certificateRoutes from "./certificates.js";

const savedKey = process.env["RECORD_SIGNING_KEY"];

const canned = vi.hoisted(() => ({
  event: undefined as { id: string; name: string; state: string } | undefined,
  memberships: [] as Array<{ id: string; role: string }>,
  judgeFacts: undefined as Record<string, unknown> | undefined,
  projectFacts: undefined as Record<string, unknown> | undefined,
  participantFacts: undefined as Record<string, unknown> | undefined,
  conflict: false,
  existing: undefined as Record<string, unknown> | undefined,
  cert: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../db/index.js", () => ({
  pool: {
    query: async (text: string, values?: unknown[]) => {
      const v = (values ?? []) as unknown[];
      if (text.includes("INSERT INTO certificates")) {
        if (canned.conflict) throw { code: "23505" };
        return {
          rows: [
            {
              id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              event_id: String(v[0]),
              type: String(v[1]),
              subject_id: String(v[2]),
              payload: JSON.parse(String(v[3])),
              digest: String(v[4]),
              signature: String(v[5]),
              kid: String(v[6]),
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes("FROM certificates")) {
        const row = canned.existing ?? canned.cert;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("judge_assignments")) {
        return { rows: canned.judgeFacts ? [canned.judgeFacts] : [], rowCount: canned.judgeFacts ? 1 : 0 };
      }
      if (text.includes("community_votes WHERE project_id = p.id")) {
        return { rows: canned.projectFacts ? [canned.projectFacts] : [], rowCount: canned.projectFacts ? 1 : 0 };
      }
      if (text.includes("team_members")) {
        return { rows: canned.participantFacts ? [canned.participantFacts] : [], rowCount: canned.participantFacts ? 1 : 0 };
      }
      if (text.includes("FROM events WHERE id")) {
        return { rows: canned.event ? [canned.event] : [], rowCount: canned.event ? 1 : 0 };
      }
      if (text.includes("FROM event_memberships") && text.includes("user_id")) {
        return { rows: canned.memberships, rowCount: canned.memberships.length };
      }
      if (text.includes("FROM audit_logs")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO audit_logs")) {
        return { rows: [{ id: "a", seq: 1 }], rowCount: 1 };
      }
      if (text.includes("FROM webhook_subscriptions")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  db: {},
}));

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JUDGE_1 = "66666666-6666-4666-8666-666666666666";
const PROJECT_A = "55555555-5555-4555-8555-555555555555";
const ORGANIZER_1 = "99999999-9999-4999-8999-999999999999";
const VOTER_1 = "11111111-1111-4111-8111-111111111111";

let app: FastifyInstance;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function authed(method: "GET" | "POST" | "DELETE", url: string, userId?: string, payload?: object): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    payload,
    headers: {
      ...(userId ? { "x-test-user": userId } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
  });
}

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  process.env["RECORD_SIGNING_KEY"] = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  app = Fastify({ logger: false });
  void app.addHook("onRequest", async (req) => {
    const header = req.headers["x-test-user"];
    const userId = typeof header === "string" && header.length > 0 ? header : undefined;
    req.session = userId ? { id: "cert-test", userId } : { id: "cert-test" };
  });
  void app.decorateReply("view", function (template: string, data: unknown) {
    return (this as any).code(200).send({ template, data });
  });
  await app.register(certificateRoutes);
  await app.ready();
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env["RECORD_SIGNING_KEY"];
  else process.env["RECORD_SIGNING_KEY"] = savedKey;
  await app.close();
});

beforeEach(() => {
  canned.event = { id: EVENT_A, name: "Evt", state: "PUBLISHED" };
  canned.memberships = [{ id: "m1", role: "organizer" }];
  canned.judgeFacts = {
    id: JUDGE_1,
    email: "j@x.org",
    name: "J",
    assigned: 3,
    scored: 2,
    rubric_version: 1,
  };
  canned.projectFacts = undefined;
  canned.participantFacts = undefined;
  canned.conflict = false;
  canned.existing = undefined;
  canned.cert = undefined;
});

describe("certificate issuance", () => {
  it("issues a signed judge-participation record (201)", async () => {
    const res = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    expect(res.statusCode).toBe(201);
    const cert = res.json().certificate;
    expect(cert.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof cert.signature).toBe("string");
    expect(cert.payload.facts.assigned).toBe(3);
    canned.cert = cert;
  });
  it("re-issues deterministically (200 deduped)", async () => {
    canned.conflict = true;
    canned.existing = { id: "cert-old", digest: "d" };
    const res = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deduped).toBe(true);
  });
  it("rejects bad types/subjects/outsiders", async () => {
    const badType = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "gold-medal",
      subject_id: JUDGE_1,
    });
    expect(badType.statusCode).toBe(422);
    const badSub = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "judge-participation",
      subject_id: "nope",
    });
    expect(badSub.statusCode).toBe(422);
    canned.judgeFacts = undefined;
    const missing = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    expect(missing.statusCode).toBe(404);
    canned.judgeFacts = { id: JUDGE_1, email: "j@x.org", name: "J", assigned: 1, scored: 1, rubric_version: 1 };
    canned.memberships = [];
    const outsider = await authed("POST", `/api/events/${EVENT_A}/certificates`, VOTER_1, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    expect(outsider.statusCode).toBe(404);
    const anon = await authed("POST", `/api/events/${EVENT_A}/certificates`, undefined, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe("public read + verify", () => {
  it("serves records publicly and verifies them", async () => {
    const issued = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    const cert = issued.json().certificate;
    canned.cert = cert;
    const read = await authed("GET", `/api/certificates/${cert.id}`);
    expect(read.statusCode).toBe(200);
    const verify = await authed("GET", `/api/certificates/${cert.id}/verify`);
    expect(verify.statusCode).toBe(200);
    expect(verify.json().valid).toBe(true);
  });
  it("fails tampered copies via the payload override", async () => {
    const issued = await authed("POST", `/api/events/${EVENT_A}/certificates`, ORGANIZER_1, {
      type: "judge-participation",
      subject_id: JUDGE_1,
    });
    const cert = issued.json().certificate;
    canned.cert = cert;
    const tampered = { ...cert.payload, facts: { ...cert.payload.facts, scored_current: 999 } };
    const encoded = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
    const res = await authed("GET", `/api/certificates/${cert.id}/verify?payload=${encoded}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().digest_match).toBe(false);
  });
  it("exposes the public key and renders the HTML view", async () => {
    const key = await authed("GET", "/api/records/pubkey");
    expect(key.statusCode).toBe(200);
    expect(key.json().pem).toContain("PUBLIC KEY");
    canned.cert = { id: PROJECT_A, payload: { subject: {}, facts: {} } };
    const view = await authed("GET", `/certificates/${PROJECT_A}`);
    expect(view.statusCode).toBe(200);
    expect(view.json().template).toBe("certificate.njk");
  });
});
