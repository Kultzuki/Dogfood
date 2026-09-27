# Architecture

Dogfood is a self-hostable hackathon submission and judging platform built on
[Fastify](https://www.fastify.io/) (Node.js 22) with Nunjucks server-rendered
pages, PostgreSQL 16, and zero external runtime dependencies.

## System Design

```
┌─────────────────────────────────────────────────────┐
│  Docker Compose                                     │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │  app:3000     │  │  postgres:5432               │ │
│  │  Fastify+TS   │  │  pg 16 alpine                │ │
│  └──────┬───────┘  └──────────────────────────────┘ │
│         │ TCP                                         │
│         └───────────────────────────────┐            │
└─────────────────────────────────────────┼────────────┘
                                          │
```

The platform starts with `docker compose up`. No cloud services, hosted
databases, external authentication providers, runtime CDNs, remote fonts,
analytics, or telemetry are required.

## Components

### Application Layer (`src/`)

| Path | Purpose |
|------|---------|
| `src/server.ts` | Entry point; starts Fastify on `0.0.0.0:3000`. |
| `src/app.ts` | Application factory; registers plugins in dependency order. |
| `src/authz/` | `roles.ts` (role types), `guards.ts` (`requireAuth` 401 / `requireEventRole` + `requireTrackScope` + `requireAssignment` 404-isolation, never 403). |
| `src/judging/` | Pure deterministic pipeline (`validate → dedupe → exclude → canonical-sort → normalize → aggregate → rank`; `centering` method; tie-break chain; SHA-256 `inputHash`). No I/O, no clocks — see JUDGING.md. |
| `src/routes/pages/` | Server-rendered UI: `shell.ts` (`/`, `/register`), `participant*.ts` (dashboard, teams, project draft/edit/submit, uploads), `judge.ts` (queue `/events/:eventId/judge`, ballot `/judge/assignments/:id`), `organizer.ts` (`/events/new`, `/events/:eventId/manage`, `judging-progress`, `audit-viewer`, `data`), `community.ts` (T3 ballot `GET/POST /events/:eventId/ballot`, detail comment form `POST /gallery/:projectId/comments`; forms never POST to `/api/*`). |

### Plugins (`src/plugins/`)

| Plugin | Purpose |
|--------|---------|
| `security.ts` | `@fastify/helmet` — CSP `default-src 'self'`, HSTS, referrer-policy, no-Sniff. |
| `session.ts` | Signed `sid` cookie (httpOnly, SameSite=Lax); DB-backed `sessions` rows (24 h idle, 30 d absolute, revocation); ephemeral pre-login store for CSRF. |
| `csrf.ts` | CSRF token generation + validation for state-changing methods (`x-csrf-token` header or `_csrf` body field; JSON `POST /projects/new` probe exempt). |

### Routes (`src/routes/`)

| Route | Purpose |
|-------|---------|
| `health.ts` | `/healthz` (liveness), `/readyz` (readiness with DB check). |
| `pages.ts` | `GET /` login page. Auth lives in `auth.ts` (`POST /register`, `POST /login`, `POST /logout`, `POST /password-change`). |
| `auth.ts` | Register/login/logout/password-change; scrypt password hashes; generic `invalid_credentials` (no enumeration); login rate-limited. |
| `events.ts` | Event CRUD (`POST /events`, `GET /events/:id`, `PUT /events/:id`) + lifecycle transitions (`POST /events/:id/transition`, advisory-locked, optimistic `expectedVersion`). |
| `tracks.ts` | Track/prize CRUD per event (`POST/GET/PATCH/DELETE /api/events/:eventId/tracks…`, same for `prizes…`). |
| `teams.ts` | Invite-link teams: organizer create (`POST /api/events/:eventId/teams`), token join (`POST …/teams/join`, transactional size cap), token rotation (`PATCH …/rotate`). |
| `projects.ts` | JSON project API: draft create, edit, submit (server-time deadline `now() <= submissions_close_at`), read, version history. |
| `gallery.ts` | Public `GET /gallery` (search `q`, `track` UUID-validated, `tag`); organizer question admin; team-member custom answers. |
| `scores.ts` | Assignments (`POST /api/assignments`) + scores with rescore chain; owner isolation via 404 (never 403). |
| `rubrics.ts` | Weighted rubrics: `GET /api/events/:eventId/rubric` (active weights), `POST …/rubrics` (organizer-only new version, weights sum to 100). |
| `community.ts` | T3 community voting + comments JSON API: `POST /api/projects/:id/vote` (auth, in-window, one vote per project per user), `GET …/votes` (counts; 404 for non-organizers while voting is active), `GET/POST …/comments` (public list, authenticated create, 1–2000 chars), `POST /api/events/:id/voting-window` (organizer-only window config). Ballot order is `sha256(userId&#124;projectId)` sort — deterministic per voter, stable on refresh. |
| `acceptance.ts` | Checker aliases only (no new business logic): `POST /projects/new` (deadline probe), `GET /api/judge/scores[?judge=]` (403-mapped isolation probe), `GET /api/export.csv` (organizer CSV probe). |
| `exports.ts` | Organizer CSV hub (`GET /api/events/:eventId/export?dataset=…`) + all-or-nothing row import (`POST …/import`). |
| `audit.ts` | Organizer audit read (`GET /api/events/:eventId/audit`). |
| `uploads.ts` | Upload metadata + local-disk bytes (`GET /uploads/:id`, members only). |

### Templates (`templates/`)

| Template | Purpose |
|----------|---------|
| `layout.njk` | Base HTML shell: header, nav, main, footer. Links only `/static/css/main.css`. |
| `login.njk` | Login form extending layout. Hidden `_csrf` field. BEM classes. |

### Static Assets (`static/`)

| Path | Purpose |
|------|---------|
| `static/css/main.css` | Hand-written BEM stylesheet. CSS custom properties. Zero CDN references. |

### Database (`src/db/`)

| File | Purpose |
|------|---------|
| `schema.ts` | Drizzle ORM schema definitions. |
| `migrate.ts` | Migration runner (advisory-locked, journaled in `schema_migrations`). |
| `seed.ts` | Base seed: creates `admin@dogfood.local` once (idempotent). |
| `seed-fixtures.ts` + `fixtures.ts` | Official-fixture adapter: converges `Sample Hack 2026` from `stuff/fixtures.json` (event, tracks, users, memberships, teams, projects, assignments, scores, fixed-token checker sessions); prints `Cookie: sid=…` headers. |
| `index.ts` | Database connection pool. |

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/check-offline.sh` | CI guard; fails if `templates/`, `static/`, or `src/` reference external URLs. |

## Request Pipeline

```
Request
  → onRequest: request-id assignment
  → onRequest: session restore/create from signed cookie
  → onRequest: CSRF token attach + validation (POST/PUT/PATCH/DELETE)
  → handler
  → onSend: set session cookie on response
```

## Security Model

- **CSP**: `default-src 'self'`; no inline scripts, no external resources.
- **Session**: HMAC-signed cookie; httpOnly + SameSite=Lax.
- **CSRF**: Token stored in session, submitted via header or hidden form field.
- **Transport**: HSTS with 1-year max-age; referrer policy strict-origin-when-cross-origin.
- **Authorization**: Server-side enforced; frontend visibility is never an authorization boundary.

## Pinned Digests

| Image | Digest |
|-------|--------|
| `node:22-alpine` | `sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32` |
| `postgres:16-alpine` | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` |

These digests pin exact base images to ensure reproducible builds and defend
against tag mutation. Update only after verifying upstream changelogs.

## Migration Pipeline

1. `drizzle-kit generate` — produces SQL migration files in `drizzle/`.
2. `drizzle-kit migrate` — applies pending migrations against the running database.
3. `src/db/seed.ts` — loads deterministic fixture data after migration.

Migrations are idempotent and deterministic. The application starts only after
migrations complete successfully.

## Offline Statement

The platform renders and functions with network access disabled. All CSS is
bundled locally. Templates reference only relative paths. The CI
`check-offline.sh` script enforces this invariant by grepping for forbidden
URL patterns across `templates/`, `static/`, and `src/`.
