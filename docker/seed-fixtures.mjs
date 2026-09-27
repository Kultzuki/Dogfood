#!/usr/bin/env node
// Acceptance fixture seeder — loads stuff/fixtures.json ("Sample Hack 2026")
// into the live database so `docker compose up` boots into the exact state
// the official checker (stuff/run.py) expects.
//
// Design notes:
// - IDEMPOTENT + CONVERGENT: first boot creates the fixture event's child
//   data (tracks/teams/projects/assignments/scores) and upserts
//   users/memberships/sessions. Reboots NEVER wipe: when the fixture event
//   already owns projects, only sessions are reconverged and headers
//   reprinted, so live judge scores survive restarts (mirrors
//   src/db/seed-fixtures.ts skip semantics).
// - HONEST dates: the event keeps the fixture's real submissions_close
//   (2026-03-01T18:00:00Z, past) so the deadline probe exercises the real
//   DB-clock predicate instead of a stub.
// - Score mapping: fixtures carry per-criterion 1..5 marks; the app stores
//   one scalar value 0..100, so value = round(mean(criteria) * 20).
// - Session tokens are FIXED strings (fixture-organizer, fixture-judge-a,
//   fixture-judge-b, fixture-participant) signed with SESSION_SECRET; the
//   boot log prints ready-to-paste `Cookie: sid=...` headers.
// - judge_a / judge_b are the first two fixture judges (in file order) that
//   actually have scores, so both own-scores and peer-isolation checks are
//   meaningful.
import { readFileSync, existsSync } from "node:fs";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const FIXTURE_EVENT_NAME = "Sample Hack 2026";
const FIXTURE_STATE = "SUBMISSIONS_CLOSED";
const TOKENS = {
  organizer: "fixture-organizer",
  judge_a: "fixture-judge-a",
  judge_b: "fixture-judge-b",
  participant: "fixture-participant",
};

function loadFixtures() {
  const candidates = [
    "/app/fixtures.json",
    new URL("../fixtures.json", import.meta.url).pathname,
    "fixtures.json",
    "stuff/fixtures.json",
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      /* try next */
    }
  }
  throw new Error("fixtures.json not found (tried /app/fixtures.json, ./fixtures.json, stuff/fixtures.json)");
}

// Same signing as src/plugins/session.ts: HMAC-SHA256, base64url.
function sign(value, secret) {
  return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
}

// Legacy salt:hash scrypt format accepted by src/lib/password.ts. The
// checker never logs in; this just satisfies NOT NULL + keeps logins working.
function dummyHash() {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync("fixture-login-unused", salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function scoreValue(criteria) {
  const vals = Object.values(criteria ?? {}).filter((v) => Number.isFinite(Number(v)));
  if (vals.length === 0) return 60;
  const mean = vals.reduce((a, b) => a + Number(b), 0) / vals.length;
  return Math.max(0, Math.min(100, Math.round(mean * 20)));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set.");

  const fx = loadFixtures();
  const pool = new Pool({ connectionString: databaseUrl });
  const q = (text, params) => pool.query(text, params);

  try {
    // ── Users (upsert by email) ──────────────────────────────────────
    const wantUsers = new Map(); // email -> { name, role }
    wantUsers.set("organizer@dogfood.local", { name: "Organizer", role: "organizer" });
    wantUsers.set("participant@dogfood.local", { name: "Participant", role: "participant" });
    for (const j of fx.judges ?? []) {
      if (j.email) wantUsers.set(String(j.email).toLowerCase(), { name: j.name ?? j.email, role: "judge" });
    }
    for (const t of fx.teams ?? []) {
      for (const m of t.members ?? []) {
        const email = String(m).toLowerCase();
        if (!wantUsers.has(email)) {
          wantUsers.set(email, { name: email.split("@")[0] ?? email, role: "participant" });
        }
      }
    }
    const userIds = new Map(); // email -> uuid
    for (const [email, u] of wantUsers) {
      const r = await q(
        `INSERT INTO users (email, name, password_hash, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role
         RETURNING id`,
        [email, u.name, dummyHash(), u.role],
      );
      userIds.set(email, r.rows[0].id);
    }

    // ── Fixture event (find or create, then converge dates/state) ────
    const organizerId = userIds.get("organizer@dogfood.local");
    let ev = (await q(`SELECT id FROM events WHERE name = $1 ORDER BY created_at DESC LIMIT 1`, [FIXTURE_EVENT_NAME])).rows[0];
    if (!ev) {
      ev = (
        await q(
          `INSERT INTO events (name, description, state, created_by, submissions_close_at)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [FIXTURE_EVENT_NAME, "Seeded from stuff/fixtures.json for acceptance.", FIXTURE_STATE, organizerId, fx.event.submissions_close],
        )
      ).rows[0];
    } else {
      await q(
        `UPDATE events SET submissions_close_at = $2, state = $3, updated_at = NOW() WHERE id = $1`,
        [ev.id, fx.event.submissions_close, FIXTURE_STATE],
      );
    }
    const eventId = ev.id;

    // ── Idempotent skip: never wipe live data on reboot ─────────────
    // If the fixture event already owns projects, its child data (tracks,
    // teams, projects, assignments, live judge scores) must survive the
    // reboot. Converge only the fixed-token sessions and reprint headers
    // (mirrors src/db/seed-fixtures.ts skip semantics).
    {
      const cnt = await q(`SELECT COUNT(*)::int AS n FROM projects WHERE event_id = $1`, [eventId]);
      if (Number(cnt.rows[0]?.n ?? 0) > 0) {
        const scoredOrder0 = [];
        for (const s of fx.scores ?? []) {
          if (!scoredOrder0.includes(s.judge)) scoredOrder0.push(s.judge);
        }
        const judgeEmails0 = (fx.judges ?? []).filter((j) => scoredOrder0.includes(j.id));
        const judgeA0 = judgeEmails0[0];
        const judgeB0 = judgeEmails0[1] ?? judgeEmails0[0];
        if (!judgeA0 || !judgeB0) throw new Error("fixture seed: cannot resolve skip identities");
        const judgeAEmail0 = String(judgeA0.email).toLowerCase();
        const judgeBEmail0 = String(judgeB0.email).toLowerCase();
        async function sessionUpsert(token, email) {
          await q(
            `INSERT INTO sessions (user_id, token, expires_at, absolute_expires_at, last_seen_at, revoked_at)
             VALUES ($1, $2, NOW() + INTERVAL '24 hours', NOW() + INTERVAL '30 days', NOW(), NULL)
             ON CONFLICT (token) DO UPDATE SET
               user_id = EXCLUDED.user_id,
               expires_at = NOW() + INTERVAL '24 hours',
               absolute_expires_at = NOW() + INTERVAL '30 days',
               last_seen_at = NOW(), revoked_at = NULL`,
            [userIds.get(email), token],
          );
        }
        await sessionUpsert(TOKENS.organizer, "organizer@dogfood.local");
        await sessionUpsert(TOKENS.judge_a, judgeAEmail0);
        await sessionUpsert(TOKENS.judge_b, judgeBEmail0);
        await sessionUpsert(TOKENS.participant, "participant@dogfood.local");
        const judgeUserByFixtureId0 = new Map(
          (fx.judges ?? []).map((j) => [j.id, userIds.get(String(j.email).toLowerCase())]),
        );
        console.log(`ℹ️  Event '${FIXTURE_EVENT_NAME}' exists with projects — fixture data skipped (idempotent).`);
        console.log("seeded. test logins:");
        console.log(`  organizer    Cookie: sid=${sign(TOKENS.organizer, secret)}`);
        console.log(`  judge_a      Cookie: sid=${sign(TOKENS.judge_a, secret)}`);
        console.log(`  judge_b      Cookie: sid=${sign(TOKENS.judge_b, secret)}`);
        console.log(`  participant  Cookie: sid=${sign(TOKENS.participant, secret)}`);
        console.log(
          `acceptance ids: event=${eventId} judge_a=${judgeUserByFixtureId0.get(judgeA0.id)} judge_b=${judgeUserByFixtureId0.get(judgeB0.id)}`,
        );
        return;
      }
    }

    // ── Memberships (upsert; judges unscoped track_id = NULL) ─────────
    async function membership(email, role) {
      await q(
        `INSERT INTO event_memberships (event_id, user_id, role, track_id)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [eventId, userIds.get(email), role],
      );
    }
    await membership("organizer@dogfood.local", "organizer");
    await membership("participant@dogfood.local", "participant");
    for (const j of fx.judges ?? []) {
      if (j.email) await membership(String(j.email).toLowerCase(), "judge");
    }
    for (const t of fx.teams ?? []) {
      for (const m of t.members ?? []) {
        await membership(String(m).toLowerCase(), "participant");
      }
    }

    // ── Wipe + recreate fixture-event child data (convergent) ─────────
    await q(`DELETE FROM scores WHERE event_id = $1`, [eventId]);
    await q(`DELETE FROM judge_assignments WHERE event_id = $1`, [eventId]);
    await q(`DELETE FROM projects WHERE event_id = $1`, [eventId]);
    await q(`DELETE FROM team_members WHERE event_id = $1`, [eventId]);
    await q(`DELETE FROM teams WHERE event_id = $1`, [eventId]);
    await q(`DELETE FROM tracks WHERE event_id = $1`, [eventId]);

    const trackIds = new Map();
    for (const t of fx.tracks ?? []) {
      const r = await q(
        `INSERT INTO tracks (event_id, slug, name) VALUES ($1, $2, $3) RETURNING id`,
        [eventId, t.id, t.name],
      );
      trackIds.set(t.id, r.rows[0].id);
    }

    const teamIds = new Map();
    for (const t of fx.teams ?? []) {
      const members = t.members ?? [];
      const r = await q(
        `INSERT INTO teams (event_id, name, invite_token, max_size)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [eventId, t.name, `fixture-${t.id}`, Math.max(4, members.length)],
      );
      teamIds.set(t.id, r.rows[0].id);
      for (const m of members) {
        await q(
          `INSERT INTO team_members (team_id, event_id, user_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [r.rows[0].id, eventId, userIds.get(String(m).toLowerCase())],
        );
      }
    }

    const projectIds = new Map();
    for (const p of fx.projects ?? []) {
      const teamId = teamIds.get(p.team);
      if (!teamId) continue;
      const r = await q(
        `INSERT INTO projects (event_id, team_id, track_id, title, tagline, description, tech_tags, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, $5, '{}', 'submitted', $6, $6) RETURNING id`,
        [eventId, teamId, trackIds.get(p.track) ?? null, p.title, p.summary ?? "", p.submitted_at ?? new Date().toISOString()],
      );
      projectIds.set(p.id, r.rows[0].id);
    }

    // judge_a / judge_b: first two fixture judges (file order) with scores.
    const scoredOrder = [];
    for (const s of fx.scores ?? []) {
      if (!scoredOrder.includes(s.judge)) scoredOrder.push(s.judge);
    }
    const judgeEmails = (fx.judges ?? []).filter((j) => scoredOrder.includes(j.id));
    const judgeA = judgeEmails[0];
    const judgeB = judgeEmails[1] ?? judgeEmails[0];
    const judgeUserByFixtureId = new Map(
      (fx.judges ?? []).map((j) => [j.id, userIds.get(String(j.email).toLowerCase())]),
    );

    let scoreCount = 0;
    for (const s of fx.scores ?? []) {
      const judgeUserId = judgeUserByFixtureId.get(s.judge);
      const projectId = projectIds.get(s.project);
      if (!judgeUserId || !projectId) continue;
      const a = await q(
        `INSERT INTO judge_assignments (event_id, project_id, judge_user_id, track_id, status)
         VALUES ($1, $2, $3, NULL, 'active')
         ON CONFLICT (event_id, project_id, judge_user_id)
         DO UPDATE SET status = 'active' RETURNING id`,
        [eventId, projectId, judgeUserId],
      );
      await q(
        `INSERT INTO scores (assignment_id, event_id, project_id, judge_user_id, value, version, supersedes_id, is_current)
         VALUES ($1, $2, $3, $4, $5, 1, NULL, true)`,
        [a.rows[0].id, eventId, projectId, judgeUserId, scoreValue(s.criteria)],
      );
      scoreCount++;
    }

    // ── Fixed-token sessions (upsert; converge expiry/revocation) ─────
    async function session(token, email) {
      await q(
        `INSERT INTO sessions (user_id, token, expires_at, absolute_expires_at, last_seen_at, revoked_at)
         VALUES ($1, $2, NOW() + INTERVAL '24 hours', NOW() + INTERVAL '30 days', NOW(), NULL)
         ON CONFLICT (token) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           expires_at = NOW() + INTERVAL '24 hours',
           absolute_expires_at = NOW() + INTERVAL '30 days',
           last_seen_at = NOW(), revoked_at = NULL`,
        [userIds.get(email), token],
      );
    }
    const judgeAEmail = String(judgeA.email).toLowerCase();
    const judgeBEmail = String(judgeB.email).toLowerCase();
    await session(TOKENS.organizer, "organizer@dogfood.local");
    await session(TOKENS.judge_a, judgeAEmail);
    await session(TOKENS.judge_b, judgeBEmail);
    await session(TOKENS.participant, "participant@dogfood.local");

    const projectCount = projectIds.size;
    console.log(`🌱 Fixture seed complete: ${FIXTURE_EVENT_NAME} (${projectCount} projects, ${scoreCount} scores).`);
    console.log("seeded. test logins:");
    console.log(`  organizer    Cookie: sid=${sign(TOKENS.organizer, secret)}`);
    console.log(`  judge_a      Cookie: sid=${sign(TOKENS.judge_a, secret)}`);
    console.log(`  judge_b      Cookie: sid=${sign(TOKENS.judge_b, secret)}`);
    console.log(`  participant  Cookie: sid=${sign(TOKENS.participant, secret)}`);
    console.log(
      `acceptance ids: event=${eventId} judge_a=${judgeUserByFixtureId.get(judgeA.id)} judge_b=${judgeUserByFixtureId.get(judgeB.id)}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Fixture seed failed:", err);
  process.exit(1);
});
