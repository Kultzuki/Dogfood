import { describe, expect, it } from "vitest";
import { leavePolicy, parseMaxSize } from "./teams.js";

describe("team formation and leave policy", () => {
  it("enforces max_size 1-20 integers, defaulting to 4", () => {
    expect(parseMaxSize(undefined)).toBe(4);
    expect(parseMaxSize(4)).toBe(4);
    expect(parseMaxSize(1)).toBe(1);
    expect(parseMaxSize(20)).toBe(20);
    expect(parseMaxSize(0)).toBeUndefined();
    expect(parseMaxSize(21)).toBeUndefined();
    expect(parseMaxSize(2.5)).toBeUndefined();
    expect(parseMaxSize("4")).toBeUndefined();
  });

  it("normal leave keeps the team", () => {
    expect(leavePolicy(3, { isMember: true, hasSubmission: false })).toEqual({ ok: true, dissolved: false });
  });

  it("sole member dissolves the team", () => {
    expect(leavePolicy(1, { isMember: true, hasSubmission: false })).toEqual({ ok: true, dissolved: true });
  });

  it("non-member cannot leave", () => {
    expect(leavePolicy(3, { isMember: false, hasSubmission: false })).toEqual({ ok: false, error: "not_member" });
  });

  it("submitted project blocks leave (no orphaned submissions)", () => {
    expect(leavePolicy(1, { isMember: true, hasSubmission: true })).toEqual({ ok: false, error: "has_submission" });
    expect(leavePolicy(4, { isMember: true, hasSubmission: true })).toEqual({ ok: false, error: "has_submission" });
  });
});
