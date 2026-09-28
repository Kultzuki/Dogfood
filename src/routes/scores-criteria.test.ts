import { describe, expect, it } from "vitest";
import { parseCriteria } from "./scores.js";
import { compositeFor } from "./rubrics.js";

describe("weighted rubric criteria enforcement", () => {
  it("accepts valid 0-100 criteria for all four keys", () => {
    expect(parseCriteria({ technical: 80, innovation: 90, impact: 70, polish: 85 })).toEqual({
      technical: 80, innovation: 90, impact: 70, polish: 85,
    });
    expect(parseCriteria({ technical: 0, innovation: 0, impact: 0, polish: 0 })).toBeDefined();
    expect(parseCriteria({ technical: 100, innovation: 100, impact: 100, polish: 100 })).toBeDefined();
  });

  it("rejects missing keys, out-of-range, non-numeric, and extra shapes", () => {
    expect(parseCriteria({ technical: 80, innovation: 90, impact: 70 })).toBeUndefined();
    expect(parseCriteria({ technical: 80, innovation: 90, impact: 70, polish: 101 })).toBeUndefined();
    expect(parseCriteria({ technical: -1, innovation: 90, impact: 70, polish: 85 })).toBeUndefined();
    expect(parseCriteria({ technical: "80", innovation: 90, impact: 70, polish: 85 })).toBeUndefined();
    expect(parseCriteria(null)).toBeUndefined();
    expect(parseCriteria([80, 90, 70, 85])).toBeUndefined();
    expect(parseCriteria({})).toBeUndefined();
  });

  it("computes the weighted composite server-side (40/25/20/15 example)", () => {
    const composite = compositeFor(
      { technical: 40, innovation: 25, impact: 20, polish: 15 },
      { technical: 80, innovation: 90, impact: 70, polish: 85 },
    );
    expect(composite).toBeCloseTo(81.25, 2);
  });

  it("pins history: same criteria under a new rubric version compute differently", () => {
    const criteria = { technical: 80, innovation: 90, impact: 70, polish: 85 };
    const v1 = compositeFor({ technical: 40, innovation: 25, impact: 20, polish: 15 }, criteria);
    const v2 = compositeFor({ technical: 30, innovation: 30, impact: 20, polish: 20 }, criteria);
    expect(v1).not.toBe(v2);
    expect(v2).toBeCloseTo(82, 2);
  });
});
