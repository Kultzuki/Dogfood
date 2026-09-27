-- Dogfood Platform — Event membership track scope (for requireTrackScope)
-- NULL track_id means unscoped: member may access all tracks in the event.

ALTER TABLE "event_memberships" ADD COLUMN IF NOT EXISTS "track_id" UUID REFERENCES "tracks"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "event_memberships_track_id_idx" ON "event_memberships" ("track_id");
