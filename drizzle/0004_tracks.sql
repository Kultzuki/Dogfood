-- Dogfood Platform — Tracks & Prizes migration

CREATE TABLE IF NOT EXISTS "tracks" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"    UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "slug"        VARCHAR(100) NOT NULL,
  "name"        VARCHAR(255) NOT NULL,
  "description" TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "tracks_event_slug_unique" UNIQUE ("event_id", "slug")
);

CREATE INDEX IF NOT EXISTS "tracks_event_id_idx" ON "tracks" ("event_id");

CREATE TABLE IF NOT EXISTS "prizes" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "track_id"     UUID REFERENCES "tracks"("id") ON DELETE RESTRICT,
  "slug"         VARCHAR(100) NOT NULL,
  "name"         VARCHAR(255) NOT NULL,
  "amount_cents" INTEGER CHECK ("amount_cents" >= 0),
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "prizes_event_slug_unique" UNIQUE ("event_id", "slug")
);

CREATE INDEX IF NOT EXISTS "prizes_event_id_idx" ON "prizes" ("event_id");
CREATE INDEX IF NOT EXISTS "prizes_track_id_idx" ON "prizes" ("track_id");
