/**
 * The simulation REST surface writes through the shared artifact writer, and
 * nothing else on it writes at all.
 *
 * The invariants that make a stored simulation safe to pin — an endpoint-mode
 * target that exists, a revision the store assigns and bumps under a lock — are
 * enforced in `writeSimulationArtifact`, which the `integration.simulation.*`
 * operation also calls. A route that built its own INSERT would be a second
 * place to enforce them and the first place they would stop being. The check is
 * structural because the pull to "just write the row here" arrives exactly when
 * someone is adding a field to the editor.
 */
import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerSimulationRoutes } from './simulations.js';

interface SeenRoute {
  method: string;
  url: string;
  authz: { resource?: string; action?: string; spaceIdFrom?: string } | undefined;
}

async function collectRoutes(): Promise<SeenRoute[]> {
  const app: FastifyInstance = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const seen: SeenRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      seen.push({
        method,
        url: route.url,
        authz: (route.config as { authz?: SeenRoute['authz'] } | undefined)?.authz,
      });
    }
  });

  registerSimulationRoutes(app);
  await app.ready();
  await app.close();
  return seen;
}

async function source(): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(new URL('./simulations.ts', import.meta.url), 'utf8');
}

describe('simulation REST surface', () => {
  it('exposes only the writes that have a shared writer behind them', async () => {
    // Enumerated rather than counted: the point is not how many writes there
    // are, it is that a new one arrives through review rather than by someone
    // adding an INSERT next to the editor field that needed it.
    const writes = (await collectRoutes()).filter((route) => route.method !== 'GET');

    expect(writes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
      'POST /simulations/:simulationId/baselines',
      'POST /simulations/:simulationId/baselines/freeze',
      'POST /simulations/:simulationId/baselines/restore',
      'PUT /simulations/:simulationId',
    ]);
  });

  it('classifies every route, since an unclassified one is silently unauthorized', async () => {
    for (const route of await collectRoutes()) {
      expect(route.authz, `${route.method} ${route.url} declares no authz`).toEqual({
        resource: 'api_config',
        action: route.method === 'GET' ? 'read' : 'write',
        spaceIdFrom: 'requireSpace',
      });
    }
  });

  it('reaches the store through the shared writer rather than its own INSERT', async () => {
    const src = await source();

    expect(src).toContain('writeSimulationArtifact');
    // The three baseline writes share their writer with the operations too: a
    // version minted here that skipped the carry-forward or the validation
    // would publish a world every later run pins and none can validly extend.
    expect(src).toContain('seedSimulationBaseline');
    expect(src).toContain('freezeSimulationBaseline');
    expect(src).toContain('restoreSimulationBaseline');
    // A revision assigned here would not be the one the operation assigns, and
    // a run pins the revision it started on.
    expect(src).not.toContain('INSERT INTO simulations');
    expect(src).not.toContain('pg_advisory_xact_lock');
    // Minting a baseline version is the shared writer's job, whole.
    expect(src).not.toContain('insert(simulationBaselines)');
    expect(src).not.toContain('insert(simulationEntities)');
  });
});
