import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { centerAndRank, type CenterEntry } from "../lib/csv.js";

function hashEntries(entries: CenterEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.judgeId !== b.judgeId) return a.judgeId < b.judgeId ? -1 : 1;
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return a.value - b.value;
  });
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

describe("finalization reproducibility", () => {
  const entries: CenterEntry[] = [
    { projectId: "p1", judgeId: "j1", value: 80 },
    { projectId: "p1", judgeId: "j2", value: 60 },
    { projectId: "p2", judgeId: "j1", value: 70 },
    { projectId: "p2", judgeId: "j2", value: 90 },
  ];

  it("is deterministic regardless of input order", () => {
    const shuffled = [...entries].reverse();
    expect(centerAndRank(shuffled)).toEqual(centerAndRank(entries));
    expect(hashEntries(shuffled)).toBe(hashEntries(entries));
  });

  it("detects stale inputs: hash changes when a score changes", () => {
    const before = hashEntries(entries);
    const after = hashEntries([...entries.slice(0, 3), { projectId: "p2", judgeId: "j2", value: 10 }]);
    expect(after).not.toBe(before);
  });

  it("produces sequential ranks with tie-break stability", () => {
    const ranked = centerAndRank(entries);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked[0]?.projectId).toBe("p2");
  });
});
