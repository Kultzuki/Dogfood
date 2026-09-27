import { describe, expect, it } from "vitest";
import { _clearRateLimitBuckets, rateLimit } from "./rateLimit.js";

function fakeReq(ip: string, xff?: string) {
  return {
    routeOptions: { url: "/register" },
    url: "/register",
    headers: xff ? { "x-forwarded-for": xff } : {},
    ip,
  } as never;
}

function fakeReply() {
  const state = { code: 0, headers: {} as Record<string, number> };
  return {
    state,
    header(k: string, v: number) {
      state.headers[k] = v;
    },
    code(c: number) {
      state.code = c;
      return this;
    },
    async send(_b: unknown) {
      return undefined;
    },
  } as never;
}

describe("rateLimit", () => {
  it("allows requests under the limit", async () => {
    _clearRateLimitBuckets();
    const guard = rateLimit(2, 60_000);
    for (let i = 0; i < 2; i += 1) {
      const reply = fakeReply();
      await guard(fakeReq("9.9.9.9"), reply);
      expect((reply as unknown as { state: { code: number } }).state.code).toBe(0);
    }
  });

  it("returns 429 with retry-after once over the limit", async () => {
    _clearRateLimitBuckets();
    const guard = rateLimit(2, 60_000);
    await guard(fakeReq("8.8.8.8"), fakeReply());
    await guard(fakeReq("8.8.8.8"), fakeReply());
    const reply = fakeReply();
    await guard(fakeReq("8.8.8.8"), reply);
    const state = (reply as unknown as { state: { code: number; headers: Record<string, number> } }).state;
    expect(state.code).toBe(429);
    expect(state.headers["retry-after"]).toBeGreaterThan(0);
  });

  it("ignores X-Forwarded-For unless TRUST_PROXY=1", async () => {
    _clearRateLimitBuckets();
    delete process.env.TRUST_PROXY;
    const guard = rateLimit(1, 60_000);
    await guard(fakeReq("7.7.7.7", "spoofed"), fakeReply());
    const reply = fakeReply();
    await guard(fakeReq("7.7.7.7", "other-spoof"), reply);
    expect((reply as unknown as { state: { code: number } }).state.code).toBe(429);
  });
});
