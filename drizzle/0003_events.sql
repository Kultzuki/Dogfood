-- Dogfood Platform — Events and Event Memberships
-- Human-readable migration (drizzle out/)

CREATE TABLE IF NOT EXISTS "events" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"         VARCHAR(255) NOT NULL,
  "description"  TEXT,
  "state"        VARCHAR(50)  NOT NULL DEFAULT 'DRAFT',
  "version"      INTEGER      NOT NULL DEFAULT 1,
  "created_by"   UUID NOT NULL REFERENCES "users"("id"),
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "event_memberships" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "user_id"      UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role"         VARCHAR(50)  NOT NULL DEFAULT 'participant',
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE("event_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "events_state_idx" ON "events" ("state");
CREATE INDEX IF NOT EXISTS "events_created_by_idx" ON "events" ("created_by");
CREATE INDEX IF NOT EXISTS "event_memberships_event_id_idx" ON "event_memberships" ("event_id");
CREATE INDEX IF NOT EXISTS "event_memberships_user_id_idx" ON "event_memberships" ("user_id");
