/**
 * The route-level contracts a distribution's own routes build on.
 *
 * `tenantSettingsRoutes` is a registrar a hosted admin surface mounts, and the
 * space registrars are what a hosted sharing test composes an app from; the
 * schemas are response shapes two editions must not describe differently.
 */
export { tenantSettingsRoutes } from './tenant-settings.js';
export { ErrorSchema, MemberResponseSchema, getSpaceOwnerId } from './spacesShared.js';
export { spaceCrudRoutes } from './spaceCrudRoutes.js';
export { spaceLifecycleRoutes } from './spaceLifecycleRoutes.js';
export { spacePolicyRoutes } from './spacePolicyRoutes.js';
