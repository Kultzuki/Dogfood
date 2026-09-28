/**
 * Official-fixture seed adapter: loads stuff/fixtures.json deterministically.
 *
 * Idempotent: when the 'Sample Hack 2026' event row exists the data load is
 * skipped, but fixed-token sessions are recomputed/upserted and checker-ready
 * headers are reprinted so reboots with data still emit test logins.
 *
 * Runs AFTER seed.js from docker/entrypoint.sh (which owns the base admin).
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Pool } from "pg";
import { hashPassword } from "../lib/password.js";
import { signSessionValue } from "../plugins/session.js";
import {
  duplicateFixturePairs,
  parseFixture,
  trackSlug,
  scoreValue,
  projectDescription,
  judgeA,
  judgeB,
  participantEmail,
  FIXTURE_EVENT_NAME,
  FIXTURE_TOKENS,
  type Fixture,
} from "./fixtures.js";

const ORGANIZER_EMAIL = "organizer@dogfood.local";

/** Resolve the fixture file: env override, else stuff/fixtures.json with dist/ fallback. */
export function resolveFixturePath(): string {
  const override =
    process.env["STUFF_FIXTURES"] ?? process.env["FIXTURES_PATH"] ?? process.env["FIXTURE_PATH"];
  if (override) return override;
  const primary = join(process.cwd(), "stuff", "fixtures.json");
  if (existsSync(primary)) return primary;
  return join(process.cwd(), "..", "stuff", "fixtures.json");
}

function displayName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.length > 0 ? local : email;
}

interface IdRow {
  id: string;
}

async function ensureUser(
  pool: Pool,
  email: string,
  name: string,
  role: string,
): Promise<string> {
  const found = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [email]);
  const existing = found.rows[0]?.id;
  if (existing) return existing;
  const passwordHash = await hashPassword(randomBytes(16).toString("hex"));
  const ins = await pool.query<IdRow>(
    `INSERT INTO users (email, name, password_hash, role, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, name, passwordHash, role],
  );
  const id = ins.rows[0]?.id;
  if (id) return id;
  const retry = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [email]);
  const rid = retry.rows[0]?.id;
  if (!rid) throw new Error(`fixture seed: user upsert failed for ${email}`);
  return rid;
}

async function upsertSession(pool: Pool, userId: string, token: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (user_id, token, expires_at, created_at, last_seen_at, absolute_expires_at, revoked_at)
     VALUES ($1, $2, NOW() + INTERVAL '24 hours', NOW(), NOW(), NOW() + INTERVAL '30 days', NULL)
     ON CONFLICT (token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       expires_at = NOW() + INTERVAL '24 hours',
       last_seen_at = NOW(),
       absolute_expires_at = NOW() + INTERVAL '30 days',
       revoked_at = NULL`,
    [userId, token],
  );
}

function printHeaders(judgeAId: string, cookies: Record<string, string>): void {
  console.log("seeded. test logins:");
  console.log(`organizer Cookie: sid=${cookies["organizer"] ?? ""}`);
  console.log(`judge_a Cookie: sid=${cookies["judgeA"] ?? ""}`);
  console.log(`judge_b Cookie: sid=${cookies["judgeB"] ?? ""}`);
  console.log(`participant Cookie: sid=${cookies["participant"] ?? ""}`);
  console.log(`peer_scores_url: /api/judge/scores?judge=${judgeAId}`);
}

async function seedFixtures(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error("❌ DATABASE_URL is not set.");
    process.exit(1);
  }
  const fixturePath = resolveFixturePath();
  let raw: string;
  try {
    raw = readFileSync(fixturePath, "utf-8");
  } catch {
    console.log(`ℹ️  Fixture file not found at ${fixturePath} — fixture seed skipped.`);
    return;
  }
  const fixture: Fixture = parseFixture(JSON.parse(raw) as unknown);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const existing = await pool.query<IdRow>("SELECT id FROM events WHERE name = $1 LIMIT 1", [
      FIXTURE_EVENT_NAME,
    ]);
    const existingEventId = existing.rows[0]?.id;

    // Idempotent skip path: recompute identities + sessions, reprint headers.
    if (existingEventId) {
      const ja = judgeA(fixture);
      const jb = judgeB(fixture);
      const partEmail = participantEmail(fixture);
      if (!ja || !jb || !partEmail) throw new Error("fixture seed: cannot resolve skip identities");
      const organizerId = await ensureUser(pool, ORGANIZER_EMAIL, "Organizer", "admin");
      const judgeAUser = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [ja.email]);
      const judgeBUser = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [jb.email]);
      const partUser = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [partEmail]);
      const judgeAId = judgeAUser.rows[0]?.id;
      const judgeBId = judgeBUser.rows[0]?.id;
      const participantId = partUser.rows[0]?.id;
      if (!judgeAId || !judgeBId || !participantId) {
        throw new Error("fixture seed: skip-path users missing");
      }
      const judges = fixture.judges;
      for (const judge of judges) {
        const userId = (await pool.query<IdRow>(`SELECT id FROM users WHERE email = $1`, [judge.email])).rows[0]?.id;
        if (!userId) continue;
        const membershipId = (await pool.query<IdRow>(`SELECT id FROM event_memberships WHERE event_id = $1 AND user_id = $2 AND role = 'judge'`, [existingEventId, userId])).rows[0]?.id;
        if (!membershipId) continue;
        await pool.query(`UPDATE event_memberships SET track_id = NULL, track_scope_all = FALSE WHERE id = $1`, [membershipId]);
        await pool.query(`DELETE FROM event_membership_tracks WHERE membership_id = $1`, [membershipId]);
        for (const fixtureTrack of judge.tracks) {
          const trackId = (await pool.query<IdRow>(`SELECT id FROM tracks WHERE event_id = $1 AND slug = $2`, [existingEventId, fixtureTrack])).rows[0]?.id;
          if (trackId) await pool.query(`INSERT INTO event_membership_tracks (membership_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [membershipId, trackId]);
        }
      }
      await upsertSession(pool, organizerId, FIXTURE_TOKENS.organizer);
      await upsertSession(pool, judgeAId, FIXTURE_TOKENS.judgeA);
      await upsertSession(pool, judgeBId, FIXTURE_TOKENS.judgeB);
      await upsertSession(pool, participantId, FIXTURE_TOKENS.participant);
      console.log(`ℹ️  Event '${FIXTURE_EVENT_NAME}' exists — fixture data skipped (idempotent).`);
      printHeaders(judgeAId, {
        organizer: signSessionValue(FIXTURE_TOKENS.organizer),
        judgeA: signSessionValue(FIXTURE_TOKENS.judgeA),
        judgeB: signSessionValue(FIXTURE_TOKENS.judgeB),
        participant: signSessionValue(FIXTURE_TOKENS.participant),
      });
      return;
    }

    // ── Full load ────────────────────────────────────────────────
    const organizerId = await ensureUser(pool, ORGANIZER_EMAIL, "Organizer", "admin");

    const eventIns = await pool.query<IdRow>(
      `INSERT INTO events (name, description, state, created_by, submissions_close_at, created_at, updated_at)
       VALUES ($1, $2, 'SUBMISSIONS_CLOSED', $3, $4, NOW(), NOW()) RETURNING id`,
      [
        FIXTURE_EVENT_NAME,
        "Official fixture event evt_01",
        organizerId,
        fixture.event.submissionsClose,
      ],
    );
    const eventId = eventIns.rows[0]?.id;
    if (!eventId) throw new Error("fixture seed: event insert failed");

    await pool.query(
      `INSERT INTO event_memberships (event_id, user_id, role) VALUES ($1, $2, 'organizer')
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [eventId, organizerId],
    );

    // Tracks: slug = fixture id lowercased.
    const trackUuidByFixture = new Map<string, string>();
    for (const t of fixture.tracks) {
      const slug = trackSlug(t.id);
      const r = await pool.query<IdRow>(
        `INSERT INTO tracks (event_id, slug, name, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (event_id, slug) DO NOTHING RETURNING id`,
        [eventId, slug, t.name],
      );
      let trackId = r.rows[0]?.id;
      if (!trackId) {
        const retry = await pool.query<IdRow>(
          "SELECT id FROM tracks WHERE event_id = $1 AND slug = $2",
          [eventId, slug],
        );
        trackId = retry.rows[0]?.id;
      }
      if (!trackId) throw new Error(`fixture seed: track insert failed for ${t.id}`);
      trackUuidByFixture.set(t.id, trackId);
    }

    // Teams + members → users (participant) + team_members.
    const teamUuidByFixture = new Map<string, string>();
    const seenMember = new Set<string>();
    let firstMemberEmail: string | undefined;
    for (const team of fixture.teams) {
      const inviteToken = randomBytes(16).toString("hex");
      const r = await pool.query<IdRow>(
        `INSERT INTO teams (event_id, name, invite_token, max_size, created_at, updated_at)
         VALUES ($1, $2, $3, 4, NOW(), NOW()) RETURNING id`,
        [eventId, team.name, inviteToken],
      );
      const teamId = r.rows[0]?.id;
      if (!teamId) throw new Error(`fixture seed: team insert failed for ${team.id}`);
      teamUuidByFixture.set(team.id, teamId);
      for (const email of team.members) {
        if (!seenMember.has(email)) {
          seenMember.add(email);
          if (!firstMemberEmail) firstMemberEmail = email;
          await ensureUser(pool, email, displayName(email), "participant");
        }
        const userRow = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [email]);
        const userId = userRow.rows[0]?.id;
        if (!userId) throw new Error(`fixture seed: member user missing ${email}`);
        await pool.query(
          `INSERT INTO team_members (team_id, event_id, user_id, created_at)
           VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
          [teamId, eventId, userId],
        );
      }
    }

    // Projects: status submitted, tagline = summary, description = summary + repo_url.
    const projectUuidByFixture = new Map<string, string>();
    for (const p of fixture.projects) {
      const teamId = teamUuidByFixture.get(p.team);
      const trackId = trackUuidByFixture.get(p.track) ?? null;
      if (!teamId) throw new Error(`fixture seed: unknown team ${p.team}`);
      const r = await pool.query<IdRow>(
        `INSERT INTO projects (event_id, team_id, track_id, title, tagline, description, repo_url, demo_url, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'submitted', $9, NOW()) RETURNING id`,
        [
          eventId,
          teamId,
          trackId,
          p.title,
          p.summary,
          projectDescription(p.summary, p.repoUrl),
          p.repoUrl,
          p.demoUrl || null,
          p.submittedAt,
        ],
      );
      const projectId = r.rows[0]?.id;
      if (!projectId) throw new Error(`fixture seed: project insert failed for ${p.id}`);
      projectUuidByFixture.set(p.id, projectId);
    }
    const duplicatePairs = duplicateFixturePairs(fixture.projects);
    const duplicateFixtureIds = new Set(duplicatePairs.map((pair) => pair.duplicateId));
    for (const pair of duplicatePairs) {
      const keepId = projectUuidByFixture.get(pair.keepId);
      const duplicateId = projectUuidByFixture.get(pair.duplicateId);
      if (keepId && duplicateId) await pool.query(
        `UPDATE projects SET duplicate_of_project_id = $1, needs_review = true WHERE id = $2 AND event_id = $3`,
        [keepId, duplicateId, eventId],
      );
    }

    // Judges have one membership and explicit allowed tracks in the join table.
    const judgeUuidByFixture = new Map<string, string>();
    for (const j of fixture.judges) {
      const userId = await ensureUser(pool, j.email, j.name, "judge");
      judgeUuidByFixture.set(j.id, userId);
      const membership = await pool.query<{ id: string }>(
        `INSERT INTO event_memberships (event_id, user_id, role, track_id)
         VALUES ($1, $2, 'judge', NULL) ON CONFLICT (event_id, user_id) DO UPDATE SET role = 'judge' RETURNING id`,
        [eventId, userId],
      );
      const membershipId = membership.rows[0]?.id ?? (await pool.query<{ id: string }>(`SELECT id FROM event_memberships WHERE event_id = $1 AND user_id = $2`, [eventId, userId])).rows[0]?.id;
      if (membershipId) for (const fixtureTrack of j.tracks) {
        const trackId = trackUuidByFixture.get(fixtureTrack);
        if (trackId) await pool.query(`INSERT INTO event_membership_tracks (membership_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [membershipId, trackId]);
      }
    }

    // Scores: judge_assignments (active) + scores v1 is_current=true.
    for (const s of fixture.scores) {
      if (duplicateFixtureIds.has(s.project)) continue;
      const judgeUserId = judgeUuidByFixture.get(s.judge);
      const projectId = projectUuidByFixture.get(s.project);
      if (!judgeUserId || !projectId) continue;
      const aIns = await pool.query<IdRow>(
        `INSERT INTO judge_assignments (event_id, project_id, judge_user_id, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (event_id, project_id, judge_user_id) DO NOTHING RETURNING id`,
        [eventId, projectId, judgeUserId],
      );
      let assignmentId = aIns.rows[0]?.id;
      if (!assignmentId) {
        const retry = await pool.query<IdRow>(
          `SELECT id FROM judge_assignments WHERE event_id = $1 AND project_id = $2 AND judge_user_id = $3`,
          [eventId, projectId, judgeUserId],
        );
        assignmentId = retry.rows[0]?.id;
      }
      if (!assignmentId) continue;
      const have = await pool.query(
        `SELECT 1 FROM scores WHERE assignment_id = $1 AND is_current = true LIMIT 1`,
        [assignmentId],
      );
      if ((have.rowCount ?? 0) > 0) continue;
      await pool.query(
        `INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, version, is_current, comment, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, true, $6, NOW())`,
        [assignmentId, eventId, projectId, judgeUserId, scoreValue(s.criteria), s.comment],
      );
    }

    // Special identities.
    const ja = judgeA(fixture);
    const jb = judgeB(fixture);
    const partEmail = participantEmail(fixture) ?? firstMemberEmail;
    if (!ja || !jb || !partEmail) throw new Error("fixture seed: cannot resolve identities");
    const judgeAId = judgeUuidByFixture.get(ja.id);
    const judgeBId = judgeUuidByFixture.get(jb.id);
    const partRow = await pool.query<IdRow>("SELECT id FROM users WHERE email = $1", [partEmail]);
    const participantId = partRow.rows[0]?.id;
    if (!judgeAId || !judgeBId || !participantId) {
      throw new Error("fixture seed: identity users missing");
    }

    await upsertSession(pool, organizerId, FIXTURE_TOKENS.organizer);
    await upsertSession(pool, judgeAId, FIXTURE_TOKENS.judgeA);
    await upsertSession(pool, judgeBId, FIXTURE_TOKENS.judgeB);
    await upsertSession(pool, participantId, FIXTURE_TOKENS.participant);

    console.log(`🌱 Fixture event '${FIXTURE_EVENT_NAME}' seeded.`);
    printHeaders(judgeAId, {
      organizer: signSessionValue(FIXTURE_TOKENS.organizer),
      judgeA: signSessionValue(FIXTURE_TOKENS.judgeA),
      judgeB: signSessionValue(FIXTURE_TOKENS.judgeB),
      participant: signSessionValue(FIXTURE_TOKENS.participant),
    });
  } finally {
    await pool.end();
  }
}

// ── Entry point ─────────────────────────────────────────────────────
seedFixtures().catch((err) => {
  console.error("❌ Fixture seed runner failed:", err);
  process.exit(1);
});
