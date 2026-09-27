import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_COLUMNS,
  AUDIT_COLUMNS,
  CENTERED_COLUMNS,
  RANKING_COLUMNS,
  SCORES_RAW_COLUMNS,
  centerAndRank,
  csvStream,
  escapeCell,
  headerFor,
  rankedToRecord,
  validateAssignmentRow,
  validateScoreRow,
} from "./csv.js";

const EV = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const J1 = "44444444-4444-4444-8444-444444444444";
const J2 = "55555555-5555-4555-8555-555555555555";

describe("column contracts", () => {
  it("locks exact headers", () => {
    expect([...ASSIGNMENT_COLUMNS]).toEqual([
      "event_id", "project_id", "judge_user_id", "track_id", "status",
    ]);
    expect([...SCORES_RAW_COLUMNS]).toEqual([
      "id", "event_id", "project_id", "judge_user_id",
      "value", "version", "is_current", "created_at",
    ]);
    expect([...CENTERED_COLUMNS]).toEqual([
      "project_id", "normalized", "raw_mean", "n", "rank",
    ]);
    expect([...RANKING_COLUMNS]).toEqual([...CENTERED_COLUMNS]);
    expect([...AUDIT_COLUMNS]).toEqual([
      "seq", "event_id", "actor_user_id", "action",
      "resource_type", "resource_id", "created_at",
    ]);
  });

  it("headerFor covers every dataset", () => {
    for (const d of ["assignments", "scores-raw", "scores-normalized", "rankings", "audit"] as const)
      expect(headerFor(d).length).toBeGreaterThan(0);
  });
});

describe("escapeCell", () => {
  it("quotes commas, quotes, CR, LF per RFC4180", () => {
    expect(escapeCell("plain")).toBe("plain");
    expect(escapeCell("a,b")).toBe('"a,b"');
    expect(escapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCell("a\r\nb")).toBe('"a\r\nb"');
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(true)).toBe("true");
  });

  it("neutralizes spreadsheet formula prefixes", () => {
    expect(escapeCell("=2+2")).toBe("'=2+2");
    expect(escapeCell("+cmd")).toBe("'+cmd");
    expect(escapeCell("-x")).toBe("'-x");
    expect(escapeCell("@mention")).toBe("'@mention");
    expect(escapeCell("2+2=4")).toBe("2+2=4");
  });
});

describe("csvStream", () => {
  it("emits header then rows with CRLF", async () => {
    const chunks: string[] = [];
    for await (const c of csvStream(["a", "b"], [{ a: "1", b: "x,y" }]))
      chunks.push(String(c));
    expect(chunks.join("")).toBe("a,b\r\n1,\"x,y\"\r\n");
  });
});

describe("centerAndRank", () => {
  it("removes harsh/generous rater offsets", () => {
    // J1 harsh (10,20), J2 generous (80,90); true gap P2 > P1 by 10.
    const out = centerAndRank([
      { projectId: P1, judgeId: J1, value: 10 },
      { projectId: P2, judgeId: J1, value: 20 },
      { projectId: P1, judgeId: J2, value: 80 },
      { projectId: P2, judgeId: J2, value: 90 },
    ]);
    expect(out.map((r) => r.projectId)).toEqual([P2, P1]);
    expect(out[0]?.rank).toBe(1);
    expect(out[1]?.rank).toBe(2);
    // globalMean=50, judgeMeans 15/85 → P1: 10-15+50=45 & 80-85+50=45
    expect(out[1]?.normalized).toBe(45);
    expect(out[0]?.normalized).toBe(55);
    expect(out[0]?.rawMean).toBe(55);
    expect(out[0]?.n).toBe(2);
  });

  it("breaks full ties by projectId asc", () => {
    const out = centerAndRank([
      { projectId: P2, judgeId: J1, value: 50 },
      { projectId: P1, judgeId: J1, value: 50 },
    ]);
    expect(out.map((r) => r.projectId)).toEqual([P1, P2]);
  });

  it("rankedToRecord matches centered columns", () => {
    const rec = rankedToRecord({ projectId: P1, normalized: 45, rawMean: 45, n: 2, rank: 2 });
    expect(Object.keys(rec)).toEqual([...CENTERED_COLUMNS]);
    expect(rec["project_id"]).toBe(P1);
  });
});

describe("validators", () => {
  it("accepts a good assignment row", () => {
    expect(validateAssignmentRow({
      event_id: EV, project_id: P1, judge_user_id: J1, track_id: "", status: "active",
    }, EV)).toEqual([]);
  });

  it("flags bad assignment fields", () => {
    const errs = validateAssignmentRow({
      event_id: "other", project_id: "nope", judge_user_id: J1, status: "",
    }, EV);
    expect(errs).toContain("event_mismatch");
    expect(errs).toContain("invalid_project_id");
    expect(errs).toContain("invalid_status");
  });

  it("rejects unknown assignment status", () => {
    const errs = validateAssignmentRow({
      event_id: EV, project_id: P1, judge_user_id: J1, status: "archived",
    }, EV);
    expect(errs).toContain("invalid_status");
  });

  it("flags bad score values, allows missing event_id", () => {
    expect(validateScoreRow({ project_id: P1, judge_user_id: J1, value: "150" }, EV).errors)
      .toContain("invalid_value");
    expect(validateScoreRow({ project_id: P1, judge_user_id: J1, value: "NaN" }, EV).errors)
      .toContain("invalid_value");
    expect(validateScoreRow({ project_id: P1, judge_user_id: J1, value: "42.5" }, EV))
      .toEqual({ errors: [], value: 42.5 });
  });
});
