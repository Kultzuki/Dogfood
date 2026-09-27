/**
 * Health routes.
 *
 * GET /healthz — always returns 200 { status: 'ok', uptime }.
 *                No DB dependency; liveness probe.
 *
 * GET /readyz  — checks DB reachability via SELECT 1.
 *                200 { status: 'ready' } if reachable.
 *                503 { status: 'not-ready' } if unreachable or no DB configured.
 */
import type { FastifyInstance } from "fastify";
import { ROLES } from "../authz/index.js";

async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness — always succeeds.
   */
  app.get("/healthz", async (_req, reply) => {
    return reply.code(200).send({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  /**
   * Readiness — requires a reachable database.
   */
  app.get("/readyz", async (_req, reply) => {
    const db = (app as unknown as Record<string, unknown>)["db"] as
      | { query: (sql: string) => Promise<unknown> }
      | undefined;

    if (db) {
      try {
        await db.query("SELECT 1");
        return reply.code(200).send({ status: "ready" });
      } catch {
        return reply.code(503).send({ status: "not-ready" });
      }
    }

    // No pool decorated — try connecting via DATABASE_URL
    const url = process.env.DATABASE_URL;
    if (!url) {
      return reply.code(503).send({ status: "not-ready" });
    }

    try {
      // Dynamic import to avoid hard dependency if pg is not installed
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      await pool.end();
      return reply.code(200).send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "not-ready" });
    }
  });
}

export default healthRoutes;
