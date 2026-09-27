/**
 * T4 bulk-dataset contracts: votes + comments export columns.
 * Existing datasets are asserted intact (compatibility guard).
 */
import { describe, expect, it } from "vitest";
import {
  COMMENTS_COLUMNS,
  EXPORT_DATASETS,
  VOTES_COLUMNS,
  headerFor,
} from "./csv.js";

describe("T4 export datasets", () => {
  it("exposes votes and comments columns", () => {
    expect([...VOTES_COLUMNS]).toEqual([
      "id",
      "event_id",
      "project_id",
      "user_id",
      "created_at",
    ]);
    expect([...COMMENTS_COLUMNS]).toEqual([
      "id",
      "event_id",
      "project_id",
      "user_id",
      "body",
      "created_at",
    ]);
    expect(headerFor("votes")).toBe(VOTES_COLUMNS);
    expect(headerFor("comments")).toBe(COMMENTS_COLUMNS);
  });
  it("keeps every pre-T4 dataset registered and unchanged", () => {
    for (const d of [
      "assignments",
      "scores-raw",
      "scores-normalized",
      "rankings",
      "audit",
      "votes",
      "comments",
    ] as const) {
      expect(EXPORT_DATASETS).toContain(d);
      expect(headerFor(d).length).toBeGreaterThan(0);
    }
  });
});
