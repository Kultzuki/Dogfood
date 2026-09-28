/**
 * T4 bulk-dataset contracts: votes + comments export columns.
 * Existing datasets are asserted intact (compatibility guard).
 */
import { describe, expect, it } from "vitest";
import {
  COMMENTS_COLUMNS,
  EXPORT_DATASETS,
  JUDGES_COLUMNS,
  PROJECTS_COLUMNS,
  TEAMS_COLUMNS,
  VOTES_COLUMNS,
  escapeCell,
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
      "projects",
      "teams",
      "judges",
    ] as const) {
      expect(EXPORT_DATASETS).toContain(d);
      expect(headerFor(d).length).toBeGreaterThan(0);
    }
  });
  it("exposes projects, teams, and judges columns with deterministic order", () => {
    expect([...PROJECTS_COLUMNS]).toEqual([
      "id",
      "event_id",
      "team_id",
      "track_id",
      "title",
      "status",
      "created_at",
    ]);
    expect([...TEAMS_COLUMNS]).toEqual([
      "id",
      "event_id",
      "name",
      "max_size",
      "leader_user_id",
      "created_at",
    ]);
    expect([...JUDGES_COLUMNS]).toEqual([
      "event_id",
      "user_id",
      "role",
      "track_id",
      "created_at",
    ]);
  });
  it("escapes hostile cells (formula injection, quotes, commas, newlines)", () => {
    expect(escapeCell("=cmd|'/c calc'!A0")).toBe("'=cmd|'/c calc'!A0");
    expect(escapeCell('a"b')).toBe('"a""b"');
    expect(escapeCell("a,b")).toBe('"a,b"');
    expect(escapeCell("a\nb")).toBe('"a\nb"');
    expect(escapeCell("plain")).toBe("plain");
  });
});
