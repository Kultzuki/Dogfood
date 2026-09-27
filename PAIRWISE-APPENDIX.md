# Pairwise Comparison Mode — Deferred (Design Appendix)

Status: **deferred, design only**. No pairwise code exists in this repository.
The shipped system uses disjoint absolute scoring (each project scored
independently by exactly k judges, default k=3).

## Why pairwise is deferred: workload math

Assume a typical event: ~40 projects, ~30 judges, each judge scores ~8
projects (the current assignment budget: 40 × 3 = 120 judging slots ÷
30 judges ≈ 4 slots each at k=3; ≤8 with headroom).

A Bradley-Terry model needs *comparisons*, not scores. The complete
pairwise graph over 40 projects has:

    C(40, 2) = 40 × 39 / 2 = 780 pairs

Stable ability estimates need each pair compared several times (Crowd-BT
practice: ≥5 independent comparisons per pair for usable confidence),
i.e. **~3,900 comparisons** for full coverage. At ~10–15 comparisons per
judge session, 30 judges produce ~300–450 comparisons — roughly **an order
of magnitude short**, covering ~10% of pairs once each. Estimates from
that data would be dominated by graph-structure noise, not project
quality.

Gavel (the Crowd-BT system by Khoury, Hamlet, and colleagues, used at
HackMIT and other large hackathons) makes pairwise work by *adaptive*
assignment: it serves each judge the currently most-informative pair and
runs many short judging rounds. That requires a rounds-based judging UX,
a live assignment optimizer, and judge availability spread over the event —
three subsystems we do not have in v1. Bolting a Bradley-Terry estimator
onto our sparse, one-shot, disjoint absolute scores would produce
rankings with false precision: mathematically sophisticated output whose
error bars exceed the gaps between ranks.

## What ships instead

Disjoint absolute scoring with k=3, per-judge centering normalization
(see `JUDGING.md`), and a documented deterministic tie-break chain. Every
project gets exactly k independent reads; every judge's harshness offset
is removed without estimating anything from fewer than ~8 samples.

## Revisit conditions

Pairwise becomes viable when **all** hold: (a) ≥25 active judges
available across multiple rounds, (b) an adaptive pair-serving assignment
service exists, (c) the judging UI is rebuilt around compare-two-projects
rounds rather than score-one-project forms. Until then, this appendix is
the complete extent of pairwise work.
