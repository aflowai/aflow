/**
 * The core helpers a distribution's routes compose with.
 *
 * Curated, not a barrel over the directory: every symbol here is one a private
 * distribution was measured to need, and adding one is a deliberate widening of
 * a published interface. Everything else under `lib/` stays internal.
 */
export { recordAdminAudit } from './adminAudit.js';
export { clientIp } from './clientIp.js';
export { classifyDbError, databaseErrorText } from './databaseErrors.js';
export { BadRequestError } from './errors.js';
export {
  consumeInviteRequestRateLimit,
  inviteRequestEmailRateLimitKey,
} from './rateLimitPolicy.js';
export { assertSessionSpaceAccess } from './sessionSpaceAccess.js';
export { readBooleanClaim, readClaim, readStringClaim } from './tokenClaims.js';
