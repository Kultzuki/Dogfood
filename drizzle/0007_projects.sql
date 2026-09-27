-- Dogfood Platform — Projects with server-time deadlines + append-only versions
-- Human-readable migration (drizzle out/)
--
-- Flow: create draft -> edit draft -> submit (DB now() <= submissions_close_at;
-- exactly at close_at accepted, after rejected; NULL close_at means open
-- indefinitely) -> post-submit edits append new versions. project_versions
-- is append-only: UPDATE/DELETE blocked by trigger.

-- Deadline lives on the event so the submit predicate can use the DB clock.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "submissions_close_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "projects" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"    UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "team_id"     UUID NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "track_id"    UUID REFERENCES "tracks"("id") ON DELETE SET NULL,
  "title"       VARCHAR(255) NOT NULL,
  "tagline"     VARCHAR(255),
  "description" TEXT NOT NULL DEFAULT '',
  "tech_tags"   TEXT[] NOT NULL DEFAULT '{}',
  "status"      VARCHAR(20) NOT NULL DEFAULT 'draft',
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "projects_status_check" CHECK ("status" IN ('draft', 'submitted'))
);

CREATE INDEX IF NOT EXISTS "projects_event_id_idx" ON "projects" ("event_id");
CREATE INDEX IF NOT EXISTS "projects_team_id_idx" ON "projects" ("team_id");

-- Append-only history: every mutation snapshots the project here.
CREATE TABLE IF NOT EXISTS "project_versions" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"  UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version_no"  INTEGER NOT NULL,
  "title"       VARCHAR(255) NOT NULL,
  "tagline"     VARCHAR(255),
  "description" TEXT NOT NULL DEFAULT '',
  "tech_tags"   TEXT[] NOT NULL DEFAULT '{}',
  "status"      VARCHAR(20) NOT NULL DEFAULT 'draft',
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "project_versions_project_no_unique" UNIQUE ("project_id", "version_no")
);

CREATE INDEX IF NOT EXISTS "project_versions_project_id_idx" ON "project_versions" ("project_id");

-- Append-only enforcement at the DB level, regardless of role.
CREATE OR REPLACE FUNCTION prevent_project_versions_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project_versions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_project_versions_mutation ON "project_versions";
CREATE TRIGGER prevent_project_versions_mutation
  BEFORE UPDATE OR DELETE ON "project_versions"
  FOR EACH ROW EXECUTE FUNCTION prevent_project_versions_mutation();
