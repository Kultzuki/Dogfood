/**
 * Gallery data layer — custom questions/answers table defs, gallery search,
 * and per-qtype answer validation. Projects table is owned by the projects
 * worker (SELECT-only here); this module never redefines it.
 */
import {
  pgTable,
  uuid,
  varchar,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { pool } from "./index.js";

export const customQuestions = pgTable(
  "custom_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").notNull(),
    key: varchar("key", { length: 100 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    qtype: varchar("qtype", { length: 20 }).notNull(),
    required: boolean("required").notNull().default(false),
    options: jsonb("options").$type<string[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("custom_questions_event_key_idx").on(t.eventId, t.key),
    index("custom_questions_event_id_idx").on(t.eventId),
  ],
);

export const customAnswers = pgTable(
  "custom_answers",
  {
    projectId: uuid("project_id").notNull(),
    questionId: uuid("question_id").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.questionId] }),
    index("custom_answers_question_id_idx").on(t.questionId),
  ],
);

export type QuestionType = "text" | "number" | "choice";

export interface QuestionRow {
  id: string;
  event_id: string;
  key: string;
  label: string;
  qtype: string;
  required: boolean;
  options: unknown;
}

export interface GalleryFilters {
  q?: string;
  trackId?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface GalleryProject {
  id: string;
  event_id: string;
  team_id: string;
  track_id: string | null;
  title: string;
  tagline: string | null;
  description: string | null;
  tech_tags: string[] | null;
  status: string;
  event_name: string;
  event_state: string;
  rank: number;
}

const GALLERY_STATES = [
  "SUBMISSIONS_CLOSED",
  "JUDGING",
  "RESULTS_FINAL",
  "PUBLISHED",
] as const;

function docExpr(): string {
  return `to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.tagline,'') || ' ' || coalesce(p.description,'') || ' ' || coalesce(array_to_string(p.tech_tags,' '),''))`;
}

/**
 * Public gallery search. Fully parameterized — a hostile `q` (e.g. an
 * SQL-injection string) is bound as a value and matches zero rows.
 */
export async function searchGallery(
  filters: GalleryFilters,
): Promise<GalleryProject[]> {
  const q = (filters.q ?? "").trim();
  const params: unknown[] = [...GALLERY_STATES];
  let idx = GALLERY_STATES.length + 1;
  const conds = [
    `p.status = 'submitted'`,
    `p.needs_review = false`,
    `e.state IN ($1, $2, $3, $4)`,
  ];
  if (filters.trackId !== undefined && filters.trackId !== "") {
    params.push(filters.trackId);
    conds.push(`p.track_id = $${idx++}`);
  }
  if (filters.tag !== undefined && filters.tag !== "") {
    params.push(filters.tag);
    conds.push(`$${idx++} = ANY (p.tech_tags)`);
  }
  let rankSel = "0::float AS rank";
  if (q !== "") {
    params.push(q);
    const qp = `$${idx++}`;
    conds.push(
      `(${docExpr()} @@ plainto_tsquery('english', ${qp}) OR similarity(p.title, ${qp}) > 0.15)`,
    );
    rankSel =
      `(ts_rank_cd(${docExpr()}, plainto_tsquery('english', ${qp})) + similarity(p.title, ${qp})) AS rank`;
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  params.push(limit);
  params.push(Math.max(0, Math.floor(filters.offset ?? 0)));
  const res = await pool.query(
    `SELECT p.id, p.event_id, p.team_id, p.track_id, p.title, p.tagline,
            p.description, p.tech_tags, p.status,
            e.name AS event_name, e.state AS event_state, ${rankSel}
       FROM projects p JOIN events e ON e.id = p.event_id
      WHERE ${conds.join(" AND ")}
      ORDER BY rank DESC, p.created_at DESC, p.id ASC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    params,
  );
  return res.rows as GalleryProject[];
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** Validate one answer value against its question. Returns message or null. */
export function validateAnswerValue(
  q: Pick<QuestionRow, "qtype" | "required" | "options" | "key">,
  value: unknown,
): string | null {
  if (isEmpty(value)) {
    return q.required ? `${q.key}: answer is required` : null;
  }
  if (q.qtype === "text") {
    if (typeof value !== "string") return `${q.key}: must be text`;
    if (value.length > 2000) return `${q.key}: must be at most 2000 characters`;
    if (q.required && value.trim() === "")
      return `${q.key}: answer is required`;
    return null;
  }
  if (q.qtype === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return `${q.key}: must be a finite number`;
    return null;
  }
  if (q.qtype === "choice") {
    const opts = Array.isArray(q.options) ? q.options : [];
    if (typeof value !== "string" || !opts.includes(value))
      return `${q.key}: must be one of the allowed options`;
    return null;
  }
  return `${q.key}: unknown question type`;
}
