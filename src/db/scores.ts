/**
 * Drizzle table definitions for the minimal judged-score domain.
 * Mirrors drizzle/0010_scores.sql (assignments, scores, rubrics stub) plus
 * drizzle/0013_rubrics.sql (rubric_versions, scores.rubric_version).
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  varchar,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";

export const judgeAssignments = pgTable(
  "judge_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    projectId: uuid("project_id").notNull(),
    judgeUserId: uuid("judge_user_id").notNull(),
    trackId: uuid("track_id"),
    status: varchar("status", { length: 20 }).notNull().default("active"),
  },
  (t) => [
    uniqueIndex("judge_assignments_event_project_judge_unique").on(
      t.eventId,
      t.projectId,
      t.judgeUserId,
    ),
    index("judge_assignments_event_id_idx").on(t.eventId),
    index("judge_assignments_project_id_idx").on(t.projectId),
    index("judge_assignments_judge_user_id_idx").on(t.judgeUserId),
  ],
);

export const rubrics = pgTable(
  "rubrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("rubrics_event_id_idx").on(t.eventId)],
);

export const rubricVersions = pgTable(
  "rubric_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    version: integer("version").notNull(),
    weights: jsonb("weights").$type<Record<string, number>>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rubric_versions_event_id_idx").on(t.eventId),
    index("rubric_versions_event_active_idx").on(t.eventId, t.isActive),
  ],
);

export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assignmentId: uuid("assignment_id").notNull(),
    eventId: uuid("event_id").notNull(),
    projectId: uuid("project_id").notNull(),
    judgeUserId: uuid("judge_user_id").notNull(),
    value: numeric("value").notNull(),
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
    isCurrent: boolean("is_current").notNull().default(true),
    rubricVersion: integer("rubric_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("scores_value_check", sql`${t.value} >= 0 AND ${t.value} <= 100`),
    index("scores_assignment_id_idx").on(t.assignmentId),
    index("scores_event_id_idx").on(t.eventId),
    index("scores_project_id_idx").on(t.projectId),
    index("scores_judge_user_id_idx").on(t.judgeUserId),
    index("scores_current_idx").on(t.assignmentId, t.isCurrent),
  ],
);

export type JudgeAssignment = typeof judgeAssignments.$inferSelect;
export type RubricVersion = typeof rubricVersions.$inferSelect;
export type Score = typeof scores.$inferSelect;
