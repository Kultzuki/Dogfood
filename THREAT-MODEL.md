# Threat Model (First Draft — Prep Phase)

Scope: the platform as implemented today (Prompts 1–5). Voting and
comments do not exist yet, so voting threats are assessed against
controls present, with gaps stated plainly. Nothing below claims a
control that is not in the tree; verify each citation with grep.

## 1. Sybil voting

**Status: not addressed.** There is no voting subsystem yet, and account
creation has no email verification, no CAPTCHA, and no proof-of-personhood.
The only friction is the auth throttle (`src/lib/rateLimit.ts`: 30
register/login attempts per 10 min per IP, `TRUST_PROXY`-gated XFF), which
slows but does not stop mass registration. When voting lands (roadmap
T3), it MUST NOT trust user identity alone: plan is `voter_key` UNIQUE
per event+project, IP-hash token buckets, and hidden results until
publish. Until then, any claim of Sybil resistance would be false.

## 2. Ballot stuffing

**Status: not addressed (no ballots exist).** No vote table, no
replay protection, no per-IP accounting exists today. Residual control
worth noting: all state-changing routes require CSRF tokens
(`src/plugins/csrf.ts`), so cross-site forged writes are blocked — but
that stops third-party forgery, not a first-party stuffer with a valid
session. The T3 design (unique voter keys + DB-enforced one-row-per-voter
+ concurrent double-POST hammer test) is specified but unbuilt.

## 3. Submission scraping

**Status: not addressed.** `GET /gallery` is intentionally public with no
authentication, no rate limiting, and no bot detection
(`src/routes/gallery.ts` has no throttle; confirmed by grep). Anyone can
enumerate all submitted projects, titles, descriptions, and tech tags at
machine speed. This is accepted for v1 on the grounds that submitted
showcase content is public by design — but organizer PII, draft (non-
submitted) projects, and unpublished events are never exposed: gallery
queries filter `status = 'submitted'` plus showcase event states, and
non-member reads of anything else return 404, never 403
(`src/authz/guards.ts`). If scraping becomes abuse (mirrored events,
spam), the lever is gallery rate-limiting plus API keys — not built.

## 4. Judge collusion

**Status: partially addressed.** What exists: judges cannot read peer
scores (owner-or-organizer check → 404, `src/routes/scores.ts`), cannot
cross into other tracks when scoped (`requireTrackScope`), cannot cross
events (membership miss → 404), and every one of these cells is pinned by
`src/authz/isolation.test.ts`, which runs on every commit. Score edits go
through a rescore chain that retains history, and lifecycle transitions
emit structured audit lines. What does NOT exist: statistical collusion
detection (correlated-score analysis), conflict-of-interest declarations,
or blind review (judges see project authors). A pair of judges can still
agree off-platform to inflate each other's assigned projects; nothing in
the tree detects that. Honest statement: isolation raises the cost of
collusion from trivial reads to coordinated score manipulation, which the
append-only history at least makes visible after the fact.

## 5. Deadline gaming

**Status: addressed at the predicate level.** Submission acceptance uses
the database clock, not client timestamps: the submit path requires
`now() <= submissions_close_at` evaluated in Postgres
(`drizzle/0007_projects.sql`, `src/routes/projects.ts`), exactly-at
accepted, one second after rejected. Forged client timestamps are never
read. Retries at the boundary are serialized by the same transaction that
checks the predicate, so a double-submit straddling the deadline yields
one row, not two. Residual gaps: (a) no NTP discipline is documented for
self-hosters — a skewed DB clock moves the true deadline, so operators
should run NTP (noted here, not enforced); (b) post-deadline *edits* are
rejected with 422, but there is no organizer override flow yet — a
legitimate late fix needs direct DB access, which bypasses the audit
trail. Clock skew and the missing override are accepted v1 gaps.

## Control inventory (implemented → threat)

| Control | File | Covers |
|---|---|---|
| DB-clock deadline predicate | `src/routes/projects.ts`, `drizzle/0007_projects.sql` | Deadline gaming (5) |
| Peer/cross-track/cross-event 404s + matrix suite | `src/routes/scores.ts`, `src/authz/isolation.test.ts` | Judge collusion reads (4) |
| Rescore history (old rows retained) | `drizzle/0010_scores.sql`, `src/routes/scores.ts` | Collusion visibility (4) |
| Hash-chained audit log + trigger | `src/lib/audit.ts`, `drizzle/0011_audit.sql` | Post-hoc review (4), admin accountability |
| Auth throttle 30/10min/IP | `src/lib/rateLimit.ts`, `src/routes/auth.ts` | Registration abuse friction (1, partial) |
| CSRF on all mutations | `src/plugins/csrf.ts` | Forged writes (2, partial) |
| Signed sessions, scrypt, revocation | `src/plugins/session.ts`, `src/lib/password.ts` | Account takeover preconditions (all) |
| One-vote-per-project UNIQUE + window predicate on DB clock | `drizzle/0014_community.sql`, `src/routes/community.ts` | Duplicate votes, out-of-window votes (2, partial) |
| Vote burst throttle 60/h + per-user velocity cap 100/h + audit `vote.cast` | `src/routes/community.ts`, `src/lib/rateLimit.ts` | Excessive voting / ballot stuffing signals (2, partial) |
| Counts 404 while voting is active (organizers only) | `src/routes/community.ts` | Hidden-result bypass (2) |
| Comment throttle 30/10min + attribution + audit `comment.create` | `src/routes/community.ts` | Comment spam friction (2, partial) |
| Webhook SSRF guard + HMAC signatures + organizer-only config | `src/lib/webhooks.ts`, `src/routes/webhooks.ts` | Webhook abuse / exfiltration via event system (new surface) |
| Ed25519 record keys gitignored + rotation documented | `src/lib/signing.ts`, `.gitignore` | Record-forgery after key leak (partial — single-deploy trust, no PKI) |

## Explicitly not claimed

Sybil-proof voting (registration is open, so one human can hold many
accounts — the unique constraint binds accounts, not humans),
statistical ballot-stuffing detection, scrape prevention, statistical
collusion detection, blind review, NTP enforcement. Each needs either
further T3 work or an operational control before anyone asserts it.
