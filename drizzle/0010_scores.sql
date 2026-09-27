-- Dogfood Platform — Minimal judged-score domain (assignments + scores + rubrics stub)
-- Wave 4 (matrix proper) comes later; keep these tables minimal but stable.

CREATE TABLE IF NOT EXISTS "judge_assignments" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"       UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "project_id"     UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "judge_user_id"  UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "track_id"       UUID REFERENCES "tracks"("id") ON DELETE SET NULL,
  "status"         VARCHAR(20) NOT NULL DEFAULT 'active',
  CONSTRAINT "judge_assignments_event_project_judge_unique" UNIQUE ("event_id", "project_id", "judge_user_id")
);

CREATE INDEX IF NOT EXISTS "judge_assignments_event_id_idx" ON "judge_assignments" ("event_id");
CREATE INDEX IF NOT EXISTS "judge_assignments_project_id_idx" ON "judge_assignments" ("project_id");
CREATE INDEX IF NOT EXISTS "judge_assignments_judge_user_id_idx" ON "judge_assignments" ("judge_user_id");

-- NOTE: rubrics is a minimal stub. Wave 4 will extend it with criteria,
-- weights, scale, and versioning. Do not build rubric logic on this stub.
CREATE TABLE IF NOT EXISTS "rubrics" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "name"       VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "rubrics_event_id_idx" ON "rubrics" ("event_id");

CREATE TABLE IF NOT EXISTS "scores" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "assignment_id" UUID NOT NULL REFERENCES "judge_assignments"("id") ON DELETE CASCADE,
  "event_id"      UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "project_id"    UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "judge_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "value"         NUMERIC NOT NULL CONSTRAINT "scores_value_check" CHECK ("value" >= 0 AND "value" <= 100),
  "version"       INTEGER NOT NULL DEFAULT 1,
  "supersedes_id" UUID REFERENCES "scores"("id") ON DELETE SET NULL,
  "is_current"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "scores_assignment_id_idx" ON "scores" ("assignment_id");
CREATE INDEX IF NOT EXISTS "scores_event_id_idx" ON "scores" ("event_id");
CREATE INDEX IF NOT EXISTS "scores_project_id_idx" ON "scores" ("project_id");
CREATE INDEX IF NOT EXISTS "scores_judge_user_id_idx" ON "scores" ("judge_user_id");
CREATE INDEX IF NOT EXISTS "scores_current_idx" ON "scores" ("assignment_id", "is_current");
