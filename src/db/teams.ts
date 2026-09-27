/**
 * Drizzle table definitions for teams and team members.
 * Separate from schema.ts to keep modules under 250 LOC.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    inviteToken: varchar("invite_token", { length: 64 }).notNull().unique(),
    maxSize: integer("max_size").notNull().default(4),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("teams_event_id_idx").on(t.eventId),
    uniqueIndex("teams_invite_token_idx").on(t.inviteToken),
    check("teams_max_size_check", sql`${t.maxSize} >= 1 AND ${t.maxSize} <= 20`),
  ],
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    eventId: uuid("event_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("team_members_team_user_unique").on(t.teamId, t.userId),
    uniqueIndex("team_members_user_event_unique").on(t.userId, t.eventId),
    index("team_members_team_id_idx").on(t.teamId),
    index("team_members_event_id_idx").on(t.eventId),
    index("team_members_user_id_idx").on(t.userId),
  ],
);
