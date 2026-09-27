/**
 * Drizzle table definitions for projects and append-only project_versions.
 * Mirrors drizzle/0007_projects.sql — column names are a stable contract.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    teamId: uuid("team_id").notNull(),
    trackId: uuid("track_id"),
    title: varchar("title", { length: 255 }).notNull(),
    tagline: varchar("tagline", { length: 255 }),
    description: text("description").notNull().default(""),
    techTags: text("tech_tags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("projects_status_check", sql`${t.status} IN ('draft', 'submitted')`),
    index("projects_event_id_idx").on(t.eventId),
    index("projects_team_id_idx").on(t.teamId),
  ],
);

export const projectVersions = pgTable(
  "project_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    versionNo: integer("version_no").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    tagline: varchar("tagline", { length: 255 }),
    description: text("description").notNull().default(""),
    techTags: text("tech_tags")
      .array()
      .notNull()
      .default(sql`'{}'`),
    status: varchar("status", { length: 20 }).notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("project_versions_project_no_unique").on(
      t.projectId,
      t.versionNo,
    ),
    index("project_versions_project_id_idx").on(t.projectId),
  ],
);
