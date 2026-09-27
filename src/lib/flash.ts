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
 */
export function consumeFlash(req: FastifyRequest): FlashMessage | null {
  const raw = req.session[FLASH_KEY] as Record<string, unknown> | undefined;
  delete req.session[FLASH_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const kind: unknown = raw["kind"];
  const message: unknown = raw["message"];
  if (!isFlashKind(kind)) return null;
  if (typeof message !== "string" || message.length === 0) return null;
  return { kind, message };
}
