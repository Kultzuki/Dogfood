/**
 * Judging pipeline entry point: validate → dedupe → exclude →
 * canonical-sort → normalize → aggregate → rank, with audit hashing.
 *
 * Order rationale: invalid rows are dropped BEFORE dedupe so an invalid
 * rescore can never shadow a prior valid score; disqualified projects
 * are removed before normalization so they cannot shift judge/global
 * statistics; the usable entries are canonical-sorted before
 * normalization so group statistics are exactly permutation-invariant.
 *
 * Deterministic by construction: canonical input ordering, population
 * statistics, 6-decimal rounding, and a total-order tie-break chain
 * evaluated on rounded values. No randomness, no clocks, no I/O,
 * no web/DB imports.
 */

import { createHash } from "node:crypto";
import { aggregateByProject } from "./aggregate.js";
import { isUsableEntry } from "./validate.js";
import { mean, normalizeEntries, populationStd, round6 } from "./normalize.js";
import { rankProjects } from "./rank.js";
import type { Method, PipelineOut, RankRow, ScoreEntry } from "./types.js";

export type { Method, PipelineOut, RankRow, ScoreEntry };

/**
 * Canonical ordering: (judgeId, projectId, value). Code-unit string
 * comparison keeps the order locale-independent and reproducible.
 */
export function canonicalSort(entries: readonly ScoreEntry[]): ScoreEntry[] {
  return [...entries].sort((a, b) => {
    if (a.judgeId !== b.judgeId) return a.judgeId < b.judgeId ? -1 : 1;
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return a.value - b.value;
  });
}

/**
 * SHA-256 hex of the canonical JSON of `entries` (sorted copy with
 * fixed key order). Input-order independent: any permutation of the
 * same multiset of entries yields the same hash. Never throws on data.
 */
export function hashEntries(entries: ScoreEntry[]): string {
  const list: ScoreEntry[] = Array.isArray(entries) ? entries : [];
  const canonical = canonicalSort(list).map((e) => ({
    judgeId: e.judgeId,
    projectId: e.projectId,
    value: e.value,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Rescore rule: a duplicate (judgeId, projectId) pair keeps the LAST
 * entry in input order. Callers MUST supply time-ordered input (later
 * rescores appended last); ties on identical keys keep the later
 * array position. Returns entries in first-seen key order; the
 * pipeline canonical-sorts afterwards, so output order is deterministic.
 *
 * NOTE: dedupe assumes pre-validated input — the pipeline filters to
 * usable entries BEFORE calling this, so an invalid rescore never
 * erases a prior valid score. Do not call dedupe on unvalidated input.
 */
export function dedupeRescores(entries: readonly ScoreEntry[]): ScoreEntry[] {
  const latest = new Map<string, ScoreEntry>();
  for (const e of entries) {
    latest.set(JSON.stringify([e.judgeId, e.projectId]), e);
  }
  return [...latest.values()];
}

/**
 * Run the full judging pipeline.
 *
 * - `entries`: raw scores in time order (later rescores appended last);
 *   malformed rows are dropped BEFORE dedupe, never thrown on.
 * - `method`: normalization strategy; unknown names throw (config error).
 * - `excluded`: disqualified project ids, honoured before normalization
 *   (DQ entries cannot shift judge/global statistics).
 *
 * `inputHash` is the post-dedupe multiset fingerprint: SHA-256 over the
 * effective (validated, deduped, non-excluded, canonical-sorted) entries.
 * Equal hash + equal method implies equal ranking. Raw-input permutations
 * (including rescore positions that resolve to the same effective set)
 * hash identically; differing raw inputs that reduce to the same
 * effective set also hash identically — by design.
 *
 * `method`/`excluded` (sorted) are recorded on the output for audit.
 * `mean`/`std` are the population statistics over the projects'
 * normalized scores, rounded to 6 decimals. Empty effective input
 * yields an empty ranking with mean/std 0.
 */
export function runPipeline(
  entries: ScoreEntry[],
  method: Method,
  excluded?: Set<string>,
): PipelineOut {
  const list: ScoreEntry[] = Array.isArray(entries) ? entries : [];
  const valid = list.filter((e) => isUsableEntry(e));
  const deduped = dedupeRescores(valid);
  const usable = deduped.filter(
    (e) => excluded === undefined || !excluded.has(e.projectId),
  );
  const ordered = canonicalSort(usable);
  const inputHash = hashEntries(ordered);
  const normalized = normalizeEntries(ordered, method);
  const ranking = rankProjects(aggregateByProject(normalized));
  const scores = ranking.map((r) => r.normalized);
  const excludedOut = excluded === undefined ? [] : [...excluded].sort();
  return {
    ranking,
    mean: round6(mean(scores)),
    std: round6(populationStd(scores)),
    inputHash,
    method,
    excluded: excludedOut,
  };
}
