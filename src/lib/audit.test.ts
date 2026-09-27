import { describe, expect, it } from "vitest";
import {
  appendAudit,
  appendAuditForRequest,
  canonicalJson,
  verifyChain,
  type AuditRow,
  type PoolLike,
} from "./audit.js";

/** In-memory PoolLike honoring the two queries appendAudit issues. */
function fakePool(): PoolLike & { table: AuditRow[] } {
  const table: AuditRow[] = [];
  return {
    table,
    async query(text: string, values?: unknown[]) {
      if (text.startsWith("SELECT hash")) {
        const last = table[table.length - 1];
        return { rows: (last ? [{ hash: last.hash }] : []) as AuditRow[] };
      }
      const v = values as unknown[];
      const row: AuditRow = {
        id: `id-${table.length + 1}`,
        seq: table.length + 1,
        event_id: v[0] as string | null,
        track_id: v[1] as string | null,
        actor_user_id: v[2] as string | null,
        action: v[3] as string,
        resource_type: v[4] as string,
        resource_id: v[5] as string,
        detail: JSON.parse(v[6] as string) as unknown,
        prev_hash: v[7] as string,
        hash: v[8] as string,
        created_at: v[9] as string,
      };
      table.push(row);
      return { rows: [row] };
    },
  };
}

describe("canonicalJson", () => {
  it("sorts keys and keeps numbers as-is", () => {
    expect(canonicalJson({ b: 1, a: { d: 2.5, c: [3, 1] } })).toBe(
      '{"a":{"c":[3,1],"d":2.5},"b":1}',
    );
    expect(canonicalJson({ n: 0.1 + 0.2 })).toBe(
      `{"n":${JSON.stringify(0.1 + 0.2)}}`,
    );
  });
});

describe("appendAudit + verifyChain", () => {
  it("starts from GENESIS and verifies a clean chain", async () => {
    const pool = fakePool();
    const first = await appendAudit(pool, {
      eventId: "e1",
      action: "event.finalize",
      resourceType: "event",
      resourceId: "e1",
    });
    expect(first.prev_hash).toBe("GENESIS");
    await appendAudit(pool, {
      eventId: "e1",
      actorUserId: "u1",
      action: "score.submit",
      resourceType: "score",
      resourceId: "s1",
      detail: { total: 42 },
    });
    expect(verifyChain(pool.table)).toEqual({ ok: true });
  });

  it("detects a tampered row (fork) at its seq", async () => {
    const pool = fakePool();
    await appendAudit(pool, {
      eventId: "e1",
      action: "rubric.create",
      resourceType: "rubric",
      resourceId: "r1",
    });
    await appendAudit(pool, {
      eventId: "e1",
      action: "score.submit",
      resourceType: "score",
      resourceId: "s9",
      detail: { total: 7 },
    });
    const tampered: AuditRow[] = pool.table.map((r) => ({ ...r }));
    const target = tampered[1] as AuditRow;
    tampered[1] = { ...target, detail: { total: 100 } };
    expect(verifyChain(tampered)).toEqual({ ok: false, badSeq: 2 });
  });

  it("detects a rewired prev_hash link", async () => {
    const pool = fakePool();
    await appendAudit(pool, {
      eventId: null,
      action: "admin.action",
      resourceType: "user",
      resourceId: "u2",
    });
    await appendAudit(pool, {
      eventId: null,
      action: "event.publish",
      resourceType: "event",
      resourceId: "e2",
    });
    const rewired: AuditRow[] = pool.table.map((r) => ({ ...r }));
    const second = rewired[1] as AuditRow;
    rewired[1] = { ...second, prev_hash: "GENESIS" };
    expect(verifyChain(rewired).ok).toBe(false);
  });

  it("holds an advisory lock around prev-read plus insert when connect exists", async () => {
    const base = fakePool();
    const seen: string[] = [];
    const passthrough = async (text: string, values?: unknown[]) => {
      seen.push(text);
      if (
        values === undefined &&
        (text === "BEGIN" ||
          text === "COMMIT" ||
          text.includes("pg_advisory_xact_lock"))
      )
        return { rows: [] as AuditRow[] };
      return base.query(text, values);
    };
    const lockingPool: PoolLike = {
      query: passthrough,
      async connect() {
        return {
          query: passthrough,
          release: () => undefined,
        };
      },
    };
    await appendAudit(lockingPool, {
      eventId: "e1",
      action: "score.submit",
      resourceType: "score",
      resourceId: "s1",
    });
    await appendAudit(lockingPool, {
      eventId: "e1",
      action: "score.submit",
      resourceType: "score",
      resourceId: "s2",
    });
    expect(verifyChain(base.table).ok).toBe(true);
    const lockIdx = seen.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const firstRead = seen.findIndex((s) => s.startsWith("SELECT hash"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(firstRead).toBeGreaterThan(lockIdx);
    expect(seen.filter((s) => s === "BEGIN").length).toBe(2);
    expect(seen.filter((s) => s === "COMMIT").length).toBe(2);
  });

  it("appendAuditForRequest binds the actor from the session", async () => {
    const pool = fakePool();
    const row = await appendAuditForRequest(
      pool,
      { session: { userId: "u9" } },
      { eventId: null, action: "admin.action", resourceType: "user", resourceId: "u9" },
    );
    expect(row.actor_user_id).toBe("u9");
    await expect(
      appendAuditForRequest(
        pool,
        { session: {} },
        { eventId: null, action: "admin.action", resourceType: "user", resourceId: "u9" },
      ),
    ).rejects.toThrow("audit_actor_missing");
  });
});
