import Fastify, { type FastifyServerOptions } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import fastifyView from "@fastify/view";
import fastifyStatic from "@fastify/static";
import nunjucks from "nunjucks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import securityPlugin from "./plugins/security.js";
import sessionPlugin from "./plugins/session.js";
import csrfPlugin from "./plugins/csrf.js";
import healthRoutes from "./routes/health.js";
import pageRoutes from "./routes/pages.js";
import eventRoutes from "./routes/events.js";
import authRoutes from "./routes/auth.js";
import trackRoutes from "./routes/tracks.js";
import teamRoutes from "./routes/teams.js";
import projectRoutes from "./routes/projects.js";
import uploadRoutes from "./routes/uploads.js";
import galleryRoutes from "./routes/gallery.js";
import scoreRoutes from "./routes/scores.js";
import auditRoutes from "./routes/audit.js";
import exportRoutes from "./routes/exports.js";
import { registerRubricRoutes } from "./routes/rubrics.js";
import communityRoutes from "./routes/community.js";
import webhookRoutes from "./routes/webhooks.js";
import certificateRoutes from "./routes/certificates.js";
import apiIndexRoutes from "./routes/api.js";
import acceptanceRoutes from "./routes/acceptance.js";
import { registerShellPages } from "./routes/pages/shell.js";
import { registerParticipantPages } from "./routes/pages/participant.js";
import { registerJudgePages } from "./routes/pages/judge.js";
import { registerOrganizerPages } from "./routes/pages/organizer.js";
import { registerCommunityPages } from "./routes/pages/community.js";

export interface AppOptions {
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    // Structured JSON logging via pino (default when object passed).
    // request.id set below surfaces as reqId in every log line.
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
  });

  // Generate request_id for structured logging if not already present
  app.addHook("onRequest", async (request, _reply) => {
    const existing = request.headers["x-request-id"];
    request.id =
      typeof existing === "string" ? existing : randomUUID();
  });

  // ── 1. Cookie parser + form body (required by session + login form) ──
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);

  // ── 2. Security headers (helmet / CSP) ──────────────────────────
  await app.register(securityPlugin);

  // ── 3. Session (in-memory stub) ──────────────────────────────────
  await app.register(sessionPlugin);

  // ── 4. CSRF protection ──────────────────────────────────────────
  await app.register(csrfPlugin);

  // ── 5. Static files ─────────────────────────────────────────────
  const rootDir = import.meta.dirname ?? process.cwd();
  await app.register(fastifyStatic, {
    root: join(rootDir, "..", "static"),
    prefix: "/static/",
    decorateReply: false,
  });

  // ── 6. Template engine (Nunjucks via @fastify/view) ──────────────
  const templateDir = join(rootDir, "..", "templates");

  await app.register(fastifyView, {
    engine: { nunjucks },
    templates: templateDir,
    options: { autoescape: true },
  });

  // ── 7. Routes ───────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(pageRoutes);
  await app.register(eventRoutes);
  await app.register(authRoutes);
  await app.register(trackRoutes);
  await app.register(teamRoutes);
  await app.register(projectRoutes);
  await app.register(uploadRoutes);
  await app.register(galleryRoutes);
  await app.register(scoreRoutes);
  await app.register(auditRoutes);
  await app.register(exportRoutes);
  await app.register(registerRubricRoutes);
  await app.register(communityRoutes);
  await app.register(webhookRoutes);
  await app.register(certificateRoutes);
  await app.register(apiIndexRoutes);
  await app.register(acceptanceRoutes);

  // ── 8. Server-rendered UI pages ───────────────────────────────────
  await app.register(registerShellPages);
  await app.register(registerParticipantPages);
  await app.register(registerJudgePages);
  await app.register(registerOrganizerPages);
  await app.register(registerCommunityPages);

  await app.ready();
  return app;
}
