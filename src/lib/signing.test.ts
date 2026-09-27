/**
 * Ed25519 record-signing tests (pure, offline). Each case isolates its key
 * via RECORD_SIGNING_KEY so no key file is touched and cases cannot leak.
 */
import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  getPublicKeyInfo,
  getSigningKey,
  sha256Hex,
  verifySignature,
} from "./signing.js";

const savedKey = process.env["RECORD_SIGNING_KEY"];
const savedFile = process.env["RECORD_KEY_FILE"];

function freshKeyEnv(): void {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  process.env["RECORD_SIGNING_KEY"] = der.toString("base64");
  delete process.env["RECORD_KEY_FILE"];
}

beforeEach(() => {
  freshKeyEnv();
});

afterAll(() => {
  if (savedKey === undefined) delete process.env["RECORD_SIGNING_KEY"];
  else process.env["RECORD_SIGNING_KEY"] = savedKey;
  if (savedFile === undefined) delete process.env["RECORD_KEY_FILE"];
  else process.env["RECORD_KEY_FILE"] = savedFile;
});

describe("ed25519 record signing", () => {
  it("signs and verifies a roundtrip", () => {
    const key = getSigningKey();
    const sig = key.sign("hello-records");
    expect(verifySignature(key.publicKeyPem, "hello-records", sig)).toBe(true);
  });
  it("fails cleanly for tampered messages", () => {
    const key = getSigningKey();
    const sig = key.sign('{"v":1}');
    expect(verifySignature(key.publicKeyPem, '{"v":2}', sig)).toBe(false);
  });
  it("fails with the wrong key and with garbage inputs", () => {
    const key = getSigningKey();
    const sig = key.sign("msg");
    freshKeyEnv();
    const other = getSigningKey();
    expect(other.kid).not.toBe(key.kid);
    expect(verifySignature(other.publicKeyPem, "msg", sig)).toBe(false);
    expect(verifySignature(key.publicKeyPem, "msg", "!!!not-base64!!!")).toBe(false);
    expect(verifySignature("not-a-pem", "msg", sig)).toBe(false);
    expect(verifySignature(key.publicKeyPem, "msg", "")).toBe(false);
  });
  it("pins a stable kid to its public key", () => {
    const a = getPublicKeyInfo();
    const b = getPublicKeyInfo();
    expect(a.kid).toBe(b.kid);
    expect(a.pem).toContain("PUBLIC KEY");
  });
  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
