-- Explicit multi-track membership scopes. A NULL legacy track_id grants no
-- judge scope; only track_scope_all grants access to every track.
ALTER TABLE event_memberships ADD COLUMN IF NOT EXISTS track_scope_all BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS event_membership_tracks (
  membership_id UUID NOT NULL REFERENCES event_memberships(id) ON DELETE CASCADE,
  track_id UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (membership_id, track_id)
);
CREATE INDEX IF NOT EXISTS event_membership_tracks_track_idx ON event_membership_tracks(track_id);
