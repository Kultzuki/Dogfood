/**
 * Project file uploads — local-disk store under UPLOAD_DIR.
 *
 * POST /api/projects/:projectId/uploads — multipart "file" (team members)
 * GET  /uploads/:id — download (team members only, attachment + nosniff)
 *
 * 401 unauthenticated · 404 not-found (outsiders mapping to 404, never 403)
 * 413 file_too_large · 422 invalid_file_type | path_traversal | file_required
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import multipart, { type MultipartFile } from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { pool } from "../db/index.js";
import { requireAuth } from "../authz/guards.js";
import {
  EXT_TO_KIND,
  EXT_TO_MIME,
  MAX_FILE_BYTES,
  containsTraversal,
  ensureUploadDir,
  extFromName,
  getUploadDir,
  randomStoredName,
  safePathFor,
  sniffKind,
  streamToFile,
} from "../lib/uploadStore.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract userId from session (mirrors routes/events.ts). */
function getUserId(req: FastifyRequest): string | undefined {
  const uid = req.session["userId"];
  if (typeof uid === "string" && uid.length > 0) return uid;
  const u = req.session.user as Record<string, unknown> | undefined;
  if (typeof u === "object" && u !== null && "id" in u) {
    return typeof u.id === "string" && u.id.length > 0 ? u.id : undefined;
  }
  return undefined;
}

/** True when a multipart/parse failure is an over-size rejection. */
function isTooLarge(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as Record<string, unknown>;
  if (rec["code"] === "FST_REQ_FILE_TOO_LARGE") return true;
  if (rec["statusCode"] === 413) return true;
  const msg = typeof rec["message"] === "string" ? rec["message"] : "";
  return /too large|file size|limit/i.test(msg);
}

function pgCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

interface UploadRow {
  id: string;
  project_id: string;
  stored_name: string;
  original_name: string;
  mime: string;
  size_bytes: number;
}

/**
 * Upload gate: TEAM membership (team_members) in the project's team, or
 * organizer membership IN THE PROJECT'S EVENT. Event membership alone,
 * global system roles, and judge assignments are insufficient.
 * Unknown projects → false (caller sends 404).
 * Missing optional tables degrade gracefully instead of crashing.
 */
async function projectAllowsUpload(projectId: string, userId: string): Promise<boolean> {
  let project: Record<string, unknown>;
  try {
    const r = await pool.query("SELECT event_id, team_id FROM projects WHERE id = $1", [projectId]);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return false;
    project = row;
  } catch {
    return false; // Fail closed: without the projects table we cannot authorize.
  }

  const teamId = project["team_id"];
  if (typeof teamId === "string" && teamId.length > 0) {
    for (const q of [
      "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 LIMIT 1",
      "SELECT 1 FROM team_memberships WHERE team_id = $1 AND user_id = $2 LIMIT 1",
    ]) {
      try {
        const r = await pool.query(q, [teamId, userId]);
        if ((r.rowCount ?? 0) > 0) return true;
      } catch { /* ignore — layout may differ */ }
    }
  }
  const eventId = project["event_id"];
  if (typeof eventId === "string" && eventId.length > 0) {
    try {
      const r = await pool.query(
        "SELECT 1 FROM event_memberships WHERE event_id = $1 AND user_id = $2 AND role IN ('organizer', 'admin') LIMIT 1",
        [eventId, userId],
      );
      if ((r.rowCount ?? 0) > 0) return true;
    } catch { /* ignore — table may not exist */ }
  }
  return false;
}

/**
 * Download gate: upload-allowed callers, plus judges holding an ACTIVE
 * assignment on that specific project. Unknown projects → false (404).
 */
async function projectAllowsDownload(projectId: string, userId: string): Promise<boolean> {
  if (await projectAllowsUpload(projectId, userId)) return true;
  try {
    const r = await pool.query(
      "SELECT 1 FROM judge_assignments WHERE project_id = $1 AND judge_user_id = $2 AND status = 'active' LIMIT 1",
      [projectId, userId],
    );
    if ((r.rowCount ?? 0) > 0) return true;
  } catch { /* ignore — table may not exist */ }
  return false;
}

export default async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated: multipart lives only inside this plugin scope.
  await app.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 20, fieldSize: 1_048_576 },
  });
  app.addHook("onRequest", requireAuth);

  /** POST /api/projects/:projectId/uploads — store one file on local disk. */
  app.post(
    "/api/projects/:projectId/uploads",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getUserId(req);
      if (userId === undefined) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const { projectId } = req.params as { projectId: string };
      if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
        return reply.code(422).send({ error: "invalid_project_id" });
      }
      if (containsTraversal(projectId)) {
        return reply.code(422).send({ error: "path_traversal" });
      }

      let filename = "";
      let mime = "";
      let ext: string | undefined;
      let filePart: MultipartFile | undefined;
      try {
        for await (const part of req.parts()) {
          if (part.type === "file") {
            if (filePart !== undefined) {
              part.file.resume();
              return reply.code(422).send({ error: "too_many_files" });
            }
            if (containsTraversal(part.fieldname)) {
              part.file.resume();
              return reply.code(422).send({ error: "path_traversal" });
            }
            filename = part.filename;
            mime = part.mimetype;
            if (containsTraversal(filename) || containsTraversal(mime)) {
              part.file.resume();
              return reply.code(422).send({ error: "path_traversal" });
            }
            ext = extFromName(filename);
            if (
              ext === undefined ||
              EXT_TO_MIME[ext] === undefined ||
              mime.toLowerCase() !== EXT_TO_MIME[ext]
            ) {
              part.file.resume();
              return reply.code(422).send({ error: "invalid_file_type" });
            }
            filePart = part;
          } else {
            const v = part.value;
            if (typeof v === "string" && containsTraversal(v)) {
              return reply.code(422).send({ error: "path_traversal" });
            }
            if (containsTraversal(part.fieldname)) {
              return reply.code(422).send({ error: "path_traversal" });
            }
          }
        }
      } catch (err: unknown) {
        if (isTooLarge(err)) return reply.code(413).send({ error: "file_too_large" });
        return reply.code(422).send({ error: "invalid_upload" });
      }
      if (filePart === undefined || ext === undefined) {
        return reply.code(422).send({ error: "file_required" });
      }
      if (!(await projectAllowsUpload(projectId, userId))) {
        filePart.file.resume();
        return reply.code(404).send({ error: "not_found" });
      }

      const dir = await ensureUploadDir();
      const tmpPath = safePathFor(dir, `tmp-${randomUUID()}`);
      const streamed = await streamToFile(filePart.file, tmpPath, MAX_FILE_BYTES).catch(
        async (err: Error) => {
          await unlink(tmpPath).catch(() => undefined);
          throw err;
        },
      );
      if (streamed.overLimit || streamed.sizeBytes > MAX_FILE_BYTES) {
        await unlink(tmpPath).catch(() => undefined);
        return reply.code(413).send({ error: "file_too_large" });
      }
      const kind = sniffKind(streamed.head);
      if (kind === undefined || kind !== EXT_TO_KIND[ext]) {
        await unlink(tmpPath).catch(() => undefined);
        return reply.code(422).send({ error: "invalid_file_type" });
      }

      const id = randomUUID();
      const loweredMime = mime.toLowerCase();
      let storedName = randomStoredName(ext);
      let currentPath = safePathFor(dir, storedName);
      await rename(tmpPath, currentPath);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await pool.query(
            `INSERT INTO uploads
               (id, project_id, stored_name, original_name, mime, size_bytes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, projectId, storedName, filename, loweredMime, streamed.sizeBytes, userId],
          );
          return reply.code(201).send({
            id,
            projectId,
            storedName,
            originalName: filename,
            mime: loweredMime,
            sizeBytes: streamed.sizeBytes,
          });
        } catch (err: unknown) {
          if (pgCode(err) === "23503") {
            await unlink(currentPath).catch(() => undefined);
            return reply.code(404).send({ error: "not_found" });
          }
          if (pgCode(err) === "23505" && attempt < 2) {
            const nextName = randomStoredName(ext);
            const nextPath = safePathFor(dir, nextName);
            await rename(currentPath, nextPath).catch(() => undefined);
            storedName = nextName;
            currentPath = nextPath;
            continue;
          }
          await unlink(currentPath).catch(() => undefined);
          if (pgCode(err) === "23505") {
            return reply.code(503).send({ error: "temporarily_unavailable" });
          }
          throw err;
        }
      }
      await unlink(currentPath).catch(() => undefined);
      return reply.code(503).send({ error: "temporarily_unavailable" });
    },
  );

  /** GET /uploads/:id — serve the stored bytes (members only). */
  app.get("/uploads/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = getUserId(req);
    if (userId === undefined) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const { id } = req.params as { id: string };
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return reply.code(422).send({ error: "invalid_upload_id" });
    }
    if (containsTraversal(id)) return reply.code(422).send({ error: "path_traversal" });

    let row: UploadRow | undefined;
    try {
      const r = await pool.query(
        `SELECT id, project_id, stored_name, original_name, mime, size_bytes
         FROM uploads WHERE id = $1`,
        [id],
      );
      row = r.rows[0] as UploadRow | undefined;
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    if (row === undefined) return reply.code(404).send({ error: "not_found" });
    if (!(await projectAllowsDownload(row.project_id, userId))) {
      return reply.code(404).send({ error: "not_found" });
    }

    let abs: string;
    try {
      abs = safePathFor(getUploadDir(), row.stored_name);
    } catch {
      return reply.code(422).send({ error: "path_traversal" });
    }
    let data: Buffer;
    try {
      data = await readFile(abs);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    const safeName = row.original_name.replace(/["\r\n]/g, "_");
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Type", row.mime)
      .header("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
      .header("Content-Length", data.length)
      .send(data);
  });
}
