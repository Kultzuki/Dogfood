# Judging

Competition-critical scoring pipeline (`src/judging/`). Pure, deterministic,
independently testable: node:stdlib + relative imports only, no randomness,
no clocks, no I/O, no web/DB imports. Public names: `runPipeline`,
`hashEntries` (extended, never renamed).

## Pipeline order

`runPipeline(entries, method, excluded?)` executes exactly:

1. **validate** — drop malformed rows (bad ids, non-finite or out-of-range
   values). Never throws on data.
2. **dedupe** — rescore collapse (see Rescore below).
3. **exclude** — drop entries whose `projectId` is in `excluded`
   (disqualified projects cannot shift judge/global statistics).
4. **canonical-sort** — `(judgeId, projectId, value)` code-unit order, so
   group statistics are exactly permutation-invariant.
5. **normalize** — per `method`.
6. **aggregate** — mean of normalized values (plus raw mean, `n`) per project.
7. **rank** — total-order sort into sequential ranks 1..k.

## Chosen method: `centering`

`normalized = raw − judgeMean + globalMean`. Removes additive
harsh/generous rater offsets without rescaling spread. A constant rater
(zero variance, incl. single-score judges) just shifts by the global
offset — no NaN by construction, no variance estimated from tiny samples.

## Comparison (adjudication)

Candidates evaluated on `evidence/w4-sims/` (`npm run simulate`):
seeded fixtures (40 projects, 30 judges, harsh/generous/constant/incomplete
raters, rescore + rubric-edit analogues) plus a ground-truth leg (seeded
latent project quality + per-judge harshness/spread biases + partial
overlap; methods scored by Spearman rank correlation vs latent truth and
top-10 recovery).

| method | vsTruth Spearman | vsTruth top-10 | vs raw-mean baseline (top-10 overlap) | verdict |
|---|---|---|---|---|
| `centering` | 0.9715 | 8/10 | 5/10 | **chosen (primary)** |
| `zscore-global` | 0.9672 | 8/10 | 6/10 | runner-up, kept |
| `raw-mean` | 0.9518 | 7/10 | — (baseline) | rejected: no bias correction |
| `median-mad` | 0.9407 | 7/10 | 6/10 | rejected: per-project median discards cross-judge signal, worst truth recovery |

`centering` wins on evidence (best latent-truth recovery) and is
assumption-lighter than `zscore-global`: it never divides by a per-judge
spread estimated from a handful of scores (see batch-size assumption).
The margin over `zscore-global` is narrow; both are kept as runnable
methods and the harness re-adjudicates on every `npm run simulate`.

## Assumptions

- Judge batches are random/unbiased samples of projects (partial overlap
  is expected and handled; systematically skewed batches bias every method).
- Batch size ≥ 3 scores per judge recommended. With batch size 2,
  `zscore-global` z-scores are structurally ±1 (two points always sit one
  sample-std from their mean), so spread correction becomes noise —
  prefer `centering` for tiny batches.
- Normalized values may fall outside [0,100] (bias corrections are
  additive/multiplicative shifts, not clamps). Displayed `normalized`
  values are rounded to 6 decimals; ranking never re-clamps.

## Tie-break chain (on rounded values)

Sort keys are the ROUND6 values actually displayed, so sub-display
(≈1e-7) float noise cannot flip a tie:

1. `normalized` desc
2. `rawMean` desc
3. `n` desc (more evidence wins)
4. `projectId` asc (code-unit order — total, locale-independent)

The chain is recorded verbatim on every row (`tieBreak`). Project ids are
unique, so ranks are always sequential 1..k with no shared positions.

## Rescore (last-wins)

A duplicate `(judgeId, projectId)` pair keeps the LAST entry. Callers MUST
supply time-ordered input (later rescores appended last); among entries
with equal keys the later array position wins. Dedupe runs on validated
entries only, so an invalid rescore never erases a prior valid score
(e.g. `[80, NaN]` and `[NaN, 80]` both resolve to `80`, `n = 1`).

## Disqualification (DQ before normalization)

`excluded` project ids are removed before normalization, so DQ entries
cannot shift judge means, judge spreads, or global statistics. The
simulate harness filters DQ entries simulate-side AND passes `excluded`
through; both orders commute (idempotent set subtraction).

## Audit hash (`inputHash`)

`inputHash` is a SHA-256 post-dedupe multiset fingerprint: the canonical
JSON of the effective (validated, deduped, non-excluded,
canonical-sorted) entries. Equal hash + equal method implies equal
ranking. Raw-input permutations — including rescore orderings that
resolve to the same effective set — hash identically.

## Results record method + exclusions

Every `PipelineOut` carries `method` and sorted `excluded`, and
`evidence/w4-sims/summary.txt` records a `run method=… excluded=…
inputHash=…` line per method, so any ranking is reproducible from its
recorded inputs.

## Rubric versioning (organizer-configurable weights)

The ballot composite is a weighted sum over the four criteria
`technical / innovation / impact / polish`:

- An organizer publishes weights per event via
  `POST /api/events/:eventId/rubrics`; members read the active version
  via `GET /api/events/:eventId/rubric` (`drizzle/0013_rubrics.sql`).
- Weights must use exactly those four keys, each a finite 0..100
  number, and sum to 100 — otherwise the publish is rejected with 422.
- Each publish creates version `max + 1` and deactivates the previous
  version in the same transaction (advisory-locked per event), so exactly
  one version is active per event.
- Every score pins the active `rubric_version` at submit/rescore time
  (`scores.rubric_version`). Reweighting never rewrites old scores: they
  stay immutable and keep the version — and therefore the weights — they
  were computed with.
- Events with no published version use the default
  30 / 25 / 25 / 20 weights (version 1), preserving historical composites.
- Normalization is unaffected: it operates on the stored scalar
  composites (`scores.value`), never on criteria or weights, so a
  reweight only changes subsequently submitted scores.
