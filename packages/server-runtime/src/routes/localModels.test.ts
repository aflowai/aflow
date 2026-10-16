/**
 * Loading and unloading a model on this computer is the local edition's, and
 * only for a model the catalog says runs there.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { EditionId } from '@aflow/schemas';
import { localModelRoutes } from './localModels.js';

const SPACE = '00000000-0000-0000-0000-0000000000a1';

async function post(edition: EditionId, model: string) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('edition', { edition } as never);
  (app as unknown as { appContext: unknown }).appContext = { db: {}, redis: undefined };
  app.decorateRequest('requireTenant', async () => ({ tenantId: 't' }) as never);
  app.decorateRequest('requireSpace', async () => ({ spaceId: SPACE }) as never);
  await app.register(localModelRoutes);
  const res = await app.inject({
    method: 'POST',
    url: `/${SPACE}/local-models/warm`,
    payload: { model },
  });
  await app.close();
  return res;
}

describe('POST /spaces/:spaceId/local-models/:action', () => {
  it('is refused in the hosted edition', async () => {
    const res = await post('enterprise', 'gemma-local');
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('local edition');
  });

  it('refuses a model that does not run on this computer', async () => {
    const res = await post('community-local', 'glm-pro');
    expect(res.statusCode).toBe(400);
  });
});
