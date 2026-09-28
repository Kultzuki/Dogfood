/**
 * Page routes — login page.
 *
 * GET / — renders the login form (login.njk via layout.njk).
 *
 * POST /login has moved to src/routes/auth.ts.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import "@fastify/view";
import { pool } from "../db/index.js";
import { requireAuth } from "../authz/guards.js";

async function pageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET / — Role-aware root page.
   * Organizers/Admins → /dashboard
   * Judges → /judging
   * Participants → /dashboard
   * Unauthenticated → login form
   */
  app.get("/", async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session.userId;
    if (typeof userId === "string" && userId.length > 0) {
      try {
        const { rows } = await pool.query<{ role: string }>(
          "SELECT role FROM users WHERE id = $1",
          [userId],
        );
        const role = rows[0]?.role ?? "participant";
        if (role === "organizer" || role === "admin") {
          return reply.code(302).redirect("/dashboard");
        }
        if (role === "judge") {
          return reply.code(302).redirect("/judging");
        }
        return reply.code(302).redirect("/dashboard");
      } catch {
        return reply.code(302).redirect("/gallery");
      }
    }
    const csrfToken = req.csrfToken();
    return reply.view("login.njk", { csrfToken, error: null });
  });

  /**
   * GET /login — Redirect to canonical sign-in page at /
   */
  app.get("/login", async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.code(302).redirect("/");
  });

  app.get("/me", { preHandler: [requireAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ userId: req.session.userId ?? null });
  });

  /**
   * GET /account — User account profile.
   */
  app.get("/account", { preHandler: [requireAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.session.userId;
    if (typeof userId !== "string" || !userId) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const userRes = await pool.query<{ id: string; email: string; name: string; role: string; created_at: Date }>(
      "SELECT id, email, name, role, created_at FROM users WHERE id = $1",
      [userId],
    );
    const user = userRes.rows[0];
    if (!user) return reply.code(404).send({ error: "not_found" });

    const memberships = await pool.query<{ event_id: string; name: string; state: string; role: string; track_name: string | null }>(
      `SELECT m.event_id, e.name, e.state, m.role, t.name AS track_name
       FROM event_memberships m
       JOIN events e ON e.id = m.event_id
       LEFT JOIN tracks t ON t.id = m.track_id
       WHERE m.user_id = $1
       ORDER BY e.created_at DESC`,
      [userId],
    );

    return reply.view("account.njk", {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: user.created_at ? new Date(user.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "",
      },
      memberships: memberships.rows,
    });
  });
}

export default pageRoutes;
