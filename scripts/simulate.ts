/**
 * W4 normalization-method comparison harness.
 *
 * Run:  npm run simulate   (tsx scripts/simulate.ts)
 * Out:  evidence/w4-sims/<method>.csv + evidence/w4-sims/summary.txt
 *
 * For each method (zscore-global, centering, raw-mean, median-mad) runs
 * the judging `runPipeline` over the synthetic fixtures and writes a CSV
 * plus a summary comparing rank movement against the raw-mean baseline
 * and rank recovery against a seeded latent-quality ground truth.
 *
 * Exclusion note: runPipeline accepts an `excluded` set and honours it
 * before normalization. This script ALSO filters disqualified entries
 * simulate-side and passes `excluded` through; both orders commute
 * because exclusion is idempotent set subtraction, and the recorded
 * per-run `excluded` + `method` fields make the audit trail explicit.
 *
 * Deterministic: seeded fixtures, fixed float formatting (toFixed(4)),
 * no timestamps — reruns are byte-identical.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/judging/index.js";
import type {
  Method,
  PipelineOut,
  RankRow,
  ScoreEntry,
} from "../src/judging/index.js";
import { generateFixtures, generateGroundTruth } from "../src/judging/synthetic.js";
import type { LatentQuality } from "../src/judging/synthetic.js";

const METHODS: Method[] = ["zscore-global", "centering", "raw-mean", "median-mad"];
const BASELINE: Method = "raw-mean";
const TOP_K = 10;

const fmt = (x: number): string => x.toFixed(4);

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function populationStd(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

function rankOf(rows: RankRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.projectId, r.rank]));
}

function topKSet(rows: RankRow[], k: number): Set<string> {
  return new Set(
    [...rows].sort((a, b) => a.rank - b.rank).slice(0, k).map((r) => r.projectId),
  );
}

function truthTopK(truth: LatentQuality[], k: number): Set<string> {
  return new Set(
    [...truth]
      .sort((a, b) => b.quality - a.quality || (a.projectId < b.projectId ? -1 : 1))
      .slice(0, k)
      .map((t) => t.projectId),
  );
}

function spearmanVsTruth(truth: LatentQuality[], rows: RankRow[]): number {
  const pipeRank = rankOf(rows);
  const common = truth.filter((t) => pipeRank.has(t.projectId));
  const n = common.length;
  if (n < 2) return 0;
  const sorted = [...common].sort(
    (a, b) => b.quality - a.quality || (a.projectId < b.projectId ? -1 : 1),
  );
  const truthRank = new Map(sorted.map((t, i) => [t.projectId, i + 1]));
  let sumD2 = 0;
  for (const t of common) {
    const d = (truthRank.get(t.projectId) ?? 0) - (pipeRank.get(t.projectId) ?? 0);
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "evidence", "w4-sims");
mkdirSync(outDir, { recursive: true });

// Simulate-side DQ filter is kept AND `excluded` is passed through to the
// pipeline (commuting, idempotent set subtraction — see header note).
const { entries: rawEntries, excluded } = generateFixtures();
const entries: ScoreEntry[] = rawEntries.filter((e) => !excluded.has(e.projectId));

const results = new Map<Method, PipelineOut>();
for (const method of METHODS) {
  const out: PipelineOut = runPipeline(entries, method, excluded);
  results.set(method, out);
  const lines = ["projectId,normalized,rawMean,n,rank,tieBreak"];
  for (const r of out.ranking) {
    lines.push(
      `${r.projectId},${fmt(r.normalized)},${fmt(r.rawMean)},${r.n},${r.rank},${r.tieBreak.join("|")}`,
    );
  }
  writeFileSync(join(outDir, `${method}.csv`), `${lines.join("\n")}\n`, "utf8");
}

// Summary: per-run method+excluded+inputHash, per-method input (before)
// vs output (after) mean/std, pairwise rank movement vs the raw-mean
// baseline, and ground-truth rank recovery (Spearman + top-10 overlap).
const summary: string[] = [];
const first = results.get(METHODS[0]!)!;
summary.push(`inputHash: ${first.inputHash}`);
summary.push(`inputEntries: ${entries.length}`);
summary.push(`excludedProjects: ${[...excluded].sort().join(",")}`);
summary.push(
  `hashConsistent: ${METHODS.every((m) => results.get(m)!.inputHash === first.inputHash) ? "yes" : "NO"}`,
);
for (const method of METHODS) {
  const out = results.get(method)!;
  const normalized = out.ranking.map((r) => r.normalized);
  summary.push(
    `run method=${out.method} excluded=${out.excluded.join(",")} inputHash=${out.inputHash} ` +
      `inputMean=${fmt(out.mean)} inputStd=${fmt(out.std)} ` +
      `outputMean=${fmt(mean(normalized))} outputStd=${fmt(populationStd(normalized))} ` +
      `projects=${out.ranking.length}`,
  );
}

const baseRanks = rankOf(results.get(BASELINE)!.ranking);
const baseTop = topKSet(results.get(BASELINE)!.ranking, TOP_K);
for (const method of METHODS) {
  if (method === BASELINE) {
    summary.push(
      `vsBaseline method=${method} moved=0 up=0 down=0 same=${baseRanks.size} top${TOP_K}Overlap=${TOP_K}`,
    );
    continue;
  }
  const ranks = rankOf(results.get(method)!.ranking);
  const top = topKSet(results.get(method)!.ranking, TOP_K);
  let moved = 0;
  let up = 0;
  let down = 0;
  for (const [projectId, baseRank] of baseRanks) {
    const rank = ranks.get(projectId);
    if (rank === undefined || rank === baseRank) continue;
    moved += 1;
    if (rank < baseRank) up += 1;
    else down += 1;
  }
  let overlap = 0;
  for (const p of top) {
    if (baseTop.has(p)) overlap += 1;
  }
  const same = baseRanks.size - moved;
  summary.push(
    `vsBaseline method=${method} moved=${moved} up=${up} down=${down} same=${same} top${TOP_K}Overlap=${overlap}`,
  );
}

const { truth, entries: truthEntries } = generateGroundTruth();
const truthTop = truthTopK(truth, TOP_K);
summary.push(`truthEntries: ${truthEntries.length}`);
for (const method of METHODS) {
  const out: PipelineOut = runPipeline(truthEntries, method);
  const rho = spearmanVsTruth(truth, out.ranking);
  const top = topKSet(out.ranking, TOP_K);
  let overlap = 0;
  for (const p of top) {
    if (truthTop.has(p)) overlap += 1;
  }
  summary.push(
    `vsTruth method=${method} spearman=${fmt(rho)} top${TOP_K}Recovery=${overlap}`,
  );
}

const summaryText = `${summary.join("\n")}\n`;
writeFileSync(join(outDir, "summary.txt"), summaryText, "utf8");
console.log(summaryText.trimEnd());
