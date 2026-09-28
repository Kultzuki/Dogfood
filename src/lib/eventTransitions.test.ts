import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  EVENT_STATES,
  canWriteJudgeBallot,
  canCreate,
  canRead,
  canTransition,
  isEventState,
  isValidTransition,
  requiresSystemRole,
} from "./eventTransitions.js";

describe("EVENT_STATES", () => {
  it("allows ballot submit and rescore only during JUDGING", () => {
    expect(canWriteJudgeBallot("JUDGING")).toBe(true);
    expect(canWriteJudgeBallot("RESULTS_FINAL")).toBe(false);
    expect(canWriteJudgeBallot("PUBLISHED")).toBe(false);
  });
  it("contains exactly the 8 lifecycle states in order", () => {
    expect(EVENT_STATES).toEqual([
      "DRAFT",
      "REGISTRATION_OPEN",
      "SUBMISSIONS_OPEN",
      "SUBMISSIONS_CLOSED",
      "JUDGING",
      "RESULTS_FINAL",
      "PUBLISHED",
      "ARCHIVED",
    ]);
  });

  it("ARCHIVED is terminal", () => {
    expect(ALLOWED_TRANSITIONS.get("ARCHIVED")).toEqual([]);
  });

  it("every non-terminal state has exactly one outgoing edge", () => {
    for (const s of EVENT_STATES) {
      if (s === "ARCHIVED") continue;
      expect(ALLOWED_TRANSITIONS.get(s)?.length).toBe(1);
    }
  });
});

describe("isValidTransition", () => {
  it("accepts each legal edge", () => {
    const edges: Array<[string, string]> = [
      ["DRAFT", "REGISTRATION_OPEN"],
      ["REGISTRATION_OPEN", "SUBMISSIONS_OPEN"],
      ["SUBMISSIONS_OPEN", "SUBMISSIONS_CLOSED"],
      ["SUBMISSIONS_CLOSED", "JUDGING"],
      ["JUDGING", "RESULTS_FINAL"],
      ["RESULTS_FINAL", "PUBLISHED"],
      ["PUBLISHED", "ARCHIVED"],
    ];
    for (const [from, to] of edges) {
      expect(isValidTransition(from, to)).toBe(true);
    }
  });

  it("rejects illegal jumps", () => {
    expect(isValidTransition("DRAFT", "JUDGING")).toBe(false);
    expect(isValidTransition("DRAFT", "ARCHIVED")).toBe(false);
    expect(isValidTransition("REGISTRATION_OPEN", "JUDGING")).toBe(false);
    expect(isValidTransition("JUDGING", "PUBLISHED")).toBe(false);
  });

  it("rejects backward and self transitions", () => {
    expect(isValidTransition("JUDGING", "DRAFT")).toBe(false);
    expect(isValidTransition("DRAFT", "DRAFT")).toBe(false);
    expect(isValidTransition("ARCHIVED", "ARCHIVED")).toBe(false);
  });

  it("rejects unknown states", () => {
    expect(isValidTransition("DRAFT", "NOPE")).toBe(false);
    expect(isValidTransition("NOPE", "DRAFT")).toBe(false);
    expect(isValidTransition("", "")).toBe(false);
  });
});

describe("isEventState", () => {
  it("accepts known states and rejects the rest", () => {
    for (const s of EVENT_STATES) expect(isEventState(s)).toBe(true);
    expect(isEventState("draft")).toBe(false);
    expect(isEventState("")).toBe(false);
  });
});

describe("permission matrix", () => {
  it("only organizer/admin create events", () => {
    expect(canCreate("organizer")).toBe(true);
    expect(canCreate("admin")).toBe(true);
    expect(canCreate("participant")).toBe(false);
    expect(canCreate("judge")).toBe(false);
    expect(canCreate("")).toBe(false);
  });

  it("only organizer/admin transition or edit", () => {
    expect(canTransition("organizer", "JUDGING")).toBe(true);
    expect(canTransition("admin", "PUBLISHED")).toBe(true);
    expect(canTransition("participant", "JUDGING")).toBe(false);
    expect(canTransition("judge", "JUDGING")).toBe(false);
  });

  it("PUBLISHED and ARCHIVED require system-level role", () => {
    expect(requiresSystemRole("PUBLISHED")).toBe(true);
    expect(requiresSystemRole("ARCHIVED")).toBe(true);
    expect(requiresSystemRole("JUDGING")).toBe(false);
    expect(requiresSystemRole("DRAFT")).toBe(false);
  });
});

describe("canRead", () => {
  it("PUBLISHED is public, others need membership", () => {
    expect(canRead(false, "PUBLISHED")).toBe(true);
    expect(canRead(false, "DRAFT")).toBe(false);
    expect(canRead(true, "DRAFT")).toBe(true);
  });
});
