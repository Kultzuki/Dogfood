/**
 * Page routes — login page.
 *
 * GET / — renders the login form (login.njk via layout.njk).
 *
 * POST /login has moved to src/routes/auth.ts.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// Ensure @fastify/view type augmentation (reply.view)
import "@fastify/view";
import { requireAuth } from "../authz/guards.js";

async function pageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET / — Login page.
   */
  app.get("/", async (req: FastifyRequest, reply: FastifyReply) => {
    if (typeof req.session.userId === "string" && req.session.userId.length > 0) {
      return reply.code(302).redirect("/gallery");
    }
    const csrfToken = req.csrfToken();
    return reply.view("login.njk", { csrfToken, error: null });
  });

  app.get("/me", { preHandler: [requireAuth] }, async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ userId: req.session.userId ?? null });
  });
}

export default pageRoutes;
