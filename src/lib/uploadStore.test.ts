import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  checkFile,
  containsTraversal,
  extFromName,
  sniffKind,
} from "./uploadStore.js";

const pngHead = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const mzHead = Buffer.from([
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
]);

describe("containsTraversal", () => {
  it("flags ascii attacks and encoded slashes", () => {
    expect(containsTraversal("../../etc/passwd")).toBe(true);
    expect(containsTraversal("/abs/path")).toBe(true);
    expect(containsTraversal("a\\b")).toBe(true);
    expect(containsTraversal("a%2fb")).toBe(true);
    expect(containsTraversal("a%5Cb")).toBe(true);
    expect(containsTraversal("plain.png")).toBe(false);
  });

  it("flags unicode slashes", () => {
    for (const u of ["\u2044", "\u2215", "\u29F5", "\uFF0F", "\uFF3C"]) {
      expect(u).toHaveLength(1);
      expect(containsTraversal(`a${u}b`)).toBe(true);
    }
  });
});

describe("extFromName", () => {
  it("takes the extension after the last dot and separator", () => {
    expect(extFromName("photo.png")).toBe("png");
    expect(extFromName("ARCH.JPG")).toBe("jpg");
    expect(extFromName("noext")).toBe(undefined);
    expect(extFromName("a\u2215b.gif")).toBe("gif");
  });
});

describe("sniffKind + checkFile", () => {
  it("accepts a real PNG", () => {
    expect(checkFile(pngHead, "png", "image/png")).toBe(undefined);
  });

  it("rejects a renamed exe (MZ header as .png)", () => {
    expect(sniffKind(mzHead)).toBe(undefined);
    expect(checkFile(mzHead, "png", "image/png")).toBe("invalid_file_type");
  });

  it("rejects MIME↔ext mismatch", () => {
    expect(checkFile(pngHead, "png", "application/x-sh")).toBe("invalid_file_type");
  });

  it("rejects oversize buffers", () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0);
    expect(checkFile(big, "png", "image/png")).toBe("file_too_large");
  });
});
