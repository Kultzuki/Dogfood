-- Dogfood Platform — Score criteria persistence (additive only)
--
-- Stores the judge-submitted criterion marks alongside the computed
-- composite (scores.value). Old rows keep value-only (criteria NULL).

ALTER TABLE "scores" ADD COLUMN IF NOT EXISTS "criteria" JSONB;
