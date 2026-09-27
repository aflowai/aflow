/**
 * A local-edition instance resolves one tenant and refuses to be told otherwise.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import sensible from '@fastify/sensible';
import { LOCAL_EDITION_TENANT_ID, type EditionDescriptor } from '@aflow/schemas';
import { tenantPlugin } from './tenant.js';
import type { AuthUser } from './auth.js';

const HOSTED: EditionDescriptor = {
  edition: 'enterprise',
  authProvider: 'auth0',
  tenancy: { mode: 'multi' },
  exposure: { bind: 'any', requireTls: true },
  computeRuntime: 'present',
  codeLane: 'present',
  hostLane: 'absent',
};

const LOCAL: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: LOCAL_EDITION_TENANT_ID },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
};

/** A tenant this instance is never pinned to. */
const OTHER_TENANT = '11111111-2222-4333-8444-555555555555';

const OWNER: AuthUser = {
  userId: '00000000-0000-4000-8000-000000000001' as AuthUser['userId'],
  roles: [],
  authMethod: 'session',
  isServicePrincipal: false,
};

/** Boots the tenant plugin with a stub auth plugin and no database. */
async function boot(edition: EditionDescriptor, authUser: AuthUser = OWNER) {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(
    fp(
      (instance, _o, done: () => void) => {
        instance.decorate('edition', edition);
        done();
      },
      { name: 'edition-plugin' },
    ),
  );
  // `resolveMembershipRole` returns null without a database, so the local
  // edition's owner role must come from somewhere the test can supply.
  app.decorate('appContext', { db: null, redis: null } as never);
  await app.register(sensible);
  await app.register(
    fp(
      (instance, _o, done: () => void) => {
        instance.decorateRequest('authUser', undefined);
        instance.addHook('onRequest', (request, _reply, next) => {
          request.authUser = authUser;
          next();
        });
        done();
      },
      { name: 'auth-plugin' },
    ),
  );
  await app.register(tenantPlugin);

  app.get('/probe', async (request) => {
    const tenant = await request.requireTenant();
    return { tenantId: tenant.tenantId };
  });

  await app.ready();
  return app;
}

describe('tenant resolution under a fixed-tenancy edition', () => {
  it('resolves the pinned tenant with no selector on the request', async () => {
    const app = await boot(LOCAL, { ...OWNER, authMethod: 'dev_bypass' });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: LOCAL_EDITION_TENANT_ID });
  });

  it('accepts a selector that agrees with the instance', async () => {
    const app = await boot(LOCAL, { ...OWNER, authMethod: 'dev_bypass' });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': LOCAL_EDITION_TENANT_ID },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
  });

  it('rejects a header naming another tenant', async () => {
    const app = await boot(LOCAL, { ...OWNER, authMethod: 'dev_bypass' });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': OTHER_TENANT },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/pinned to a single tenant/);
    expect(res.json().message).not.toMatch(/single workspace/);
  });

  it('rejects an API key bound to another tenant', async () => {
    const app = await boot(LOCAL, {
      ...OWNER,
      authMethod: 'api_key',
      apiKeyTenantId: OTHER_TENANT as AuthUser['apiKeyTenantId'],
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('rejects a JWT claim naming another tenant', async () => {
    const app = await boot(LOCAL, {
      ...OWNER,
      authMethod: 'jwt',
      claims: {
        sub: 'x',
        iss: 'x',
        aud: 'x',
        exp: 0,
        iat: 0,
        'https://aflow.ai/tenant_id': OTHER_TENANT,
      },
    });
    const res = await app.inject({ method: 'GET', url: '/probe' });
    await app.close();
    expect(res.statusCode).toBe(400);
  });

  it('rejects a conflicting header even when the API key names the pinned tenant', async () => {
    const app = await boot(LOCAL, {
      ...OWNER,
      authMethod: 'api_key',
      apiKeyTenantId: LOCAL_EDITION_TENANT_ID as AuthUser['apiKeyTenantId'],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': OTHER_TENANT },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    // Only the disagreeing source is named, so the message points at the
    // selector that has to change.
    expect(res.json().message).toMatch(/X-Tenant-ID header/);
    expect(res.json().message).not.toMatch(/API key/);
  });

  it('rejects a conflicting claim even when the header names the pinned tenant', async () => {
    const app = await boot(LOCAL, {
      ...OWNER,
      authMethod: 'jwt',
      claims: {
        sub: 'x',
        iss: 'x',
        aud: 'x',
        exp: 0,
        iat: 0,
        'https://aflow.ai/tenant_id': OTHER_TENANT,
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': LOCAL_EDITION_TENANT_ID },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/tenant claim in the token/);
    expect(res.json().message).not.toMatch(/X-Tenant-ID header/);
  });

  it('names every disagreeing source when more than one conflicts', async () => {
    const app = await boot(LOCAL, {
      ...OWNER,
      authMethod: 'jwt',
      claims: {
        sub: 'x',
        iss: 'x',
        aud: 'x',
        exp: 0,
        iat: 0,
        'https://aflow.ai/tenant_id': OTHER_TENANT,
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': OTHER_TENANT },
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/the X-Tenant-ID header and the tenant claim in the token/);
  });
});

describe('tenant resolution under multi-tenancy', () => {
  it('keeps header precedence over a disagreeing claim', async () => {
    const app = await boot(HOSTED, {
      ...OWNER,
      authMethod: 'dev_bypass',
      claims: {
        sub: 'x',
        iss: 'x',
        aud: 'x',
        exp: 0,
        iat: 0,
        'https://aflow.ai/tenant_id': OTHER_TENANT,
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': LOCAL_EDITION_TENANT_ID },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: LOCAL_EDITION_TENANT_ID });
  });

  it('still requires a selector', async () => {
    const previous = process.env['DEFAULT_TENANT_ID'];
    const previousEnv = process.env['NODE_ENV'];
    delete process.env['DEFAULT_TENANT_ID'];
    process.env['NODE_ENV'] = 'production';
    const app = await boot(HOSTED);
    const res = await app.inject({ method: 'GET', url: '/probe' });
    await app.close();
    if (previous === undefined) delete process.env['DEFAULT_TENANT_ID'];
    else process.env['DEFAULT_TENANT_ID'] = previous;
    if (previousEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousEnv;
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Missing tenant context/);
  });
});
