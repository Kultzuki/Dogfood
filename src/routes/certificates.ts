/**
 * T4.2 certificates + T4.3 signed judge participation records.
 *
 * One table, one flow. `POST /api/events/:id/certificates` (organizer-only)
 * gathers source facts from the DB, builds a canonical payload, digests it
 * (SHA-256) and signs the canonical bytes with the deployment Ed25519 key.
 * Re-issuing identical facts returns the existing row (UNIQUE on
 * event/type/subject) — records are deterministic and reproducible.
 *
 * Signed payload (exact, versioned):
 *   { v: 1, type, event_id, event_name,
 *     subject: { kind: "user"|"project", id, email?, name?, title? },
 *     facts: {...per type...} }
 * No wall-clock timestamps inside the signed bytes (row created_at lives
 * outside the digest), so identical facts always yield identical bytes.
 *
 * Verification is PUBLIC (`GET /api/certificates/:id/verify`): recompute
 * the digest from the stored payload and Ed25519-verify against the key
 * matching the record's `kid`. Optional `{payload}` body override verifies
 * caller-supplied bytes against the stored signature — a modified copy
 * fails with valid:false (the tamper demo).
 *
 * Convention: 401 unauthenticated · 404 isolation (never 403) · 422 invalid.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import "@fastify/view";
import { pool } from "../db/index.js";
import { requireEventRole } from "../authz/guards.js";
import { appendAuditForRequest, canonicalJson, type PoolLike } from "../lib/audit.js";
import {
  getPublicKeyInfo,
  getSigningKey,
  sha256Hex,
  verifySignature,
} from "../lib/signing.js";
import { recordWebhookEvents, sweepDueDeliveries } from "../lib/webhooks.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CERT_TYPES = [
  "judge-participation",
  "project-submission",
  "participant",
] as const;

type CertType = (typeof CERT_TYPES)[number];

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function emit(
  req: FastifyRequest,
  entry: Omit<
    Parameters<typeof appendAuditForRequest>[2],
    "actorUserId"
  >,
): Promise<void> {
  try {
    await appendAuditForRequest(
      pool as unknown as PoolLike,
      req as unknown as { session?: Record<string, unknown> },
      entry,
    );
  } catch (err) {
    req.log.warn({ err }, "audit_emit_failed");
  }
}

const resolveEventId = (req: FastifyRequest): string | undefined =>
  (req.params as { eventId?: unknown }).eventId as string | undefined;
const organizeEvent = requireEventRole(resolveEventId, "organizer");

interface CertRow {
  id: string;
  event_id: string;
  type: string;
  subject_id: string;
  payload: unknown;
  digest: string;
  signature: string;
  kid: string;
  created_at: unknown;
}

const outCert = (r: CertRow): Record<string, unknown> => ({
  id: r.id,
  event_id: r.event_id,
  type: r.type,
  subject_id: r.subject_id,
  payload: r.payload,
  digest: r.digest,
  signature: r.signature,
  kid: r.kid,
  created_at: r.created_at,
});

async function eventName(
  db: PoolLike,
  eventId: string,
): Promise<{ id: string; name: string; state: string } | undefined> {
  try {
    const r = await db.query(
      `SELECT id, name, state FROM events WHERE id = $1`,
      [eventId],
    );
    return (r.rows as unknown as Array<{ id: string; name: string; state: string }>)[0];
  } catch {
    return undefined;
  }
}

interface Facts {
  subject: Record<string, unknown>;
  facts: Record<string, unknown>;
}

/** Gather source facts; undefined = subject missing/out-of-event (404). */
async function gatherFacts(
  db: PoolLike,
  ev: { id: string; name: string; state: string },
  type: CertType,
  subjectId: string,
): Promise<Facts | undefined> {
  if (type === "judge-participation") {
    const u = await db.query(
      `SELECT u.id, u.email, u.name,
              (SELECT COUNT(*)::int FROM judge_assignments
                WHERE event_id = $1 AND judge_user_id = u.id) AS assigned,
              (SELECT COUNT(*)::int FROM scores
                WHERE event_id = $1 AND judge_user_id = u.id AND is_current = true) AS scored,
              (SELECT version FROM rubric_versions
                WHERE event_id = $1 AND is_active = true LIMIT 1) AS rubric_version
         FROM users u
         JOIN event_memberships m ON m.user_id = u.id
        WHERE u.id = $2 AND m.event_id = $1 AND m.role = 'judge'`,
      [ev.id, subjectId],
    );
    const row = (u.rows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) return undefined;
    return {
      subject: { kind: "user", id: row["id"], email: row["email"], name: row["name"] },
      facts: {
        assigned: Number(row["assigned"] ?? 0),
        scored_current: Number(row["scored"] ?? 0),
        rubric_version: row["rubric_version"] ?? 1,
        event_state: ev.state,
      },
    };
  }
  if (type === "project-submission") {
    const p = await db.query(
      `SELECT p.id, p.title, p.status, t.name AS track_name, tm.name AS team_name,
              (SELECT COUNT(*)::int FROM community_votes WHERE project_id = p.id) AS votes
         FROM projects p
         LEFT JOIN tracks t ON t.id = p.track_id
         LEFT JOIN teams tm ON tm.id = p.team_id
        WHERE p.id = $2 AND p.event_id = $1`,
      [ev.id, subjectId],
    );
    const row = (p.rows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) return undefined;
    return {
      subject: { kind: "project", id: row["id"], title: row["title"] },
      facts: {
        status: row["status"],
        track: row["track_name"],
        team: row["team_name"],
        community_votes: Number(row["votes"] ?? 0),
        event_state: ev.state,
      },
    };
  }
  const u = await db.query(
    `SELECT u.id, u.email, u.name, tm.name AS team_name,
            (SELECT COUNT(*)::int FROM projects p
              JOIN team_members m ON m.team_id = p.team_id
             WHERE p.event_id = $1 AND m.user_id = u.id) AS projects
       FROM users u
       JOIN event_memberships m ON m.user_id = u.id
       LEFT JOIN team_members tmm ON tmm.user_id = u.id
       LEFT JOIN teams tm ON tm.id = tmm.team_id AND tm.event_id = $1
      WHERE u.id = $2 AND m.event_id = $1`,
    [ev.id, subjectId],
  );
  const row = (u.rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return undefined;
  return {
    subject: { kind: "user", id: row["id"], email: row["email"], name: row["name"] },
    facts: {
      team: row["team_name"],
      projects_in_event: Number(row["projects"] ?? 0),
      event_state: ev.state,
    },
  };
}

async function findCert(
  db: PoolLike,
  id: string,
): Promise<CertRow | undefined> {
  try {
    const r = await db.query(`SELECT * FROM certificates WHERE id = $1`, [id]);
    return (r.rows as unknown as CertRow[])[0];
  } catch {
    return undefined;
  }
}

function verifyRecord(
  row: CertRow,
  payloadOverride?: unknown,
): { valid: boolean; digest_match: boolean; signature_valid: boolean; kid: string } {
  const payload = payloadOverride ?? row.payload;
  const canonical =
    typeof payload === "string" ? payload : canonicalJson(payload);
  const digestMatch = sha256Hex(canonical) === row.digest;
  let sigValid = false;
  try {
    const { kid, pem } = getPublicKeyInfo();
    sigValid = kid === row.kid && verifySignature(pem, canonical, row.signature);
  } catch {
    sigValid = false;
  }
  return {
    valid: digestMatch && sigValid,
    digest_match: digestMatch,
    signature_valid: sigValid,
    kid: row.kid,
  };
}

export default async function certificateRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ── Issue (organizer-only, idempotent per event/type/subject) ──────
  app.post(
    "/api/events/:eventId/certificates",
    { preHandler: [organizeEvent] },
    async (req, reply) => {
      const { eventId } = req.params as { eventId: string };
      const body = (req.body ?? {}) as Record<string, unknown>;
      const type = typeof body["type"] === "string" ? body["type"] : "";
      const subjectId =
        typeof body["subject_id"] === "string" ? body["subject_id"] : "";
      if (!(CERT_TYPES as readonly string[]).includes(type))
        return reply.code(422).send({ error: "invalid_type" });
      if (!UUID_RE.test(subjectId))
        return reply.code(422).send({ error: "invalid_subject_id" });
      const db = pool as unknown as PoolLike;
      const ev = await eventName(db, eventId);
      if (!ev) return reply.code(404).send({ error: "not_found" });
      const gathered = await gatherFacts(db, ev, type as CertType, subjectId);
      if (!gathered) return reply.code(404).send({ error: "not_found" });
      const payload = {
        v: 1,
        type,
        event_id: eventId,
        event_name: ev.name,
        subject: gathered.subject,
        facts: gathered.facts,
      };
      const canonical = canonicalJson(payload);
      const digest = sha256Hex(canonical);
      let key: { kid: string; sign: (m: string) => string };
      try {
        key = getSigningKey();
      } catch {
        return reply.code(500).send({ error: "signing_unavailable" });
      }
      const signature = key.sign(canonical);
      try {
        const ins = await db.query(
          `INSERT INTO certificates
             (event_id, type, subject_id, payload, digest, signature, kid)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           RETURNING *`,
          [eventId, type, subjectId, canonical, digest, signature, key.kid],
        );
        const row = (ins.rows as unknown as CertRow[])[0];
        if (!row) return reply.code(404).send({ error: "not_found" });
        await emit(req, {
          eventId,
          action: "certificate.issue",
          resourceType: "certificate",
          resourceId: row.id,
          detail: { type, subject_id: subjectId },
        });
        try {
          await recordWebhookEvents(db, {
            type: "certificate.issued",
            eventId,
            data: { certificate_id: row.id, type, subject_id: subjectId },
          });
          sweepDueDeliveries(db);
        } catch {
          // Webhooks never break issuance.
        }
        return reply.code(201).send({ certificate: outCert(row) });
      } catch (err) {
        if (pgCode(err) === "23505") {
          const existing = await db.query(
            `SELECT * FROM certificates
              WHERE event_id = $1 AND type = $2 AND subject_id = $3`,
            [eventId, type, subjectId],
          );
          const row = (existing.rows as unknown as CertRow[])[0];
          if (row)
            return reply.send({ certificate: outCert(row), deduped: true });
        }
        throw err;
      }
    },
  );

  // ── Public record read ─────────────────────────────────────────────
  app.get("/api/certificates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(422).send({ error: "invalid_id" });
    const row = await findCert(pool as unknown as PoolLike, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.send({ certificate: outCert(row) });
  });

  // ── Public verification (+ caller-supplied tamper check) ───────────
  // GET (not POST) so anonymous verifiers never hit the CSRF gate: an
  // optional ?payload=<base64url JSON> verifies caller-supplied bytes
  // against the stored signature — a modified copy fails (tamper demo).
  app.get("/api/certificates/:id/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(422).send({ error: "invalid_id" });
    const row = await findCert(pool as unknown as PoolLike, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    const q = (req.query ?? {}) as Record<string, unknown>;
    let override: unknown;
    if (typeof q["payload"] === "string" && q["payload"] !== "") {
      try {
        override = JSON.parse(
          Buffer.from(q["payload"], "base64url").toString("utf8"),
        );
      } catch {
        return reply.code(422).send({ error: "invalid_payload" });
      }
    }
    const result = verifyRecord(row, override);
    return reply.send({ id, ...result, checked_at: new Date().toISOString() });
  });

  // ── Current public key ─────────────────────────────────────────────
  app.get("/api/records/pubkey", async (_req, reply) => {
    try {
      return reply.send(getPublicKeyInfo());
    } catch {
      return reply.code(500).send({ error: "signing_unavailable" });
    }
  });

  // ── Printable certificate view (public, offline, print-friendly) ───
  app.get("/certificates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: "not_found" });
    const row = await findCert(pool as unknown as PoolLike, id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return reply.view("certificate.njk", { cert: outCert(row) });
  });
}
