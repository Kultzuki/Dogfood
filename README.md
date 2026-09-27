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
Out of scope and not claimed: webhooks and certificates do not exist in
this build.

## Tests

There is no top-level `tests/` directory. The suite lives colocated with
the code as `src/**/*.test.ts` (10 files: `authz/isolation`,
`judging/engine`, `lib/audit`, `lib/csv`, `lib/eventTransitions`,
`lib/password`, `lib/rateLimit`, `lib/uploadStore`, `routes/rubrics`,
`routes/community`).
Run it with `npm test` (`vitest run`).
