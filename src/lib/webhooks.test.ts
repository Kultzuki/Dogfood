/**
 * Webhook helper tests: SSRF guard, retry policy, delivery signing.
 * Hermetic by design — literal-IP lookups resolve locally, no traffic.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  isBlockedIp,
  retryDelayMs,
  signDeliveryBody,
  validateWebhookUrl,
  MAX_DELIVERY_ATTEMPTS,
} from "./webhooks.js";

const savedLoopback = process.env["ALLOW_LOOPBACK_WEBHOOKS"];

beforeEach(() => {
  delete process.env["ALLOW_LOOPBACK_WEBHOOKS"];
});

afterAll(() => {
  if (savedLoopback === undefined) delete process.env["ALLOW_LOOPBACK_WEBHOOKS"];
  else process.env["ALLOW_LOOPBACK_WEBHOOKS"] = savedLoopback;
});

describe("isBlockedIp", () => {
  it("blocks loopback, private, link-local, and unspecified ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "127.9.9.9",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.10.20",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.167.0.1"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
});

describe("validateWebhookUrl", () => {
  it("rejects malformed and non-http URLs without DNS", async () => {
    expect(await validateWebhookUrl("")).toBe("invalid_url");
    expect(await validateWebhookUrl("not-a-url")).toBe("invalid_url");
    expect(await validateWebhookUrl("ftp://example.com/hook")).toBe("invalid_url");
    expect(await validateWebhookUrl("https://user:pass@example.com/")).toBe("invalid_url");
    expect(await validateWebhookUrl("x".repeat(2001))).toBe("invalid_url");
  });
  it("rejects literal-IP loopback/private hosts (local resolution only)", async () => {
    expect(await validateWebhookUrl("http://127.0.0.1:9/hook")).toBe("blocked_host");
    expect(await validateWebhookUrl("http://10.0.0.1/hook")).toBe("blocked_host");
  });
  it("skips DNS only under the explicit loopback affordance", async () => {
    process.env["ALLOW_LOOPBACK_WEBHOOKS"] = "1";
    expect(await validateWebhookUrl("http://127.0.0.1:9/hook")).toBe(null);
  });
});

describe("retry policy + signing", () => {
  it("backs off exponentially and caps attempts", () => {
    expect(retryDelayMs(1)).toBe(5 * 60 * 1000);
    expect(retryDelayMs(2)).toBe(10 * 60 * 1000);
    expect(retryDelayMs(5)).toBe(80 * 60 * 1000);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(5);
  });
  it("signs bodies deterministically (HMAC-SHA256 hex)", () => {
    const got = signDeliveryBody("s3cret", '{"a":1}');
    const want = createHmac("sha256", "s3cret").update('{"a":1}', "utf8").digest("hex");
    expect(got).toBe(want);
  });
});
