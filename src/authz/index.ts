/**
 * Authorization module barrel export.
 *
 * Usage:
 *   import { requireAuth, requireEventRole, ROLES, EVENT_ROLES } from "../authz/index.js";
 *   // or simply:
 *   import { requireAuth } from "../authz/index.js";
 */

// Roles & types
export { ROLES, EVENT_ROLES } from "./roles.js";
export type { Role, EventRole, EventMembership } from "./roles.js";

// Guards
export {
  requireAuth,
  requireEventRole,
  requireTrackScope,
  requireAssignment,
} from "./guards.js";
export type { EventIdResolver, TrackIdResolver } from "./guards.js";
