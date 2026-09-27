/**
 * The shape a composition root contributes, and how a process composes several.
 *
 * A surface carries no tier of its own. Which tier it belongs to is decided by
 * the composition root that lists it, so the two cannot disagree: a route
 * module reaches the server through exactly one root, and that root's `tier` is
 * the answer. The public core builds from `coreComposition` alone and never
 * resolves the hosted modules at all.
 */
import type { FastifyInstance } from 'fastify';
import type { EditionTier } from '@aflow/schemas';

import type { IdentityPlane } from './tokenVerification.js';

import type { buildSpaceActionCenterAggregator } from '../services/actionCenter/buildSpaceAggregator.js';

export interface ServerSurface {
  /** Stable identifier, published by `/v1/users/me` and read by the edition tests. */
  name: string;
  register: (scope: FastifyInstance) => PromiseLike<unknown>;
}

export interface V1SurfaceDeps {
  actionCenterAggregator: ReturnType<typeof buildSpaceActionCenterAggregator> | null;
}

export interface SurfaceTier {
  tier: EditionTier;
  /** Surfaces mounted at the server root rather than under `/v1`. */
  root: ServerSurface[];
  v1: (deps: V1SurfaceDeps) => ServerSurface[];
}

/**
 * The tiers one process serves. Ordered, and composed by filtering on the
 * edition the process resolved — so a hosted artifact run as `community-local`
 * serves the core tier only, while a core artifact has no other tier to drop.
 */
export type SurfaceComposition = readonly SurfaceTier[];

/**
 * Everything a composition root decides.
 *
 * Surfaces are one facet; a distribution also contributes the providers its
 * edition has and core does not. The object grows a field per contract rather
 * than the builder growing a parameter, so adding one does not touch a caller
 * that has nothing to say about it.
 */
export interface ServerComposition {
  tiers: SurfaceComposition;

  /**
   * How this distribution verifies a bearer JWT, where it has a provider.
   *
   * Absent in core, which verifies with a symmetric development secret and
   * refuses a production boot that would rely on it. Supplying one replaces
   * the bearer-token arm of `authenticate` alone — the local instance
   * credential, the development bypass and the API key path are core and are
   * not reached through it.
   */
  identityPlane?: IdentityPlane | undefined;
}
