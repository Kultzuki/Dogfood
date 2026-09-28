import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { duplicateFixturePairs, parseFixture } from "./fixtures.js";

describe("fixture duplicate handling", () => {
  it("flags prj_41 as a duplicate of prj_07 and leaves one canonical public row", () => {
    const root = process.cwd();
    const fixturePath = existsSync(join(root, "stuff", "fixtures.json")) ? join(root, "stuff", "fixtures.json") : join(root, "..", "stuff", "fixtures.json");
    const fixture = parseFixture(JSON.parse(readFileSync(fixturePath, "utf8")));
    const pair = duplicateFixturePairs(fixture.projects).find((p) => p.duplicateId === "prj_41");
    expect(pair).toEqual({ keepId: "prj_07", duplicateId: "prj_41" });
    if (!pair) throw new Error("expected fixture duplicate pair prj_07/prj_41");
    expect(fixture.projects.filter((p) => p.id === pair.keepId || p.id === pair.duplicateId).filter((p) => p.id !== pair.duplicateId).map((p) => p.id)).toEqual(["prj_07"]);
  });

  it("does not merge same titles belonging to different teams", () => {
    expect(duplicateFixturePairs([
      { id: "a", team: "one", title: "Same", repoUrl: "", demoUrl: "", summary: "", track: "", submittedAt: "" },
      { id: "b", team: "two", title: "Same", repoUrl: "", demoUrl: "", summary: "", track: "", submittedAt: "" },
    ])).toEqual([]);
  });
});
