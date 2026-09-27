/**
 * Organizer-configurable weighted rubrics (minimal, versioned).
 *
 *   GET  /api/events/:eventId/rubric   — active weights (members read)
 *   POST /api/events/:eventId/rubrics  — new version (organizer only)
 *
 * Weights always carry exactly {technical, innovation, impact, polish},
 * each a finite 0..100 number, summing to 100 — else 422. Publishing a new
 * version deactivates the previous one inside the same txn (single active
 * version per event is a code invariant, not a DB constraint). Scores pin
 * the active `rubric_version` at submit time; old scores stay immutable.
 * 401 unauthenticated · 404 isolation (never 403) · 422 invalid.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";

export const RUBRIC_KEYS = ["technical", "innovation", "impact", "polish"] as const;
export type RubricKey = (typeof RUBRIC_KEYS)[number];
export type RubricWeights = Record<RubricKey, number>;

export const DEFAULT_WEIGHTS: RubricWeights = {
  technical: 30,
  innovation: 25,
  impact: 25,
  polish: 20,
};

export interface ActiveRubric {
  version: number;
  weights: RubricWeights;
}

type P = { eventId: string };

const resolveEventId = (req: { params: unknown }): string | undefined =>
  (req.params as P).eventId;
const readEvent = requireEventRole(resolveEventId, "participant", "judge", "organizer");
const organizeEvent = requireEventRole(resolveEventId, "organizer");

function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* keep original error */
  }
}

async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Pure: validate a weights payload. Sum must equal 100 (float-tolerant). */
export function validateWeights(input: unknown):
  | { ok: true; weights: RubricWeights }
  | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "invalid_weights" };
  const rec = input as Record<string, unknown>;
  const out = {} as Record<RubricKey, number>;
  for (const k of RUBRIC_KEYS) {
    const n = rec[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: "invalid_weights" };
    }
    out[k] = n;
  }
  for (const k of Object.keys(rec)) {
    if (!(RUBRIC_KEYS as readonly string[]).includes(k)) return { ok: false, error: "invalid_weights" };
  }
  const sum = RUBRIC_KEYS.reduce((a, k) => a + out[k], 0);
  if (Math.abs(sum - 100) > 1e-9) return { ok: false, error: "invalid_weights" };
  return { ok: true, weights: out as RubricWeights };
}

/** Pure: next version number given the current max (null/0 when no rows). */
export function nextRubricVersion(maxVersion: number | null | undefined): number {
  return (maxVersion ?? 0) + 1;
}

/** Pure: weighted composite 0..100 rounded to 2dp (same semantics everywhere). */
export function compositeFor(weights: RubricWeights, criteria: RubricWeights): number {
  const raw =
    (weights.technical / 100) * criteria.technical +
    (weights.innovation / 100) * criteria.innovation +
    (weights.impact / 100) * criteria.impact +
    (weights.polish / 100) * criteria.polish;
  return Math.round(raw * 100) / 100;
}

function coerceWeights(raw: unknown): RubricWeights | undefined {
  const parsed = validateWeights(raw);
  return parsed.ok ? parsed.weights : undefined;
}

/** Active rubric for an event; falls back to v1 defaults when no row exists. */
export async function fetchActiveRubric(eventId: string): Promise<ActiveRubric> {
  try {
    const r = await pool.query<{ version: number; weights: unknown }>(
      `SELECT version, weights FROM rubric_versions WHERE event_id = $1 AND is_active = true LIMIT 1`,
      [eventId],
    );
    const row = r.rows[0];
    if (row) {
      const weights = coerceWeights(row.weights);
      if (weights) return { version: row.version, weights };
    }
  } catch {
    /* table missing or unreadable → defaults preserve current behavior */
  }
  return { version: 1, weights: { ...DEFAULT_WEIGHTS } };
}

interface RubricVersionRow {
  id: string;
  event_id: string;
  version: number;
  weights: unknown;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

const outRubric = (r: RubricVersionRow): Record<string, unknown> => ({
  ...r,
  weights: coerceWeights(r.weights) ?? { ...DEFAULT_WEIGHTS },
});

export async function registerRubricRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get("/api/events/:eventId/rubric", { preHandler: [readEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const active = await fetchActiveRubric(eventId);
    return reply.send({ event_id: eventId, version: active.version, weights: active.weights, is_active: true });
  });

  app.post("/api/events/:eventId/rubrics", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const candidate = body.weights !== undefined ? body.weights : body;
    const parsed = validateWeights(candidate);
    if (!parsed.ok) return reply.code(422).send({ error: parsed.error });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('rubric_' || $1))`, [eventId]);
      const maxRow = (
        await client.query<{ max_version: number | null }>(
          `SELECT COALESCE(MAX(version), 0) AS max_version FROM rubric_versions WHERE event_id = $1`,
          [eventId],
        )
      ).rows[0];
      const version = nextRubricVersion(maxRow?.max_version);
      await client.query(`UPDATE rubric_versions SET is_active = false WHERE event_id = $1`, [eventId]);
      const row = (
        await client.query<RubricVersionRow>(
          `INSERT INTO rubric_versions (event_id, version, weights, is_active, created_by)
           VALUES ($1, $2, $3, true, $4) RETURNING *`,
          [eventId, version, JSON.stringify(parsed.weights), userId],
        )
      ).rows[0];
      await client.query("COMMIT");
      if (!row) return reply.code(500).send({ error: "create_failed" });
      return reply.code(201).send(outRubric(row));
    } catch (err) {
      await safeRollback(client);
      throw err;
    } finally {
      client.release();
    }
  });
}

export default registerRubricRoutes;
