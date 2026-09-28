# Demo Video Script — 5 Minutes, Shot by Shot

Total runtime target: 5:00. Record at 1080p against a fresh local sandbox:

```sh
DOGFOOD_DEMO_ACCOUNTS=1 docker compose up --build
```

Demo accounts are OPT-IN (`test.organizer@dogfood.local`,
`test.judgea@dogfood.local`, `test.judgeb@dogfood.local`,
`test.participant@dogfood.local`, shared password `DogfoodTest123!`).
Never enable them outside a throwaway sandbox. Acceptance fixtures
(`stuff/fixtures.json`) are separate and seeded regardless.

## Shot 0 — Cold boot (0:00–0:20)

Terminal: `DOGFOOD_DEMO_ACCOUNTS=1 docker compose up --build`. Voiceover:
"One command. Postgres 16 and the web app, pinned digests, migrations,
seed — no cloud, no accounts." Cut to browser on
`http://localhost:3000`: the Sign In page. `curl /readyz` → 200 overlay.

## Shot 1 — Organizer creates/configures event (0:20–0:50)

Signed in as demo organizer. Create event "Raptor Cup" with
`submissions_open_at`/`submissions_close_at` (ISO), walk the lifecycle
DRAFT → REGISTRATION_OPEN → SUBMISSIONS_OPEN. Add two tracks and a prize
per track. Voiceover: "Events are a state machine with validated dates —
illegal jumps get 422, concurrent transitions serialize."

## Shot 2 — Participant creates team (0:50–1:20)

As demo participant, create team "Night Owls" — creator auto-joins as
leader. Copy the invite link (no email/SMTP — copy-paste link).
Incognito: join as second user, show roster of two. Voiceover: "Team
leadership, one-team-per-event, and size caps are database-enforced."

## Shot 3 — Submit against the deadline (1:20–2:00)

As the team, create a draft, edit it (version history entry), then
submit. Show the submissions window and the accepted submission.
Voiceover: "The deadline is the database clock — exact second counts,
client timestamps ignored." Upload a PNG (10 MB cap, type sniffing,
members-only serve).

## Shot 4 — Public gallery (2:00–2:20)

Logged-out `/gallery`: submitted projects, search, track filter.
Voiceover: "Public, searchable, submitted-only."

## Shot 5 — Judge dashboard + weighted scoring (2:20–3:20)

As an assigned judge, open the queue, submit criterion marks
(technical/innovation/impact/polish) — show the server-computed weighted
composite. In a second judge window, show the first judge's score is
unreachable — 404, not a leak. Voiceover: "Weights are enforced in the
backend and pinned per score; old scores keep their rubric version."

## Shot 6 — Organizer progress + finalize (3:20–4:30)

As organizer: judging progress, audit trail, CSV export (scores,
rankings, projects, teams, judges). `POST
/api/events/:eventId/finalize`, show stored rankings + input hash; change
a score, show `stale:true`, re-finalize. Voiceover: "Centering
normalization, reproducible from the input hash — documented in
JUDGING.md."

## Shot 7 — Publish + bonus (4:30–5:00)

Transition to RESULTS_FINAL, then PUBLISHED. Show `/gallery` results and
one bonus: community vote + comment, or webhook delivery, or certificate
verify (`/api/certificates/:id/verify`). Closing: "Self-hosted,
offline-capable, auditable — `docker compose up` is the whole install."
End card: repo URL + license.

## B-roll / cut list

- Pairwise scoring stays in PAIRWISE-APPENDIX.md; do not present as built.
- Sybil-proof voting is NOT claimed (open registration) — say so if asked.
- If anything breaks live, cut to the pre-recorded fallback for that shot
  only; never re-record the whole video in one take.
