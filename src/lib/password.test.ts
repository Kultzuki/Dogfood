/**
 * Unit tests for src/lib/password.ts (vitest).
 *
 * Covers:
 * - hashPassword format and determinism
 * - verifyPassword with correct/wrong password
 * - legacy format support
 * - malformed input handling
 * - timing-safe comparison (same length derived keys)
 */
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  // ── hashPassword ──────────────────────────────────────────────

  describe("hashPassword", () => {
    it("returns scrypt$N$r$p$salt$hash format", async () => {
      const hash = await hashPassword("test-password-123");
      const parts = hash.split("$");
      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe("scrypt");
      expect(parts[1]).toBe("16384"); // N
      expect(parts[2]).toBe("8"); // r
      expect(parts[3]).toBe("1"); // p
      expect(parts[4]).toMatch(/^[0-9a-f]{32}$/); // 16-byte hex salt
      expect(parts[5]).toMatch(/^[0-9a-f]{128}$/); // 64-byte hex hash
    });

    it("produces different hashes for the same password (random salt)", async () => {
      const h1 = await hashPassword("same-password");
      const h2 = await hashPassword("same-password");
      expect(h1).not.toBe(h2);
    });

    it("produces consistent hashes with same salt (via verify roundtrip)", async () => {
      const hash = await hashPassword("roundtrip-test");
      const valid = await verifyPassword("roundtrip-test", hash);
      expect(valid).toBe(true);
    });
  });

  // ── verifyPassword (new format) ───────────────────────────────

  describe("verifyPassword", () => {
    it("returns true for correct password", async () => {
      const hash = await hashPassword("correct-horse-battery-staple");
      expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(
        true,
      );
    });

    it("returns false for wrong password", async () => {
      const hash = await hashPassword("real-password");
      expect(await verifyPassword("wrong-password", hash)).toBe(false);
    });

    it("returns false for empty password", async () => {
      const hash = await hashPassword("not-empty");
      expect(await verifyPassword("", hash)).toBe(false);
    });

    it("returns false for completely malformed string", async () => {
      expect(await verifyPassword("password", "not-a-hash")).toBe(false);
    });

    it("returns false for truncated hash", async () => {
      expect(await verifyPassword("pw", "scrypt$16384$8$1$abc$def")).toBe(
        false,
      );
    });

    it("returns false for wrong N parameter", async () => {
      const hash = await hashPassword("test");
      // Change the N value from 16384 to 32768
      const tampered = hash.replace("16384", "32768");
      expect(await verifyPassword("test", tampered)).toBe(false);
    });

    it("returns false when hash bytes are tampered", async () => {
      const hash = await hashPassword("test");
      const parts = hash.split("$");
      // Flip a hex char in the hash part
      const lastPart = parts[5];
      if (!lastPart) throw new Error("expected hash part");
      const flipped =
        lastPart.slice(0, -1) +
        (lastPart.slice(-1) === "a" ? "b" : "a");
      parts[5] = flipped;
      expect(await verifyPassword("test", parts.join("$"))).toBe(false);
    });
  });

  // ── verifyPassword (legacy format) ────────────────────────────

  describe("verifyPassword (legacy salt:hash)", () => {
    it("returns true for correct password with legacy format", async () => {
      const { scryptSync, randomBytes } = await import("node:crypto");
      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync("legacy-pw", salt, 64).toString("hex");
      const stored = `${salt}:${hash}`;
      expect(await verifyPassword("legacy-pw", stored)).toBe(true);
    });

    it("returns false for wrong password with legacy format", async () => {
      const { scryptSync, randomBytes } = await import("node:crypto");
      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync("legacy-pw", salt, 64).toString("hex");
      const stored = `${salt}:${hash}`;
      expect(await verifyPassword("wrong-pw", stored)).toBe(false);
    });
  });
});
