-- Dogfood Platform — Auth: session expiry + revocation columns
-- Human-readable migration (drizzle out/)

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "absolute_expires_at" TIMESTAMPTZ;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ;
