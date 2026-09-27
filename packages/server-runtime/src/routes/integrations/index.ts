import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerDefinitionRoutes } from './definitions.js';
import { registerBindingRoutes } from './bindings.js';
import { registerCredentialRoutes } from './credentials.js';
import { registerMcpServerRoutes } from './mcp-servers.js';
import { registerMcpBindingRoutes } from './mcp-bindings.js';
import { registerMcpOauthRoutes } from './mcp-oauth.js';
import { registerApiOauthRoutes } from './api-oauth.js';
import { registerRepoBindingRoutes } from './repoBindings.js';
import { registerOAuthClientRoutes } from './oauth-clients.js';
import { registerSimulationRoutes } from './simulations.js';

export const integrationsRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', app.authenticate);

  registerDefinitionRoutes(fastify);
  registerBindingRoutes(fastify);
  registerCredentialRoutes(fastify);
  registerMcpServerRoutes(fastify);
  registerMcpBindingRoutes(fastify);
  registerMcpOauthRoutes(fastify);
  registerApiOauthRoutes(fastify);
  registerRepoBindingRoutes(fastify);
  registerOAuthClientRoutes(fastify);
  registerSimulationRoutes(fastify);
};
