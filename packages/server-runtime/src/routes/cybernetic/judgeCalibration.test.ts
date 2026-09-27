/**
 * Judge-calibration labels are eval ground truth (Plan 269 D7/D10): the POST
 * route shares the operator-only boundary with the golden-dataset writes — a
 * service-principal (agent) caller is rejected before any read or insert,
 * regardless of its space grants.
 */
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { judgeCalibrationRoutes } from './judgeCalibration.js';

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';

async function buildTestApp(opts: {
  isServicePrincipal: boolean;
  onDbUse: () => void;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      opts.onDbUse();
      return fn({ execute: async () => undefined });
    },
  };
  (app as unknown as { appContext: unknown }).appContext = { db };
  app.decorate('authenticate', async () => undefined);

  app.addHook('onRequest', async (request) => {
    (request as unknown as { authUser: unknown }).authUser = {
      userId: USER_ID,
      authMethod: 'test',
      isServicePrincipal: opts.isServicePrincipal,
    };
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
    });
  });

  await app.register(judgeCalibrationRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return app;
}

describe('judge-calibration label submission — operator-only boundary', () => {
  it('rejects a service-principal caller before touching the database', async () => {
    let dbUsed = false;
    const app = await buildTestApp({ isServicePrincipal: true, onDbUse: () => (dbUsed = true) });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/spaces/${SPACE_ID}/judge-calibration`,
      payload: {
        criterionId: 'insight_quality',
        runId: 'run_1',
        scope: 'goal',
        verdict: 'fail',
        critique: 'The judge passed a fabricated citation.',
        evalSuitePath: '/evals/daily-metrics/suite.json',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'operator_only' });
    expect(dbUsed).toBe(false);
    await app.close();
  });
});
