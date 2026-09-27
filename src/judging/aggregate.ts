/**
 * Per-project aggregation of normalized scores.
 *
 * Pure and deterministic: grouping follows first-seen insertion order,
 * so callers that feed canonically sorted entries get canonical output.
 */

import { mean } from "./normalize.js";
import type { NormalizedEntry } from "./normalize.js";

/** Aggregated scores for one project. */
export interface ProjectAggregate {
  projectId: string;
  /** Mean of the entries' normalized values. */
  normalized: number;
  /** Mean of the entries' raw values. */
  rawMean: number;
  /** Number of (deduped, in-scope) scores behind this row. */
  n: number;
}

/**
 * Fold normalized entries into one row per project.
 * Empty input yields an empty array.
 */
export function aggregateByProject(entries: readonly NormalizedEntry[]): ProjectAggregate[] {
  const byProject = new Map<string, { normed: number[]; raw: number[] }>();
  for (const e of entries) {
    const bucket = byProject.get(e.projectId);
    if (bucket === undefined) {
      byProject.set(e.projectId, { normed: [e.normalized], raw: [e.raw] });
    } else {
      bucket.normed.push(e.normalized);
      bucket.raw.push(e.raw);
    }
  }
  const out: ProjectAggregate[] = [];
  for (const [projectId, bucket] of byProject) {
    out.push({
      projectId,
      normalized: mean(bucket.normed),
      rawMean: mean(bucket.raw),
      n: bucket.normed.length,
    });
  }
  return out;
}
