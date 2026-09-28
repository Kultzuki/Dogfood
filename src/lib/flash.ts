/**
 * Flash messages — one-shot notices carried across PRG (POST → 302 → GET).
 *
 * Flow: a POST handler calls setFlash() then redirects; the shell locals
 * hook consumes the message on the next request and exposes it to templates
 * as `flash`, rendered once by layout.njk inside an aria-live banner.
 *
 * Storage: req.session (server-side, see src/plugins/session.ts), so no
 * message content ever lives in cookies or URLs. Messages are consumed
 * exactly once — consumeFlash() deletes the entry.
 */
import type { FastifyRequest } from "fastify";

export type FlashKind = "success" | "error" | "info";

export interface FlashMessage {
  kind: FlashKind;
  message: string;
}

const FLASH_KEY = "_flash";

function isFlashKind(value: unknown): value is FlashKind {
  return value === "success" || value === "error" || value === "info";
}

/**
 * Stage a flash message on the current session. Overwrites any pending
 * message — one slot is enough for PRG redirects.
 */
export function setFlash(
  req: FastifyRequest,
  kind: FlashKind,
  message: string,
): void {
  if (!isFlashKind(kind)) return;
  if (typeof message !== "string" || message.length === 0) return;
  req.session[FLASH_KEY] = { kind, message } satisfies FlashMessage;
}

/**
 * Take and clear the pending flash message, or null when absent/invalid.
 * Invalid shapes are discarded so a corrupt session value never renders.
 * Cached on the request object so multiple calls on the same request return
 * the consumed message rather than null, while still removing it from session
 * so subsequent HTTP requests will never see it.
 */
export function consumeFlash(req: FastifyRequest): FlashMessage | null {
  const reqAny = req as unknown as { _consumedFlash?: FlashMessage | null };
  if (reqAny && reqAny._consumedFlash !== undefined) {
    return reqAny._consumedFlash;
  }

  const raw = req.session ? (req.session[FLASH_KEY] as Record<string, unknown> | undefined) : undefined;
  if (req.session && FLASH_KEY in req.session) {
    delete req.session[FLASH_KEY];
  }

  if (typeof raw !== "object" || raw === null) {
    if (reqAny) reqAny._consumedFlash = null;
    return null;
  }
  const kind: unknown = raw["kind"];
  const message: unknown = raw["message"];
  if (!isFlashKind(kind)) {
    if (reqAny) reqAny._consumedFlash = null;
    return null;
  }
  if (typeof message !== "string" || message.length === 0) {
    if (reqAny) reqAny._consumedFlash = null;
    return null;
  }
  const result: FlashMessage = { kind, message };
  if (reqAny) reqAny._consumedFlash = result;
  return result;
}

/**
 * Inspect the flash message on the current request without mutating session.
 */
export function getFlash(req: FastifyRequest): FlashMessage | null {
  const reqAny = req as unknown as { _consumedFlash?: FlashMessage | null };
  if (reqAny && reqAny._consumedFlash !== undefined) {
    return reqAny._consumedFlash;
  }
  const raw = req.session ? (req.session[FLASH_KEY] as Record<string, unknown> | undefined) : undefined;
  if (typeof raw !== "object" || raw === null) return null;
  const kind: unknown = raw["kind"];
  const message: unknown = raw["message"];
  if (!isFlashKind(kind) || typeof message !== "string" || message.length === 0) return null;
  return { kind, message };
}
