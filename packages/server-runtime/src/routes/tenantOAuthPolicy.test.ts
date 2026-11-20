/**
 * PATCH /tenant/oauth-policy takes only a Default OAuth app the edition can
 * satisfy. Local bootstrap moves a stored default onto Tenant on every start,
 * and that undoes no operator choice only while this route refuses the rest.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { EditionId, TenantId } from '@aflow/schemas';
import { tenantSettingsRoutes } from './tenant-settings.js';

interface PatchResult {
  statusCode: number;
  body: { policy?: { defaultClientScope: string }; message?: string };
  written: Array<Record<string, unknown>>;
}

async function patchPolicy(
  edition: EditionId,
  body: Record<string, unknown>,
): Promise<PatchResult> {
  const written: Array<Record<string, unknown>> = [];
  const db = {
    update: () => ({
      set: (updates: Record<string, unknown>) => {
        written.push(updates);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  oauthDefaultOwnerScope: 'space',
                  oauthDefaultClientScope: updates['oauthDefaultClientScope'] ?? 'tenant',
                  oauthAllowUserSelfConnect: true,
                },
              ]),
          }),
        };
      },
    }),
  };
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db };
  app.decorate('edition', { edition } as never);
  app.decorate('authenticate', async () => undefined);
  app.decorateRequest('requireTenant', function (this: FastifyRequest) {
    return Promise.resolve({
      tenantId: 'a0000000-0000-4000-8000-000000000001' as TenantId,
      tenantRole: 'admin',
      isAdmin: true,
    });
  });
  await app.register(tenantSettingsRoutes, { prefix: '/tenant' });
  const res = await app.inject({ method: 'PATCH', url: '/tenant/oauth-policy', payload: body });
  await app.close();
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as PatchResult['body'], written };
}

describe('PATCH /tenant/oauth-policy by edition', () => {
  it('refuses a space or platform default in the local edition and writes nothing', async () => {
    for (const defaultClientScope of ['space', 'platform']) {
      const res = await patchPolicy('community-local', { defaultClientScope });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toContain(`cannot be "${defaultClientScope}"`);
      expect(res.body.message).toContain('Choose "tenant"');
      expect(res.written).toEqual([]);
    }
  });

  it('takes the tenant default in the local edition', async () => {
    const res = await patchPolicy('community-local', { defaultClientScope: 'tenant' });
    expect(res.statusCode).toBe(200);
    expect(res.body.policy?.defaultClientScope).toBe('tenant');
  });

  it('takes a patch that leaves the default alone in the local edition', async () => {
    const res = await patchPolicy('community-local', { allowUserSelfConnect: false });
    expect(res.statusCode).toBe(200);
    expect(res.written[0]).not.toHaveProperty('oauthDefaultClientScope');
  });

  it('takes a space default in the hosted edition', async () => {
    const res = await patchPolicy('enterprise', { defaultClientScope: 'space' });
    expect(res.statusCode).toBe(200);
    expect(res.written[0]?.['oauthDefaultClientScope']).toBe('space');
  });
});
