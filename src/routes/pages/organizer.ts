import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import "@fastify/view";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../../db/index.js";
import { requireAuth, requireEventRole } from "../../authz/guards.js";
import { EVENT_STATES, ALLOWED_TRANSITIONS, isEventState, isValidTransition } from "../../lib/eventTransitions.js";
import { verifyChain, type AuditRow } from "../../lib/audit.js";
import { setFlash } from "../../lib/flash.js";
import { runImport } from "../exports.js";
import { EXPORT_DATASETS, type ImportDataset } from "../../lib/csv.js";
import { dateRangeError, parseIsoNullable } from "../events.js";
import { fetchActiveRubric, validateWeights, nextRubricVersion } from "../rubrics.js";
import { parseMaxSize } from "../teams.js";
import { centerAndRank, type CenterEntry } from "../../lib/csv.js";

type P = { eventId: string };
interface EventRow {
  id: string;
  name: string;
  description: string | null;
  state: string;
  version: number;
  submissions_close_at: string | null;
  submissions_open_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
}
interface IdRow { id: string }
const resolveEventId = (req: { params: unknown }): string | undefined => (req.params as P).eventId;
const organizeEvent = requireEventRole(resolveEventId, "organizer");
const SLUG_RE = /^[a-z0-9-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const K = 3;

const FINALIZE_OK_STATES = new Set([
  "SUBMISSIONS_CLOSED",
  "JUDGING",
  "RESULTS_FINAL",
  "PUBLISHED",
]);

interface CenterEntryLike { projectId: string; judgeId: string; value: number }

function hashCenterEntries(entries: CenterEntryLike[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.judgeId !== b.judgeId) return a.judgeId < b.judgeId ? -1 : 1;
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return a.value - b.value;
  });
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function centerRows(entries: CenterEntryLike[]): { projectId: string; normalized: number; rawMean: number; n: number; rank: number }[] {
  return centerAndRank(entries as CenterEntry[]);
}

const bodyOf = (req: FastifyRequest): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
const s = (v: unknown): string => typeof v === "string" ? v : "";
const pgCode = (e: unknown): string | undefined => typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : undefined;
const q = (req: FastifyRequest): Record<string, string> => {
  const o = (req.query ?? {}) as Record<string, unknown>; const r: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === "string") r[k] = v;
  return r;
};

async function sysRole(uid: string): Promise<string> {
  const r = await pool.query("SELECT role FROM users WHERE id = $1", [uid]);
  return (r.rows[0] as { role: string } | undefined)?.role ?? "participant";
}

async function sysGuard(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  await requireAuth(req, reply); if (reply.sent) return undefined;
  const uid = req.session["userId"]; if (typeof uid !== "string" || !uid) { await reply.code(401).send({ error: "unauthenticated" }); return undefined; }
  if (!["organizer", "admin"].includes(await sysRole(uid))) { await reply.code(404).send({ error: "not_found" }); return undefined; }
  return uid;
}

async function eventRow(id: string): Promise<EventRow | undefined> {
  const r = await pool.query("SELECT * FROM events WHERE id = $1", [id]);
  return r.rows[0] as EventRow | undefined;
}

async function safe<T>(fn: () => Promise<T>, fb: T): Promise<T> { try { return await fn(); } catch { return fb; } }

function formatDateReadable(v: unknown): string {
  if (v === null || v === undefined) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "UTC",
  });
}

function formatPrizeAmount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const rupees = Math.round(cents / 100);
  const formatted = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(rupees);
  return `${formatted} (${cents.toLocaleString()} cents)`;
}

function getContextHelp(state: string): { message: string; steps: string[] } {
  switch (state) {
    case "DRAFT":
      return {
        message: "Your event is in Draft state. Participants cannot register or submit projects yet. Configure dates, tracks, and prizes below, then open registration.",
        steps: [
          "Configure event schedule and deadlines (starts at, ends at, submission window).",
          "Add competition tracks to categorize project submissions.",
          "Add prizes to reward top submissions.",
          "Advance state to REGISTRATION OPEN to start onboarding teams.",
        ],
      };
    case "REGISTRATION_OPEN":
      return {
        message: "Registration is open! Participants can form teams and join via team invite links.",
        steps: [
          "Share team invite links with participants.",
          "Review registered teams in the Teams section.",
          "Prepare and invite judges.",
          "Advance state to SUBMISSIONS OPEN when hacking officially starts.",
        ],
      };
    case "SUBMISSIONS_OPEN":
      return {
        message: "The hackathon is active! Teams can create, edit, and submit project drafts until the deadline.",
        steps: [
          "Monitor active projects and incoming submissions.",
          "Confirm judging rubric weights with your judging team.",
          "Ensure all judges have accounts and are invited.",
          "Advance state to SUBMISSIONS CLOSED when the deadline passes.",
        ],
      };
    case "SUBMISSIONS_CLOSED":
      return {
        message: "Submissions are closed. Projects are locked from further editing. Prepare for judging.",
        steps: [
          "Verify all submitted projects in the Projects section.",
          "Confirm judge assignments and ensure adequate reviewer coverage (target k=3).",
          "Advance state to JUDGING so judges can access their scoring queues.",
        ],
      };
    case "JUDGING":
      return {
        message: "Judging is in progress! Assigned judges are evaluating projects using the configured rubric.",
        steps: [
          "Monitor completion progress on the Judging Progress dashboard.",
          "Ensure all projects meet minimum review coverage (k=3).",
          "Finalize results once all scores are submitted to run normalization.",
        ],
      };
    case "RESULTS_FINAL":
      return {
        message: "Results and rankings are finalized and cryptographically verified.",
        steps: [
          "Review final rankings on the Judging Progress dashboard.",
          "Verify award recipients for event-wide and track prizes.",
          "Advance state to PUBLISHED to reveal winners in the public gallery.",
        ],
      };
    case "PUBLISHED":
      return {
        message: "Results are published! Winners and submissions are visible in the public gallery.",
        steps: [
          "Direct participants and sponsors to the public gallery.",
          "Export official score data and audit logs from the Data Hub for your records.",
          "Advance state to ARCHIVED once post-event operations conclude.",
        ],
      };
    case "ARCHIVED":
      return {
        message: "This event is archived. Records and scores are preserved in read-only mode.",
        steps: ["All event operations are complete."],
      };
    default:
      return {
        message: `Current state: ${state}.`,
        steps: ["Review event sections below."],
      };
  }
}

function getTransitionsInfo(transitions: string[]): { to: string; explanation: string }[] {
  const map: Record<string, string> = {
    REGISTRATION_OPEN: "Opens team registration and allows participants to join via invite links.",
    SUBMISSIONS_OPEN: "Opens the project submission window so teams can create drafts and submit.",
    SUBMISSIONS_CLOSED: "Locks all project submissions from further edits to prepare for judging.",
    JUDGING: "Enables judges to access their ballots and submit scores based on the rubric.",
    RESULTS_FINAL: "Locks scoring and marks centering-normalized rankings as official.",
    PUBLISHED: "Reveals winners and final project submissions in the public project gallery.",
    ARCHIVED: "Permanently archives the event into read-only competition history.",
  };
  return transitions.map((t) => ({
    to: t,
    explanation: map[t] || `Transition event to ${t}.`,
  }));
}

interface OrganizerEventItem {
  id: string;
  name: string;
  description: string | null;
  state: string;
  version: number;
  starts_at: string | null;
  ends_at: string | null;
  submissions_open_at: string | null;
  submissions_close_at: string | null;
  created_at: Date;
  updated_at: Date;
  team_count: number;
  project_count: number;
  submitted_project_count: number;
  judge_count: number;
  score_count: number;
  updated_at_formatted: string;
  submissions_close_formatted: string;
  dates_summary: string;
  next_step_hint: string;
}

async function loadOrganizerEvents(uid: string, isSysAdmin: boolean): Promise<OrganizerEventItem[]> {
  const query = `
    SELECT e.*,
      (SELECT COUNT(*)::int FROM teams t WHERE t.event_id = e.id) AS team_count,
      (SELECT COUNT(*)::int FROM projects p WHERE p.event_id = e.id) AS project_count,
      (SELECT COUNT(*)::int FROM projects p WHERE p.event_id = e.id AND p.status = 'submitted') AS submitted_project_count,
      (SELECT COUNT(DISTINCT m.user_id)::int FROM event_memberships m WHERE m.event_id = e.id AND m.role = 'judge') AS judge_count,
      (SELECT COUNT(*)::int FROM scores s WHERE s.event_id = e.id AND s.is_current = true) AS score_count
    FROM events e
    WHERE ($1 = true OR e.created_by = $2 OR EXISTS (
      SELECT 1 FROM event_memberships m WHERE m.event_id = e.id AND m.user_id = $2 AND m.role IN ('organizer', 'admin')
    ))
    ORDER BY e.created_at DESC
  `;
  const res = await safe(() => pool.query(query, [isSysAdmin, uid]).then((r) => r.rows), []);
  return res.map((row: any) => {
    const closeFormatted = row.submissions_close_at ? formatDateReadable(row.submissions_close_at) : "";
    let datesSummary = "";
    if (row.starts_at && row.ends_at) {
      datesSummary = `${formatDateReadable(row.starts_at)} – ${formatDateReadable(row.ends_at)}`;
    } else if (row.starts_at) {
      datesSummary = `Starts ${formatDateReadable(row.starts_at)}`;
    }
    let hint = "";
    if (row.state === "DRAFT") hint = "Configure dates & tracks, then open registration";
    else if (row.state === "REGISTRATION_OPEN") hint = "Share team invite links, then open submissions";
    else if (row.state === "SUBMISSIONS_OPEN") hint = "Review project drafts and submissions";
    else if (row.state === "SUBMISSIONS_CLOSED") hint = "Assign judges and advance to judging";
    else if (row.state === "JUDGING") hint = "Monitor judge scoring and review coverage";
    else if (row.state === "RESULTS_FINAL") hint = "Publish results to the gallery";
    else if (row.state === "PUBLISHED") hint = "Results are live in the gallery";

    return {
      ...row,
      team_count: Number(row.team_count || 0),
      project_count: Number(row.project_count || 0),
      submitted_project_count: Number(row.submitted_project_count || 0),
      judge_count: Number(row.judge_count || 0),
      score_count: Number(row.score_count || 0),
      updated_at_formatted: row.updated_at ? formatDateReadable(row.updated_at) : "",
      submissions_close_formatted: closeFormatted,
      dates_summary: datesSummary,
      next_step_hint: hint,
    };
  });
}

function buildChecklist(
  ev: EventRow,
  tracksCount: number,
  prizesCount: number,
  judgesCount: number,
  rubricVersion: number,
  hasFinalization: boolean,
) {
  return [
    {
      title: "Event created",
      description: "Basic hackathon event container created.",
      done: true,
      actionUrl: null,
      actionLabel: null,
    },
    {
      title: "Configure event schedule & deadlines",
      description: "Set start/end dates and submission deadline.",
      done: Boolean(ev.starts_at || ev.submissions_open_at || ev.submissions_close_at),
      actionUrl: `#schedule-section`,
      actionLabel: "Configure dates",
    },
    {
      title: "Add tracks",
      description: "Categorize submissions for evaluation.",
      done: tracksCount > 0,
      actionUrl: `#tracks-section`,
      actionLabel: "Manage tracks",
    },
    {
      title: "Add prizes",
      description: "Set up event-wide and track-specific awards.",
      done: prizesCount > 0,
      actionUrl: `#prizes-section`,
      actionLabel: "Manage prizes",
    },
    {
      title: "Open registration",
      description: "Allow participants to form teams via invite links.",
      done: ev.state !== "DRAFT",
      actionUrl: ev.state === "DRAFT" ? `#lifecycle-section` : null,
      actionLabel: "Open registration",
    },
    {
      title: "Open submissions",
      description: "Allow teams to create and submit projects.",
      done: ["SUBMISSIONS_OPEN", "SUBMISSIONS_CLOSED", "JUDGING", "RESULTS_FINAL", "PUBLISHED"].includes(ev.state),
      actionUrl: ev.state === "REGISTRATION_OPEN" ? `#lifecycle-section` : null,
      actionLabel: "Open submissions",
    },
    {
      title: "Invite and assign judges",
      description: "Add judges to evaluate submissions.",
      done: judgesCount > 0,
      actionUrl: `/events/${ev.id}/judges`,
      actionLabel: "Manage judges",
    },
    {
      title: "Configure scoring rubric",
      description: "Define weighted criteria (Technical, Innovation, Impact, Polish).",
      done: rubricVersion > 1,
      actionUrl: `/events/${ev.id}/rubric`,
      actionLabel: "Configure rubric",
    },
    {
      title: "Review submissions",
      description: "Close submissions to lock project edits before scoring.",
      done: ["SUBMISSIONS_CLOSED", "JUDGING", "RESULTS_FINAL", "PUBLISHED"].includes(ev.state),
      actionUrl: ev.state === "SUBMISSIONS_OPEN" ? `#lifecycle-section` : `/events/${ev.id}/projects`,
      actionLabel: ev.state === "SUBMISSIONS_OPEN" ? "Close submissions" : "View projects",
    },
    {
      title: "Finalize results",
      description: "Run centering score normalization and verify rankings.",
      done: hasFinalization,
      actionUrl: `/events/${ev.id}/judging-progress`,
      actionLabel: "Finalize results",
    },
    {
      title: "Publish results",
      description: "Reveal final rankings and showcase winners publicly in gallery.",
      done: ev.state === "PUBLISHED",
      actionUrl: ev.state === "RESULTS_FINAL" ? `#lifecycle-section` : null,
      actionLabel: "Publish results",
    },
  ];
}

export async function registerOrganizerPages(app: FastifyInstance): Promise<void> {
  /**
   * GET /events — Organizer Events Index
   */
  app.get("/events", async (req, reply) => {
    const uid = await sysGuard(req, reply);
    if (uid === undefined) return;
    const isSysAdmin = (await sysRole(uid)) === "admin";
    const events = await loadOrganizerEvents(uid, isSysAdmin);
    return reply.view("events_index.njk", {
      events,
    });
  });

  /**
   * GET /dashboard — Organizer Dashboard
   */
  app.get("/dashboard", async (req, reply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const uid = req.session["userId"];
    if (typeof uid !== "string" || !uid) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const role = await sysRole(uid);
    if (role === "judge") {
      return reply.code(302).redirect("/judging");
    }
    if (role === "participant") {
      const m = await pool.query<{ event_id: string }>(
        "SELECT event_id FROM event_memberships WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [uid],
      );
      if (m.rows[0]) {
        return reply.code(302).redirect(`/events/${m.rows[0].event_id}/dashboard`);
      }
      return reply.code(302).redirect("/gallery");
    }
    const isSysAdmin = role === "admin";
    const events = await loadOrganizerEvents(uid, isSysAdmin);
    const totalEvents = events.length;
    const totalTeams = events.reduce((sum, e) => sum + e.team_count, 0);
    const totalProjects = events.reduce((sum, e) => sum + e.project_count, 0);
    const totalJudges = events.reduce((sum, e) => sum + e.judge_count, 0);
    const totalScores = events.reduce((sum, e) => sum + e.score_count, 0);

    return reply.view("organizer_dashboard.njk", {
      events,
      totalEvents,
      totalTeams,
      totalProjects,
      totalJudges,
      totalScores,
    });
  });

  /**
   * GET /events/new — New Event form
   */
  app.get("/events/new", async (req, reply) => {
    if (await sysGuard(req, reply) === undefined) return;
    return reply.view("event_new.njk", { csrfToken: req.csrfToken(), error: null });
  });

  /**
   * POST /events/new — Create Event
   */
  app.post("/events/new", async (req, reply) => {
    const uid = await sysGuard(req, reply); if (uid === undefined) return;
    const b = bodyOf(req); const name = s(b.name).trim();
    if (!name || name.length > 255) return reply.code(422).view("event_new.njk", { csrfToken: req.csrfToken(), error: "invalid_name", flash: null });
    const desc = typeof b.description === "string" && b.description !== "" ? b.description : null;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const ins = await c.query<IdRow & EventRow>("INSERT INTO events (name, description, created_by) VALUES ($1,$2,$3) RETURNING *", [name, desc, uid]);
      const ev = ins.rows[0]; if (!ev) throw new Error("create_failed");
      await c.query("INSERT INTO event_memberships (event_id, user_id, role) VALUES ($1,$2,'organizer')", [ev.id, uid]);
      await c.query("COMMIT");
      setFlash(req, "success", "Event created successfully. Let's configure your event.");
      return reply.code(302).redirect(`/events/${ev.id}/manage`);
    } catch (e) { try { await c.query("ROLLBACK"); } catch { /* dead conn */ } throw e; } finally { c.release(); }
  });

  /**
   * GET /events/:eventId/manage — Event Management Hub
   */
  app.get("/events/:eventId/manage", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const qq = q(req);

    const tracks = await safe(() => pool.query(`
      SELECT t.id, t.slug, t.name,
        (SELECT COUNT(*)::int FROM projects p WHERE p.track_id = t.id) AS project_count
      FROM tracks t WHERE t.event_id = $1 ORDER BY t.slug
    `, [eventId]).then((r) => r.rows as { id: string; slug: string; name: string; project_count: number }[]), []);

    const rawPrizes = await safe(() => pool.query(`
      SELECT p.id, p.slug, p.name, p.amount_cents, p.track_id, t.name AS track_name
      FROM prizes p
      LEFT JOIN tracks t ON t.id = p.track_id
      WHERE p.event_id = $1 ORDER BY p.slug
    `, [eventId]).then((r) => r.rows), []);

    const prizes = rawPrizes.map((p: any) => ({
      ...p,
      formatted_amount: formatPrizeAmount(p.amount_cents),
    }));

    const toInput = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const d = v instanceof Date ? v : new Date(String(v));
      if (Number.isNaN(d.getTime())) return "";
      return d.toISOString().slice(0, 16);
    };

    const schedule = {
      starts_at: toInput(ev.starts_at),
      ends_at: toInput(ev.ends_at),
      submissions_open_at: toInput(ev.submissions_open_at),
      submissions_close_at: toInput(ev.submissions_close_at),
    };

    const readableSchedule = {
      starts_at: formatDateReadable(ev.starts_at),
      ends_at: formatDateReadable(ev.ends_at),
      submissions_open_at: formatDateReadable(ev.submissions_open_at),
      submissions_close_at: formatDateReadable(ev.submissions_close_at),
    };

    const activeRubric = await fetchActiveRubric(eventId);

    const teamCountRes = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM teams WHERE event_id = $1", [eventId]);
    const teamMemberCountRes = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM team_members WHERE event_id = $1", [eventId]);
    const projectCountRes = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM projects WHERE event_id = $1", [eventId]);
    const submittedCountRes = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM projects WHERE event_id = $1 AND status = 'submitted'", [eventId]);
    const draftCountRes = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM projects WHERE event_id = $1 AND status = 'draft'", [eventId]);
    const judgeCountRes = await pool.query<{ count: string }>("SELECT COUNT(DISTINCT user_id) AS count FROM event_memberships WHERE event_id = $1 AND role = 'judge'", [eventId]);
    const scoreCountRes = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM scores WHERE event_id = $1 AND is_current = true", [eventId]);

    const finRow = await safe(() => pool.query<{ id: string; input_hash: string; method: string; created_at: Date }>(
      `SELECT id, input_hash, method, created_at FROM event_finalizations WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1`, [eventId],
    ).then((r) => r.rows[0]), undefined);

    const stats = {
      teamCount: Number(teamCountRes.rows[0]?.count || 0),
      teamMemberCount: Number(teamMemberCountRes.rows[0]?.count || 0),
      projectCount: Number(projectCountRes.rows[0]?.count || 0),
      submittedCount: Number(submittedCountRes.rows[0]?.count || 0),
      draftCount: Number(draftCountRes.rows[0]?.count || 0),
      judgeCount: Number(judgeCountRes.rows[0]?.count || 0),
      scoreCount: Number(scoreCountRes.rows[0]?.count || 0),
      isFinalized: Boolean(finRow),
    };

    const nextTransitions = [...(ALLOWED_TRANSITIONS.get(ev.state as never) ?? [])] as string[];
    const transitionsInfo = getTransitionsInfo(nextTransitions);
    const contextHelp = getContextHelp(ev.state);
    const checklist = buildChecklist(ev, tracks.length, prizes.length, stats.judgeCount, activeRubric.version, stats.isFinalized);
    const checklistCompleted = checklist.filter((i) => i.done).length;

    const finalization = finRow ? {
      id: finRow.id,
      method: finRow.method,
      inputHash: finRow.input_hash,
      inputShort: finRow.input_hash.slice(0, 12),
      createdAt: formatDateReadable(finRow.created_at),
    } : null;

    return reply.view("event_manage.njk", {
      csrfToken: req.csrfToken(),
      event: ev,
      schedule,
      readableSchedule,
      states: [...EVENT_STATES],
      next: nextTransitions,
      transitionsInfo,
      contextHelp,
      checklist,
      checklistCompleted,
      stats,
      rubric: activeRubric,
      finalization,
      tracks,
      prizes,
      error: qq["error"] ?? null,
    });
  });

  /**
   * POST /events/:eventId/manage — Lifecycle transition, track/prize mutation, schedule mutation
   */
  app.post("/events/:eventId/manage", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const b = bodyOf(req); const act = s(b.action);
    const fail = (code: string): FastifyReply => reply.code(302).redirect(`/events/${eventId}/manage?error=${code}`);
    if (act === "transition") {
      const to = s(b.toState).trim();
      if (!isEventState(to)) return fail("invalid_transition");
      const ev = await eventRow(eventId); if (!ev) return reply.code(404).send({ error: "not_found" });
      if (!isValidTransition(ev.state, to)) return fail("invalid_transition");
      const exp = typeof b.expectedVersion === "string" && b.expectedVersion !== "" ? Number(b.expectedVersion) : undefined;
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtext('event_' || $1))", [eventId]);
        const lr = await c.query("SELECT state, version FROM events WHERE id = $1 FOR UPDATE", [eventId]);
        const locked = lr.rows[0] as { state: string; version: number } | undefined;
        if (!locked) { try { await c.query("ROLLBACK"); } catch { /* noop */ } return reply.code(404).send({ error: "not_found" }); }
        if (!isValidTransition(locked.state, to)) { try { await c.query("ROLLBACK"); } catch { /* noop */ } return fail("invalid_transition"); }
        if (exp !== undefined && exp !== locked.version) { try { await c.query("ROLLBACK"); } catch { /* noop */ } return fail("version_conflict"); }
        await c.query("UPDATE events SET state = $1, version = version + 1, updated_at = now() WHERE id = $2", [to, eventId]);
        await c.query("COMMIT");
        setFlash(req, "success", `Event transitioned to ${to.replace(/_/g, " ")}.`);
        return reply.code(302).redirect(`/events/${eventId}/manage`);
      } catch (e) { try { await c.query("ROLLBACK"); } catch { /* noop */ } throw e; } finally { c.release(); }
    }
    if (act === "track_add" || act === "prize_add") {
      const slug = s(b.slug).trim().toLowerCase(), name = s(b.name).trim();
      if (!SLUG_RE.test(slug) || !name) return fail(act === "track_add" ? "invalid_track" : "invalid_prize");
      try {
        if (act === "track_add") await pool.query("INSERT INTO tracks (event_id, slug, name) VALUES ($1,$2,$3)", [eventId, slug, name]);
        else {
          const amt = s(b.amountCents) === "" ? null : Number(s(b.amountCents));
          if (amt !== null && (!Number.isInteger(amt) || amt < 0)) return fail("invalid_amount");
          const tid = s(b.trackId) === "" ? null : s(b.trackId);
          if (tid !== null && !UUID_RE.test(tid)) return fail("invalid_track");
          await pool.query("INSERT INTO prizes (event_id, slug, name, track_id, amount_cents) VALUES ($1,$2,$3,$4,$5)", [eventId, slug, name, tid, amt]);
        }
      } catch (e: unknown) { const cd = pgCode(e); return fail(cd === "23505" ? "slug_conflict" : cd === "23503" ? "invalid_track" : "db_error"); }
      setFlash(req, "success", act === "track_add" ? "Track added." : "Prize added.");
      return reply.code(302).redirect(`/events/${eventId}/manage`);
    }
    if (act === "track_delete" || act === "prize_delete") {
      const rid = s(b.id); if (!UUID_RE.test(rid)) return fail("invalid_id");
      try {
        const r = await pool.query(`DELETE FROM ${act === "track_delete" ? "tracks" : "prizes"} WHERE event_id = $1 AND id = $2`, [eventId, rid]);
        if ((r.rowCount ?? 0) === 0) return fail("not_found");
      } catch (e: unknown) { return fail(pgCode(e) === "23503" ? "track_in_use" : "db_error"); }
      setFlash(req, "success", "Deleted.");
      return reply.code(302).redirect(`/events/${eventId}/manage`);
    }
    if (act === "deadline" || act === "dates") {
      const fields = ["starts_at", "ends_at", "submissions_open_at", "submissions_close_at"] as const;
      const parsed: Record<string, string | null> = {};
      for (const f of fields) {
        const raw = s(b[f]).trim();
        if (raw === "") {
          parsed[f] = null;
          continue;
        }
        const iso = parseIsoNullable(raw);
        if (iso === undefined || iso === null) return fail("invalid_date");
        parsed[f] = iso;
      }
      const cur = await eventRow(eventId); if (!cur) return reply.code(404).send({ error: "not_found" });
      const effective = {
        starts_at: b.starts_at !== undefined ? (parsed.starts_at ?? undefined) : (cur.starts_at ?? undefined),
        ends_at: b.ends_at !== undefined ? (parsed.ends_at ?? undefined) : (cur.ends_at ?? undefined),
        submissions_open_at: b.submissions_open_at !== undefined ? (parsed.submissions_open_at ?? undefined) : (cur.submissions_open_at ?? undefined),
        submissions_close_at: b.submissions_close_at !== undefined ? (parsed.submissions_close_at ?? undefined) : (cur.submissions_close_at ?? undefined),
      };
      const norm = (v: string | Date | null | undefined): string | undefined => {
        if (v === null || v === undefined) return undefined;
        return v instanceof Date ? v.toISOString() : v;
      };
      const rangeErr = dateRangeError({
        starts_at: norm(effective.starts_at),
        ends_at: norm(effective.ends_at),
        submissions_open_at: norm(effective.submissions_open_at),
        submissions_close_at: norm(effective.submissions_close_at),
      });
      if (rangeErr) return fail("invalid_date_range");
      await pool.query(
        "UPDATE events SET starts_at = $1, ends_at = $2, submissions_open_at = $3, submissions_close_at = $4, updated_at = now() WHERE id = $5",
        [parsed.starts_at, parsed.ends_at, parsed.submissions_open_at, parsed.submissions_close_at, eventId],
      );
      setFlash(req, "success", "Event schedule updated.");
      return reply.code(302).redirect(`/events/${eventId}/manage`);
    }
    return fail("invalid_action");
  });

  /**
   * GET /events/:eventId/rubric — Rubric Configuration Page
   */
  app.get("/events/:eventId/rubric", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const activeRubric = await fetchActiveRubric(eventId);
    const qq = q(req);
    return reply.view("event_rubric.njk", {
      csrfToken: req.csrfToken(),
      event: ev,
      activeRubric,
      error: qq["error"] ?? null,
    });
  });

  /**
   * POST /events/:eventId/rubric — Update Rubric Weights
   */
  app.post("/events/:eventId/rubric", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const b = bodyOf(req);
    const weightsCandidate = {
      technical: Number(b.technical),
      innovation: Number(b.innovation),
      impact: Number(b.impact),
      polish: Number(b.polish),
    };
    const parsed = validateWeights(weightsCandidate);
    if (!parsed.ok) {
      setFlash(req, "error", "Invalid weights: values must be 0–100 numbers and sum to exactly 100%.");
      return reply.code(302).redirect(`/events/${eventId}/rubric`);
    }
    const uid = req.session["userId"];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('rubric_' || $1))`, [eventId]);
      const maxRow = (await client.query<{ max_version: number | null }>(
        `SELECT COALESCE(MAX(version), 0) AS max_version FROM rubric_versions WHERE event_id = $1`,
        [eventId],
      )).rows[0];
      const version = nextRubricVersion(maxRow?.max_version);
      await client.query(`UPDATE rubric_versions SET is_active = false WHERE event_id = $1`, [eventId]);
      await client.query(
        `INSERT INTO rubric_versions (event_id, version, weights, is_active, created_by)
         VALUES ($1, $2, $3, true, $4)`,
        [eventId, version, JSON.stringify(parsed.weights), uid],
      );
      await client.query("COMMIT");
      setFlash(req, "success", `Rubric updated to version v${version}.`);
      return reply.code(302).redirect(`/events/${eventId}/rubric`);
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  });

  /**
   * GET /events/:eventId/judges — Judge Management Page
   */
  app.get("/events/:eventId/judges", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });

    const tracks = await safe(() => pool.query<{ id: string; name: string }>(
      "SELECT id, name FROM tracks WHERE event_id = $1 ORDER BY name", [eventId],
    ).then((r) => r.rows), []);

    const judgesQuery = `
      SELECT m.user_id, COALESCE(u.name, '') AS name, COALESCE(u.email, '') AS email,
        COALESCE((SELECT string_agg(scope_track.name, ', ' ORDER BY scope_track.name)
          FROM event_membership_tracks mt JOIN tracks scope_track ON scope_track.id = mt.track_id
          WHERE mt.membership_id = m.id), t.name, CASE WHEN m.track_scope_all THEN 'All tracks' END) AS track_name,
        (SELECT COUNT(*)::int FROM judge_assignments a WHERE a.event_id = $1 AND a.judge_user_id = m.user_id AND a.status = 'active') AS assigned_count,
        (SELECT COUNT(*)::int FROM scores s WHERE s.event_id = $1 AND s.judge_user_id = m.user_id AND s.is_current = true) AS done_count
      FROM event_memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN tracks t ON t.id = m.track_id
      WHERE m.event_id = $1 AND m.role = 'judge'
      ORDER BY email ASC
    `;
    const rows = await safe(() => pool.query(judgesQuery, [eventId]).then((r) => r.rows), []);
    const judges = rows.map((j: any) => {
      const assigned = Number(j.assigned_count || 0);
      const done = Number(j.done_count || 0);
      return {
        ...j,
        assigned_count: assigned,
        done_count: done,
        pct: assigned > 0 ? Math.round((Math.min(done, assigned) / assigned) * 100) : 0,
      };
    });

    const qq = q(req);
    return reply.view("event_judges.njk", {
      csrfToken: req.csrfToken(),
      event: ev,
      judges,
      tracks,
      error: qq["error"] ?? null,
    });
  });

  /**
   * POST /events/:eventId/judges — Invite / Add Judge
   */
  app.post("/events/:eventId/judges", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const b = bodyOf(req);
    const identifier = s(b.identifier).trim();
    if (!identifier) {
      setFlash(req, "error", "Judge email or user ID is required.");
      return reply.code(302).redirect(`/events/${eventId}/judges`);
    }
    const trackIdRaw = s(b.trackId).trim();
    const trackId = trackIdRaw && UUID_RE.test(trackIdRaw) ? trackIdRaw : null;
    if (trackId) {
      const t = await pool.query("SELECT 1 FROM tracks WHERE id = $1 AND event_id = $2", [trackId, eventId]);
      if ((t.rowCount ?? 0) === 0) {
        setFlash(req, "error", "Invalid track selected.");
        return reply.code(302).redirect(`/events/${eventId}/judges`);
      }
    }
    const isUuid = UUID_RE.test(identifier);
    const userRes = isUuid
      ? await pool.query<{ id: string; role: string; email: string }>("SELECT id, role, email FROM users WHERE id = $1", [identifier])
      : await pool.query<{ id: string; role: string; email: string }>("SELECT id, role, email FROM users WHERE LOWER(email) = LOWER($1)", [identifier]);
    const target = userRes.rows[0];
    if (!target) {
      setFlash(req, "error", "No user found with that email or ID.");
      return reply.code(302).redirect(`/events/${eventId}/judges`);
    }
    if (!["judge", "admin"].includes(target.role)) {
      setFlash(req, "error", `User '${target.email}' does not have a judge account (current role: ${target.role}).`);
      return reply.code(302).redirect(`/events/${eventId}/judges`);
    }
    await pool.query(
      `INSERT INTO event_memberships (event_id, user_id, role, track_id)
       VALUES ($1, $2, 'judge', $3)
       ON CONFLICT (event_id, user_id)
       DO UPDATE SET role = 'judge', track_id = EXCLUDED.track_id`,
      [eventId, target.id, trackId],
    );
    setFlash(req, "success", `Judge '${target.email}' added to event.`);
    return reply.code(302).redirect(`/events/${eventId}/judges`);
  });

  /**
   * GET /events/:eventId/teams — Teams Management Page
   */
  app.get("/events/:eventId/teams", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });

    const teamsQuery = `
      SELECT t.id, t.name, t.invite_token, t.max_size,
        COALESCE(u.name, u.email, 'Unknown') AS leader_name,
        (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
      FROM teams t
      LEFT JOIN users u ON u.id = t.leader_user_id
      WHERE t.event_id = $1
      ORDER BY t.created_at ASC
    `;
    const rows = await safe(() => pool.query(teamsQuery, [eventId]).then((r) => r.rows), []);
    const teams = rows.map((r: any) => ({
      ...r,
      invite_url: `/events/${eventId}/teams/join?token=${r.invite_token}`,
    }));

    const qq = q(req);
    return reply.view("event_teams.njk", {
      csrfToken: req.csrfToken(),
      event: ev,
      teams,
      error: qq["error"] ?? null,
    });
  });

  /**
   * POST /events/:eventId/teams — Create Team (Organizer)
   */
  app.post("/events/:eventId/teams", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const b = bodyOf(req);
    const name = s(b.name).trim();
    if (!name || name.length > 255) {
      setFlash(req, "error", "Team name is required (max 255 characters).");
      return reply.code(302).redirect(`/events/${eventId}/teams`);
    }
    const maxSize = parseMaxSize(Number(b.maxSize) || undefined) ?? 4;
    const uid = req.session["userId"];
    const token = randomBytes(32).toString("hex");
    try {
      await pool.query(
        "INSERT INTO teams (event_id, name, invite_token, max_size, created_by) VALUES ($1, $2, $3, $4, $5)",
        [eventId, name, token, maxSize, uid],
      );
      setFlash(req, "success", `Team '${name}' created.`);
      return reply.code(302).redirect(`/events/${eventId}/teams`);
    } catch {
      setFlash(req, "error", "Failed to create team.");
      return reply.code(302).redirect(`/events/${eventId}/teams`);
    }
  });

  /**
   * POST /events/:eventId/teams/:teamId/rotate — Rotate Team Invite Link
   */
  app.post("/events/:eventId/teams/:teamId/rotate", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, teamId } = req.params as { eventId: string; teamId: string };
    const newToken = randomBytes(32).toString("hex");
    await pool.query(
      "UPDATE teams SET invite_token = $1, updated_at = now() WHERE id = $2 AND event_id = $3",
      [newToken, teamId, eventId],
    );
    setFlash(req, "success", "Team invite link rotated.");
    return reply.code(302).redirect(`/events/${eventId}/teams`);
  });

  /**
   * GET /events/:eventId/projects — Projects / Submissions Overview Page
   */
  app.get("/events/:eventId/projects", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });

    const projectsQuery = `
      SELECT p.id, p.title, p.tagline, p.status, p.tech_tags, p.needs_review, p.duplicate_of_project_id,
        t.name AS track_name,
        tm.name AS team_name
      FROM projects p
      LEFT JOIN tracks t ON t.id = p.track_id
      LEFT JOIN teams tm ON tm.id = p.team_id
      WHERE p.event_id = $1
      ORDER BY p.created_at DESC
    `;
    const projects = await safe(() => pool.query(projectsQuery, [eventId]).then((r) => r.rows), []);
    const submittedCount = projects.filter((p: any) => p.status === "submitted").length;
    const draftCount = projects.filter((p: any) => p.status === "draft").length;

    return reply.view("event_projects.njk", {
      event: ev,
      projects,
      submittedCount,
      draftCount,
    });
  });

  app.post("/events/:eventId/projects/:projectId/resolve-duplicate", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId, projectId } = req.params as { eventId: string; projectId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const duplicateId = typeof b.duplicate_of_project_id === "string" ? b.duplicate_of_project_id : "";
    if (!UUID_RE.test(projectId) || !UUID_RE.test(duplicateId) || projectId === duplicateId)
      return reply.code(422).send({ error: "invalid_duplicate_pair" });
    const pair = await pool.query(`SELECT 1 FROM projects a JOIN projects b ON b.id = $3 AND b.team_id = a.team_id AND b.event_id = a.event_id WHERE a.id = $2 AND a.event_id = $1`, [eventId, projectId, duplicateId]);
    if ((pair.rowCount ?? pair.rows.length) === 0) return reply.code(404).send({ error: "not_found" });
    const action = b.action;
    if (action === "keep") {
      await pool.query(`UPDATE projects SET needs_review = false, duplicate_of_project_id = NULL, updated_at = now() WHERE id = $2 AND event_id = $1`, [eventId, projectId]);
      await pool.query(`UPDATE projects SET needs_review = true, duplicate_of_project_id = $2, updated_at = now() WHERE id = $3 AND event_id = $1`, [eventId, projectId, duplicateId]);
    } else if (action === "duplicate") {
      await pool.query(`UPDATE projects SET needs_review = true, duplicate_of_project_id = $2, updated_at = now() WHERE id = $3 AND event_id = $1`, [eventId, projectId, duplicateId]);
      await pool.query(`UPDATE projects SET needs_review = false, duplicate_of_project_id = NULL, updated_at = now() WHERE id = $2 AND event_id = $1`, [eventId, duplicateId]);
    } else return reply.code(422).send({ error: "invalid_action" });
    setFlash(req, "success", "Duplicate review resolved.");
    return reply.code(302).redirect(`/events/${eventId}/projects`);
  });

  /**
   * GET /judging — Cross-event Judging Hub
   */
  app.get("/judging", async (req, reply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const uid = req.session["userId"];
    if (typeof uid !== "string" || !uid) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const role = await sysRole(uid);
    const isOrganizer = role === "organizer" || role === "admin";
    const isJudge = role === "judge" || role === "admin";

    let organizerEvents: any[] = [];
    if (isOrganizer) {
      const isSysAdmin = role === "admin";
      const qry = `
        SELECT e.id, e.name, e.state,
          (SELECT COUNT(*)::int FROM projects p WHERE p.event_id = e.id AND p.status = 'submitted') AS submitted_count,
          (SELECT COUNT(DISTINCT m.user_id)::int FROM event_memberships m WHERE m.event_id = e.id AND m.role = 'judge') AS judge_count,
          (SELECT COUNT(*)::int FROM scores s WHERE s.event_id = e.id AND s.is_current = true) AS score_count,
          EXISTS(SELECT 1 FROM event_finalizations f WHERE f.event_id = e.id) AS is_finalized,
          (SELECT version FROM rubric_versions rv WHERE rv.event_id = e.id AND rv.is_active = true LIMIT 1) AS rubric_version
        FROM events e
        WHERE ($1 = true OR e.created_by = $2 OR EXISTS (
          SELECT 1 FROM event_memberships m WHERE m.event_id = e.id AND m.user_id = $2 AND m.role IN ('organizer', 'admin')
        ))
        ORDER BY e.created_at DESC
      `;
      organizerEvents = await safe(() => pool.query(qry, [isSysAdmin, uid]).then((r) => r.rows), []);
    }

    let judgeAssignments: any[] = [];
    if (isJudge) {
      const jQry = `
        SELECT e.id AS event_id, e.name AS event_name,
          COUNT(a.id)::int AS assigned_count,
          COUNT(CASE WHEN s.id IS NULL THEN 1 END)::int AS pending_count
        FROM event_memberships m
        JOIN events e ON e.id = m.event_id
        LEFT JOIN judge_assignments a ON a.event_id = e.id AND a.judge_user_id = m.user_id AND a.status = 'active'
        LEFT JOIN scores s ON s.assignment_id = a.id AND s.is_current = true
        WHERE m.user_id = $1 AND m.role = 'judge'
        GROUP BY e.id, e.name
        ORDER BY e.name ASC
      `;
      judgeAssignments = await safe(() => pool.query(jQry, [uid]).then((r) => r.rows), []);
    }

    return reply.view("judging_hub.njk", {
      isOrganizer,
      isJudge,
      events: organizerEvents,
      judgeAssignments,
    });
  });

  /**
   * GET /results — Cross-event Results Hub
   */
  app.get("/results", async (req, reply) => {
    await requireAuth(req, reply);
    if (reply.sent) return;
    const uid = req.session["userId"];
    if (typeof uid !== "string" || !uid) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const role = await sysRole(uid);
    if (!["organizer", "admin"].includes(role)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const isSysAdmin = role === "admin";
    const qry = `
      SELECT e.id, e.name, e.state,
        (SELECT COUNT(*)::int FROM projects p WHERE p.event_id = e.id AND p.status = 'submitted') AS submitted_count,
        (SELECT COUNT(*)::int FROM scores s WHERE s.event_id = e.id AND s.is_current = true) AS score_count,
        EXISTS(SELECT 1 FROM event_finalizations f WHERE f.event_id = e.id) AS is_finalized,
        (SELECT created_at FROM event_finalizations f WHERE f.event_id = e.id ORDER BY created_at DESC LIMIT 1) AS finalized_at,
        (SELECT COUNT(*)::int FROM event_rankings er JOIN event_finalizations f ON f.id = er.finalization_id WHERE f.event_id = e.id) AS ranked_count
      FROM events e
      WHERE ($1 = true OR e.created_by = $2 OR EXISTS (
        SELECT 1 FROM event_memberships m WHERE m.event_id = e.id AND m.user_id = $2 AND m.role IN ('organizer', 'admin')
      ))
      ORDER BY e.created_at DESC
    `;
    const rows = await safe(() => pool.query(qry, [isSysAdmin, uid]).then((r) => r.rows), []);
    const events = rows.map((r: any) => ({
      ...r,
      finalized_at: r.finalized_at ? formatDateReadable(r.finalized_at) : null,
    }));
    return reply.view("results_hub.njk", {
      events,
    });
  });

  /**
   * GET /events/:eventId/judging-progress — Progress, coverage, normalization, finalization
   */
  app.get("/events/:eventId/judging-progress", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const judges = await safe(() => pool.query("SELECT m.user_id, COALESCE(u.email,'') AS email FROM event_memberships m LEFT JOIN users u ON u.id = m.user_id WHERE m.event_id = $1 AND m.role = 'judge' ORDER BY email", [eventId]).then((r) => r.rows as { user_id: string; email: string }[]), []);
    const assigns = await safe(() => pool.query("SELECT project_id, judge_user_id FROM judge_assignments WHERE event_id = $1", [eventId]).then((r) => r.rows as { project_id: string; judge_user_id: string }[]), []);
    const scores = await safe(() => pool.query("SELECT project_id, judge_user_id, value FROM scores WHERE event_id = $1 AND is_current = true", [eventId]).then((r) => r.rows as { project_id: string; judge_user_id: string; value: string }[]), []);
    const projects = await safe(() => pool.query("SELECT id, title FROM projects WHERE event_id = $1 ORDER BY title", [eventId]).then((r) => r.rows as { id: string; title: string }[]), []);
    const doneBy = new Map(judges.map((j) => [j.user_id, 0]));
    const seen = new Set(assigns.map((a) => `${a.judge_user_id}|${a.project_id}`));
    for (const sc of scores) if (seen.has(`${sc.judge_user_id}|${sc.project_id}`)) doneBy.set(sc.judge_user_id, (doneBy.get(sc.judge_user_id) ?? 0) + 1);
    const table = judges.map((j) => {
      const ad = assigns.filter((a) => a.judge_user_id === j.user_id).length;
      const dn = Math.min(doneBy.get(j.user_id) ?? 0, ad); const pd = ad - dn;
      return { email: j.email, assigned: ad, done: dn, pending: pd, pct: ad === 0 ? 0 : Math.round((dn / ad) * 100) };
    });
    const covBy = new Map(projects.map((p) => [p.id, new Set<string>()]));
    for (const sc of scores) covBy.get(sc.project_id)?.add(sc.judge_user_id);
    const coverage = projects.map((p) => ({ id: p.id, title: p.title, n: covBy.get(p.id)?.size ?? 0, warn: (covBy.get(p.id)?.size ?? 0) < K }));
    let preview: { projectId: string; normalized: number; rawMean: number; n: number; rank: number }[] | null = null;
    if (q(req)["preview"] === "1" && scores.length > 0) {
      const r6 = (x: number): number => { const r = Math.round(x * 1e6) / 1e6; return r === 0 ? 0 : r; };
      const entries = scores.map((sc) => ({ p: sc.project_id, j: sc.judge_user_id, v: Number(sc.value) })).filter((e) => Number.isFinite(e.v));
      const g = entries.reduce((a, e) => a + e.v, 0) / entries.length;
      const js = new Map<string, { t: number; n: number }>();
      for (const e of entries) { const a = js.get(e.j) ?? { t: 0, n: 0 }; a.t += e.v; a.n += 1; js.set(e.j, a); }
      const byP = new Map<string, { norm: number[]; raw: number[] }>();
      for (const e of entries) {
        const a = js.get(e.j); const jm = a ? a.t / a.n : g; const nv = e.v - jm + g;
        const bucket = byP.get(e.p) ?? { norm: [], raw: [] }; bucket.norm.push(nv); bucket.raw.push(e.v); byP.set(e.p, bucket);
      }
      const rows = [...byP].map(([projectId, v]) => ({ projectId, normalized: r6(v.norm.reduce((a, x) => a + x, 0) / v.norm.length), rawMean: r6(v.raw.reduce((a, x) => a + x, 0) / v.raw.length), n: v.norm.length }));
      rows.sort((a, b) => b.normalized - a.normalized || b.rawMean - a.rawMean || b.n - a.n || (a.projectId < b.projectId ? -1 : 1));
      preview = rows.slice(0, 10).map((r, i) => ({ ...r, rank: i + 1 }));
    }
    const finRow = await safe(() => pool.query<{ id: string; input_hash: string; method: string; created_at: Date }>(
      `SELECT id, input_hash, method, created_at FROM event_finalizations WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1`, [eventId],
    ).then((r) => r.rows[0]), undefined);
    interface RankRow { project_id: string; raw_mean: number; normalized: number; n: number; rank: number }
    let rankRows: RankRow[] = [];
    let stale = false;
    if (finRow) {
      rankRows = await safe(() => pool.query<RankRow>(
        `SELECT project_id, raw_mean, normalized, n, rank FROM event_rankings WHERE finalization_id = $1 ORDER BY rank ASC`, [finRow.id],
      ).then((r) => r.rows), []);
      try {
        const cur = scores.map((sc) => ({ projectId: sc.project_id, judgeId: sc.judge_user_id, value: Number(sc.value) })).filter((e) => Number.isFinite(e.value));
        stale = hashCenterEntries(cur) !== finRow.input_hash;
      } catch {
        stale = false;
      }
    }
    const finalization = finRow ? {
      id: finRow.id,
      method: finRow.method,
      inputHash: finRow.input_hash,
      inputShort: finRow.input_hash.slice(0, 12),
      createdAt: finRow.created_at instanceof Date ? finRow.created_at.toISOString() : String(finRow.created_at),
    } : null;
    return reply.view("judging_progress.njk", { csrfToken: req.csrfToken(), event: ev, judges: table, coverage, k: K, preview, finalization, rankings: rankRows, stale, canFinalize: FINALIZE_OK_STATES.has(ev.state) });
  });

  /**
   * POST /events/:eventId/judging-progress — Finalize scores
   */
  app.post("/events/:eventId/judging-progress", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P;
    const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    if (!FINALIZE_OK_STATES.has(ev.state)) {
      setFlash(req, "error", `Finalization requires state SUBMISSIONS_CLOSED, JUDGING, RESULTS_FINAL, or PUBLISHED (now ${ev.state}).`);
      return reply.code(302).redirect(`/events/${eventId}/judging-progress`);
    }
    const entries = await safe(() => pool.query<{ project_id: string; judge_user_id: string; value: string }>(
      `SELECT s.project_id, s.judge_user_id, s.value FROM scores s JOIN projects p ON p.id = s.project_id WHERE s.event_id = $1 AND s.is_current = true AND p.needs_review = false`, [eventId],
    ).then((r) => r.rows.map((x) => ({ projectId: x.project_id, judgeId: x.judge_user_id, value: Number(x.value) })).filter((e) => Number.isFinite(e.value))), []);
    if (entries.length === 0) {
      setFlash(req, "error", "Nothing to finalize — no current scores yet.");
      return reply.code(302).redirect(`/events/${eventId}/judging-progress`);
    }
    const inputHash = hashCenterEntries(entries);
    const latest = await safe(() => pool.query<{ id: string; input_hash: string }>(
      `SELECT id, input_hash FROM event_finalizations WHERE event_id = $1 AND method = 'centering' ORDER BY created_at DESC LIMIT 1`, [eventId],
    ).then((r) => r.rows[0]), undefined);
    if (latest?.input_hash === inputHash) {
      setFlash(req, "success", "Rankings are already up to date for the current scores.");
      return reply.code(302).redirect(`/events/${eventId}/judging-progress`);
    }
    const ranked = centerRows(entries);
    const uid = req.session["userId"];
    const actor = typeof uid === "string" && uid ? uid : null;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('finalize_' || $1))`, [eventId]);
      const fin = await c.query<{ id: string }>(
        `INSERT INTO event_finalizations (event_id, method, input_hash, created_by) VALUES ($1, 'centering', $2, $3) RETURNING id`,
        [eventId, inputHash, actor],
      );
      const fid = fin.rows[0]?.id;
      if (!fid) { try { await c.query("ROLLBACK"); } catch { /* noop */ } throw new Error("create_failed"); }
      for (const r of ranked) {
        await c.query(
          `INSERT INTO event_rankings (finalization_id, event_id, project_id, raw_mean, normalized, n, rank) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [fid, eventId, r.projectId, r.rawMean, r.normalized, r.n, r.rank],
        );
      }
      await c.query("COMMIT");
      setFlash(req, "success", `Results finalized (${ranked.length} projects, input ${inputHash.slice(0, 12)}…).`);
      return reply.code(302).redirect(`/events/${eventId}/judging-progress`);
    } catch (e) { try { await c.query("ROLLBACK"); } catch { /* noop */ } throw e; } finally { c.release(); }
  });

  /**
   * GET /events/:eventId/audit-viewer — Audit trail
   */
  app.get("/events/:eventId/audit-viewer", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const page = Math.max(1, Number.parseInt(q(req)["page"] ?? "1", 10) || 1);
    const latest = await pool.query("SELECT id, seq, event_id, actor_user_id, action, resource_type, resource_id, prev_hash, hash, created_at, detail FROM audit_logs WHERE event_id = $1 ORDER BY seq DESC LIMIT 200", [eventId]);
    const asc = [...(latest.rows as AuditRow[])].reverse();
    const chain = verifyChain(asc);
    const rows = (latest.rows as AuditRow[]).slice((page - 1) * 50, page * 50);
    return reply.view("audit_log.njk", { csrfToken: req.csrfToken(), event: ev, rows, chain, page, pages: Math.max(1, Math.ceil(latest.rows.length / 50)), total: latest.rows.length });
  });

  /**
   * GET /events/:eventId/data — Data hub CSV
   */
  app.get("/events/:eventId/data", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const qq = q(req);
    return reply.view("data_hub.njk", { csrfToken: req.csrfToken(), event: ev, datasets: [...EXPORT_DATASETS], error: qq["error"] ?? null });
  });

  /**
   * POST /events/:eventId/data — Import data
   */
  app.post("/events/:eventId/data", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const b = bodyOf(req); const ds = s(b.dataset);
    const render = (error: string): FastifyReply => reply.code(422).view("data_hub.njk", { csrfToken: req.csrfToken(), event: ev, datasets: [...EXPORT_DATASETS], flash: null, error });
    if (ds !== "assignments" && ds !== "scores") return render("invalid_dataset");
    let parsed: unknown;
    try { parsed = JSON.parse(s(b.payload)); } catch { return render("invalid_json"); }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown }).rows;
    if (!Array.isArray(arr)) return render("rows_required");
    const rows: Record<string, string>[] = [];
    for (const item of arr as unknown[]) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return render("invalid_row_shape");
      const rec: Record<string, string> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) rec[k] = v === null || v === undefined ? "" : String(v);
      rows.push(rec);
    }
    const out = await runImport(pool, eventId, ds as ImportDataset, rows);
    if ("error" in out) return reply.code(302).redirect(`/events/${eventId}/data?error=${out.error}`);
    setFlash(req, "success", `Imported ${out.imported} row(s), ${out.errors.length} error(s).`);
    return reply.code(302).redirect(`/events/${eventId}/data`);
  });
}

export default registerOrganizerPages;
