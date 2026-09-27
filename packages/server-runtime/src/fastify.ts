/**
 * The Fastify surface the core plugins add, published as part of the contract.
 *
 * A distribution's routes call `app.authenticate`, read `request.authUser` and
 * `request.requireTenant()`, and reach `app.appContext`. Those are declaration
 * merges (`declare module 'fastify'`) living beside the plugins that install
 * them, and an ambient merge only applies to a program that loads the file it is
 * written in — so a consumer resolving this package's public entry saw a bare
 * `FastifyInstance` and every decorated member as a type error.
 *
 * Re-exporting a type from each module is what carries the merges here: a plain
 * side-effect import is elidable and declaration emit drops it.
 *
 * **A consumer imports this in every file that touches a decorated member.**
 * Loading it once is not enough and a `.d.ts` in the consumer's own sources does
 * not work either — measured, not assumed: one file's errors clear when it adds
 * the import and no other file's do. A missing import fails at compile time
 * naming the member, which is the tolerable version of this cost.
 *
 * Adding a decoration to a core plugin means adding its module here, or the
 * decoration exists for core and does not exist for anyone composing core.
 */
export type { AuthUser, Auth0Claims, AuthPluginOptions } from './plugins/auth.js';
export type { TenantContext } from './plugins/tenant.js';
export type { SpaceContext } from './plugins/space.js';
export type { RouteAuthzConfig, RouteAuthzMetadata } from './plugins/authz.js';
export type { AuditEventInput } from './plugins/audit.js';
export type { AppContext } from './services/context.js';
export { editionPlugin } from './plugins/edition.js';
export { getRequestSpan } from './plugins/tracing.js';
