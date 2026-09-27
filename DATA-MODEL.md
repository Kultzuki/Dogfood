# DATA-MODEL

Schema, fixture mapping, and import/export paths. Docs follow code: anything
listed here exists in `drizzle/*.sql` (runtime DDL) and is exercised by the
live seed + the acceptance checker (`py -3 stuff/run.py .dogfood.toml`).

## Tables

All tables live in PostgreSQL 16 (`db` service). Migrations run in
lexicographic order at boot (`node dist/db/migrate.js`, advisory-locked,
journaled in `schema_migrations`).

| Table | Source | Purpose |
|---|---|---|
| `users` | `0001_init.sql` | Accounts. `email` unique. `role`: `admin` / `organizer` / `judge` / `participant` (system default; event-scoped authority lives in `event_memberships`). |
| `sessions` | `0001` + `0002_auth.sql` | Login sessions. `token` unique, looked up from the signed `sid` cookie. `last_seen_at` (24 h idle), `absolute_expires_at` (30 d), `revoked_at` (logout/revoke). |
| `events` | `0003_events.sql` (+ `submissions_close_at` from `0007`, `voting_opens_at` / `voting_closes_at` from `0014`) | Hackathon events. `state` lifecycle machine, `submissions_close_at` is the trusted deadline clock (`now() <= submissions_close_at` ⇒ open). Community voting is active iff `voting_opens_at IS NOT NULL AND voting_opens_at <= now() AND (voting_closes_at IS NULL OR voting_closes_at > now())`; both NULL (the default) means voting never opens. |
| `event_memberships` | `0003` (+ `track_id` scope from `0005`) | Per-event roles: `participant` / `judge` / `organizer`. `UNIQUE(event_id, user_id)`. `track_id NULL` = unscoped. |
| `tracks` | `0004_tracks.sql` | Event tracks. `UNIQUE(event_id, slug)`. |
| `prizes` | `0004_tracks.sql` | Event prizes, optionally per track. |
| `teams` | `0006_teams.sql` | `invite_token` unique (invite-link joins), `max_size` 1–20. |
| `team_members` | `0006_teams.sql` | `UNIQUE(team_id, user_id)` and `UNIQUE(user_id, event_id)` (one team per user per event). |
| `projects` | `0007_projects.sql` | Submissions. `status` ∈ `draft`/`submitted` (DB check). `tech_tags TEXT[]`. |
| `project_versions` | `0007_projects.sql` | Append-only snapshots (DB trigger blocks UPDATE/DELETE). |
| `uploads` | `0008_uploads.sql` | Upload metadata; bytes on local disk. |
| `custom_questions` / `custom_answers` | `0009_gallery.sql` | Organizer-defined submission fields + answers. |
| `judge_assignments` | `0010_scores.sql` | Judge→project assignments. `UNIQUE(event_id, project_id, judge_user_id)`, `status` default `active`. |
| `rubrics` | `0010_scores.sql` | Legacy stub table (name per event). Unused by the weighted-rubric flow; superseded by `rubric_versions`. |
| `rubric_versions` | `0013_rubrics.sql` | Organizer-configurable weighted rubrics. One active version per event (`UNIQUE(event_id, version)`; deactivation in the same txn, enforced in app code). `weights` JSONB holds exactly `{technical, innovation, impact, polish}`, each 0–100, summing to 100 (validated, else 422). Events with no row use the default 30/25/25/20 (version 1). Every score pins the active version at submit time (`scores.rubric_version`); reweighting never rewrites old scores. |
| `scores` | `0010_scores.sql` (+ `comment TEXT` from `0012_fixtures.sql`) | Scalar `value NUMERIC` with DB check `0 <= value <= 100`. Rescore chain via `version` / `supersedes_id` / `is_current`. |
| `audit_logs` | `0011_audit.sql` | Append-only (DB trigger), hash-chained audit trail. |
| `community_votes` | `0014_community.sql` | T3 community votes. `UNIQUE(event_id, project_id, user_id)` — one vote per project per user, enforced by the DB so concurrent double-votes cannot both land. No unvote: rows are never updated or deleted by the app. |
| `project_comments` | `0014_community.sql` | T3 project comments. `body TEXT` with DB check `char_length BETWEEN 1 AND 2000` (app validates identically, else 422). Attributed to `user_id`; rendered escaped via Nunjucks autoescape. |
| `schema_migrations` | `src/db/migrate.ts` | Applied-migration journal (boot idempotency). |

## Fixture mapping (`stuff/fixtures.json` → DB)

Boot converges the `Sample Hack 2026` event to the fixture content:

- **Event**: row named `Sample Hack 2026`, `submissions_close_at` = fixture
  `event.submissions_close` (`2026-03-01T18:00:00Z`, past), `state` =
  `SUBMISSIONS_CLOSED` (a gallery-visible state; the gallery only lists
  `submitted` projects from events in `SUBMISSIONS_CLOSED`/`JUDGING`/
  `RESULTS_FINAL`/`PUBLISHED`).
- **Tracks**: fixture `id` → `tracks.slug` (unique per event), fixture `name` → `name`.
- **Users**: fixture judges + all team-member emails → `users` (role `judge`
  / `participant`), plus `organizer@dogfood.local` (`organizer`) and
  `participant@dogfood.local` (`participant`). Upserted by email.
- **Memberships**: organizer → `organizer`, fixture judges → `judge`, team
  members + probe participant → `participant`, all unscoped (`track_id NULL`).
- **Teams**: fixture `id` → `teams.invite_token = 'fixture-<id>'` (stable,
  unique); all fixture members added to `team_members`.
- **Projects**: `title` verbatim, `summary` → `description`, `status` =
  `submitted`, `created_at`/`updated_at` = fixture `submitted_at`. (The
  schema has no `submitted_at`/`repo_url` columns; those fixture fields are
  not stored.)
- **Assignments/scores**: one `judge_assignments` row per (`judge`,
  `project`) pair; one current `scores` row per fixture score entry with
  scalar `value = round(mean(criteria) * 20)` (fixture criteria are 1–5
  marks; the app stores a single 0–100 value). Fixture score `comment`
  text is not stored by the convergent seeder.
- **Sessions (checker auth)**: fixed tokens `fixture-organizer`,
  `fixture-judge-a`, `fixture-judge-b`, `fixture-participant` in
  `sessions.token` (upserted, expiry refreshed, never revoked). The boot log
  prints ready-to-paste `Cookie: sid=<signed>` headers plus
  `acceptance ids: event=<uuid> judge_a=<uuid> …`.
- **judge_a / judge_b**: the first two fixture judges (file order) that own
  at least one score, so own-scores reads are non-empty and peer isolation
  is meaningful.

## Import paths (how data gets in)

1. `docker compose up` → `docker/entrypoint.sh`: waits for Postgres, runs
   `node dist/db/migrate.js`, then `node dist/db/seed.js` (creates
   `admin@dogfood.local` once), then `node /app/docker/seed-fixtures.mjs`
   (converges the fixture event: upserts users/memberships/sessions, wipes
   + recreates only that event's tracks/teams/projects/assignments/scores),
   then `node dist/db/seed-fixtures.js` (skips the data load when the
   fixture event exists, reprints the same checker headers).
2. Fixture file reaches the image via `Dockerfile`: `COPY
   stuff/fixtures.json ./fixtures.json` (+ the seeder script itself).
3. Runtime CSV/JSON row import for assignments/scores: `POST
   /api/events/:eventId/import?dataset=…` (organizer only, all-or-nothing).

## Export paths (how data gets out)

- `GET /api/export.csv` — checker-facing organizer export of current scores
  as `text/csv` (header `id,event_id,project_id,judge_user_id,value,version,
  is_current,created_at`, RFC-4180 escaping via `src/lib/csv.ts`).
- `GET /api/events/:eventId/export?dataset=assignments|scores-raw|
  scores-normalized|rankings|audit` — full organizer CSV hub (streaming).
- `GET /gallery` — public HTML gallery of submitted projects.
