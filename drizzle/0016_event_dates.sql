-- Dogfood Platform — Event date configuration (additive only)
--
-- Adds nullable scheduling columns. NULL = unconstrained (preserves exact
-- pre-change behavior: previously only submissions_close_at existed and NULL
-- meant "open indefinitely"). Predicates use the DB clock (now()).

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMPTZ;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "ends_at" TIMESTAMPTZ;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "submissions_open_at" TIMESTAMPTZ;

-- submissions_close_at already exists (see 0007_projects.sql).
