import { describe, expect, it } from "vitest";
import { hashEntries, runPipeline } from "./index.js";
import { rankProjects } from "./rank.js";
import type { Method, PipelineOut, ScoreEntry } from "./types.js";

const E = (projectId: string, judgeId: string, value: number): ScoreEntry => ({
  projectId,
  judgeId,
  value,
});

const top = (out: PipelineOut): string => out.ranking[0]?.projectId ?? "MISSING";
const order = (out: PipelineOut): string[] => out.ranking.map((r) => r.projectId);
const finite = (out: PipelineOut): boolean =>
  out.ranking.every((r) => Number.isFinite(r.normalized) && Number.isFinite(r.rawMean)) &&
  Number.isFinite(out.mean) &&
  Number.isFinite(out.std);

const METHODS: Method[] = ["zscore-global", "centering", "raw-mean", "median-mad"];

describe("judging engine pathological cases", () => {
  it("1. harsh judge preserves consensus order", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j1", 70),
      E("A", "j2", 80), E("B", "j2", 70),
      E("A", "harsh", 40), E("B", "harsh", 30),
    ];
    const out = runPipeline(entries, "zscore-global");
    expect(finite(out)).toBe(true);
    expect(top(out)).toBe("A");
  });

  it("2. generous judge preserves consensus order", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j1", 70),
      E("A", "j2", 82), E("B", "j2", 71),
      E("A", "gen", 100), E("B", "gen", 90),
    ];
    const out = runPipeline(entries, "zscore-global");
    expect(finite(out)).toBe(true);
    expect(top(out)).toBe("A");
  });

  it("3. low-variance and constant raters stay finite", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j1", 70),
      E("A", "flat", 51), E("B", "flat", 50),
      E("A", "const", 60), E("B", "const", 60),
    ];
    for (const m of METHODS) {
      const out = runPipeline(entries, m);
      expect(finite(out)).toBe(true);
      expect(top(out)).toBe("A");
    }
  });

  it("4. high-variance rater does not flip consensus", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j1", 70),
      E("A", "j2", 78), E("B", "j2", 72),
      E("A", "wild", 100), E("B", "wild", 0),
    ];
    const out = runPipeline(entries, "zscore-global");
    expect(finite(out)).toBe(true);
    expect(top(out)).toBe("A");
  });

  it("5. outlier swings raw-mean but median-mad resists", () => {
    const entries = [
      E("A", "j1", 80), E("A", "j2", 82), E("A", "j3", 81),
      E("B", "j1", 79), E("B", "j2", 78), E("B", "j3", 100),
    ];
    expect(top(runPipeline(entries, "raw-mean"))).toBe("B");
    expect(top(runPipeline(entries, "median-mad"))).toBe("A");
  });

  it("6. missing scores and malformed rows are tolerated", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j2", 70), E("A", "j2", 85),
      E("B", "j1", Number.NaN), E("", "j1", 50), E("C", "", 50),
      E("D", "j3", 200),
    ];
    const out = runPipeline(entries, "zscore-global");
    expect(finite(out)).toBe(true);
    expect(order(out).sort()).toEqual(["A", "B"]);
  });

  it("7. partial judge overlap ranks disjointly-rated projects", () => {
    const entries = [E("A", "j1", 90), E("B", "j1", 60), E("C", "j2", 80), E("D", "j2", 70)];
    const out = runPipeline(entries, "zscore-global");
    expect(finite(out)).toBe(true);
    expect(out.ranking.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it("8. tiny sample (n=1) is well-defined", () => {
    const out = runPipeline([E("solo", "j1", 73)], "zscore-global");
    expect(out.ranking.length).toBe(1);
    expect(out.ranking[0]?.n).toBe(1);
    expect(out.ranking[0]?.normalized).toBe(73);
    expect(out.mean).toBe(73);
    expect(out.std).toBe(0);
  });

  it("9. judge dropout still ranks every project", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j1", 70),
      E("A", "j2", 82), E("B", "j3", 68),
    ];
    const out = runPipeline(entries, "zscore-global");
    expect(finite(out)).toBe(true);
    expect(order(out).sort()).toEqual(["A", "B"]);
    expect(runPipeline(entries, "zscore-global")).toEqual(out);
  });

  it("10. disqualified project is excluded via excluded set", () => {
    const entries = [E("A", "j1", 90), E("B", "j1", 80), E("C", "j1", 95)];
    const out = runPipeline(entries, "raw-mean", new Set(["C"]));
    expect(order(out)).toEqual(["A", "B"]);
    expect(out.method).toBe("raw-mean");
    expect(out.excluded).toEqual(["C"]);
    expect(top(runPipeline(entries, "raw-mean"))).toBe("C");
  });

  it("11. rescore duplicate keeps the LAST entry", () => {
    const entries = [E("A", "j1", 10), E("B", "j1", 50), E("A", "j1", 90)];
    const out = runPipeline(entries, "raw-mean");
    expect(out.ranking.find((r) => r.projectId === "A")?.rawMean).toBe(90);
    expect(out.ranking.find((r) => r.projectId === "A")?.n).toBe(1);
    expect(top(out)).toBe("A");
  });

  it("12. normalized tie breaks deterministically by projectId", () => {
    const entries = [E("B", "j1", 80), E("A", "j1", 80), E("B", "j2", 80), E("A", "j2", 80)];
    const shuffled = [entries[2], entries[0], entries[3], entries[1]].filter(
      (e): e is ScoreEntry => e !== undefined,
    );
    const out = runPipeline(entries, "zscore-global");
    expect(order(out)).toEqual(["A", "B"]);
    expect(out.ranking.map((r) => r.rank)).toEqual([1, 2]);
    expect(out.ranking[0]?.tieBreak).toEqual([
      "normalized desc", "rawMean desc", "n desc", "projectId asc",
    ]);
    expect(hashEntries(shuffled)).toBe(hashEntries(entries));
    expect(runPipeline(shuffled, "zscore-global")).toEqual(out);
  });

  it("13. all-identical scores stay finite with zero spread", () => {
    const entries = [
      E("A", "j1", 70), E("B", "j1", 70), E("A", "j2", 70), E("B", "j2", 70),
    ];
    for (const m of METHODS) {
      const out = runPipeline(entries, m);
      expect(finite(out)).toBe(true);
      expect(out.std).toBe(0);
      expect(out.mean).toBe(70);
      expect(order(out)).toEqual(["A", "B"]);
    }
  });

  it("14. identical raw means with divergent spreads differentiate under zscore-global", () => {
    const entries = [
      E("A", "j1", 70), E("B", "j1", 80), E("C", "j1", 75),
      E("A", "j2", 90), E("B", "j2", 80), E("C", "j2", 75),
    ];
    const raw = runPipeline(entries, "raw-mean");
    expect(order(raw)).toEqual(["A", "B", "C"]);
    const z = runPipeline(entries, "zscore-global");
    expect(finite(z)).toBe(true);
    expect(top(z)).toBe("B");
  });

  it("15. ranking sorts on ROUND6 values (1e-7 noise cannot flip a tie)", () => {
    const rows = rankProjects([
      { projectId: "B", normalized: 70.00000009, rawMean: 70, n: 2 },
      { projectId: "A", normalized: 70.00000004, rawMean: 80, n: 2 },
    ]);
    expect(rows.map((r) => r.projectId)).toEqual(["A", "B"]);
    expect(rows[0]?.normalized).toBe(70);
    expect(rows[1]?.normalized).toBe(70);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("16. permutation-invariance holds for heterogeneous near-tie values", () => {
    const entries = [
      E("A", "j1", 70.1), E("B", "j1", 70.2), E("C", "j1", 70.0),
      E("A", "j2", 80.2), E("B", "j2", 80.1), E("C", "j2", 80.0),
      E("A", "j3", 60.0), E("B", "j3", 60.15), E("C", "j3", 60.1),
    ];
    const shuffled = [entries[5], entries[0], entries[8], entries[2], entries[6],
      entries[1], entries[4], entries[7], entries[3]].filter(
      (e): e is ScoreEntry => e !== undefined,
    );
    for (const m of METHODS) {
      const a = runPipeline(entries, m);
      const b = runPipeline(shuffled, m);
      expect(b).toEqual(a);
      expect(finite(a)).toBe(true);
    }
    expect(hashEntries(shuffled)).toBe(hashEntries(entries));
  });

  it("17. invalid rescore never shadows a prior valid score", () => {
    const badLast = [E("A", "j1", 80), E("B", "j1", 50), E("A", "j1", Number.NaN)];
    const outBad = runPipeline(badLast, "raw-mean");
    expect(outBad.ranking.find((r) => r.projectId === "A")?.rawMean).toBe(80);
    expect(outBad.ranking.find((r) => r.projectId === "A")?.n).toBe(1);
    const rangeLast = [E("A", "j1", 80), E("A", "j1", 200)];
    expect(runPipeline(rangeLast, "raw-mean").ranking.find((r) => r.projectId === "A")?.rawMean).toBe(80);
    const badFirst = [E("A", "j1", Number.NaN), E("A", "j1", 80), E("B", "j1", 50)];
    expect(runPipeline(badFirst, "raw-mean").ranking.find((r) => r.projectId === "A")?.rawMean).toBe(80);
    expect(runPipeline(badFirst, "raw-mean")).toEqual(runPipeline([E("A", "j1", 80), E("B", "j1", 50)], "raw-mean"));
  });

  it("18. inputHash covers the effective entries (dupes collapse, invalids drop)", () => {
    const base = [E("A", "j1", 80), E("B", "j1", 70)];
    const withDupe = [...base, E("A", "j1", 80)];
    const withInvalid = [...base, E("A", "j1", Number.NaN)];
    expect(runPipeline(withDupe, "raw-mean").inputHash).toBe(runPipeline(base, "raw-mean").inputHash);
    expect(runPipeline(withInvalid, "raw-mean").inputHash).toBe(runPipeline(base, "raw-mean").inputHash);
    expect(runPipeline(base, "raw-mean").method).toBe("raw-mean");
    expect(runPipeline(base, "raw-mean").excluded).toEqual([]);
  });

  it("19. centering removes additive judge bias and stays finite", () => {
    const entries = [
      E("A", "j1", 80), E("B", "j1", 70),
      E("A", "harsh", 40), E("B", "harsh", 30),
    ];
    const out = runPipeline(entries, "centering");
    expect(finite(out)).toBe(true);
    expect(top(out)).toBe("A");
    expect(out.method).toBe("centering");
  });
});
