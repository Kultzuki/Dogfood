/**
 * CSV exports (streaming) + validated JSON-row imports.
 *
 * All endpoints organizer-only (organizeEvent → others get 404, never 403).
 * Judges cannot export even their own scores — documented posture.
 * 401 unauthenticated · 404 not-found (incl. missing parallel-worker tables,
 * never 500 on 42P01) · 422 bad dataset/body/row-shape.
 *
 * Tables judge_assignments / scores / audit_logs are owned by parallel
 * workers: every query is defensive (SELECT * + key mapping; missing table
 * → 404). Centering math is the engine duplicate in ../lib/csv.js (the
 * eslint judging-import ban covers src/routes, so no engine import here).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/index.js";
import { requireAuth, requireEventRole } from "../authz/guards.js";
import { appendAuditForRequest, type PoolLike } from "../lib/audit.js";

async function emit(req: FastifyRequest, entry: Omit<Parameters<typeof appendAuditForRequest>[2], "actorUserId">): Promise<void> {
  try { await appendAuditForRequest(pool as unknown as PoolLike, req as unknown as { session?: Record<string, unknown> }, entry); } catch (err) { req.log.warn({ err }, "audit_emit_failed"); }
}
import {
  EXPORT_DATASETS,
  cellText,
  centerAndRank,
  csvStream,
  headerFor,
  rankedToRecord,
  validateAssignmentRow,
  validateScoreRow,
  type CenterEntry,
  type ExportDataset,
  type ImportDataset,
  type RowReport,
} from "../lib/csv.js";

const MAX_IMPORT_ROWS = 2000;

type P = { eventId: string };

const resolveEventId = (req: { params: unknown }): string | undefined =>
  (req.params as P).eventId;
const organizeEvent = requireEventRole(resolveEventId, "organizer");

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

const isMissingTable = (err: unknown): boolean => pgCode(err) === "42P01";

async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

type AnyRow = Record<string, unknown>;
const str = (r: AnyRow, k: string): string => cellText(r[k]);

async function tableRows(table: string, eventId: string, order: string): Promise<AnyRow[]> {
  const r = await pool.query(`SELECT * FROM ${table} WHERE event_id = $1 ORDER BY ${order}`, [eventId]);
  return r.rows as AnyRow[];
}

function exportRecords(dataset: ExportDataset, rows: AnyRow[]): Record<string, string>[] {
  switch (dataset) {
    case "assignments":
      return rows.map((r) => ({
        event_id: str(r, "event_id"), project_id: str(r, "project_id"),
        judge_user_id: str(r, "judge_user_id"), track_id: str(r, "track_id"),
        status: str(r, "status"),
      }));
    case "scores-raw":
      return rows.map((r) => ({
        id: str(r, "id"), event_id: str(r, "event_id"), project_id: str(r, "project_id"),
        judge_user_id: str(r, "judge_user_id"), value: str(r, "value"),
        version: str(r, "version"), is_current: str(r, "is_current"),
        created_at: str(r, "created_at"),
      }));
    case "scores-normalized":
    case "rankings": {
      // Center over is_current=true rows (absent flag ⇒ treat as current).
      const entries: CenterEntry[] = [];
      for (const r of rows) {
        if (r["is_current"] === false) continue;
        const v = Number(r["value"]);
        if (!Number.isFinite(v)) continue;
        entries.push({
          projectId: str(r, "project_id"),
          judgeId: str(r, "judge_user_id"),
          value: v,
        });
      }
      return centerAndRank(entries).map(rankedToRecord);
    }
    case "audit":
      return rows.map((r) => ({
        seq: str(r, "seq"), event_id: str(r, "event_id"),
        actor_user_id: str(r, "actor_user_id"), action: str(r, "action"),
        resource_type: str(r, "resource_type"), resource_id: str(r, "resource_id"),
        created_at: str(r, "created_at"),
      }));
  }
}

const EXPORT_SOURCE: Record<ExportDataset, { table: string; order: string }> = {
  assignments: { table: "judge_assignments", order: "project_id, judge_user_id" },
  "scores-raw": { table: "scores", order: "created_at, id" },
  "scores-normalized": { table: "scores", order: "created_at, id" },
  rankings: { table: "scores", order: "created_at, id" },
  audit: { table: "audit_logs", order: "created_at, id" },
};

async function scopedIds(table: string, eventId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await pool.query(
    `SELECT id FROM ${table} WHERE event_id = $1 AND id = ANY($2)`, [eventId, ids],
  );
  return new Set(r.rows.map((x) => String((x as { id: unknown }).id)));
}

async function userIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await pool.query("SELECT id FROM users WHERE id = ANY($1)", [ids]);
  return new Set(r.rows.map((x) => String((x as { id: unknown }).id)));
}

function coerceRows(body: unknown): Record<string, string>[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length > MAX_IMPORT_ROWS) return undefined;
  const out: Record<string, string>[] = [];
  for (const item of rows) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const rec: Record<string, string> = {};
    for (const [k, v] of Object.entries(item as Record<string, unknown>))
      rec[k] = v === null || v === undefined ? "" : String(v);
    out.push(rec);
  }
  return out;
}

export type ImportResult =
  | { imported: number; errors: RowReport[] }
  | { error: "not_found" | "invalid_reference" };

/**
 * Validated JSON-row import core (extracted for page-handler reuse;
 * behavior identical to the original inline route body).
 * Zero partial writes: any error ⇒ nothing written.
 */
export async function runImport(
  db: typeof pool,
  eventId: string,
  dataset: ImportDataset,
  rows: Record<string, string>[],
): Promise<ImportResult> {
  // ── Phase 1: shape validation (all rows) ──
  const errors: RowReport[] = [];
  const values: number[] = [];
  rows.forEach((r, i) => {
    if (dataset === "assignments") {
      const errs = validateAssignmentRow(r, eventId);
      if (errs.length > 0) errors.push({ row: i + 1, errors: errs });
    } else {
      const { errors: errs, value } = validateScoreRow(r, eventId);
      values.push(value);
      if (errs.length > 0) errors.push({ row: i + 1, errors: errs });
    }
  });

  // ── Phase 2: batched FK existence (defensive: missing table → 404) ──
  if (errors.length === 0) {
    try {
      const pids = [...new Set(rows.map((r) => String(r["project_id"] ?? "")))];
      const jids = [...new Set(rows.map((r) => String(r["judge_user_id"] ?? "")))];
      const [projects, users] = await Promise.all([
        scopedIds("projects", eventId, pids),
        userIds(jids),
      ]);
      let tracks = new Set<string>();
      if (dataset === "assignments") {
        const tids = [...new Set(rows.map((r) => String(r["track_id"] ?? "")).filter((t) => t !== ""))];
        tracks = await scopedIds("tracks", eventId, tids);
      }
      rows.forEach((r, i) => {
        const errs: string[] = [];
        if (!projects.has(String(r["project_id"]))) errs.push("unknown_project");
        if (!users.has(String(r["judge_user_id"]))) errs.push("unknown_judge");
        const t = String(r["track_id"] ?? "");
        if (dataset === "assignments" && t !== "" && !tracks.has(t)) errs.push("unknown_track");
        if (errs.length > 0) errors.push({ row: i + 1, errors: errs });
      });
    } catch (err: unknown) {
      if (isMissingTable(err)) return { error: "not_found" };
      throw err;
    }
  }

  // Zero partial writes: any error ⇒ nothing written.
  if (errors.length > 0) return { imported: 0, errors };

  // ── Phase 3: single-transaction insert ──
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    try {
      if (dataset === "assignments") {
        for (const r of rows) {
          const t = String(r["track_id"] ?? "");
          await client.query(
            "INSERT INTO judge_assignments (event_id, project_id, judge_user_id, track_id, status) VALUES ($1,$2,$3,$4,$5)",
            [eventId, r["project_id"], r["judge_user_id"], t === "" ? null : t, r["status"]],
          );
        }
      } else {
        for (let i = 0; i < rows.length; i++)
          await client.query(
            "INSERT INTO scores (event_id, project_id, judge_user_id, value) VALUES ($1,$2,$3,$4)",
            [eventId, rows[i]?.["project_id"], rows[i]?.["judge_user_id"], values[i]],
          );
      }
      await client.query("COMMIT");
    } catch (err: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch { /* keep original error */ }
      if (isMissingTable(err)) return { error: "not_found" };
      if (pgCode(err) === "23503") return { error: "invalid_reference" };
      throw err;
    }
    return { imported: rows.length, errors: [] };
  } finally {
    client.release();
  }
}

export default async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  app.get("/api/events/:eventId/export", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const dataset = (req.query as { dataset?: unknown }).dataset;
    if (typeof dataset !== "string" || !(EXPORT_DATASETS as readonly string[]).includes(dataset))
      return reply.code(422).send({ error: "invalid_dataset" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const ds = dataset as ExportDataset;
    try {
      const src = EXPORT_SOURCE[ds];
      const records = exportRecords(ds, await tableRows(src.table, eventId, src.order));
      return reply
        .header("content-type", "text/csv")
        .header("content-disposition", `attachment; filename="${eventId}-${ds}.csv"`)
        .send(csvStream(headerFor(ds), records));
    } catch (err: unknown) {
      if (isMissingTable(err)) return reply.code(404).send({ error: "not_found" });
      throw err;
    }
  });

  app.post("/api/events/:eventId/import", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const dataset = (req.query as { dataset?: unknown }).dataset;
    if (dataset !== "assignments" && dataset !== "scores")
      return reply.code(422).send({ error: "invalid_dataset" });
    const rows = coerceRows(req.body);
    if (rows === undefined) return reply.code(422).send({ error: "invalid_body" });
    if (!(await eventExists(eventId))) return reply.code(404).send({ error: "not_found" });
    const ds = dataset as ImportDataset;
    const out = await runImport(pool, eventId, ds, rows);
    if ("error" in out)
      return reply.code(out.error === "not_found" ? 404 : 422).send({ error: out.error });
    await emit(req, { eventId, action: "admin.action", resourceType: "event", resourceId: eventId, detail: { dataset: ds, imported: out.imported } });
    return reply.send(out);
  });
}
