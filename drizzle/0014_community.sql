-- Dogfood Platform — T3 community voting + project comments (additive only)
--
-- New tables; no existing table is altered except events, which gains two
-- nullable voting-window columns (NULL/NULL = voting never opens, which
-- preserves the exact pre-T3 behavior of every existing route).
--
-- Identity model: authenticated users only (open registration = community).
-- One vote per (event, project, user) enforced by the DB, not the app.
-- Comments are attributed to users and length-checked in DB and app.

-- Voting window lives on the event; predicates use the DB clock (now()).
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "voting_opens_at" TIMESTAMPTZ;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "voting_closes_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "community_votes" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "community_votes_event_project_user_unique"
    UNIQUE ("event_id", "project_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "community_votes_event_id_idx"
  ON "community_votes" ("event_id");
CREATE INDEX IF NOT EXISTS "community_votes_project_id_idx"
  ON "community_votes" ("project_id");
CREATE INDEX IF NOT EXISTS "community_votes_user_recent_idx"
  ON "community_votes" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "project_comments" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "body"       TEXT NOT NULL
    CONSTRAINT "project_comments_body_length_check"
    CHECK (char_length("body") BETWEEN 1 AND 2000),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "project_comments_project_id_idx"
  ON "project_comments" ("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "project_comments_event_id_idx"
  ON "project_comments" ("event_id");
