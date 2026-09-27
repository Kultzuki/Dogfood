/**
 * Offline Ed25519 signing for T4 records (certificates / judge participation).
 *
 * Why Ed25519 and not the HMAC used for sessions: verification must work
 * for the PUBLIC without the secret (T4.3). Anyone holding the public key
 * can verify; only the deployment holding the private key can sign.
 *
 * Key lifecycle: `RECORD_SIGNING_KEY` env (base64 PKCS#8 DER) wins when set;
 * otherwise a keypair is generated once and persisted to
 * `RECORD_KEY_FILE` (default `<cwd>/data/record_ed25519.json`, mode 0600 —
 * `/app/data` in Docker, which is the persisted appdata volume). The env is
 * re-read on every call so tests can isolate keys per case.
 *
 * Limitations (documented, not hidden): single-deploy trust (no PKI —
 * operators distribute the public key out of band); rotating the key
 * invalidates previously issued records (each record pins its `kid`);
 * signatures prove issuance by the key holder, not real-world identity.
 */
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SigningKeypair {
  kid: string;
  publicKeyPem: string;
  sign: (message: string) => string;
}

function kidFor(publicDer: Buffer): string {
  return createHash("sha256").update(publicDer).digest("hex").slice(0, 16);
}

function keyFilePath(): string {
  const override = process.env["RECORD_KEY_FILE"];
  if (override) return override;
  return join(process.cwd(), "data", "record_ed25519.json");
}

function fromPrivateDer(der: Buffer): SigningKeypair {
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const kid = kidFor(publicDer);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return {
    kid,
    publicKeyPem,
    sign: (message: string): string =>
      cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

/** Load (or lazily create) this deployment's record-signing keypair. */
export function getSigningKey(): SigningKeypair {
  const env = process.env["RECORD_SIGNING_KEY"];
  if (env) {
    return fromPrivateDer(Buffer.from(env, "base64"));
  }
  const path = keyFilePath();
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { privateDer?: string };
    if (typeof raw.privateDer === "string") {
      return fromPrivateDer(Buffer.from(raw.privateDer, "base64"));
    }
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ privateDer: der.toString("base64") }), { mode: 0o600 });
  return fromPrivateDer(der);
}

/** Current public key for distribution (JWK-style minimal + PEM). */
export function getPublicKeyInfo(): { kid: string; pem: string } {
  const { kid, publicKeyPem } = getSigningKey();
  return { kid, pem: publicKeyPem };
}

/**
 * Verify a base64 Ed25519 signature over a UTF-8 message with a PEM key.
 * Returns false for any malformed input (never throws on attacker data).
 */
export function verifySignature(
  publicKeyPem: string,
  message: string,
  signatureB64: string,
): boolean {
  try {
    const publicKey = createPublicKey({ key: publicKeyPem, format: "pem" });
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length === 0) return false;
    return cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, sig);
  } catch {
    return false;
  }
}

/** SHA-256 hex digest (content addressing for certificate payloads). */
export function sha256Hex(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}
