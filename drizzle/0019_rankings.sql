-- Dogfood Platform — Persistent normalization finalization (additive only)
--
-- Stores the deterministic centering pipeline output per event so rankings
-- are reproducible, auditable, and detect stale inputs via input_hash.

CREATE TABLE IF NOT EXISTS "event_finalizations" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "method"       VARCHAR(30) NOT NULL DEFAULT 'centering',
  "input_hash"   VARCHAR(64) NOT NULL,
  "created_by"   UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "event_finalizations_event_id_idx"
  ON "event_finalizations" ("event_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "event_rankings" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "finalization_id" UUID NOT NULL REFERENCES "event_finalizations"("id") ON DELETE CASCADE,
  "event_id"     UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "project_id"   UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "raw_mean"     DOUBLE PRECISION NOT NULL,
  "normalized"   DOUBLE PRECISION NOT NULL,
  "n"            INTEGER NOT NULL,
  "rank"         INTEGER NOT NULL,
  CONSTRAINT "event_rankings_final_project_unique" UNIQUE ("finalization_id", "project_id")
);

CREATE INDEX IF NOT EXISTS "event_rankings_event_id_idx"
  ON "event_rankings" ("event_id", "rank");
