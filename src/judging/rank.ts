/**
 * Deterministic ranking of aggregated project scores.
 *
 * Tie-break chain (applied in order, recorded on every row), evaluated
 * on values ROUNDED to 6 decimals (the displayed values):
 *   1. normalized desc
 *   2. rawMean desc
 *   3. n desc (more evidence wins)
 *   4. projectId asc (code-unit order — total, locale-independent)
 *
 * Because projectId is unique, the chain is a total order: ranks are
 * always sequential (1..k) with no shared positions, which keeps
 * downstream result finalization reproducible.
 */

import { round6 } from "./normalize.js";
import type { ProjectAggregate } from "./aggregate.js";
import type { RankRow } from "./types.js";

/** Documented tie-break chain, stored verbatim on every RankRow. */
export const TIE_BREAK_CHAIN: readonly string[] = [
  "normalized desc",
  "rawMean desc",
  "n desc",
  "projectId asc",
];

function compareProjectIdAsc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Sort aggregates into ranked rows. Sort keys are the ROUND6 values that
 * are displayed, so projects tied at 6 decimals resolve through the
 * documented chain (rawMean desc → n desc → projectId asc) instead of
 * leaking sub-display (1e-7) float noise into the order. Never throws
 * on data; empty input yields an empty array.
 */
export function rankProjects(projects: readonly ProjectAggregate[]): RankRow[] {
  const keys = projects.map((p) => ({
    p,
    norm: round6(p.normalized),
    raw: round6(p.rawMean),
  }));
  keys.sort((a, b) => {
    if (b.norm !== a.norm) return b.norm - a.norm;
    if (b.raw !== a.raw) return b.raw - a.raw;
    if (b.p.n !== a.p.n) return b.p.n - a.p.n;
    return compareProjectIdAsc(a.p.projectId, b.p.projectId);
  });
  return keys.map(({ p, norm, raw }, i) => ({
    projectId: p.projectId,
    normalized: norm,
    rawMean: raw,
    n: p.n,
    rank: i + 1,
    tieBreak: [...TIE_BREAK_CHAIN],
  }));
}
