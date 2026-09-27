/**
 * Webhook retry regression tests: failed rows must be re-selected with
 * backoff and eventually go dead. Hermetic — mock PoolLike query spy only.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_DELIVERY_ATTEMPTS,
  dueDeliveries,
  markFailed,
  retryDelayMs,
} from "./webhooks.js";
import type { PoolLike } from "./audit.js";

function mockDb(impl?: (text: string, values?: unknown[]) => unknown) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const db = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const r = impl?.(text, values);
      if (r !== undefined) return r as { rows: unknown[] };
      return { rows: [] };
    }),
  } as unknown as PoolLike & { query: ReturnType<typeof vi.fn> };
  return { db, calls };
}

describe("retryDelayMs", () => {
  it("backs off 5m doubling to 80m", () => {
    expect(retryDelayMs(1)).toBe(5 * 60 * 1000);
    expect(retryDelayMs(2)).toBe(10 * 60 * 1000);
    expect(retryDelayMs(3)).toBe(20 * 60 * 1000);
    expect(retryDelayMs(4)).toBe(40 * 60 * 1000);
    expect(retryDelayMs(5)).toBe(80 * 60 * 1000);
  });
  it("enforces MAX_DELIVERY_ATTEMPTS=5", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
  });
});

describe("dueDeliveries", () => {
  it("selects pending AND failed rows whose next_retry_at is due", async () => {
    const { db, calls } = mockDb(() => ({ rows: [] }));
    await dueDeliveries(db, 10);
    expect(calls).toHaveLength(1);
    const sql = calls[0]!.text;
    expect(sql).toContain("IN ('pending', 'failed')");
    expect(sql).toContain("d.next_retry_at <= now()");
    expect(sql).toContain("JOIN webhook_subscriptions");
    expect(sql).toContain("ORDER BY d.created_at");
    expect(calls[0]!.values).toEqual([10]);
  });
  it("returns delivery rows to the caller", async () => {
    const row = { id: "d1", attempts: 2 };
    const { db } = mockDb(() => ({ rows: [row] }));
    const out = await dueDeliveries(db, 5);
    expect(out).toEqual([row]);
  });
});

describe("markFailed", () => {
  it("keeps backoff: failed status with next_retry_at secs", async () => {
    const { db, calls } = mockDb(() => ({ rows: [] }));
    await markFailed(db, "d1", 1, "http_500");
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(text).toContain("status = 'failed'");
    expect(text).toContain("next_retry_at = now() + make_interval(secs => $4)");
    // attempts 1 -> next 2 -> 10min = 600s
    expect(values).toEqual(["d1", 2, "http_500", retryDelayMs(2) / 1000]);
    expect(values![3]).toBe(600);
  });
  it("goes dead at MAX attempts without a next_retry_at", async () => {
    const { db, calls } = mockDb(() => ({ rows: [] }));
    await markFailed(db, "d1", MAX_DELIVERY_ATTEMPTS - 1, "timeout");
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0]!;
    expect(text).toContain("status = 'dead'");
    expect(text).not.toContain("next_retry_at");
    expect(values).toEqual(["d1", 5, "timeout"]);
  });
  it("stays dead past the cap", async () => {
    const { db, calls } = mockDb(() => ({ rows: [] }));
    await markFailed(db, "d1", 7, "http_500");
    const { text, values } = calls[0]!;
    expect(text).toContain("status = 'dead'");
    expect(values![1]).toBe(8);
  });
});
