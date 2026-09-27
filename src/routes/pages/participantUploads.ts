/**
 * Participant upload page — multipart form on the project edit page.
 *
 * The file arrives buffered via attachFieldsToBody:"keyValues" + onFile
 * (see participant.ts): that keeps the _csrf field visible to the global
 * CSRF hook, which preHandler streaming (req.parts) cannot do. Bytes stay
 * bounded by the parser fileSize limit; validation + disk persistence reuse
 * the uploadStore helpers (checkFile / saveBuffer). No inline previews:
 * the form lists download links served by GET /uploads/:id.
 */
import type { FastifyInstance } from "fastify";
import "@fastify/view";
import { pool } from "../../db/index.js";
import { requireAuth } from "../../authz/guards.js";
import { setFlash } from "../../lib/flash.js";
import {
  checkFile,
  containsTraversal,
  extFromName,
  saveBuffer,
} from "../../lib/uploadStore.js";
import {
  UUID_RE,
  getEvent,
  getUserId,
  isTeamMember,
  pgCode,
  type ParsedUpload,
  type ProjectInfo,
} from "./participantShared.js";
import { renderProjectForm } from "./participantProjectForm.js";

type ProjectParams = { eventId: string; projectId: string };

function asUpload(raw: unknown): ParsedUpload | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!(r.data instanceof Buffer)) return undefined;
  if (typeof r.filename !== "string" || typeof r.mimetype !== "string") return undefined;
  return { data: r.data, filename: r.filename, mimetype: r.mimetype };
}

export async function registerParticipantUploadPages(
  app: FastifyInstance,
): Promise<void> {
  app.post("/events/:eventId/projects/:projectId/uploads", { preHandler: [requireAuth] }, async (req, reply) => {
    const userId = getUserId(req);
    if (!userId) return reply.code(401).send({ error: "unauthenticated" });
    const { eventId, projectId } = req.params as ProjectParams;
    if (!UUID_RE.test(eventId) || !UUID_RE.test(projectId)) {
      return reply.code(422).send({ error: "invalid_input" });
    }
    const ev = await getEvent(eventId);
    if (!ev) return reply.code(404).send({ error: "not_found" });
    const found = await pool.query<ProjectInfo>(
      `SELECT * FROM projects WHERE id = $1 AND event_id = $2`, [projectId, eventId],
    );
    const project = found.rows[0];
    if (!project || !(await isTeamMember(project.team_id, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const fail = async (message: string, status: number): Promise<void> => {
      await renderProjectForm(req, reply, eventId, ev.name, "edit", project,
        { error: message, status });
    };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const file = asUpload(body.file);
    if (!file) {
      await fail("Choose a file to upload.", 422);
      return;
    }
    if (containsTraversal(file.filename) || containsTraversal(file.mimetype)
      || file.filename.length > 255) {
      await fail("Invalid file name.", 422);
      return;
    }
    const ext = extFromName(file.filename);
    if (ext === undefined) {
      await fail("Invalid file type. Allowed: png, jpg, gif, webp, pdf.", 422);
      return;
    }
    const problem = checkFile(file.data, ext, file.mimetype);
    if (problem === "file_too_large") {
      await fail("File is too large (max 10 MB).", 413);
      return;
    }
    if (problem !== undefined) {
      await fail("Invalid file type. Allowed: png, jpg, gif, webp, pdf.", 422);
      return;
    }
    let saved: { storedName: string };
    try {
      saved = await saveBuffer(file.data, ext);
    } catch {
      await fail("Invalid file type. Allowed: png, jpg, gif, webp, pdf.", 422);
      return;
    }
    try {
      await pool.query(
        `INSERT INTO uploads (project_id, stored_name, original_name, mime, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, saved.storedName, file.filename,
          file.mimetype.toLowerCase(), file.data.length, userId],
      );
    } catch (e) {
      if (pgCode(e) === "23503") return reply.code(404).send({ error: "not_found" });
      throw e;
    }
    setFlash(req, "success", "File uploaded.");
    return reply.code(302).redirect(`/events/${eventId}/projects/${projectId}/edit`);
  });
}
