/**
 * Score normalization methods.
 *
 * All functions are pure and deterministic: no randomness, no clocks,
 * no I/O. Every fallback is chosen so the output can never be NaN
 * for finite input in [0, 100].
 *
 * Methods:
 * - "zscore-global": per-judge z-score mapped back onto the global
 *   mean/std scale. Removes harsh/generous rater bias while keeping
 *   scores interpretable on the original 0..100-ish scale.
 * - "centering": additive bias removal (normalized = raw - judgeMean
 *   + globalMean). Removes harsh/generous rater offsets without
 *   rescaling spread; no NaN by construction (means always defined).
 * - "raw-mean": identity (no adjustment); aggregation takes the mean.
 * - "median-mad": robust per-project center. Each entry maps to its
 *   project's median; the MAD (scaled by 1.4826, the Gaussian
 *   consistency constant) characterises spread for audit. Resists
 *   single-outlier distortion that drags raw means around.
 */

import type { Method, ScoreEntry } from "./types.js";

/** Scale factor converting MAD to a std-consistent spread (normal model). */
export const MAD_SCALE = 1.4826;

/** A score entry annotated with its normalized value. */
export interface NormalizedEntry {
  projectId: string;
  judgeId: string;
  raw: number;
  normalized: number;
}

/** Arithmetic mean; empty input yields 0. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation; empty input yields 0. */
export function populationStd(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/**
 * Round to 6 decimals for determinism across runtimes.
 * Non-finite input maps to 0 and negative zero is normalised to 0.
 */
export function round6(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Math.round(x * 1_000_000) / 1_000_000;
  return r === 0 ? 0 : r;
}

/** Median; empty input yields 0. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const v = sorted[mid];
    return v === undefined ? 0 : v;
  }
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return 0;
  return (lo + hi) / 2;
}

/** Median absolute deviation around `center` (defaults to the median). */
export function mad(values: readonly number[], center?: number): number {
  if (values.length === 0) return 0;
  const c = center === undefined ? median(values) : center;
  return median(values.map((v) => Math.abs(v - c)));
}

/** Robust per-project center with spread estimate for audit. */
export interface RobustCenter {
  median: number;
  mad: number;
  scaledMad: number;
}

/**
 * Median plus a MAD-based spread with a documented fallback chain:
 * MAD == 0 (e.g. majority-tied values) falls back to the mean absolute
 * deviation; a fully constant project yields spread 0.
 */
export function projectRobustCenter(values: readonly number[]): RobustCenter {
  const med = median(values);
  let m = mad(values, med);
  if (m === 0 && values.length > 0) {
    m = mean(values.map((v) => Math.abs(v - med)));
  }
  return { median: med, mad: m, scaledMad: MAD_SCALE * m };
}

function groupByJudge(entries: readonly ScoreEntry[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const bucket = groups.get(e.judgeId);
    if (bucket === undefined) {
      groups.set(e.judgeId, [e.value]);
    } else {
      bucket.push(e.value);
    }
  }
  return groups;
}

function groupByProject(entries: readonly ScoreEntry[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const bucket = groups.get(e.projectId);
    if (bucket === undefined) {
      groups.set(e.projectId, [e.value]);
    } else {
      bucket.push(e.value);
    }
  }
  return groups;
}

function normalizeZScoreGlobal(entries: readonly ScoreEntry[]): NormalizedEntry[] {
  const all = entries.map((e) => e.value);
  const globalMean = mean(all);
  const globalStd = populationStd(all);
  const judgeStats = new Map<string, { judgeMean: number; judgeStd: number }>();
  for (const [judgeId, values] of groupByJudge(entries)) {
    judgeStats.set(judgeId, { judgeMean: mean(values), judgeStd: populationStd(values) });
  }
  return entries.map((e) => {
    const stats = judgeStats.get(e.judgeId);
    const judgeMean = stats === undefined ? globalMean : stats.judgeMean;
    const judgeStd = stats === undefined ? 0 : stats.judgeStd;
    // Constant rater (sd == 0, incl. single-score judges): z = 0,
    // so the entry maps exactly to the global mean — no NaN, no bias.
    const z = judgeStd === 0 ? 0 : (e.value - judgeMean) / judgeStd;
    const normalized = globalStd === 0 ? globalMean : globalMean + z * globalStd;
    return { projectId: e.projectId, judgeId: e.judgeId, raw: e.value, normalized };
  });
}

function normalizeCentering(entries: readonly ScoreEntry[]): NormalizedEntry[] {
  const all = entries.map((e) => e.value);
  const globalMean = mean(all);
  const judgeMeans = new Map<string, number>();
  for (const [judgeId, values] of groupByJudge(entries)) {
    judgeMeans.set(judgeId, mean(values));
  }
  return entries.map((e) => {
    const judgeMean = judgeMeans.get(e.judgeId) ?? globalMean;
    return {
      projectId: e.projectId,
      judgeId: e.judgeId,
      raw: e.value,
      normalized: e.value - judgeMean + globalMean,
    };
  });
}

function normalizeRawMean(entries: readonly ScoreEntry[]): NormalizedEntry[] {
  return entries.map((e) => ({
    projectId: e.projectId,
    judgeId: e.judgeId,
    raw: e.value,
    normalized: e.value,
  }));
}

function normalizeMedianMad(entries: readonly ScoreEntry[]): NormalizedEntry[] {
  const centers = new Map<string, number>();
  for (const [projectId, values] of groupByProject(entries)) {
    centers.set(projectId, projectRobustCenter(values).median);
  }
  return entries.map((e) => {
    const center = centers.get(e.projectId);
    const normalized = center === undefined ? e.value : center;
    return { projectId: e.projectId, judgeId: e.judgeId, raw: e.value, normalized };
  });
}

/**
 * Map every entry to its normalized value under `method`.
 * Throws only on an unknown method name (configuration error, not data).
 */
export function normalizeEntries(
  entries: readonly ScoreEntry[],
  method: Method,
): NormalizedEntry[] {
  switch (method) {
    case "zscore-global":
      return normalizeZScoreGlobal(entries);
    case "centering":
      return normalizeCentering(entries);
    case "raw-mean":
      return normalizeRawMean(entries);
    case "median-mad":
      return normalizeMedianMad(entries);
    default:
      throw new Error(`normalizeEntries: unknown method ${(method as string) ?? "?"}`);
  }
}
