-- Dogfood Platform — Initial Schema
-- Human-readable migration (drizzle out/)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "users" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email"        VARCHAR(255) NOT NULL UNIQUE,
  "name"         VARCHAR(255) NOT NULL,
  "role"         VARCHAR(50)  NOT NULL DEFAULT 'participant',
  "password_hash" TEXT        NOT NULL,
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token"      VARCHAR(255) NOT NULL UNIQUE,
  "expires_at" TIMESTAMPTZ  NOT NULL,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" ("expires_at");
