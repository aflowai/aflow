import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerScheduleRoutes } from './registerRoutes.js';

export const schedulesRoutes: FastifyPluginAsync = (fastify) => {
  fastify.withTypeProvider<ZodTypeProvider>();
  fastify.addHook('preHandler', fastify.authenticate);
  registerScheduleRoutes(fastify);
  return Promise.resolve();
};
