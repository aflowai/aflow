import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { resolveOAuthCallbackUrl, resolveCimdDocumentUrl } from '@aflow/oauth';
import { resolveWebBaseUrlOrNull } from '@aflow/lib';

const CimdDocumentSchema = z.object({
  client_id: z.string().url(),
  client_name: z.string(),
  client_uri: z.string().url(),
  redirect_uris: z.array(z.string().url()),
  grant_types: z.array(z.string()),
  response_types: z.array(z.string()),
  token_endpoint_auth_method: z.string(),
  scope: z.string().optional(),
  logo_uri: z.string().url().optional(),
});

export const cimdRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Shown on the authorization server's consent screen as who is asking. Every
  // other URL in this document is resolved from where this instance actually
  // runs, and a self-hosted one naming the hosted product would be asking for
  // consent under someone else's identity.
  //
  // Where no web origin is declared, this falls back to the origin serving the
  // document rather than refusing: an instance that names itself by its API is
  // still naming itself, and an unauthenticated document an authorization
  // server fetches mid-consent is the wrong place to raise a configuration
  // gap. Resolved once so the answer cannot vary between requests.
  const clientUri =
    process.env['PLATFORM_URL'] ??
    resolveWebBaseUrlOrNull() ??
    new URL(resolveCimdDocumentUrl()).origin;

  app.get(
    '/cimd',
    {
      schema: {
        tags: ['Integrations'],
        summary: 'Phoenix Client ID Metadata Document (SEP-991, OAuth 2.1)',
        response: { 200: CimdDocumentSchema },
      },
    },
    async (_request, reply) => {
      const doc = {
        client_id: resolveCimdDocumentUrl(),
        client_name: 'Phoenix Aflow',
        client_uri: clientUri,
        redirect_uris: [resolveOAuthCallbackUrl()],
        // OAuth 2.1 + PKCE; no implicit, no client_credentials here (those
        // are server-to-server, not consent-based).
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // SEP-991 PKCE clients are public: no secret at the token endpoint.
        token_endpoint_auth_method: 'none',
        ...(process.env['CIMD_LOGO_URI'] ? { logo_uri: process.env['CIMD_LOGO_URI'] } : {}),
      };
      reply.header('content-type', 'application/json');
      // Allow ASes to cache. The doc only changes when the platform base URL
      // moves (rare) — a 1h cache balances freshness with AS load.
      reply.header('cache-control', 'public, max-age=3600');
      reply.send(doc);
    },
  );
};
