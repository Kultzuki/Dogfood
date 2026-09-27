-- Dogfood Platform — Organizer-configurable weighted rubrics (versioned)
-- Additive only. Active weight set per event lives in rubric_versions;
-- scores pin the rubric version used at submit time (scores.rubric_version).
-- Only one active version per event is enforced in application code
-- (deactivate-others inside the same txn), not by the DB.

CREATE TABLE IF NOT EXISTS "rubric_versions" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "version"    INTEGER NOT NULL,
  "weights"    JSONB NOT NULL,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "rubric_versions_event_version_unique" UNIQUE ("event_id", "version")
);

CREATE INDEX IF NOT EXISTS "rubric_versions_event_id_idx" ON "rubric_versions" ("event_id");
CREATE INDEX IF NOT EXISTS "rubric_versions_event_active_idx" ON "rubric_versions" ("event_id", "is_active");

ALTER TABLE "scores" ADD COLUMN IF NOT EXISTS "rubric_version" INTEGER NOT NULL DEFAULT 1;
