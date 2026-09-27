-- Dogfood Platform — T4 webhooks + certificates/records (additive only)
--
-- No existing table is altered. Webhook delivery state lives here (outbox);
-- certificates are deterministic content-addressed rows (digest over the
-- canonical payload, UNIQUE per event/type/subject so re-issue is stable).

CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "url"        VARCHAR(2000) NOT NULL,
  "secret"     VARCHAR(128) NOT NULL,
  "events"     TEXT[] NOT NULL DEFAULT '{}',
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_event_id_idx"
  ON "webhook_subscriptions" ("event_id");

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id" UUID NOT NULL REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE,
  "event_id"        UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "event_type"      VARCHAR(100) NOT NULL,
  "payload"         JSONB NOT NULL,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CONSTRAINT "webhook_deliveries_status_check"
    CHECK ("status" IN ('pending', 'delivered', 'failed', 'dead')),
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "next_retry_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_error"      TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "delivered_at"    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx"
  ON "webhook_deliveries" ("status", "next_retry_at");
CREATE INDEX IF NOT EXISTS "webhook_deliveries_subscription_id_idx"
  ON "webhook_deliveries" ("subscription_id");

CREATE TABLE IF NOT EXISTS "certificates" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"   UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "type"       VARCHAR(30) NOT NULL
    CONSTRAINT "certificates_type_check"
    CHECK ("type" IN ('judge-participation', 'project-submission', 'participant')),
  "subject_id" TEXT NOT NULL,
  "payload"    JSONB NOT NULL,
  "digest"     VARCHAR(64) NOT NULL,
  "signature"  TEXT NOT NULL,
  "kid"        VARCHAR(16) NOT NULL,
  "created_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "certificates_event_type_subject_unique"
    UNIQUE ("event_id", "type", "subject_id")
);

CREATE INDEX IF NOT EXISTS "certificates_event_id_idx"
  ON "certificates" ("event_id");
