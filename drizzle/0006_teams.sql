-- Dogfood Platform — Teams & Team Members migration

CREATE TABLE IF NOT EXISTS "teams" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "name"         VARCHAR(255) NOT NULL,
  "invite_token" VARCHAR(64) NOT NULL UNIQUE,
  "max_size"     INTEGER NOT NULL DEFAULT 4 CHECK ("max_size" >= 1 AND "max_size" <= 20),
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "teams_event_id_idx" ON "teams" ("event_id");
CREATE INDEX IF NOT EXISTS "teams_invite_token_idx" ON "teams" ("invite_token");

CREATE TABLE IF NOT EXISTS "team_members" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "team_id"    UUID NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "team_members_team_user_unique" UNIQUE ("team_id", "user_id"),
  CONSTRAINT "team_members_user_event_unique" UNIQUE ("user_id", "event_id")
);

CREATE INDEX IF NOT EXISTS "team_members_team_id_idx" ON "team_members" ("team_id");
CREATE INDEX IF NOT EXISTS "team_members_event_id_idx" ON "team_members" ("event_id");
CREATE INDEX IF NOT EXISTS "team_members_user_id_idx" ON "team_members" ("user_id");
