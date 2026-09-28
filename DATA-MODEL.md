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
| `events` | `0003_events.sql` (+ `submissions_close_at` from `0007`, `voting_opens_at` / `voting_closes_at` from `0014`, `starts_at` / `ends_at` / `submissions_open_at` from `0016`) | Hackathon events. `state` lifecycle machine. Submissions open iff `(submissions_open_at IS NULL OR now() >= open) AND (submissions_close_at IS NULL OR now() <= close)` on the DB clock; both NULL = open indefinitely. Community voting is active iff `voting_opens_at IS NOT NULL AND voting_opens_at <= now() AND (voting_closes_at IS NULL OR voting_closes_at > now())`; both NULL (the default) means voting never opens. `starts_at <= ends_at` and `open < close` enforced by API validation (422). |
| `event_memberships` | `0003` (+ `track_id` from `0005`, explicit scopes from `0020`) | Per-event roles: `participant` / `judge` / `organizer`. `UNIQUE(event_id, user_id)`. A judge's `track_id NULL` is not a wildcard. |
| `event_membership_tracks` | `0020_membership_track_scopes.sql` | Explicit many-to-many allowed tracks for a membership; rows cascade when a membership or track is deleted. |
| `tracks` | `0004_tracks.sql` | Event tracks. `UNIQUE(event_id, slug)`. |
| `prizes` | `0004_tracks.sql` | Event prizes, optionally per track. |
| `teams` | `0006_teams.sql` (+ `leader_user_id` / `created_by` from `0017`) | `invite_token` unique (invite-link joins), `max_size` 1–20. Creator becomes `leader_user_id`/`created_by`; non-organizer creators auto-join `team_members`. Leave policy: submitted project blocks (409), sole member dissolves the team, leader passes to oldest remaining member. |
| `team_members` | `0006_teams.sql` | `UNIQUE(team_id, user_id)` and `UNIQUE(user_id, event_id)` (one team per user per event). |
| `projects` | `0007_projects.sql` + `0021_duplicate_projects.sql` + `0022_project_links.sql` | Submissions. `status` ∈ `draft`/`submitted` (DB check), `tech_tags TEXT[]`, nullable HTTP(S)-only `repo_url`/`demo_url`, `duplicate_of_project_id` self-reference, and `needs_review`. |
| `project_versions` | `0007_projects.sql` | Append-only snapshots (DB trigger blocks UPDATE/DELETE). |
| `uploads` | `0008_uploads.sql` | Upload metadata; bytes on local disk. |
| `custom_questions` / `custom_answers` | `0009_gallery.sql` | Organizer-defined submission fields + answers. |
| `judge_assignments` | `0010_scores.sql` | Judge→project assignments. `UNIQUE(event_id, project_id, judge_user_id)`, `status` default `active`. |
| `rubrics` | `0010_scores.sql` | Legacy stub table (name per event). Unused by the weighted-rubric flow; superseded by `rubric_versions`. |
| `rubric_versions` | `0013_rubrics.sql` | Organizer-configurable weighted rubrics. One active version per event (`UNIQUE(event_id, version)`; deactivation in the same txn, enforced in app code). `weights` JSONB holds exactly `{technical, innovation, impact, polish}`, each 0–100, summing to 100 (validated, else 422). Events with no row use the default 30/25/25/20 (version 1). Every score pins the active version at submit time (`scores.rubric_version`); reweighting never rewrites old scores. |
| `scores` | `0010_scores.sql` (+ `comment TEXT` from `0012_fixtures.sql`, `criteria` JSONB from `0018`) | Criteria marks `{technical,innovation,impact,polish}` 0–100 validated server-side; scalar `value NUMERIC` (DB check `0 <= value <= 100`) is the weighted composite `compositeFor(activeWeights,criteria)` rounded to 2dp. Rescore chain via `version` / `supersedes_id` / `is_current`. |
| `audit_logs` | `0011_audit.sql` | Append-only (DB trigger), hash-chained audit trail. |
| `webhook_subscriptions` | `0015_t4.sql` | T4 per-event webhook targets: `url`, HMAC `secret` (write-only), `events` type list, `is_active`. Deliveries cascade on delete. |
| `webhook_deliveries` | `0015_t4.sql` | T4 delivery outbox: `event_type`, `payload` JSONB, `status` ∈ pending/delivered/failed/dead (DB check), `attempts`, `next_retry_at`, `last_error`. |
| `certificates` | `0015_t4.sql` | T4 deterministic records: `type` ∈ judge-participation/project-submission/participant (DB check), canonical `payload` JSONB, `digest` (SHA-256 hex), Ed25519 `signature`, `kid`. `UNIQUE(event_id, type, subject_id)` makes re-issue stable. |
| `community_votes` | `0014_community.sql` | T3 community votes. `UNIQUE(event_id, project_id, user_id)` — one vote per project per user, enforced by the DB so concurrent double-votes cannot both land. No unvote: rows are never updated or deleted by the app. |
| `project_comments` | `0014_community.sql` | T3 project comments. `body TEXT` with DB check `char_length BETWEEN 1 AND 2000` (app validates identically, else 422). Attributed to `user_id`; rendered escaped via Nunjucks autoescape. |
| `schema_migrations` | `src/db/migrate.ts` | Applied-migration journal (boot idempotency). |
| `event_finalizations` / `event_rankings` | `0019_rankings.sql` | Persistent normalization: one `event_finalizations` row per finalize run (`method`, SHA-256 `input_hash`, `created_by`), plus per-project `event_rankings` rows (`raw_mean`, `normalized`, `n`, `rank`). Same input hash re-finalizes idempotently (`deduped:true`); score changes make stored rankings `stale:true` until re-finalized. |

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
- **Projects**: `title` verbatim, `summary` → `description`, fixture `repo_url`
  stored in `projects.repo_url`, optional `demo_url` stored when present,
  `status` = `submitted`, and `created_at`/`updated_at` = fixture
  `submitted_at`.
- **Duplicates**: same-team projects with the same normalized repository URL
  (or normalized title if no repository URL exists) are retained. The first
  fixture row is canonical; later rows set `duplicate_of_project_id` to the
  canonical row and `needs_review=true`. Such rows are excluded from public
  gallery/detail, assignment creation/import, and ranking input/output until
  an organizer submits a resolution action. The seeded duplicate pair is
  `prj_07` / `prj_41`.
- **Assignments/scores**: one `judge_assignments` row per (`judge`,
  `project`) pair except unresolved duplicate projects; one current `scores` row per fixture score entry with
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
  scores-normalized|rankings|audit|votes|comments|projects|teams|judges` — full organizer CSV hub (streaming).
- `GET /gallery` — public HTML gallery of submitted projects.
- `GET /gallery/embed` — same visibility query as the gallery, chromeless widget document.
