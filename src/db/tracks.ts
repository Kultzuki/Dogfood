/**
 * Drizzle table definitions for tracks and prizes.
 * Separate from schema.ts to keep modules under 250 LOC.
 */
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const tracks = pgTable(
  "tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("tracks_event_slug_idx").on(t.eventId, t.slug),
    index("tracks_event_id_idx").on(t.eventId),
  ],
);

export const prizes = pgTable(
  "prizes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    trackId: uuid("track_id"),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    amountCents: integer("amount_cents"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("prizes_event_slug_idx").on(t.eventId, t.slug),
    index("prizes_event_id_idx").on(t.eventId),
    index("prizes_track_id_idx").on(t.trackId),
  ],
);
