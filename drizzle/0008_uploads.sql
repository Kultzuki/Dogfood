-- Dogfood Platform — Upload metadata (optional; bytes live under UPLOAD_DIR)
-- Files are stored on local disk as <random-hex>.<ext>; this table maps
-- upload ids to stored names and owning projects for authorization.

CREATE TABLE IF NOT EXISTS "uploads" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"    UUID NOT NULL,
  "stored_name"   VARCHAR(255) NOT NULL UNIQUE,
  "original_name" VARCHAR(255) NOT NULL,
  "mime"          VARCHAR(127) NOT NULL,
  "size_bytes"    INTEGER NOT NULL CHECK ("size_bytes" >= 0),
  "created_by"    UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "uploads_project_id_idx" ON "uploads" ("project_id");

-- FK to projects only when that table exists (migration order independent).
DO $$ BEGIN
  IF to_regclass('public.projects') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'uploads_project_id_fkey'
    ) THEN
      ALTER TABLE "uploads"
        ADD CONSTRAINT "uploads_project_id_fkey"
        FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
    END IF;
  END IF;
END $$;
