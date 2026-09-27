/**
 * Minimal REST API index (T4.1): a static, honest map of the JSON surface.
 * No database access — safe to call unauthenticated. Per-endpoint auth and
 * guards are documented inline so integrators know what to expect.
 */
import type { FastifyInstance } from "fastify";

interface ApiEndpoint {
  method: string;
  path: string;
  auth: string;
  notes: string;
}

const ENDPOINTS: ApiEndpoint[] = [
  { method: "POST", path: "/register", auth: "none (rate-limited)", notes: "Create account + session." },
  { method: "POST", path: "/login", auth: "none (rate-limited)", notes: "Authenticate + session." },
  { method: "POST", path: "/logout", auth: "session", notes: "Revoke current session." },
  { method: "POST", path: "/password-change", auth: "session", notes: "Rotate password." },
  { method: "GET", path: "/events/:id", auth: "session", notes: "Event detail (scoped)." },
  { method: "POST", path: "/events", auth: "organizer/admin", notes: "Create event." },
  { method: "POST", path: "/events/:id/transition", auth: "organizer", notes: "Lifecycle transition (optimistic version)." },
  { method: "GET", path: "/gallery", auth: "none", notes: "Public project gallery (?q, ?track, ?tag)." },
  { method: "GET", path: "/gallery/embed", auth: "none", notes: "Framing-friendly public gallery widget." },
  { method: "GET", path: "/api/events/:eventId/rubric", auth: "member", notes: "Active rubric weights." },
  { method: "POST", path: "/api/events/:eventId/rubrics", auth: "organizer", notes: "Publish a new rubric version." },
  { method: "POST", path: "/api/assignments", auth: "organizer", notes: "Create a judge assignment (auto-ensures judge membership)." },
  { method: "POST", path: "/api/events/:eventId/judges", auth: "organizer", notes: "Invite a judge to an event (creates membership)." },
  { method: "GET", path: "/api/assignments/mine", auth: "judge", notes: "Own assignments." },
  { method: "POST", path: "/api/scores", auth: "judge (assignment)", notes: "Submit a score." },
  { method: "POST", path: "/api/scores/:id/rescore", auth: "judge (owner)", notes: "Supersede own score." },
  { method: "GET", path: "/api/judge/scores", auth: "judge (own only)", notes: "Own scores; peer probe is 403-mapped." },
  { method: "GET", path: "/api/export.csv", auth: "organizer", notes: "Checker-facing score export." },
  { method: "GET", path: "/api/events/:eventId/export?dataset=", auth: "organizer", notes: "CSV hub: assignments, scores-raw, scores-normalized, rankings, audit, votes, comments." },
  { method: "POST", path: "/api/events/:eventId/import", auth: "organizer", notes: "All-or-nothing JSON row import (assignments, scores)." },
  { method: "GET", path: "/api/events/:eventId/audit", auth: "organizer", notes: "Audit log read." },
  { method: "POST", path: "/api/projects/:projectId/vote", auth: "session", notes: "Community vote (in-window, one per project)." },
  { method: "GET", path: "/api/projects/:projectId/votes", auth: "public after close; organizer while voting", notes: "Vote counts (404 while voting is active)." },
  { method: "GET", path: "/api/projects/:projectId/comments", auth: "none", notes: "Public comment list." },
  { method: "POST", path: "/api/projects/:projectId/comments", auth: "session", notes: "Post a comment (1-2000 chars)." },
  { method: "POST", path: "/api/events/:eventId/voting-window", auth: "organizer", notes: "Configure the community voting window." },
  { method: "GET", path: "/api/events/:eventId/webhooks", auth: "organizer", notes: "List webhook subscriptions (no secrets)." },
  { method: "POST", path: "/api/events/:eventId/webhooks", auth: "organizer", notes: "Subscribe (secret returned once)." },
  { method: "DELETE", path: "/api/events/:eventId/webhooks/:webhookId", auth: "organizer", notes: "Unsubscribe." },
  { method: "POST", path: "/api/events/:eventId/certificates", auth: "organizer", notes: "Issue a signed certificate/record." },
  { method: "GET", path: "/api/certificates/:id", auth: "none", notes: "Public certificate record." },
  { method: "GET", path: "/api/certificates/:id/verify", auth: "none (+ optional ?payload= override)", notes: "Verify digest + signature; modified copies fail." },
  { method: "GET", path: "/api/records/pubkey", auth: "none", notes: "Current record-signing public key." },
  { method: "GET", path: "/healthz", auth: "none", notes: "Liveness." },
  { method: "GET", path: "/readyz", auth: "none", notes: "Readiness (DB check)." },
];

export default async function apiIndexRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api", async (_req, reply) => {
    return reply.send({
      name: "dogfood",
      api: "v1",
      tiers: ["T1", "T2", "T3"],
      conventions:
        "401 unauthenticated; 404 isolation (never 403 for cross-resource); 422 invalid; 409 conflict; 429 limited.",
      endpoints: ENDPOINTS,
    });
  });
}
