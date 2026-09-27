/**
 * Pure event lifecycle transition table and permission matrix.
 * No side effects, no DB imports — fully testable in isolation.
 */

// ── States ────────────────────────────────────────────────────────────

export const EVENT_STATES = [
  "DRAFT",
  "REGISTRATION_OPEN",
  "SUBMISSIONS_OPEN",
  "SUBMISSIONS_CLOSED",
  "JUDGING",
  "RESULTS_FINAL",
  "PUBLISHED",
  "ARCHIVED",
] as const;

export type EventState = (typeof EVENT_STATES)[number];

// ── Transition table ──────────────────────────────────────────────────

/** Allowed outgoing transitions for each state. */
export const ALLOWED_TRANSITIONS: ReadonlyMap<
  EventState,
  readonly EventState[]
> = new Map([
  ["DRAFT", ["REGISTRATION_OPEN"]],
  ["REGISTRATION_OPEN", ["SUBMISSIONS_OPEN"]],
  ["SUBMISSIONS_OPEN", ["SUBMISSIONS_CLOSED"]],
  ["SUBMISSIONS_CLOSED", ["JUDGING"]],
  ["JUDGING", ["RESULTS_FINAL"]],
  ["RESULTS_FINAL", ["PUBLISHED"]],
  ["PUBLISHED", ["ARCHIVED"]],
  ["ARCHIVED", []],
]);

/**
 * Check whether a transition from one state to another is valid.
 */
export function isValidTransition(from: string, to: string): boolean {
  if (!isEventState(from) || !isEventState(to)) return false;
  const targets = ALLOWED_TRANSITIONS.get(from);
  return targets !== undefined && (targets as readonly string[]).includes(to);
}

/**
 * Type guard — check if a string is a valid EventState.
 */
export function isEventState(value: string): value is EventState {
  return (EVENT_STATES as readonly string[]).includes(value);
}

// ── Permission matrix ─────────────────────────────────────────────────

/**
 * System-level roles allowed to create events.
 */
export const CREATE_ROLES = ["organizer", "admin"] as const;

/**
 * Privileged per-event / system roles for transitions and edits.
 */
export const TRANSITION_ROLES = ["organizer", "admin"] as const;

/**
 * States whose incoming transitions require system-level role
 * (admin or organizer at the platform level, not just per-event).
 */
export const SYSTEM_ROLE_STATES: readonly EventState[] = [
  "PUBLISHED",
  "ARCHIVED",
];

/**
 * Whether a transition into `toState` requires system-level role check.
 */
export function requiresSystemRole(toState: string): boolean {
  return SYSTEM_ROLE_STATES.includes(toState as EventState);
}

/**
 * Is the system role allowed to create events?
 */
export function canCreate(systemRole: string): boolean {
  return (CREATE_ROLES as readonly string[]).includes(systemRole);
}

/**
 * Is the given role privileged enough for a transition / edit?
 */
export function canTransition(role: string, _toState: string): boolean {
  return (TRANSITION_ROLES as readonly string[]).includes(role);
}

/**
 * Read permission: is the user allowed to view this event?
 * - PUBLISHED events are public.
 * - Otherwise the user must be a member.
 */
export function canRead(isMember: boolean, eventState: string): boolean {
  if (eventState === "PUBLISHED") return true;
  return isMember;
}
