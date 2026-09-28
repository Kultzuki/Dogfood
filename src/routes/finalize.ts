import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { pool } from "../db/index.js";
import { requireEventRole } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";
import { centerAndRank, type CenterEntry } from "../lib/csv.js";

const FINALIZE_STATES = new Set([
  "SUBMISSIONS_CLOSED",
  "JUDGING",
  "RESULTS_FINAL",
  "PUBLISHED",
]);

const resolveEventId = (req: FastifyRequest): string | undefined =>
  (req.params as { eventId?: unknown }).eventId as string | undefined;
const organizeEvent = requireEventRole(resolveEventId, "organizer");
const readEvent = requireEventRole(resolveEventId, "participant", "judge", "organizer");

async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}

function hashEntries(entries: CenterEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.judgeId !== b.judgeId) return a.judgeId < b.judgeId ? -1 : 1;
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return a.value - b.value;
  });
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

async function currentEntries(eventId: string): Promise<CenterEntry[]> {
  const r = await pool.query<{ project_id: string; judge_user_id: string; value: string | number }>(
    `SELECT s.project_id, s.judge_user_id, s.value FROM scores s JOIN projects p ON p.id = s.project_id WHERE s.event_id = $1 AND s.is_current = true AND p.needs_review = false`,
    [eventId],
  );
  const out: CenterEntry[] = [];
  for (const row of r.rows) {
    const v = Number(row.value);
    if (!Number.isFinite(v)) continue;
    out.push({ projectId: row.project_id, judgeId: row.judge_user_id, value: v });
  }
  return out;
}

function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

export default async function finalizeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/events/:eventId/finalize", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as { eventId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const method = typeof body.method === "string" ? body.method : "centering";
    if (method !== "centering") return reply.code(422).send({ error: "invalid_method" });
    const ev = await pool.query<{ state: string }>(`SELECT state FROM events WHERE id = $1`, [eventId]);
    if ((ev.rowCount ?? 0) === 0) return reply.code(404).send({ error: "not_found" });
    const state = ev.rows[0]?.state ?? "";
    if (!FINALIZE_STATES.has(state)) return reply.code(422).send({ error: "wrong_state", state });
    const entries = await currentEntries(eventId);
    if (entries.length === 0) return reply.code(422).send({ error: "no_scores" });
    const inputHash = hashEntries(entries);
    const latest = await pool.query<{ id: string; input_hash: string }>(
      `SELECT id, input_hash FROM event_finalizations WHERE event_id = $1 AND method = $2 ORDER BY created_at DESC LIMIT 1`,
      [eventId, method],
    );
    if (latest.rows[0]?.input_hash === inputHash) {
      const rows = await pool.query(
        `SELECT er.project_id, er.raw_mean, er.normalized, er.n, er.rank FROM event_rankings er JOIN projects p ON p.id = er.project_id WHERE er.finalization_id = $1 AND p.needs_review = false ORDER BY er.rank ASC`,
        [latest.rows[0].id],
      );
      return reply.send({ finalization_id: latest.rows[0].id, event_id: eventId, method, input_hash: inputHash, rankings: rows.rows, stale: false, deduped: true });
    }
    const ranked = centerAndRank(entries);
    const userId = getUserId(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('finalize_' || $1))`, [eventId]);
      const fin = await client.query<{ id: string }>(
        `INSERT INTO event_finalizations (event_id, method, input_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [eventId, method, inputHash, userId ?? null],
      );
      const fid = fin.rows[0]?.id;
      if (!fid) { await client.query("ROLLBACK"); return reply.code(500).send({ error: "create_failed" }); }
      for (const r of ranked) {
        await client.query(
          `INSERT INTO event_rankings (finalization_id, event_id, project_id, raw_mean, normalized, n, rank) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [fid, eventId, r.projectId, r.rawMean, r.normalized, r.n, r.rank],
        );
      }
      await client.query("COMMIT");
      await emit(req, { eventId, action: "event.finalize", resourceType: "finalization", resourceId: fid, detail: { method, input_hash: inputHash, projects: ranked.length } });
      return reply.code(201).send({ finalization_id: fid, event_id: eventId, method, input_hash: inputHash, rankings: ranked.map((r) => ({ project_id: r.projectId, raw_mean: r.rawMean, normalized: r.normalized, n: r.n, rank: r.rank })), stale: false });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* keep original */ }
      throw e;
    } finally {
      client.release();
    }
  });

  app.get("/api/events/:eventId/rankings", { preHandler: [readEvent] }, async (req, reply) => {
    const { eventId } = req.params as { eventId: string };
    const ev = await pool.query<{ state: string }>(`SELECT state FROM events WHERE id = $1`, [eventId]);
    if ((ev.rowCount ?? 0) === 0) return reply.code(404).send({ error: "not_found" });
    const state = ev.rows[0]?.state ?? "";
    const isOrganizer = req.eventRole === "organizer";
    if (!isOrganizer && state !== "RESULTS_FINAL" && state !== "PUBLISHED") {
      return reply.code(404).send({ error: "not_found" });
    }
    const latest = await pool.query<{ id: string; input_hash: string; method: string; created_at: unknown }>(
      `SELECT id, input_hash, method, created_at FROM event_finalizations WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [eventId],
    );
    const fin = latest.rows[0];
    if (!fin) return reply.send({ event_id: eventId, rankings: [], finalized: false });
    const rows = await pool.query(
      `SELECT er.project_id, er.raw_mean, er.normalized, er.n, er.rank FROM event_rankings er JOIN projects p ON p.id = er.project_id WHERE er.finalization_id = $1 AND p.needs_review = false ORDER BY er.rank ASC`,
      [fin.id],
    );
    let stale = false;
    try {
      const entries = await currentEntries(eventId);
      stale = hashEntries(entries) !== fin.input_hash;
    } catch {
      stale = false;
    }
    return reply.send({ event_id: eventId, finalization_id: fin.id, method: fin.method, input_hash: fin.input_hash, created_at: fin.created_at, rankings: rows.rows, stale, finalized: true });
  });
}
