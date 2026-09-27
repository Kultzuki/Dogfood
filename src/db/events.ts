/**
 * Drizzle table definitions for events and event_memberships.
 * These define the schema; queries in routes use raw SQL for advisory locks.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  state: varchar("state", { length: 50 }).notNull().default("DRAFT"),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const eventMemberships = pgTable(
  "event_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: varchar("role", { length: 50 }).notNull().default("participant"),
    trackId: uuid("track_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("event_memberships_event_user_idx").on(t.eventId, t.userId),
  ],
);
