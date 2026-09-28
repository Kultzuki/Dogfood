# Dogfood

Open-source, self-hostable hackathon submission and judging platform.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Node.js 22+ (for local development only; Docker handles runtime)

## Quick Start

```sh
docker compose up --build
```

The platform starts on `http://localhost:3000`. On first boot with
`SESSION_SECRET` unset, a random secret is generated and persisted to the
`appdata` volume (reused on restart).

The first `docker compose up --build` needs network access to fetch the pinned
base images and install locked npm packages. Once built and the images are
present, application runtime and assets do not call external services.

When serving behind a trusted reverse proxy, set `TRUST_PROXY` to `true` or
to the proxy IP/CIDR so Fastify uses forwarded protocol/client information.
Set `COOKIE_SECURE=true` to force Secure session cookies, or `false` when TLS
is terminated upstream but the internal hop is plain HTTP. The default follows
the request protocol; only trust forwarded headers from a proxy you control.

## Demo test accounts — OPT-IN, LOCAL SANDBOX ONLY ⚠️

Disabled by default (`DOGFOOD_DEMO_ACCOUNTS=0`). Enable explicitly for
local browser QA or the demo-video recording:

```sh
DOGFOOD_DEMO_ACCOUNTS=1 docker compose up --build
```

When enabled, four fixed password-loginable identities exist:

| Role       | Email                        | Password          |
| ---------- | ---------------------------- | ----------------- |
| organizer  | `test.organizer@dogfood.local` | `DogfoodTest123!` |
| judge      | `test.judgea@dogfood.local`    | `DogfoodTest123!` |
| judge      | `test.judgeb@dogfood.local`    | `DogfoodTest123!` |
| participant| `test.participant@dogfood.local` | `DogfoodTest123!` |

Sign in normally at `http://localhost:3000`. One role per account, so
cross-role isolation tests are meaningful.

## Current limits

- Judge invitations are currently direct membership assignment for an existing account. There is no pending invitation token flow for a judge who has not registered yet.
- Webhook delivery retries use a database outbox and are triggered by an explicit request/sweep. There is no background worker, so a quiet service can leave due retries waiting.
- Unresolved duplicate submissions are retained for organizer review and hidden from the public gallery, assignment creation/imports, and ranking output. The fixture `prj_41` is flagged against `prj_07`.

The checked-in Vitest suite currently contains 32 test files and 271 tests; `.kilo/worktrees` is excluded by the `npm test` script.

**They are disabled unless you opt in.** The default (`0` or unset) is a
silent no-op. They are created through the same `users` table and scrypt
hash that `POST /register` uses — there is no backdoor route, no
pre-minted session token, and no CSRF/authorization bypass. Never enable
them outside a throwaway local sandbox.

The demo accounts are unrelated to the official acceptance fixture
identities in `stuff/fixtures.json`, and `.dogfood.toml` never references
them.

> **Session secret.** No deterministic secret is shipped. On first boot
> with `SESSION_SECRET` unset, the entrypoint generates a random secret
> and persists it to the `appdata` volume (`0600`, reused on restart).
> For a real deployment, always supply your own:
> (`SESSION_SECRET=$(openssl rand -hex 32) docker compose up -d`) and
> refresh the `[auth]` block in `.dogfood.toml` from the `Cookie: sid=...`
> lines the container prints at boot. A deterministic sandbox value is
> available ONLY as an explicit opt-in for checker reproducibility
> (`SESSION_SECRET=dogfood-local-demo-session-secret-0000000000 ...`) —
> never use it outside a throwaway sandbox.

## Verify

1. Open `http://localhost:3000` — you should see the login page.
2. Register via `POST /register` (email + name + password, min 8 chars)
   or sign in via `POST /login`; both set a signed `sid` cookie backed
   by a PostgreSQL `sessions` row (24 h idle, 30 d absolute expiry).
   Seeded checker identities are printed at boot (`Cookie: sid=...`
   for organizer / judge_a / judge_b / participant) — copy them into
   `.dogfood.toml`.
3. Run the offline check:
   ```sh
   sh scripts/check-offline.sh
   ```
   Expected output: `OFFLINE-CLEAN: No external URL references found.`

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system design, components,
security model, and pinned image digests.

## Network-Offline Operation

All assets are self-hosted. No CDN, webfonts, external scripts, analytics,
or telemetry are loaded. The application renders correctly with network
access disabled after initial image pull.

## Acceptance

The official checker (`stuff/run.py`, read-only) verifies tier completion
against the live deployment:

```sh
SESSION_SECRET=dogfood-local-demo-session-secret-0000000000 DOGFOOD_DEMO_ACCOUNTS=0 docker compose up --build -d
py -3 stuff/run.py .dogfood.toml --fixtures stuff/fixtures.json > acceptance-report.txt
```

`.dogfood.toml` holds the base URL, the honest tier claim, the seed's
printed `Cookie: sid=...` auth headers, and the route map (`/gallery`,
`/projects/new`, `/api/judge/scores`, `/api/export.csv`). The committed
`acceptance-report.txt` is the verbatim output of that run. The
deterministic `SESSION_SECRET` value above is a throwaway sandbox-only
opt-in so the committed cookies reproduce across `down -v` resets — never
use it outside a local sandbox. With a normal boot (no `SESSION_SECRET`),
copy the fresh `Cookie: sid=...` lines from the boot log into
`.dogfood.toml` before running the checker.

The base seed creates `admin@dogfood.local`. Set `ADMIN_BOOTSTRAP_PASSWORD`
(12–128 characters) before the first seed, or read the randomly generated
one-time password from the seed log. Idempotent seeding does not reset an
existing admin password.

The checked-in acceptance report is from an earlier run and has not been
reproduced against the current working tree. `.dogfood.toml` conservatively
claims T1 until the checker is rerun and the remaining T2 track-scope gaps are
closed.
T3 community voting + comments are implemented (authenticated one-vote-per-project
with a per-event voting window, hidden counts while voting is active,
deterministic per-voter ballots, attributed comments) and covered by
`src/routes/community.test.ts`, but the official checker has no T3 probes —
so T3 is reported here, not claimed in `.dogfood.toml`.
T4 additions (also reported, not claimed): REST index `GET /api`,
per-event webhooks with HMAC-signed at-least-once delivery
(`src/routes/webhooks.ts`), offline Ed25519-signed certificates/records with
public verification (`GET /api/certificates/:id/verify`, pubkey at
`GET /api/records/pubkey`), framing-friendly gallery widget
(`GET /gallery/embed`, documented below), and `votes`/`comments` CSV export
datasets. No T4 item changes T1–T3 behavior.
Out of scope and not claimed: bonus challenges; Sybil-proof voting;
key-rotation continuity for old records (rotation invalidates them).

## Gallery widget (embed)

The public gallery is embeddable with one iframe — no JavaScript, no CDN,
same server-side visibility rules as `/gallery` (submitted projects in
showcase states only; community vote counts are never rendered here):

```html
<iframe src="https://your-host/gallery/embed?limit=12"
        width="100%" height="600" loading="lazy"
        title="Hackathon project gallery"></iframe>
```

Optional query params: `q` (search), `tag`, `track` (UUID), `limit` (1–50,
default 12). `GET /gallery/embed` is the only route that permits framing
(`frame-ancestors *`); every other page keeps `frame-ancestors 'none'`.

## Tests

There is no top-level `tests/` directory. The suite lives colocated with
the code as `src/**/*.test.ts` (18 files: `authz/isolation`,
`judging/engine`, `lib/audit`, `lib/csv`, `lib/csvDatasets`,
`lib/eventTransitions`, `lib/password`, `lib/rateLimit`, `lib/signing`,
`lib/uploadStore`, `lib/webhooks`, `routes/rubrics`, `routes/community`,
`routes/event-dates`, `routes/scores-criteria`, `routes/scores-bypass`,
`routes/teams-flow`, `routes/teams-join`, `routes/finalize`, plus route
regression suites).
Run it with `npm test` (`vitest run`).
