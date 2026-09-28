/**
 * Pure fixture mapper for stuff/fixtures.json.
 *
 * No DB, no I/O, no randomness here — just parsing + deterministic mapping
 * contracts consumed by src/db/seed-fixtures.ts. Keeping the mapping pure
 * makes the acceptance-routes worker's expectations testable without a DB.
 */

export interface FixtureEvent {
  id: string;
  name: string;
  submissionsClose: string;
}

export interface FixtureTrack {
  id: string;
  name: string;
}

export interface FixtureJudge {
  id: string;
  name: string;
  email: string;
  tracks: string[];
}

export interface FixtureTeam {
  id: string;
  name: string;
  members: string[];
}

export interface FixtureProject {
  id: string;
  team: string;
  track: string;
  title: string;
  summary: string;
  repoUrl: string;
  demoUrl: string;
  submittedAt: string;
}

export interface FixtureCriteria {
  functionality: number;
  quality: number;
  innovation: number;
}

export interface FixtureScore {
  judge: string;
  project: string;
  criteria: FixtureCriteria;
  comment: string;
}

export interface Fixture {
  event: FixtureEvent;
  tracks: FixtureTrack[];
  judges: FixtureJudge[];
  teams: FixtureTeam[];
  projects: FixtureProject[];
  scores: FixtureScore[];
}

/** Deterministic fixture duplicate pairs; first fixture entry remains canonical. */
export function duplicateFixturePairs(projects: FixtureProject[]): Array<{ keepId: string; duplicateId: string }> {
  const canonical = new Map<string, string>();
  const pairs: Array<{ keepId: string; duplicateId: string }> = [];
  for (const project of projects) {
    const repo = project.repoUrl.trim().toLowerCase().replace(/\/$/, "");
    const title = project.title.trim().toLowerCase().replace(/\s+/g, " ");
    const keys = [
      ...(repo ? [`${project.team}\u0000repo:${repo}`] : []),
      ...(title ? [`${project.team}\u0000title:${title}`] : []),
    ];
    const first = keys.map((key) => canonical.get(key)).find((id): id is string => id !== undefined);
    if (first) pairs.push({ keepId: first, duplicateId: project.id });
    else for (const key of keys) canonical.set(key, project.id);
  }
  return pairs;
}

interface RawFixture {
  event?: { id?: unknown; name?: unknown; submissions_close?: unknown };
  tracks?: Array<{ id?: unknown; name?: unknown }>;
  judges?: Array<{ id?: unknown; name?: unknown; email?: unknown; tracks?: unknown }>;
  teams?: Array<{ id?: unknown; name?: unknown; members?: unknown }>;
  projects?: Array<{
    id?: unknown;
    team?: unknown;
    track?: unknown;
    title?: unknown;
    summary?: unknown;
    repo_url?: unknown;
    demo_url?: unknown;
    submitted_at?: unknown;
  }>;
  scores?: Array<{ judge?: unknown; project?: unknown; criteria?: unknown; comment?: unknown }>;
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

function parseCriteria(raw: unknown): FixtureCriteria {
  const c = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
  return {
    functionality: num(c["functionality"]),
    quality: num(c["quality"]),
    innovation: num(c["innovation"]),
  };
}

/** Parse + validate the raw JSON shape of stuff/fixtures.json. */
export function parseFixture(json: unknown): Fixture {
  const raw = (json ?? {}) as RawFixture;
  const event = {
    id: asString(raw.event?.id),
    name: asString(raw.event?.name),
    submissionsClose: asString(raw.event?.submissions_close),
  };
  if (!event.name) throw new Error("fixture: event.name missing");
  return {
    event,
    tracks: (raw.tracks ?? []).map((t) => ({ id: asString(t.id), name: asString(t.name) })),
    judges: (raw.judges ?? []).map((j) => ({
      id: asString(j.id),
      name: asString(j.name),
      email: asString(j.email),
      tracks: Array.isArray(j.tracks) ? j.tracks.map(asString) : [],
    })),
    teams: (raw.teams ?? []).map((t) => ({
      id: asString(t.id),
      name: asString(t.name),
      members: Array.isArray(t.members) ? t.members.map(asString) : [],
    })),
    projects: (raw.projects ?? []).map((p) => ({
      id: asString(p.id),
      team: asString(p.team),
      track: asString(p.track),
      title: asString(p.title),
      summary: asString(p.summary),
      repoUrl: asString(p.repo_url),
      demoUrl: asString(p.demo_url),
      submittedAt: asString(p.submitted_at),
    })),
    scores: (raw.scores ?? []).map((s) => ({
      judge: asString(s.judge),
      project: asString(s.project),
      criteria: parseCriteria(s.criteria),
      comment: asString(s.comment),
    })),
  };
}

/** Track slug contract: fixture id lowercased (e.g. "trk_01"). */
export function trackSlug(fixtureTrackId: string): string {
  return fixtureTrackId.toLowerCase();
}

/** Score contract: round(mean(criteria) / 5 * 100). */
export function scoreValue(criteria: FixtureCriteria): number {
  const mean = (criteria.functionality + criteria.quality + criteria.innovation) / 3;
  return Math.round((mean / 5) * 100);
}

/** Project description contract: summary + repo_url line. */
export function projectDescription(summary: string, repoUrl: string): string {
  return repoUrl ? `${summary}\n${repoUrl}` : summary;
}

/** judge_a = FIRST fixture judge (fixture order) having >= 1 score. */
export function judgeA(fixture: Fixture): FixtureJudge | undefined {
  return fixture.judges.find((j) => fixture.scores.some((s) => s.judge === j.id));
}

/** judge_b = SECOND such judge. */
export function judgeB(fixture: Fixture): FixtureJudge | undefined {
  const scored = fixture.judges.filter((j) => fixture.scores.some((s) => s.judge === j.id));
  return scored[1];
}

/** participant = first team-member email (teams[0].members[0]). */
export function participantEmail(fixture: Fixture): string | undefined {
  return fixture.teams[0]?.members[0];
}

export const FIXTURE_EVENT_NAME = "Sample Hack 2026";

export const FIXTURE_TOKENS = {
  organizer: "fixture-organizer",
  judgeA: "fixture-judge-a",
  judgeB: "fixture-judge-b",
  participant: "fixture-participant",
} as const;
