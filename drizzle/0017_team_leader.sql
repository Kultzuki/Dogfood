-- Dogfood Platform — Team leadership (additive only)
--
-- Creator becomes leader/member (see src/routes/teams.ts). Organizers may
-- create empty teams without auto-joining; participants auto-join.

ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "leader_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "created_by" UUID REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "teams_leader_user_id_idx" ON "teams" ("leader_user_id");
