/**
 * Synthetic judging fixtures — deterministic, pure, seeded.
 *
 * Seeded RNG only (mulberry32 over FNV-1a of "dogfood-2026").
 * No Math.random, no Date.now, no I/O. Same output on every run.
 *
 * Shape: 40 projects (p01..p40 across 8 tracks t1..t8), 30 judges
 * (j01..j30) each scoring a batch of ~8 projects (values 0..100).
 *
 * Baked-in edge cases:
 * - j28 constant rater (all 70s)
 * - j29 harsh judge (values 20..40, mean ~30)
 * - j30 generous judge (values 80..100, mean ~90)
 * - j27 incomplete batch (2 scores only)
 * - duplicate entry (same judge+project twice = rescore, last wins)
 * - disqualified projects (see DISQUALIFIED_PROJECT_IDS / excluded)
 * - mid-run rubric-edit analogue (RESCORED_PROJECT_ID rescored +15, clamped)
 *
 * NOTE: the pipeline (`runPipeline`) accepts an `excluded` set AND honours
 * it before normalization. Callers (scripts/simulate.ts) keep a
 * simulate-side filter as well; both orders commute because exclusion is
 * idempotent set subtraction — filtering then passing `excluded` yields
 * the same effective entries as passing `excluded` alone.
 */

export interface ScoreEntry {
  projectId: string;
  judgeId: string;
  value: number;
}

export interface FixtureSet {
  entries: ScoreEntry[];
  excluded: Set<string>;
}

/** Canonical seed string — part of the reproducibility contract. */
export const SYNTHETIC_SEED = "dogfood-2026";

export const PROJECT_IDS: string[] = Array.from(
  { length: 40 },
  (_, i) => `p${String(i + 1).padStart(2, "0")}`,
);

export const JUDGE_IDS: string[] = Array.from(
  { length: 30 },
  (_, i) => `j${String(i + 1).padStart(2, "0")}`,
);

export const TRACK_IDS: string[] = Array.from(
  { length: 8 },
  (_, i) => `t${i + 1}`,
);

/** Round-robin track assignment: p01->t1 … p08->t8, p09->t1 … (5 per track). */
export const TRACK_OF_PROJECT: Record<string, string> = Object.fromEntries(
  PROJECT_IDS.map((p, i) => [p, `t${(i % 8) + 1}`]),
);

/** Disqualified projects — excluded from pipeline input by the caller. */
export const DISQUALIFIED_PROJECT_IDS: string[] = ["p39", "p40"];

/** Project receiving the rubric-edit analogue rescore (shifted +15). */
export const RESCORED_PROJECT_ID = "p07";

const INCOMPLETE_JUDGE_ID = "j27";
const CONSTANT_JUDGE_ID = "j28";
const HARSH_JUDGE_ID = "j29";
const GENEROUS_JUDGE_ID = "j30";
const NORMAL_JUDGE_COUNT = 26;

/** FNV-1a 32-bit hash: maps the seed string to a uint32 for mulberry32. */
function seedToUint32(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 — small deterministic PRNG. Single sequential stream. */
function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFixtures(): FixtureSet {
  const rand = mulberry32(seedToUint32(SYNTHETIC_SEED));
  const intBelow = (n: number): number => Math.floor(rand() * n);
  const int100 = (): number => Math.round(rand() * 100);

  // Partial Fisher–Yates over a fresh project pool: distinct projects
  // within one judge's batch, overlapping across judges ("disjoint-ish").
  const takeBatch = (count: number): string[] => {
    const pool = [...PROJECT_IDS];
    const batch: string[] = [];
    for (let k = 0; k < count; k += 1) {
      const j = k + intBelow(pool.length - k);
      const tmp = pool[k]!;
      pool[k] = pool[j]!;
      pool[j] = tmp!;
      batch.push(pool[k]!);
    }
    batch.sort();
    return batch;
  };

  const entries: ScoreEntry[] = [];

  // Normal judges j01..j26: 8 projects each, uniform 0..100.
  for (let ji = 0; ji < NORMAL_JUDGE_COUNT; ji += 1) {
    const judgeId = JUDGE_IDS[ji]!;
    for (const projectId of takeBatch(8)) {
      entries.push({ projectId, judgeId, value: int100() });
    }
  }

  // Incomplete batch: j27 scores only 2 projects.
  for (const projectId of takeBatch(2)) {
    entries.push({ projectId, judgeId: INCOMPLETE_JUDGE_ID, value: int100() });
  }

  // Constant rater: j28 scores all 70s (zero-variance judge).
  for (const projectId of takeBatch(8)) {
    entries.push({ projectId, judgeId: CONSTANT_JUDGE_ID, value: 70 });
  }

  // Harsh judge: j29 values 20..40 (mean ~30).
  for (const projectId of takeBatch(8)) {
    entries.push({
      projectId,
      judgeId: HARSH_JUDGE_ID,
      value: 20 + Math.round(rand() * 20),
    });
  }

  // Generous judge: j30 values 80..100 (mean ~90).
  for (const projectId of takeBatch(8)) {
    entries.push({
      projectId,
      judgeId: GENEROUS_JUDGE_ID,
      value: 80 + Math.round(rand() * 20),
    });
  }

  // Duplicate entry = rescore analogue: same judge+project twice, last wins.
  const first = entries[0]!;
  entries.push({
    projectId: first.projectId,
    judgeId: first.judgeId,
    value: (first.value + 37) % 101,
  });

  // Mid-run rubric-edit analogue: every score on RESCORED_PROJECT_ID is
  // re-entered shifted +15 (clamped to 100). Appended last so last-wins
  // semantics apply the shift deterministically.
  const rescored = entries.filter((e) => e.projectId === RESCORED_PROJECT_ID);
  for (const e of rescored) {
    entries.push({
      projectId: e.projectId,
      judgeId: e.judgeId,
      value: Math.min(100, e.value + 15),
    });
  }

  return { entries, excluded: new Set(DISQUALIFIED_PROJECT_IDS) };
}

/** Canonical seed for the ground-truth leg — separate stream, same discipline. */
export const GROUND_TRUTH_SEED = "dogfood-2026-truth";

/** Latent project quality used only to score methods, never fed to them. */
export interface LatentQuality {
  projectId: string;
  quality: number;
}

export interface GroundTruthSet {
  truth: LatentQuality[];
  entries: ScoreEntry[];
}

/**
 * Ground-truth leg: latent quality per project plus biased judge
 * observations with partial overlap. Each judge has an additive
 * harshness bias (~[-25, +25]) and a spread factor (~[0.5, 1.5]);
 * observed = clamp(round(quality + bias + noise * spread)).
 * One sequential mulberry32 stream over GROUND_TRUTH_SEED; no dupes.
 */
export function generateGroundTruth(): GroundTruthSet {
  const rand = mulberry32(seedToUint32(GROUND_TRUTH_SEED));
  const truth: LatentQuality[] = PROJECT_IDS.map((p) => ({
    projectId: p,
    quality: Math.round((20 + rand() * 70) * 10000) / 10000,
  }));
  const qualityOf = new Map(truth.map((t) => [t.projectId, t.quality]));
  const takeBatchFrom = (count: number): string[] => {
    const pool = [...PROJECT_IDS];
    const batch: string[] = [];
    for (let k = 0; k < count; k += 1) {
      const j = k + Math.floor(rand() * (pool.length - k));
      const tmp = pool[k]!;
      pool[k] = pool[j]!;
      pool[j] = tmp!;
      batch.push(pool[k]!);
    }
    batch.sort();
    return batch;
  };
  const entries: ScoreEntry[] = [];
  for (const judgeId of JUDGE_IDS) {
    const bias = rand() * 50 - 25;
    const spread = 0.5 + rand() * 1.0;
    for (const projectId of takeBatchFrom(8)) {
      const q = qualityOf.get(projectId) ?? 50;
      const noise = rand() * 20 - 10;
      const v = Math.round(q + bias + noise * spread);
      entries.push({ projectId, judgeId, value: Math.min(100, Math.max(0, v)) });
    }
  }
  return { truth, entries };
}
