/**
 * Password hashing and verification using Node.js crypto scrypt.
 *
 * Format: scrypt$N$r$p$salt$hash
 * Defaults: N=16384, r=8, p=1, 64-byte derived key.
 * Verification uses timingSafeEqual for constant-time comparison.
 * Also supports legacy salt:hash format for backward compatibility.
 */
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import type { BinaryLike, ScryptOptions } from "node:crypto";

/**
 * Promisified scrypt that correctly handles the options parameter.
 * util.promisify(scrypt) only handles the 3-arg overload, so we wrap manually.
 */
function scryptAsync(
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options?: ScryptOptions,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const cb = (err: Error | null, derivedKey: Buffer): void => {
      if (err) reject(err);
      else resolve(derivedKey);
    };
    if (options) {
      scrypt(password, salt, keylen, options, cb);
    } else {
      scrypt(password, salt, keylen, cb);
    }
  });
}

const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

/**
 * Hash a password with scrypt.
 * Returns format: scrypt$N$r$p$salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
  })) as Buffer;
  const hash = derivedKey.toString("hex");
  return `scrypt$${N}$${r}$${p}$${salt}$${hash}`;
}

/**
 * Verify a password against a stored hash.
 * Supports new format (scrypt$N$r$p$salt$hash) and legacy format (salt:hash).
 * Returns false for any malformed input.
 * Always performs the same work for both paths to prevent timing leaks.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    if (stored.startsWith("scrypt$")) {
      const parts = stored.split("$");
      if (parts.length !== 6) return false;

      const [, nStr, rStr, pStr, salt, expectedHash] = parts;
      if (!nStr || !rStr || !pStr || !salt || !expectedHash) return false;

      const paramN = parseInt(nStr, 10);
      const paramR = parseInt(rStr, 10);
      const paramP = parseInt(pStr, 10);

      if (isNaN(paramN) || isNaN(paramR) || isNaN(paramP)) return false;

      const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH, {
        N: paramN,
        r: paramR,
        p: paramP,
      })) as Buffer;

      const expectedBuf = Buffer.from(expectedHash, "hex");
      if (derivedKey.length !== expectedBuf.length) return false;

      return timingSafeEqual(derivedKey, expectedBuf);
    }

    // Legacy format: salt:hash
    if (stored.includes(":")) {
      const colonIdx = stored.indexOf(":");
      const salt = stored.slice(0, colonIdx);
      const expectedHash = stored.slice(colonIdx + 1);
      if (!salt || !expectedHash) return false;

      const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
      const expectedBuf = Buffer.from(expectedHash, "hex");
      if (derivedKey.length !== expectedBuf.length) return false;

      return timingSafeEqual(derivedKey, expectedBuf);
    }

    return false;
  } catch {
    return false;
  }
}
