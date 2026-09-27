# Demo Video Script — 5 Minutes, Shot by Shot

Total runtime target: 5:00. Record at 1080p against a fresh
`docker compose up --build`. Speak the *framing line* for the invite-link
handoff exactly as scripted (shot 4) — it is a deliberate v1 scope choice,
not a missing feature.

## Shot 0 — Cold boot (0:00–0:30)

Terminal: `docker compose up --build`. Voiceover: "One command. Postgres
16 and the web app, pinned digests, migrations, seed — no cloud, no
accounts." Cut to browser on `http://localhost:3000`: the Sign In page.
`curl /readyz` → 200 in a corner overlay.

## Shot 1 — Organizer creates the event (0:30–1:20)

Signed in as `admin@dogfood.local`. Create event "Raptor Cup", walk the
lifecycle states on screen: DRAFT → REGISTRATION_OPEN → SUBMISSIONS_OPEN.
Add two tracks and a prize per track. Voiceover: "Events are a state
machine, not a status column — illegal jumps get 422, concurrent
transitions serialize."

## Shot 2 — Team hand-off, no email (1:20–2:10)

Create team "Night Owls", copy the invite link. **Framing line, say
verbatim:** "In v1, invites are copy-paste links — no email sending, no
SMTP secrets to operate, nothing to leak. The organizer pastes this link
into their own channel." Open an incognito window, join via the link as a
second user. Show the team roster at two members.

## Shot 3 — Submit against the deadline (2:10–3:10)

As the team, create a draft, edit it (note the version history entry),
then submit. Show the event's `submissions_close_at` and the accepted
submission. Voiceover: "The deadline is the database clock — the exact
second counts, and client timestamps are ignored." Upload a PNG screenshot
for the project (mention: 10 MB cap, type sniffing, served only to
members).

## Shot 4 — Judge, isolate, normalize (3:10–4:20)

As an assigned judge, score the project. In a second judge window, show
that the first judge's score is unreachable — 404, not a leak. As
organizer, open the audit trail and the CSV export. Voiceover: "Judges
see only their own queue. Every score change is a new row, never an
edit. Normalization is per-judge centering — documented with its
assumptions in JUDGING.md, reproducible from the input hash."

## Shot 5 — Publish + gallery (4:20–5:00)

Transition to RESULTS_FINAL, then PUBLISHED. Open `/gallery` in a logged-
out window: submitted projects, search, track filter. Closing line:
"Self-hosted, offline-capable, auditable — `docker compose up` is the
whole install." End card: repo URL + license.

## B-roll / cut list

- Skip: pairwise scoring (see PAIRWISE-APPENDIX.md), certificates,
  comments, voting — all deferred or unbuilt; do not show.
- If anything breaks live, cut to the pre-recorded fallback for that shot
  only; never re-record the whole video in one take.
