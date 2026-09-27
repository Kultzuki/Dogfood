import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth, requireEventRole } from "../../authz/guards.js";
import { EVENT_STATES, ALLOWED_TRANSITIONS, isEventState, isValidTransition } from "../../lib/eventTransitions.js";
import { verifyChain, type AuditRow } from "../../lib/audit.js";
import { EXPORT_DATASETS, type ImportDataset } from "../../lib/csv.js";
import { consumeFlash, setFlash } from "../../lib/flash.js";
import { runImport } from "../exports.js";

type P = { eventId: string };
interface EventRow { id: string; name: string; description: string | null; state: string; version: number; submissions_close_at: string | null; }
interface IdRow { id: string }
const resolveEventId = (req: { params: unknown }): string | undefined => (req.params as P).eventId;
const organizeEvent = requireEventRole(resolveEventId, "organizer");
const SLUG_RE = /^[a-z0-9-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const K = 3;

const bodyOf = (req: FastifyRequest): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
const s = (v: unknown): string => typeof v === "string" ? v : "";
const pgCode = (e: unknown): string | undefined => typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" ? (e as { code: string }).code : undefined;
const missing = (e: unknown): boolean => pgCode(e) === "42P01";
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
const back = (reply: FastifyReply, id: string, p: string): void => { void reply.code(302).redirect(`/events/${id}/manage${p}`); };

export async function registerOrganizerPages(app: FastifyInstance): Promise<void> {
  app.get("/events/new", async (req, reply) => {
    if (await sysGuard(req, reply) === undefined) return;
    return reply.view("event_new.njk", { csrfToken: req.csrfToken(), error: null, flash: consumeFlash(req) });
  });
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
      setFlash(req, "success", "Event created.");
      return reply.code(302).redirect(`/events/${ev.id}/manage`);
    } catch (e) { try { await c.query("ROLLBACK"); } catch { /* dead conn */ } throw e; } finally { c.release(); }
  });
  app.get("/events/:eventId/manage", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const qq = q(req);
    const tracks = await safe(() => pool.query("SELECT id, slug, name FROM tracks WHERE event_id = $1 ORDER BY slug", [eventId]).then((r) => r.rows), []);
    const prizes = await safe(() => pool.query("SELECT id, slug, name, amount_cents, track_id FROM prizes WHERE event_id = $1 ORDER BY slug", [eventId]).then((r) => r.rows), []);
    return reply.view("event_manage.njk", { csrfToken: req.csrfToken(), event: ev, states: [...EVENT_STATES], next: [...(ALLOWED_TRANSITIONS.get(ev.state as never) ?? [])] as string[], tracks,     prizes, flash: consumeFlash(req), error: qq["error"] ?? null });
  });
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
        setFlash(req, "success", `Event transitioned to ${to}.`);
        return reply.code(302).redirect(`/events/${eventId}/manage`);
      } catch (e) { try { await c.query("ROLLBACK"); } catch { /* noop */ } throw e; } finally { c.release(); }
    }
    if (act === "track_add" || act === "prize_add") {
      const slug = s(b.slug), name = s(b.name).trim();
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
    if (act === "deadline") {
      const raw = s(b.submissions_close_at).trim();
      if (raw !== "" && Number.isNaN(Date.parse(raw))) return fail("invalid_deadline");
      await pool.query("UPDATE events SET submissions_close_at = $1, updated_at = now() WHERE id = $2", [raw === "" ? null : new Date(raw).toISOString(), eventId]);
      setFlash(req, "success", "Deadline updated.");
      return reply.code(302).redirect(`/events/${eventId}/manage`);
    }
    return fail("invalid_action");
  });
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
      // Centering duplicate of src/judging/normalize.ts normalizeCentering +
      // aggregateByProject + rankProjects (normalized = raw - judgeMean +
      // globalMean; eslint bans judging imports in routes, so duplicated here).
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
    return reply.view("judging_progress.njk", { csrfToken: req.csrfToken(), event: ev, judges: table, coverage, k: K, preview });
  });
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
  app.get("/events/:eventId/data", { preHandler: [organizeEvent] }, async (req, reply) => {
    const { eventId } = req.params as P; const ev = await eventRow(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const qq = q(req);
    return reply.view("data_hub.njk", { csrfToken: req.csrfToken(), event: ev, datasets:     [...EXPORT_DATASETS], flash: consumeFlash(req), error: qq["error"] ?? null });
  });
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
