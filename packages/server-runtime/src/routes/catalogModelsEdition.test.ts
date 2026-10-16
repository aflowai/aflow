/**
 * A model on the operator's own machine is listed only by the edition that
 * runs on that machine: from the hosted service the same loopback address
 * names the platform's own host, so offering it there offers nothing.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { EditionId } from '@aflow/schemas';
import { catalogRoutes } from './catalog.js';

async function listedModels(edition: EditionId): Promise<string[]> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('edition', { edition } as never);
  app.decorate('authenticate', async () => undefined);
  await app.register(catalogRoutes);
  const res = await app.inject({ method: 'GET', url: '/models?capability=chat' });
  await app.close();
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { models: Array<{ modelId: string }> }).models.map(
    (m) => m.modelId,
  );
}

describe('GET /catalog/models by edition', () => {
  it('lists a model on this computer in the local edition', async () => {
    expect(await listedModels('community-local')).toContain('ollama-gemma4-26b');
  });

  it('does not list it in the hosted edition, and still lists the cloud models', async () => {
    const hosted = await listedModels('enterprise');
    expect(hosted).not.toContain('ollama-gemma4-26b');
    expect(hosted).toContain('accounts/fireworks/models/glm-5p3');
  });
});
