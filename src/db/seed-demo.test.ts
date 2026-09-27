/**
 * Demo-account seeder contracts (LOCAL / DEMO only).
 *
 * These assert the safety properties that matter, not just shape:
 *   - the gate is fail-closed (anything but "1" disables),
 *   - the roster never collides with the official acceptance fixtures,
 *   - one role per account (no all-powerful demo superuser),
 *   - no account or session token is exposed to the login surface.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEMO_ACCOUNTS,
  DEFAULT_DEMO_PASSWORD,
  demoAccountsEnabled,
  demoPassword,
  banner,
} from "./seed-demo.js";
import { parseFixture } from "./fixtures.js";

function fixtureEmails(): Set<string> {
  const root = process.cwd();
  const p = existsSync(join(root, "stuff", "fixtures.json"))
    ? join(root, "stuff", "fixtures.json")
    : join(root, "..", "stuff", "fixtures.json");
  const fixture = parseFixture(JSON.parse(readFileSync(p, "utf-8")));
  const emails = new Set<string>();
  for (const j of fixture.judges) emails.add(j.email.toLowerCase());
  for (const t of fixture.teams) for (const m of t.members) emails.add(m.toLowerCase());
  return emails;
}

describe("demoAccountsEnabled", () => {
  it("is enabled only by the exact value '1'", () => {
    expect(demoAccountsEnabled({ DOGFOOD_DEMO_ACCOUNTS: "1" })).toBe(true);
  });

  it("is disabled when unset (fail-closed)", () => {
    expect(demoAccountsEnabled({})).toBe(false);
  });

  it.each(["0", "", "true", "yes", "2", " 1", "1 "])(
    "is disabled for DOGFOOD_DEMO_ACCOUNTS=%j",
    (v) => {
      expect(demoAccountsEnabled({ DOGFOOD_DEMO_ACCOUNTS: v })).toBe(false);
    },
  );
});

describe("demoPassword", () => {
  it("defaults to the documented shared password", () => {
    expect(demoPassword({})).toBe(DEFAULT_DEMO_PASSWORD);
    expect(DEFAULT_DEMO_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });

  it("honours an override but rejects a too-short one", () => {
    expect(demoPassword({ DOGFOOD_DEMO_PASSWORD: "LocalOverride1!" })).toBe(
      "LocalOverride1!",
    );
    expect(demoPassword({ DOGFOOD_DEMO_PASSWORD: "short" })).toBe(
      DEFAULT_DEMO_PASSWORD,
    );
  });
});

describe("DEMO_ACCOUNTS roster", () => {
  it("exposes the four documented identities with the intended roles", () => {
    const byEmail = new Map(DEMO_ACCOUNTS.map((a) => [a.email, a.role]));
    expect(byEmail.get("test.organizer@dogfood.local")).toBe("organizer");
    expect(byEmail.get("test.judgea@dogfood.local")).toBe("judge");
    expect(byEmail.get("test.judgeb@dogfood.local")).toBe("judge");
    expect(byEmail.get("test.participant@dogfood.local")).toBe("participant");
    expect(DEMO_ACCOUNTS).toHaveLength(4);
  });

  it("never grants a single account more than one role", () => {
    expect(DEMO_ACCOUNTS.every((a) => typeof a.role === "string")).toBe(true);
    expect(DEMO_ACCOUNTS.filter((a) => a.role === "admin")).toHaveLength(0);
  });

  it("does not collide with any official acceptance fixture identity", () => {
    const fixtures = fixtureEmails();
    for (const a of DEMO_ACCOUNTS) {
      expect(fixtures.has(a.email.toLowerCase())).toBe(false);
    }
  });

  it("does not collide with the seeded admin or fixture organizer", () => {
    const reserved = new Set(["admin@dogfood.local", "organizer@dogfood.local"]);
    for (const a of DEMO_ACCOUNTS) expect(reserved.has(a.email)).toBe(false);
  });
});

describe("banner", () => {
  it("labels the credentials as demo-only and prints every account", () => {
    const text = banner(DEFAULT_DEMO_PASSWORD);
    expect(text).toContain("DEMO TEST ACCOUNTS");
    expect(text).toContain("LOCAL USE ONLY");
    expect(text).toContain("DOGFOOD_DEMO_ACCOUNTS=0");
    for (const a of DEMO_ACCOUNTS) expect(text).toContain(a.email);
  });
});

describe("no backdoor surface", () => {
  it("the seeder mints no session tokens (it only INSERTs users)", () => {
    const src = readFileSync(join(process.cwd(), "src", "db", "seed-demo.ts"), "utf-8");
    expect(src).not.toContain("signSessionValue");
    expect(src).not.toMatch(/INSERT INTO sessions/);
    // The only credential primitive it reaches for is the shared scrypt hasher.
    expect(src).toContain("hashPassword");
  });
});
