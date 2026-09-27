/**
 * Resolves which edition this process is, once, and publishes it to every
 * plugin that composes differently because of it.
 *
 * A plugin declaring `dependencies: ['edition-plugin']` cannot be registered
 * into a server that never resolved one — which is what keeps the composition
 * explicit rather than defaulting to the hosted product wherever the decorator
 * happens to be missing.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { resolveEditionDescriptor, type EditionDescriptor } from '@aflow/schemas';

declare module 'fastify' {
  interface FastifyInstance {
    edition: EditionDescriptor;
    /** Surface names this process composed, in registry order. */
    enabledSurfaces: string[];
  }
}

export const editionPlugin = fp(
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature
  async (fastify: FastifyInstance) => {
    fastify.decorate('edition', resolveEditionDescriptor());
  },
  { name: 'edition-plugin' },
);
