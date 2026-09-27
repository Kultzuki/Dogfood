/**
 * Public contract for the competition-integrity judging module.
 *
 * Pure types only — no imports, no side effects. The simulate worker
 * codes against these exact names and shapes; do not rename.
 */

export interface ScoreEntry {
  projectId: string;
  judgeId: string;
  value: number;
}

export type Method = "zscore-global" | "centering" | "raw-mean" | "median-mad";

export interface RankRow {
  projectId: string;
  normalized: number;
  rawMean: number;
  n: number;
  rank: number;
  tieBreak: string[];
}

export interface PipelineOut {
  ranking: RankRow[];
  mean: number;
  std: number;
  inputHash: string;
  method: Method;
  excluded: string[];
}
