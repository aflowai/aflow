/**
 * @aflow/server-runtime — what the API server is, for the applications that
 * compose it.
 *
 * An application here is a process entry point: it loads its environment,
 * decides its composition, and owns its own lifetime. Everything else — the
 * factory, the core surfaces, the plugins, the routes and the contracts a
 * distribution contributes against — lives here, so two applications cannot
 * drift into two servers.
 *
 * The export map is deliberately small. Internal modules stay internal: this
 * is a supported composition interface, not an SDK over the engine's insides,
 * and it is versioned with the core release rather than independently.
 *
 * @packageDocumentation
 */

export { buildApp } from './app.js';
export { serve, closeOnSignal, type ServeOptions } from './serve.js';

export { coreComposition, coreSurfaceTier } from './compose/coreSurfaces.js';
export type {
  ServerComposition,
  ServerSurface,
  SurfaceTier,
  SurfaceComposition,
  V1SurfaceDeps,
} from './compose/surfaceTier.js';

export {
  developmentTokenVerification,
  type ConfigViolation,
  type EmailVerificationInput,
  type IdentityPlane,
  type TokenProfile,
  type TokenVerification,
} from './compose/tokenVerification.js';

export { resolveListenHost } from './lib/listenHost.js';
