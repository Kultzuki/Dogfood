import type { FastifyRequest, FastifyReply } from "fastify";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5000;

function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function clientKey(req: FastifyRequest): string {
  // Only trust X-Forwarded-For behind an explicitly configured proxy;
  // otherwise any client can spoof the key and bypass the throttle.
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"];
    const first =
      typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : "";
    if (first) return first;
  }
  return req.ip || "unknown";
}

export function rateLimit(maxHits: number, windowMs: number) {
  return async function rateLimitGuard(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = `${req.routeOptions.url ?? req.url}:${clientKey(req)}`;
    const now = Date.now();
    if (buckets.size >= MAX_BUCKETS) sweepExpired(now);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > maxHits) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      reply.header("retry-after", retryAfter);
      await reply.code(429).send({ error: "rate_limited" });
    }
  };
}

export function _clearRateLimitBuckets(): void {
  buckets.clear();
}
