-- Dogfood Platform — Public gallery: custom questions/answers + full-text search
-- Human-readable migration (drizzle out/)

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── Custom questions (organizer-managed per event) ───────────────────
CREATE TABLE IF NOT EXISTS "custom_questions" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "key"        VARCHAR(100) NOT NULL CHECK ("key" ~ '^[a-z0-9-]{1,100}$'),
  "label"      VARCHAR(255) NOT NULL,
  "qtype"      VARCHAR(20) NOT NULL CHECK ("qtype" IN ('text', 'number', 'choice')),
  "required"   BOOLEAN NOT NULL DEFAULT false,
  "options"    JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "custom_questions_event_key_unique" UNIQUE ("event_id", "key")
);

CREATE INDEX IF NOT EXISTS "custom_questions_event_id_idx"
  ON "custom_questions" ("event_id");

-- ── Custom answers (one per project × question) ──────────────────────
CREATE TABLE IF NOT EXISTS "custom_answers" (
  "project_id"  UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "question_id" UUID NOT NULL REFERENCES "custom_questions"("id") ON DELETE CASCADE,
  "value"       JSONB NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "custom_answers_pkey" PRIMARY KEY ("project_id", "question_id"),
  CONSTRAINT "custom_answers_project_question_unique" UNIQUE ("project_id", "question_id")
);

CREATE INDEX IF NOT EXISTS "custom_answers_question_id_idx"
  ON "custom_answers" ("question_id");

-- ── Full-text search: GIN on english tsvector over title/tagline/ ────
-- ── description, plus trigram GIN on title for similarity fallback ───
CREATE INDEX IF NOT EXISTS "projects_search_tsv_idx" ON "projects" USING GIN (
  to_tsvector('english',
    coalesce("title", '') || ' ' ||
    coalesce("tagline", '') || ' ' ||
    coalesce("description", ''))
);

CREATE INDEX IF NOT EXISTS "projects_title_trgm_idx"
  ON "projects" USING GIN ("title" "gin_trgm_ops");
