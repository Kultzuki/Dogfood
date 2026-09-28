import { describe, expect, it } from "vitest";
import { dateRangeError, isSubmissionOpen, parseIsoNullable } from "./events.js";

describe("event date configuration", () => {
  it("accepts valid ISO timestamps and preserves null/undefined semantics", () => {
    expect(parseIsoNullable(undefined)).toBeUndefined();
    expect(parseIsoNullable(null)).toBeNull();
    expect(parseIsoNullable("")).toBeNull();
    const iso = parseIsoNullable("2026-03-01T18:00:00Z");
    expect(typeof iso).toBe("string");
    expect(Date.parse(iso as string)).not.toBeNaN();
  });

  it("rejects non-ISO input", () => {
    expect(parseIsoNullable("not-a-date")).toBeUndefined();
    expect(parseIsoNullable(123)).toBeUndefined();
    expect(parseIsoNullable({})).toBeUndefined();
  });

  it("accepts open < close and start <= end", () => {
    expect(dateRangeError({
      submissions_open_at: "2026-02-01T00:00:00Z",
      submissions_close_at: "2026-03-01T18:00:00Z",
    })).toBeNull();
    expect(dateRangeError({
      starts_at: "2026-02-01T00:00:00Z",
      ends_at: "2026-02-01T00:00:00Z",
    })).toBeNull();
    expect(dateRangeError({})).toBeNull();
    expect(dateRangeError({ submissions_close_at: "2026-03-01T18:00:00Z" })).toBeNull();
  });

  it("rejects close before-or-at open and end before start", () => {
    expect(dateRangeError({
      submissions_open_at: "2026-03-01T18:00:00Z",
      submissions_close_at: "2026-03-01T18:00:00Z",
    })).toBe("invalid_date_range");
    expect(dateRangeError({
      submissions_open_at: "2026-04-01T00:00:00Z",
      submissions_close_at: "2026-03-01T00:00:00Z",
    })).toBe("invalid_date_range");
    expect(dateRangeError({
      starts_at: "2026-05-01T00:00:00Z",
      ends_at: "2026-04-01T00:00:00Z",
    })).toBe("invalid_date_range");
  });
});

describe("submission window edges (mirror of the SQL predicate)", () => {
  const OPEN = "2026-02-01T00:00:00Z";
  const CLOSE = "2026-03-01T18:00:00Z";
  const t = (iso: string): number => Date.parse(iso);

  it("rejects before opening, allows inside, rejects after closing", () => {
    expect(isSubmissionOpen(OPEN, CLOSE, t("2026-01-31T23:59:59Z"))).toBe(false);
    expect(isSubmissionOpen(OPEN, CLOSE, t("2026-02-15T12:00:00Z"))).toBe(true);
    expect(isSubmissionOpen(OPEN, CLOSE, t("2026-03-01T18:00:01Z"))).toBe(false);
  });

  it("accepts exactly at opening and exactly at closing", () => {
    expect(isSubmissionOpen(OPEN, CLOSE, t(OPEN))).toBe(true);
    expect(isSubmissionOpen(OPEN, CLOSE, t(CLOSE))).toBe(true);
  });

  it("treats NULL bounds as open indefinitely", () => {
    expect(isSubmissionOpen(null, null, t("2026-06-01T00:00:00Z"))).toBe(true);
    expect(isSubmissionOpen(null, CLOSE, t("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isSubmissionOpen(OPEN, null, t("2027-01-01T00:00:00Z"))).toBe(true);
    expect(isSubmissionOpen(undefined, undefined, t(OPEN))).toBe(true);
  });

  it("rejects malformed bounds", () => {
    expect(isSubmissionOpen("not-a-date", CLOSE, t(OPEN))).toBe(false);
    expect(isSubmissionOpen(OPEN, "not-a-date", t(OPEN))).toBe(false);
  });
});
