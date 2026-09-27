/**
 * Data validation for score entries.
 *
 * Never throws on data: every problem is reported as a string in
 * `errors`, so callers (and the pipeline) can decide how to handle
 * invalid input deterministically.
 */

import type { ScoreEntry } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Minimum allowed score value (inclusive). */
export const MIN_SCORE = 0;

/** Maximum allowed score value (inclusive). */
export const MAX_SCORE = 100;

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_SCORE &&
    value <= MAX_SCORE
  );
}

/**
 * Per-entry usability predicate used by the pipeline to drop malformed
 * entries deterministically (instead of throwing on data).
 */
export function isUsableEntry(entry: unknown): entry is ScoreEntry {
  if (entry === null || typeof entry !== "object") return false;
  const candidate = entry as Partial<ScoreEntry>;
  return (
    isNonEmptyId(candidate.projectId) &&
    isNonEmptyId(candidate.judgeId) &&
    isValidValue(candidate.value)
  );
}

/**
 * Validate a batch of score entries without throwing.
 * Returns `{ valid: true, errors: [] }` when every entry is well-formed.
 */
export function validateEntries(entries: ScoreEntry[]): ValidationResult {
  const errors: string[] = [];
  try {
    if (!Array.isArray(entries)) {
      return { valid: false, errors: ["entries: expected an array"] };
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry === null || typeof entry !== "object") {
        errors.push(`entries[${i}]: expected an object`);
        continue;
      }
      const candidate = entry as Partial<ScoreEntry>;
      if (!isNonEmptyId(candidate.projectId)) {
        errors.push(`entries[${i}].projectId: must be a non-empty string`);
      }
      if (!isNonEmptyId(candidate.judgeId)) {
        errors.push(`entries[${i}].judgeId: must be a non-empty string`);
      }
      if (!isValidValue(candidate.value)) {
        errors.push(
          `entries[${i}].value: must be a finite number in [${MIN_SCORE}, ${MAX_SCORE}]`,
        );
      }
    }
  } catch {
    // Defensive: validation must never throw on data.
    errors.push("entries: validation failed unexpectedly");
  }
  return { valid: errors.length === 0, errors };
}
