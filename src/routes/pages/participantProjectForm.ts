/**
 * Participant project form machinery — shared by create/edit/upload/submit.
 * Field parsing, per-qtype answer validation (via db/gallery.js), and the
 * single renderProjectForm used for GETs and422/409 re-renders (PRG on ok).
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { validateAnswerValue, type QuestionRow } from "../../db/gallery.js";
import {
  UUID_RE,
  deadlineBanner,
  flashScope,
  getEvent,
  getTracks,
  isTeamMember,
  parseTechTags,
  type ProjectInfo,
} from "./participantShared.js";

export interface FormQuestion {
  id: string;
  key: string;
  label: string;
  qtype: string;
  required: boolean;
  options: string[];
}

export interface AnswerItem {
  questionId: string;
  value: unknown;
}

export interface FormValues {
  title: string;
  tagline: string;
  description: string;
  trackId: string;
  techTagsRaw: string;
}

export async function loadProject(
  eventId: string,
  projectId: string,
  userId: string,
): Promise<ProjectInfo | undefined> {
  const r = await pool.query<ProjectInfo>(
    `SELECT * FROM projects WHERE id = $1 AND event_id = $2`, [projectId, eventId],
  );
  const p = r.rows[0];
  if (!p || !(await isTeamMember(p.team_id, userId))) return undefined;
  return p;
}

export async function loadQuestions(eventId: string): Promise<{
  rows: QuestionRow[];
  view: FormQuestion[];
}> {
  const r = await pool.query<QuestionRow>(
    `SELECT * FROM custom_questions WHERE event_id = $1 ORDER BY created_at ASC`,
    [eventId],
  );
  const view = r.rows.map((q) => ({
    id: q.id,
    key: q.key,
    label: q.label,
    qtype: q.qtype,
    required: q.required,
    options: Array.isArray(q.options)
      ? (q.options as unknown[]).filter((o): o is string => typeof o === "string")
      : [],
  }));
  return { rows: r.rows, view };
}

export async function loadAnswers(projectId: string): Promise<Record<string, string>> {
  const r = await pool.query<{ question_id: string; value: unknown }>(
    `SELECT question_id, value FROM custom_answers WHERE project_id = $1`, [projectId],
  );
  const out: Record<string, string> = {};
  for (const row of r.rows) {
    out[row.question_id] = typeof row.value === "string" ? row.value
      : typeof row.value === "number" ? String(row.value) : "";
  }
  return out;
}

export function parseAnswers(
  questions: QuestionRow[],
  body: Record<string, unknown>,
): { items: AnswerItem[]; error: string | null } {
  const items: AnswerItem[] = [];
  for (const q of questions) {
    const raw: unknown = body[`answer_${q.id}`];
    const s = typeof raw === "string" ? raw : raw === undefined ? "" : null;
    if (s === null) return { items, error: `${q.key}: invalid answer` };
    if (q.qtype === "number") {
      if (s === "") {
        if (q.required) return { items, error: `${q.key}: answer is required` };
        continue;
      }
      const msg = validateAnswerValue(q, Number(s));
      if (msg) return { items, error: msg };
      items.push({ questionId: q.id, value: Number(s) });
      continue;
    }
    if (s === "") {
      if (q.required) return { items, error: `${q.key}: answer is required` };
      continue;
    }
    const msg = validateAnswerValue(q, s);
    if (msg) return { items, error: msg };
    items.push({ questionId: q.id, value: s });
  }
  return { items, error: null };
}

export function readFields(body: Record<string, unknown>): {
  values: FormValues;
  techTags: string[];
  error: string | null;
} {
  const values: FormValues = {
    title: typeof body.title === "string" ? body.title.trim() : "",
    tagline: typeof body.tagline === "string" ? body.tagline : "",
    description: typeof body.description === "string" ? body.description : "",
    trackId: typeof body.track_id === "string" ? body.track_id : "",
    techTagsRaw: typeof body.tech_tags === "string" ? body.tech_tags : "",
  };
  if (!values.title || values.title.length > 255) {
    return { values, techTags: [], error: "Enter a title of 1–255 characters." };
  }
  if (values.tagline.length > 255) {
    return { values, techTags: [], error: "Tagline must be at most 255 characters." };
  }
  if (values.trackId && !UUID_RE.test(values.trackId)) {
    return { values, techTags: [], error: "Select a valid track." };
  }
  return { values, techTags: parseTechTags(body.tech_tags), error: null };
}

/** Render new/edit form; body (when given) repopulates fields after errors. */
export async function renderProjectForm(
  req: FastifyRequest,
  reply: FastifyReply,
  eventId: string,
  eventName: string,
  mode: "new" | "edit",
  project: ProjectInfo | null,
  opts: { error: string | null; status: number; body?: Record<string, unknown> },
): Promise<void> {
  const tracks = await getTracks(eventId);
  const { rows: questions, view } = await loadQuestions(eventId);
  const ev = await getEvent(eventId);
  const banner = deadlineBanner(ev?.submissions_close_at ?? null);
  const body = opts.body;
  const answers: Record<string, string> = {};
  if (body) {
    for (const q of questions) {
      const raw: unknown = body[`answer_${q.id}`];
      answers[q.id] = typeof raw === "string" ? raw : "";
    }
  } else if (project) {
    Object.assign(answers, await loadAnswers(project.id));
  }
  const uploads: { id: string; originalName: string; mime: string; sizeBytes: number }[] = [];
  if (project) {
    const u = await pool.query(
      `SELECT id, original_name, mime, size_bytes FROM uploads WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id],
    );
    for (const row of u.rows as { id: string; original_name: string; mime: string; size_bytes: number }[]) {
      uploads.push({ id: row.id, originalName: row.original_name, mime: row.mime, sizeBytes: row.size_bytes });
    }
  }
  const values: FormValues = body ? {
    title: typeof body.title === "string" ? body.title : "",
    tagline: typeof body.tagline === "string" ? body.tagline : "",
    description: typeof body.description === "string" ? body.description : "",
    trackId: typeof body.track_id === "string" ? body.track_id : "",
    techTagsRaw: typeof body.tech_tags === "string" ? body.tech_tags : "",
  } : {
    title: project?.title ?? "",
    tagline: project?.tagline ?? "",
    description: project?.description ?? "",
    trackId: project?.track_id ?? "",
    techTagsRaw: (project?.tech_tags ?? []).join(", "),
  };
  return reply.code(opts.status).view("project_form.njk", {
    mode,
    formAction: project
      ? `/events/${eventId}/projects/${project.id}/edit`
      : `/events/${eventId}/projects/new`,
    eventId,
    eventName,
    project: {
      id: project?.id ?? "",
      title: values.title,
      tagline: values.tagline,
      description: values.description,
      trackId: values.trackId,
      status: project?.status ?? "draft",
    },
    tracks,
    techTagsRaw: values.techTagsRaw,
    questions: view,
    answers,
    uploads,
    deadlineText: banner.text,
    csrfToken: req.csrfToken(),
    error: opts.error,
    ...flashScope(req),
  });
}
