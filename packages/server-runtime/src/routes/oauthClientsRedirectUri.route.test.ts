/**
 * Both OAuth Apps pages show the redirect URI a provider's console must list.
 * The browser cannot resolve it, so both list reads carry it, and the value is
 * whatever `resolveOAuthCallbackUrl()` returns — the one the CIMD document
 * publishes and consent sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { resolveOAuthCallbackUrl } from '@aflow/oauth';

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  const emptyTx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => unknown) => cb(emptyTx),
  };
});

const { tenantSettingsRoutes } = await import('./tenant-settings.js');
const { registerOAuthClientRoutes } = await import('./integrations/oauth-clients.js');

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {} };
  app.decorate('authenticate', async (): Promise<void> => undefined);
  app.addHook('onRequest', async (request) => {
    const req = request as unknown as {
      requireTenant: () => Promise<unknown>;
      requireSpace: () => Promise<unknown>;
    };
    req.requireTenant = async () => ({ tenantId: TENANT_ID, tenantRole: 'admin', isAdmin: true });
    req.requireSpace = async () => ({ spaceId: SPACE_ID });
  });
  await app.register(tenantSettingsRoutes, { prefix: '/v1/tenant' });
  await app.register(
    async (scope) => {
      registerOAuthClientRoutes(scope);
    },
    { prefix: '/v1/integrations' },
  );
  await app.ready();
  return app;
}

describe('OAuth Apps list reads carry the redirect URI', () => {
  const original = process.env['API_BASE_URL'];
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env['API_BASE_URL'] = 'https://aflow.example.test/';
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (original === undefined) delete process.env['API_BASE_URL'];
    else process.env['API_BASE_URL'] = original;
  });

  it.each([
    ['tenant page', '/v1/tenant/oauth-clients'],
    ['space page', '/v1/integrations/oauth-clients'],
  ])('the %s read returns resolveOAuthCallbackUrl()', async (_page, url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { clients: unknown[]; redirectUri: string };
    expect(body.redirectUri).toBe(resolveOAuthCallbackUrl());
    expect(body.redirectUri).toBe('https://aflow.example.test/v1/oauth/callback');
  });

  it('follows the deployment, as the local edition serves it', async () => {
    delete process.env['API_BASE_URL'];
    const res = await app.inject({ method: 'GET', url: '/v1/tenant/oauth-clients' });
    expect((JSON.parse(res.body) as { redirectUri: string }).redirectUri).toBe(
      'http://localhost:3000/v1/oauth/callback',
    );
  });
});
