/**
 * Append-only hash-chained audit log — helper + chain math.
 *
 * Covered actions: assignment.create, rubric.create, rubric.update,
 * score.submit, score.rescore, project.disqualify (flag stub: records
 * event+project even though DQ enforcement is Wave 4), event.finalize
 * (transition to RESULTS_FINAL), event.publish, admin.action.
 *
 * 3-line call pattern for emitting routes (scores/events workers):
 * ```ts
 * import { appendAudit } from "../lib/audit.js";
 * const actor = req.session["userId"] as string | undefined;
 * await appendAudit(pool, { eventId, actorUserId: actor ?? null,
 *   action: "score.submit", resourceType: "score", resourceId: scoreId, detail: {} });
 * ```
 *
 * Best-effort emit tradeoff: route handlers MUST call appendAuditForRequest
 * only after auth (requireAuth first, else audit_actor_missing) and MUST wrap
 * it in try/catch that logs via req.log/app.log and never rethrows, so an
 * audit failure (DB outage, missing table, hash error) can never fail or
 * roll back the primary competition-critical mutation. Missed rows are
 * preferable to blocked scoring/assignment/transitions; verifyChain flags
 * gaps only as sequence breaks, not as mutation errors.
 *
 * Chain: hash = sha256hex(prev_hash + '|' + event_id + '|' + actor + '|'
 *   + action + '|' + resource_type + '|' + resource_id + '|'
 *   + canonicalJson(detail) + '|' + created_atISO). First row uses 'GENESIS'.
 * NOTE: when the pool offers connect(), the prev-read + insert run inside
 * one transaction holding pg_advisory_xact_lock('audit_chain'), so concurrent
 * appends serialize and the chain stays linear. Without connect() (tests),
 * callers must serialize externally — seq remains the total order and
 * verifyChain flags any fork.
 */
import { createHash } from "node:crypto";

export const GENESIS = "GENESIS";

export const AUDIT_ACTIONS = [
  "assignment.create",
  "rubric.create",
  "rubric.update",
  "score.submit",
  "score.rescore",
  "project.disqualify",
  "event.finalize",
  "event.publish",
  "admin.action",
  "vote.cast",
  "voting.window",
  "comment.create",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Minimal pool surface so this lib stays pure-ish (no direct db import). */
export interface PoolClientLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: AuditRow[]; rowCount?: number | null }>;
  release(): void;
}

export interface PoolLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: AuditRow[]; rowCount?: number | null }>;
  connect?: () => Promise<PoolClientLike>;
}

export interface AuditEntry {
  eventId: string | null;
  trackId?: string | null;
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  detail?: unknown;
}

export interface AuditRow {
  id: string;
  seq: string | number;
  event_id: string | null;
  track_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  detail: unknown;
  prev_hash: string;
  hash: string;
  created_at: string | Date;
}

/** Deterministic JSON: sorted keys recursively, numbers as-is (no toFixed). */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toIso(createdAt: string | Date): string {
  return createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
}

/** Pure: recompute a row's hash from its stored fields + given prev. */
export function computeRowHash(row: AuditRow, prev: string): string {
  const payload = [
    prev,
    row.event_id ?? "",
    row.actor_user_id ?? "",
    row.action,
    row.resource_type,
    row.resource_id,
    canonicalJson(row.detail ?? {}),
    toIso(row.created_at),
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Append one audit entry. Reads MAX(hash) as prev (or GENESIS), inserts,
 * returns the inserted row. created_at is set here so the hash commits to it.
 */
export async function appendAudit(pool: PoolLike, entry: AuditEntry): Promise<AuditRow> {
  const client = pool.connect ? await pool.connect() : undefined;
  const q: PoolLike | PoolClientLike = client ?? pool;
  try {
    if (client) {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('audit_chain'))");
    }
    const prevRes = await q.query(
      "SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1",
    );
    const prev: string =
      (prevRes.rows[0] as AuditRow | undefined)?.hash ?? GENESIS;
    const createdAt = new Date();
    const detail = entry.detail ?? {};
    const draft: AuditRow = {
      id: "",
      seq: 0,
      event_id: entry.eventId,
      track_id: entry.trackId ?? null,
      actor_user_id: entry.actorUserId ?? null,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId,
      detail,
      prev_hash: prev,
      hash: "",
      created_at: createdAt,
    };
    draft.hash = computeRowHash(draft, prev);
    const ins = await q.query(
      `INSERT INTO audit_logs
         (event_id, track_id, actor_user_id, action, resource_type, resource_id, detail, prev_hash, hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING *`,
      [
        draft.event_id,
        draft.track_id,
        draft.actor_user_id,
        draft.action,
        draft.resource_type,
        draft.resource_id,
        canonicalJson(detail),
        prev,
        draft.hash,
        createdAt.toISOString(),
      ],
    );
    if (client) await client.query("COMMIT");
    const row = ins.rows[0] as AuditRow | undefined;
    if (!row) throw new Error("audit_insert_failed");
    return row;
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Keep the original error.
      }
    }
    throw err;
  } finally {
    client?.release();
  }
}

/**
 * Request-bound append: derives the actor server-side from the session so
 * route handlers cannot forge actor_user_id from body params.
 */
export async function appendAuditForRequest(
  pool: PoolLike,
  req: { session?: Record<string, unknown> },
  entry: Omit<AuditEntry, "actorUserId">,
): Promise<AuditRow> {
  const actor = req.session?.["userId"];
  if (typeof actor !== "string" || actor.length === 0) {
    throw new Error("audit_actor_missing");
  }
  return appendAudit(pool, { ...entry, actorUserId: actor });
}

/**
 * Verify a seq-ordered chain. Recomputes each link; first row must build on
 * GENESIS. Returns { ok: true } or { ok: false, badSeq } at first break
 * (tampered row / fork).
 */
export function verifyChain(rows: AuditRow[]): { ok: boolean; badSeq?: string | number } {
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prev || computeRowHash(row, prev) !== row.hash)
      return { ok: false, badSeq: row.seq };
    prev = row.hash;
  }
  return { ok: true };
}
