-- Dogfood Platform — Fixture seed support (acceptance fixtures)
-- Additive only: score comments live on scores.comment.
-- Existing tables (events, tracks, teams, team_members, projects,
-- event_memberships, judge_assignments, scores, sessions) are reused.

ALTER TABLE "scores" ADD COLUMN IF NOT EXISTS "comment" TEXT;
