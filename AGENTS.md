# Dogfood Hackathon Platform — AI Development Rules

## Project

This repository is the implementation of the Dogfood hackathon challenge.

The goal is to build an open-source, self-hostable hackathon submission and
judging platform that Hackathon Raptors could realistically operate in
production.

The platform covers the full lifecycle:

Registration
→ Teams
→ Submissions
→ Eligibility
→ Assignment
→ Scoring
→ Normalization
→ Results
→ Certificates
→ Archive

The implementation must prioritize correctness, competition integrity,
operability, and maintainability over feature count.

## Official Dogfood Priorities

Optimize engineering decisions around:

- Tier Completion & Correctness — 40%
- Judging Integrity — 25%
- Adoptability & Operability — 20%
- Code Quality & Innovation — 15%

A clean, correct T2 is more valuable than a broken T4.

Do not sacrifice T1/T2 correctness for flashy features.

## Application Roles

The application has these roles:

- Participant
- Judge
- Organizer
- Admin

Do not treat public/unauthenticated visitors as a privileged application role.

Authorization must always be enforced server-side.

## T1 — Core Requirements

T1 must support:

- Authentication and sessions
- Participant role
- Judge role
- Organizer role
- Admin role
- Event creation
- Configurable event dates
- Tracks
- Prizes
- Team formation through invite links
- Project submission
- Draft and edit functionality
- Real deadline enforcement
- Searchable public project gallery

T1 is the minimum requirement for the project to be judged.

## T2 — Judging Requirements

T2 must support:

- Judge invitations
- Judge assignment
- Batch and/or algorithmic assignment
- Weighted configurable judging rubrics
- Backend-enforced role isolation
- Judge progress dashboards
- Cross-judge score normalization
- CSV export throughout the workflow

A judge must never be able to access another judge's scores.

A judge must never be able to access projects or judging data outside their
authorized event, track, or assignment.

Frontend visibility is never an authorization boundary.

## T3 — Public Requirements

Where implemented, T3 should support:

- Configurable community voting
- Open-link voting
- Email-gated voting
- Authenticated voting
- Comments
- Hidden results during voting
- Randomized project ordering
- Rate limiting
- Duplicate detection
- Audit trails

Voting protections should be technically defensible without unnecessary
overengineering.

## T4 — Stretch Requirements

Only after T1 and T2 are correct, consider:

- REST API
- Webhooks
- Certificate and record generation
- Signed and publicly verifiable judge participation records
- Embeddable gallery widget
- Bulk import/export

Do not allow T4 work to compromise T1/T2.

## Competition Integrity

Judging is competition-critical infrastructure.

The judging system must be:

- Deterministic
- Reproducible
- Explainable
- Auditable
- Mathematically defensible
- Testable

Never implement a scoring formula merely because it sounds sophisticated.

The judging pipeline should remain conceptually separated into:

1. Assignment
2. Rubric configuration
3. Raw scores
4. Score validation
5. Normalization
6. Aggregation
7. Ranking
8. Tie-breaking
9. Result finalization
10. Auditability
11. Export

The judging engine must be independently testable from ordinary CRUD logic.

Never silently change competition-critical scoring mathematics.

Any change to judging mathematics must update:

- Documentation
- Tests
- Simulations

## Normalization

Raw score averaging is not automatically sufficient.

Before selecting a normalization method:

- define the actual problem
- identify assumptions
- compare reasonable candidate approaches
- test pathological cases
- evaluate sparse data behavior
- evaluate interpretability
- evaluate determinism
- evaluate reproducibility

Important cases include:

- harsh judges
- generous judges
- low-variance judges
- high-variance judges
- outliers
- missing scores
- partial overlap
- unequal assignment sizes
- small sample sizes
- judge dropout
- disqualified projects
- rescoring
- ties
- identical scores

Fairness claims must be supported by evidence, tests, simulations, and clearly
stated assumptions.

## Event Lifecycle

Treat event lifecycle as an explicit state machine.

Expected lifecycle:

DRAFT
→ REGISTRATION_OPEN
→ SUBMISSIONS_OPEN
→ SUBMISSIONS_CLOSED
→ JUDGING
→ RESULTS_FINAL
→ PUBLISHED
→ ARCHIVED

Invalid transitions must be rejected server-side.

For each transition, explicitly consider:

- authorized roles
- permitted mutations
- forbidden mutations
- concurrent requests
- existing submissions
- existing scores
- publication/finalization rules

Do not rely only on frontend state.

## Deadline Enforcement

Deadline decisions must be made using trusted server/database time.

Never rely on:

- browser clocks
- client timestamps
- hidden frontend controls
- local-only state

Explicitly consider:

- exactly-at-deadline requests
- requests immediately after deadline
- delayed requests
- retries
- concurrent requests
- timezone conversions

## Security

Never trust frontend authorization.

All authorization decisions must be enforced server-side.

Protect against:

- broken object-level authorization
- privilege escalation
- event isolation failures
- track isolation failures
- judge isolation failures
- insecure direct object references
- session attacks
- CSRF
- XSS
- SQL injection
- SSRF
- path traversal
- malicious uploads
- command injection where applicable
- sensitive data exposure
- insecure file access

Competition-critical mutations must be auditable.

## Public Voting Security

Treat public voting as adversarial.

Consider:

- duplicate voting
- Sybil voting
- ballot stuffing
- replay attacks
- rate-limit bypass
- vote manipulation
- hidden-result bypass
- result leakage
- suspicious voting patterns

For the Dogfood Threat Model bonus, explicitly consider:

- Sybil voting
- ballot stuffing
- submission scraping
- judge collusion
- deadline gaming

Do not build an enormous fraud-detection system without a concrete need.

## Race Conditions

Explicitly consider concurrency around:

- Team joining
- Maximum team size
- Duplicate votes
- Simultaneous submissions
- Submission deadlines
- Judge assignments
- Score submission
- Rubric modification
- Project deletion
- Event state transitions
- Concurrent administrative edits

Prefer:

- database constraints
- transactions
- unique indexes
- foreign keys
- locking where necessary
- atomic operations
- server-side timestamps

over application-only checks.

## Database Integrity

Important business invariants should be enforced by the database where
appropriate.

Use:

- primary keys
- foreign keys
- unique constraints
- indexes
- transactions
- referential integrity

Do not rely solely on application checks for competition-critical invariants.

## Auditability

Competition-critical actions should be reconstructable.

Audit records should make it possible to determine:

- who acted
- what changed
- when it changed
- what event was affected
- what track was affected
- what project/resource was affected

Pay particular attention to:

- judge assignments
- rubric changes
- score changes
- rescoring
- disqualification
- result finalization
- publication
- administrative changes
- voting abuse signals

Audit records themselves should not be casually mutable or deletable.

## Offline and Self-Hosting Requirement

The platform must start with:

docker compose up

It must:

- initialize required services
- initialize/migrate the database
- load seed/fixture data
- become usable locally
- continue functioning with network connectivity disabled after setup

The runtime must not depend on:

- Hosted databases
- Authentication-as-a-service
- External APIs
- Cloud accounts
- Proprietary hosted services
- Runtime CDN assets
- Remote fonts
- Analytics
- Telemetry
- External authentication
- Runtime network access

Dependencies must be classified as:

- build-time only
- runtime-required
- optional
- forbidden

Do not introduce cloud-only runtime dependencies.

## Seed and Fixture Requirements

The final platform must start in a useful seeded state.

Seed behavior must be:

- deterministic
- reproducible
- suitable for automated testing

When official Dogfood fixture data becomes available, the application should
support the required fixture/acceptance workflow without modifying the
acceptance suite to hide failures.

## Testing

Every completed feature must have tests.

Tests should cover:

- happy paths
- invalid input
- authorization failures
- object-level authorization
- boundary conditions
- race conditions
- state transitions
- database constraints
- competition-integrity cases
- deterministic judging
- voting abuse
- deadline enforcement

For important user journeys, prefer end-to-end browser verification with
Playwright.

A feature is not complete merely because:

- it compiles
- the page renders
- the API returns 200
- the happy path works

## Acceptance Suite

The official acceptance suite is the ultimate integration target.

When available:

- run the provided acceptance suite
- use the provided fixtures
- preserve the intended test environment
- record failures honestly
- do not modify acceptance tests to manufacture success

The final repository must contain:

acceptance-report.txt

Tier claims must reflect actual tested behavior.

## Documentation

The final repository must include:

- README.md
- ARCHITECTURE.md
- DATA-MODEL.md
- JUDGING.md
- acceptance-report.txt
- LICENSE
- Tests

Documentation must match the implementation.

Do not document functionality that does not exist.

JUDGING.md must explain:

- judge assignment strategy
- scoring methodology
- normalization method
- reasoning behind the approach

ARCHITECTURE.md must explain:

- system design
- major components
- major technical decisions

DATA-MODEL.md must explain:

- schema
- important relationships
- import/export paths

## API Architecture

Prefer clean backend/API boundaries.

Where practical, UI actions should map to well-defined backend operations.

Do not create unnecessary abstraction purely for the API First bonus.

If an API is exposed, authorization must be enforced on the API itself.

## Code Quality

Prefer:

- simple designs
- strong typing
- explicit validation
- small cohesive modules
- clear error handling
- testable business logic
- database-enforced invariants
- deterministic behavior
- explicit domain boundaries

Avoid:

- premature abstractions
- giant files
- duplicated business logic
- client-only security
- hidden global state
- unnecessary dependencies
- clever but fragile code
- overengineering

Do not rewrite working code merely to satisfy personal style preferences.

## Architecture Boundaries

Keep these concerns clearly separated:

- Authentication
- Authorization
- Events
- Teams
- Projects
- Submissions
- Judge assignment
- Rubrics
- Scores
- Normalization
- Ranking
- Voting
- Audit logging
- Exports
- Certificates

Competition-critical judging logic must not be buried inside generic CRUD
handlers.

## AI Development Workflow

Before implementing a complicated feature:

1. Understand the existing architecture.
2. Inspect relevant files.
3. Identify security implications.
4. Identify concurrency implications.
5. Plan the implementation.
6. Implement the smallest coherent change.
7. Run relevant tests.
8. Review the result.
9. Fix discovered problems.
10. Re-run affected tests.

Do not rewrite working parts unnecessarily.

Do not introduce a dependency without a concrete reason.

Do not introduce a cloud dependency into core functionality.

Do not change competition-critical mathematics without explicit reasoning,
tests, simulations, and documentation.

## AI Agent Responsibilities

The project uses specialized AI roles.

Sisyphus:
- Primary implementation agent
- Owns normal feature implementation

Prometheus:
- Architecture and planning
- Difficult technical decisions
- Does not implement application code during planning

Security:
- Read-only adversarial security review
- Attempts to discover exploitable vulnerabilities

Judging:
- Judging mathematics and competition-integrity review

QA:
- Functional testing
- Acceptance coverage
- Edge cases
- Runtime/browser verification

Code Reviewer:
- Independent implementation review
- Architecture
- Correctness
- Maintainability
- Operability

Do not have multiple agents independently rewriting the same subsystem without
a deliberate reason.

Prefer:

Plan
→ Implement
→ Review
→ Security/QA
→ Fix
→ Verify

## Change Discipline

Every significant change should be:

- understandable
- reviewable
- testable
- reversible where practical

Competition-critical changes require extra verification.

Do not silently change:

- scoring formulas
- ranking logic
- rubric semantics
- event lifecycle rules
- authorization boundaries
- audit semantics

## Verification

After implementation, verify the actual running application where practical.

For user-facing functionality:

- use Playwright
- test complete workflows
- test negative paths
- test authorization boundaries
- verify actual state changes

For infrastructure:

- test `docker compose up`
- test database initialization
- test seed loading
- test restart behavior
- test offline runtime behavior

A feature is complete only when its behavior is verified, not merely when its
source code exists.

## Pre-Kickoff Rule

Before the official Dogfood hackathon window, planning, research,
documentation reading, architecture design, and AI prompt preparation are
allowed.

Project application code must not be committed before the official hackathon
window.

Do not generate or commit project implementation code during pre-kickoff
planning.

## Engineering Principle

Optimize for a system that is:

- correct
- defensible
- reproducible
- secure
- self-hostable
- understandable
- maintainable

Do not optimize for the number of features.

The goal is to ship a platform that Hackathon Raptors could actually operate.