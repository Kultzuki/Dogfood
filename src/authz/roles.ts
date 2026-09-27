/**
 * Authorization roles and membership types for the Dogfood platform.
 *
 * Global roles represent the broadest permission level a user can hold
 * across the entire platform. Event membership roles scope permissions
 * to a specific event.
 */

/** Global platform-wide roles. */
export const ROLES = ["participant", "judge", "organizer", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** Per-event membership roles. */
export const EVENT_ROLES = ["participant", "judge", "organizer"] as const;
export type EventRole = (typeof EVENT_ROLES)[number];

/**
 * Expected shape of an `event_memberships` row.
 *
 * Table DDL (for when the migration is applied):
 *
 * ```sql
 * CREATE TABLE event_memberships (
 *   id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 *   event_id   UUID NOT NULL,
 *   role       TEXT NOT NULL CHECK (role IN ('participant','judge','organizer')),
 *   track_id   UUID,          -- optional: scope a judge to a specific track
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   UNIQUE (user_id, event_id, role)
 * );
 * ```
 */
export interface EventMembership {
  id: string;
  userId: string;
  eventId: string;
  role: EventRole;
  trackId: string | null;
  createdAt: Date;
}
