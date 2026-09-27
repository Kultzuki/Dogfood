# Dogfood

Open-source, self-hostable hackathon submission and judging platform.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Node.js 22+ (for local development only; Docker handles runtime)

## Quick Start

```sh
docker compose up --build
```

The platform starts on `http://localhost:3000`.

## Demo test accounts — LOCAL SANDBOX ONLY ⚠️

`docker compose up` seeds four fixed, password-loginable identities so a
human can drive the browser UI without hand-crafting signed session cookies:

| Role       | Email                        | Password          |
| ---------- | ---------------------------- | ----------------- |
| organizer  | `test.organizer@dogfood.local` | `DogfoodTest123!` |
| judge      | `test.judgea@dogfood.local`    | `DogfoodTest123!` |
| judge      | `test.judgeb@dogfood.local`    | `DogfoodTest123!` |
| participant| `test.participant@dogfood.local` | `DogfoodTest123!` |

Sign in normally at `http://localhost:3000`. One role per account, so
cross-role isolation tests are meaningful.

**These are demo credentials for a local sandbox only.** They share one
published password and are seeded by `src/db/seed-demo.ts` behind
`DOGFOOD_DEMO_ACCOUNTS=1` (any other value is a silent no-op). They are
created through the same `users` table and scrypt hash that `POST /register`
uses — there is no backdoor route, no pre-minted session token, and no
CSRF/authorization bypass.

**Disable them for any deployment that is not a local sandbox.** Add to a
`.env` file beside `compose.yaml` (or export in your shell):

```sh
DOGFOOD_DEMO_ACCOUNTS=0
```

The demo accounts are unrelated to the official acceptance fixture
identities in `stuff/fixtures.json`, and `.dogfood.toml` never references
them.

> **Also pin `SESSION_SECRET` for real deployments.** `compose.yaml` ships a
> deterministic local-sandbox value so the committed `.dogfood.toml`
> acceptance cookies keep working across `docker compose down -v` resets.
> With that default in place, anyone who can read this repository could
> forge a session cookie for the public fixture tokens. Generate your own
> (`SESSION_SECRET=$(openssl rand -hex 32) docker compose up -d`) and
> refresh the `[auth]` block in `.dogfood.toml` from the `Cookie: sid=...`
> lines the container prints at boot.

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
docker compose up --build -d
py -3 stuff/run.py .dogfood.toml > acceptance-report.txt
```

`.dogfood.toml` holds the base URL, the honest tier claim, the seed's
printed `Cookie: sid=...` auth headers, and the route map (`/gallery`,
`/projects/new`, `/api/judge/scores`, `/api/export.csv`). The committed
`acceptance-report.txt` is the verbatim output of that run.

Current verdict: claimed `T1 T2`, verified `T1 T2` (7/7 checks pass).
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
the code as `src/**/*.test.ts` (10 files: `authz/isolation`,
`judging/engine`, `lib/audit`, `lib/csv`, `lib/eventTransitions`,
`lib/password`, `lib/rateLimit`, `lib/uploadStore`, `routes/rubrics`,
`routes/community`).
Run it with `npm test` (`vitest run`).
