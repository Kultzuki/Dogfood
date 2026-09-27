/**
 * CSV streaming exports + validated import helpers (pure: no DB, no I/O).
 *
 * STABLE COLUMN CONTRACTS (locked by csv.test.ts — never reorder/rename):
 *   assignments:       event_id,project_id,judge_user_id,track_id,status
 *   scores-raw:        id,event_id,project_id,judge_user_id,value,version,is_current,created_at
 *   scores-normalized: project_id,normalized,raw_mean,n,rank
 *   rankings:          project_id,normalized,raw_mean,n,rank (same row order as engine rank output)
 *   audit:             seq,event_id,actor_user_id,action,resource_type,resource_id,created_at
 *
 * AUTHZ (enforced in src/routes/exports.ts, organizer-only for every
 * dataset — simplest defensible posture; judges cannot export even their
 * own scores): 401 unauthenticated · 404 not-found (never 403) · 422 bad input.
 *
 * JUDGING ISOLATION: eslint.config.js bans `judging/` imports outside
 * src/judging, tests, and scripts — so `centerAndRank` below DUPLICATES the
 * 5-line centering math (raw − judgeMean + globalMean) instead of importing
 * the engine. Source of truth: src/judging/normalize.ts `normalizeCentering`,
 * src/judging/aggregate.ts `aggregateByProject`, src/judging/rank.ts
 * `rankProjects` (tie-break: normalized desc, rawMean desc, n desc,
 * projectId asc; round6 display values). Scores-normalized centers over
 * is_current=true rows only; filtering happens at the route layer.
 */

import { Readable } from "node:stream";

// ── Column contracts ────────────────────────────────────────────────

export const ASSIGNMENT_COLUMNS = [
  "event_id",
  "project_id",
  "judge_user_id",
  "track_id",
  "status",
] as const;

export const SCORES_RAW_COLUMNS = [
  "id",
  "event_id",
  "project_id",
  "judge_user_id",
  "value",
  "version",
  "is_current",
  "created_at",
] as const;

export const CENTERED_COLUMNS = [
  "project_id",
  "normalized",
  "raw_mean",
  "n",
  "rank",
] as const;

export const RANKING_COLUMNS = [...CENTERED_COLUMNS] as unknown as typeof CENTERED_COLUMNS;

export const AUDIT_COLUMNS = [
  "seq",
  "event_id",
  "actor_user_id",
  "action",
  "resource_type",
  "resource_id",
  "created_at",
] as const;

export type ExportDataset =
  | "assignments"
  | "scores-raw"
  | "scores-normalized"
  | "rankings"
  | "audit";

export type ImportDataset = "assignments" | "scores";

export const EXPORT_DATASETS: readonly ExportDataset[] = [
  "assignments",
  "scores-raw",
  "scores-normalized",
  "rankings",
  "audit",
];

export function headerFor(dataset: ExportDataset): readonly string[] {
  switch (dataset) {
    case "assignments":
      return ASSIGNMENT_COLUMNS;
    case "scores-raw":
      return SCORES_RAW_COLUMNS;
    case "scores-normalized":
      return CENTERED_COLUMNS;
    case "rankings":
      return RANKING_COLUMNS;
    case "audit":
      return AUDIT_COLUMNS;
  }
}

// ── RFC4180 escaper + streaming writer ──────────────────────────────

/** Escape one cell: quote when it contains `"`, `,`, `\r`, or `\n`. */
export function escapeCell(value: unknown): string {
  let s = cellText(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Async generator — header line first, then one line per row (memory-flat). */
export async function* csvLines(
  header: readonly string[],
  rows: Iterable<Record<string, string>> | AsyncIterable<Record<string, string>>,
): AsyncGenerator<string> {
  yield `${header.map(escapeCell).join(",")}\r\n`;
  const pick = (r: Record<string, string>): string =>
    `${header.map((c) => escapeCell(r[c] ?? "")).join(",")}\r\n`;
  if (Symbol.asyncIterator in Object(rows)) {
    for await (const r of rows as AsyncIterable<Record<string, string>>) yield pick(r);
  } else {
    for (const r of rows as Iterable<Record<string, string>>) yield pick(r);
  }
}

/** Node Readable for `reply.header('content-type','text/csv').send(stream)`. */
export function csvStream(
  header: readonly string[],
  rows: Iterable<Record<string, string>> | AsyncIterable<Record<string, string>>,
): Readable {
  return Readable.from(csvLines(header, rows));
}

// ── Centering + ranking (engine duplicate — see header comment) ─────

export interface CenterEntry {
  projectId: string;
  judgeId: string;
  value: number;
}

export interface RankedProject {
  projectId: string;
  normalized: number;
  rawMean: number;
  n: number;
  rank: number;
}

export function round6(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Math.round(x * 1_000_000) / 1_000_000;
  return r === 0 ? 0 : r;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Centered normalization + per-project aggregation + engine rank order. */
export function centerAndRank(entries: readonly CenterEntry[]): RankedProject[] {
  const usable = entries.filter((e) => Number.isFinite(e.value));
  const globalMean = mean(usable.map((e) => e.value));
  const byJudge = new Map<string, number[]>();
  for (const e of usable) {
    const b = byJudge.get(e.judgeId);
    if (b === undefined) byJudge.set(e.judgeId, [e.value]);
    else b.push(e.value);
  }
  const judgeMean = new Map<string, number>();
  for (const [j, vs] of byJudge) judgeMean.set(j, mean(vs));
  const byProject = new Map<string, { norm: number[]; raw: number[] }>();
  for (const e of usable) {
    const jm = judgeMean.get(e.judgeId) ?? globalMean;
    const normed = e.value - jm + globalMean;
    const b = byProject.get(e.projectId);
    if (b === undefined) byProject.set(e.projectId, { norm: [normed], raw: [e.value] });
    else {
      b.norm.push(normed);
      b.raw.push(e.value);
    }
  }
  const rows = [...byProject].map(([projectId, b]) => ({
    projectId,
    normalized: round6(mean(b.norm)),
    rawMean: round6(mean(b.raw)),
    n: b.norm.length,
  }));
  rows.sort((a, b) => {
    if (b.normalized !== a.normalized) return b.normalized - a.normalized;
    if (b.rawMean !== a.rawMean) return b.rawMean - a.rawMean;
    if (b.n !== a.n) return b.n - a.n;
    return a.projectId < b.projectId ? -1 : 1;
  });
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export function rankedToRecord(r: RankedProject): Record<string, string> {
  return {
    project_id: r.projectId,
    normalized: String(r.normalized),
    raw_mean: String(r.rawMean),
    n: String(r.n),
    rank: String(r.rank),
  };
}

// ── Import row validators (shape-level; FK existence is batched in routes) ──

export interface RowReport {
  row: number;
  errors: string[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Assignment lifecycle states accepted on import. */
export const ASSIGNMENT_STATUSES = ["active", "inactive", "withdrawn"] as const;

/** Shape checks for an assignments import row. Returns error codes. */
export function validateAssignmentRow(
  r: Record<string, string>,
  eventId: string,
): string[] {
  const errs: string[] = [];
  if (typeof r["event_id"] !== "string" || r["event_id"] !== eventId)
    errs.push("event_mismatch");
  if (!isUuid(r["project_id"])) errs.push("invalid_project_id");
  if (!isUuid(r["judge_user_id"])) errs.push("invalid_judge_user_id");
  const track = r["track_id"];
  if (track !== undefined && track !== "" && !isUuid(track))
    errs.push("invalid_track_id");
  if (
    typeof r["status"] !== "string" ||
    !(ASSIGNMENT_STATUSES as readonly string[]).includes(r["status"])
  )
    errs.push("invalid_status");
  return errs;
}

/** Shape checks for a scores import row. Returns error codes + parsed value. */
export function validateScoreRow(
  r: Record<string, string>,
  eventId: string,
): { errors: string[]; value: number } {
  const errs: string[] = [];
  const ev = r["event_id"];
  if (ev !== undefined && ev !== "" && ev !== eventId) errs.push("event_mismatch");
  if (!isUuid(r["project_id"])) errs.push("invalid_project_id");
  if (!isUuid(r["judge_user_id"])) errs.push("invalid_judge_user_id");
  const value = Number(r["value"]);
  if (!Number.isFinite(value) || value < 0 || value > 100)
    errs.push("invalid_value");
  return { errors: errs, value };
}
