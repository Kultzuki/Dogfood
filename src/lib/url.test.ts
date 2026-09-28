import { describe, expect, it } from "vitest";
import { isHttpUrl } from "./url.js";

describe("isHttpUrl", () => {
  it("accepts absolute HTTP and HTTPS links only", () => {
    expect(isHttpUrl("https://github.com/team/repo")).toBe(true);
    expect(isHttpUrl("http://localhost:3000/demo")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("//example.com")).toBe(false);
    expect(isHttpUrl("not a URL")).toBe(false);
  });
});
