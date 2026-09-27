/**
 * Shared helpers for participant-facing pages.
 *
 * Page handlers run the SAME pool queries as the JSON API routes
 * (teams.ts / projects.ts / gallery.ts / uploads.ts): read-only SELECTs for
 * GETs, self-contained validation + pool work + 302/flash for POSTs. Forms
 * never POST to /api/* URLs. Guards: requireAuth / requireEventRole, so
 * pages answer 401 / 404 / 422 and never 403 (CSRF failures excepted).
 */
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { pool } from "../../db/index.js";
import { consumeFlash, type FlashMessage } from "../../lib/flash.js";

/** Loose UUID check — same shape as the API routes (never 403, 422 first). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EventInfo {
  id: string;
  name: string;
  state: string;
  submissions_close_at: string | null;
}

export interface TeamInfo {
  id: string;
  event_id: string;
  name: string;
  invite_token: string;
  max_size: number;
  member_count: number;
}

export interface MemberInfo {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface TrackInfo {
  id: string;
  name: string;
  slug: string;
}

export interface ProjectInfo {
  id: string;
  event_id: string;
  team_id: string;
  track_id: string | null;
  title: string;
  tagline: string | null;
  description: string;
  tech_tags: string[];
  status: string;
}

/** Buffered file captured from a multipart page form (see participant.ts). */
export interface ParsedUpload {
  data: Buffer;
  filename: string;
  mimetype: string;
}

/** Session user id — mirrors the lookup in routes/teams.ts. */
export function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && "id" in u
    && typeof u.id === "string" && u.id.length > 0) return u.id;
  return undefined;
}

export function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Dead connection — never mask the original error.
  }
}

export async function eventExists(id: string): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM events WHERE id = $1", [id]);
  return (r.rowCount ?? 0) > 0;
}

export async function getEvent(id: string): Promise<EventInfo | undefined> {
  const r = await pool.query<EventInfo>(
    `SELECT id, name, state, submissions_close_at FROM events WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

interface TeamRow {
  id: string;
  event_id: string;
  name: string;
  invite_token: string;
  max_size: number;
  member_count: string;
}

/** The caller's team in this event (one team per user+event by DB unique). */
export async function getMyTeam(
  eventId: string,
  userId: string,
): Promise<TeamInfo | undefined> {
  const r = await pool.query<TeamRow>(
    `SELECT t.id, t.event_id, t.name, t.invite_token, t.max_size,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count
       FROM teams t JOIN team_members m ON m.team_id = t.id
      WHERE m.user_id = $1 AND m.event_id = $2 LIMIT 1`,
    [userId, eventId],
  );
  const t = r.rows[0];
  if (!t) return undefined;
  return { ...t, member_count: Number(t.member_count) };
}

export async function isTeamMember(
  teamId: string,
  userId: string,
): Promise<boolean> {
  for (const table of ["team_members", "team_memberships"]) {
    try {
      const r = await pool.query(
        `SELECT 1 FROM ${table} WHERE team_id = $1 AND user_id = $2 LIMIT 1`,
        [teamId, userId],
      );
      if ((r.rowCount ?? 0) > 0) return true;
    } catch {
      // Table may not exist yet — try the next name.
    }
  }
  return false;
}

export async function getTracks(eventId: string): Promise<TrackInfo[]> {
  const r = await pool.query<TrackInfo>(
    `SELECT id, name, slug FROM tracks WHERE event_id = $1 ORDER BY name ASC`,
    [eventId],
  );
  return r.rows;
}

/** Append-only version snapshot — same SQL as routes/projects.ts. */
export async function snapProjectVersion(
  client: PoolClient,
  p: ProjectInfo,
): Promise<void> {
  const n = await client.query(
    "SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM project_versions WHERE project_id = $1",
    [p.id],
  );
  const no = Number((n.rows[0] as { n: unknown }).n);
  await client.query(
    "INSERT INTO project_versions (project_id, version_no, title, tagline, description, tech_tags, status) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [p.id, no, p.title, p.tagline, p.description, p.tech_tags, p.status],
  );
}

/** Display-only deadline banner (enforcement stays server-side in POSTs). */
export function deadlineBanner(
  closeAt: string | null,
): { text: string; passed: boolean } {
  if (closeAt === null || Number.isNaN(Date.parse(closeAt))) {
    return {
      text: "Submissions are open — no deadline is set for this event.",
      passed: false,
    };
  }
  const when = new Date(closeAt).toISOString();
  if (new Date(closeAt).getTime() <= Date.now()) {
    return {
      text: `Submissions closed at ${when} (server time). This project is read-only.`,
      passed: true,
    };
  }
  return {
    text: `Submissions close at ${when} (server time). Late saves and submissions are rejected.`,
    passed: false,
  };
}

/** Comma-separated tech-tags input (or defensive array) → clean string[]. */
export function parseTechTags(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  return parts
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Consumed session flash as optional view scope (absent → omitted). */
export function flashScope(req: FastifyRequest): { flash?: FlashMessage } {
  const flash = consumeFlash(req);
  return flash ? { flash } : {};
}
