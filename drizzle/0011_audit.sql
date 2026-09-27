-- Dogfood Platform — Append-only hash-chained audit log
-- Human-readable migration (drizzle out/)
--
-- Covered actions (emitted by owning routes via appendAudit in src/lib/audit.ts):
--   assignment.create, rubric.create, rubric.update, score.submit, score.rescore,
--   project.disqualify (flag stub: records event+project; DQ enforcement is Wave 4),
--   event.finalize (transition to RESULTS_FINAL), event.publish, admin.action
--
-- Chain: hash = sha256hex(prev_hash + '|' + event_id + '|' + actor + '|'
--   + action + '|' + resource_type + '|' + resource_id + '|'
--   + canonicalJson(detail) + '|' + created_atISO), prev 'GENESIS' for row 1.
-- UPDATE/DELETE blocked at DB level regardless of role (precedent: 0007).

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"           BIGSERIAL UNIQUE NOT NULL,
  "event_id"      UUID REFERENCES "events"("id") ON DELETE CASCADE,
  "track_id"      UUID,
  "actor_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "action"        TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id"   TEXT NOT NULL,
  "detail"        JSONB NOT NULL DEFAULT '{}',
  "prev_hash"     TEXT NOT NULL DEFAULT '',
  "hash"          TEXT NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "audit_logs_event_seq_idx"
  ON "audit_logs" ("event_id", "seq");

-- Append-only enforcement at the DB level, regardless of role.
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_audit_mutation ON "audit_logs";
CREATE TRIGGER prevent_audit_mutation
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
