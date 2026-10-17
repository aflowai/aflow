/**
 * The models on this computer are the local edition's, and the actions on them
 * reach only a model the catalog says runs there.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { EditionId } from '@aflow/schemas';

const connected = vi.hoisted(() => ({ value: true }));

vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    resolveSpaceLocalRuntime: async () =>
      connected.value
        ? {
            config: {},
            client: {},
            runtimeId: 'this-machine:11434',
            credential: { id: 'c', scope: 'user', scopeId: 'u' },
            hostMachine: undefined,
            hostname: undefined,
          }
        : null,
  };
});

const { localModelRoutes } = await import('./localModels.js');

const SPACE = '00000000-0000-0000-0000-0000000000a1';

async function post(edition: EditionId, payload: Record<string, unknown>) {
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
    url: `/${SPACE}/local-models/actions`,
    payload,
  });
  await app.close();
  return res;
}

describe('POST /spaces/:spaceId/local-models/actions', () => {
  it('is refused in the hosted edition', async () => {
    const res = await post('enterprise', { action: 'warm', model: 'gemma-local' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('local edition');
  });

  it('refuses a model that does not run on this computer', async () => {
    connected.value = true;
    const res = await post('community-local', { action: 'warm', model: 'glm-pro' });
    expect(res.statusCode).toBe(400);
  });

  it('says where to add a connection when the space has none', async () => {
    connected.value = false;
    const res = await post('community-local', { action: 'warm', model: 'gemma-local' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Ollama connection');
  });

  it('refuses an action the schema does not carry', async () => {
    connected.value = true;
    const res = await post('community-local', { action: 'reboot', model: 'gemma-local' });
    expect(res.statusCode).toBe(400);
  });
});
