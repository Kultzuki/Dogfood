import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { setFlash, consumeFlash, getFlash } from "./flash.js";

function mockRequest(sessionData: Record<string, unknown> = {}): FastifyRequest {
  return {
    session: sessionData,
  } as unknown as FastifyRequest;
}

describe("Flash Messages", () => {
  it("sets and consumes a flash message exactly once from session", () => {
    const req1 = mockRequest();
    setFlash(req1, "success", "Event created successfully.");
    expect(req1.session["_flash"]).toEqual({
      kind: "success",
      message: "Event created successfully.",
    });

    // Request 1 consumes flash
    const flash1 = consumeFlash(req1);
    expect(flash1).toEqual({
      kind: "success",
      message: "Event created successfully.",
    });
    // Session should be cleared
    expect(req1.session["_flash"]).toBeUndefined();

    // Calling consumeFlash again on the same request returns the cached consumed flash
    const flash1Repeat = consumeFlash(req1);
    expect(flash1Repeat).toEqual(flash1);

    // Calling getFlash on the same request also returns the consumed flash
    expect(getFlash(req1)).toEqual(flash1);

    // Next request with same session (now empty) sees null
    const req2 = mockRequest(req1.session);
    const flash2 = consumeFlash(req2);
    expect(flash2).toBeNull();
  });

  it("handles getFlash without modifying session before consumption", () => {
    const req = mockRequest();
    setFlash(req, "error", "Invalid configuration");
    expect(getFlash(req)).toEqual({
      kind: "error",
      message: "Invalid configuration",
    });
    // Session key is still present
    expect(req.session["_flash"]).toBeDefined();

    // Now consume
    const consumed = consumeFlash(req);
    expect(consumed?.kind).toBe("error");
    expect(req.session["_flash"]).toBeUndefined();
  });

  it("discards invalid flash shapes safely", () => {
    const req = mockRequest({ _flash: { kind: "unknown", message: 123 } });
    expect(consumeFlash(req)).toBeNull();

    const reqEmpty = mockRequest({ _flash: { kind: "info", message: "" } });
    expect(consumeFlash(reqEmpty)).toBeNull();

    const reqNull = mockRequest({ _flash: null });
    expect(consumeFlash(reqNull)).toBeNull();
  });
});
