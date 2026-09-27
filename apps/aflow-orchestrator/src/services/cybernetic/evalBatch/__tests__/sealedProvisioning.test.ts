/**
 * What the fixture space receives, and what the trial is then pinned to.
 *
 * Both properties here cost a whole eval batch before they were tests. Neither
 * is visible to a type-check: one pinned a version that existed and was empty,
 * the other wrote a binding the loader could not parse — and an unparseable
 * binding is not reported as invalid, it is reported as ABSENT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockWriteArtifact = vi.fn();
const mockSeedBaseline = vi.fn();
vi.mock('@aflow/cybernetic-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/cybernetic-runtime')>();
  return {
    ...actual,
    writeSimulationArtifact: (...a: unknown[]) => mockWriteArtifact(...a),
    seedSimulationBaseline: (...a: unknown[]) => mockSeedBaseline(...a),
  };
});

const inserted: Array<Record<string, unknown>> = [];
const HOME_EGRESS = { allowedHosts: ['api.bnpl.example.com'], allowedMethods: ['GET'] };

/**
 * A drizzle-shaped stub: the production reads are `select().from().where()` and
 * the writes `insert().values()`, so the double answers by call ORDER, which is
 * the order `readHomeArtifacts` issues them in.
 */
function stubTx(rows: unknown[][]) {
  let read = 0;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows[read++] ?? []),
    then: (resolve: (v: unknown) => unknown) => resolve(rows[read++] ?? []),
    insert: () => chain,
    values: (v: Record<string, unknown>) => {
      inserted.push(v);
      return {
        onConflictDoNothing: () => Promise.resolve(undefined),
        then: (r: (v: unknown) => unknown) => r(undefined),
      };
    },
  };
  return chain;
}

vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => Promise<unknown>) =>
      cb(
        stubTx([
          [
            {
              name: 'Northwind Pay core',
              definitionJson: { baseUrl: 'https://api.bnpl.example.com' },
            },
          ],
          [{ definitionJson: SIMULATION }],
          [{ version: 3 }, { version: 7 }],
          [{ collection: 'purchases', bodyJson: { purchaseId: 'pur_1' } }],
          [{ egressPolicyJson: HOME_EGRESS }],
        ]),
      ),
  };
});

const SIMULATION = {
  simulationId: 'bnpl-desk',
  revision: 4,
  name: 'Desk',
  targets: { sourceKind: 'api', integrationId: 'bnpl-core' },
  collections: [
    {
      collection: 'purchases',
      identityField: 'purchaseId',
      ownership: 'shared',
      schema: { type: 'object', properties: { purchaseId: { type: 'string' } } },
    },
  ],
  personas: [{ personaId: 'cus_99' }],
  rules: [],
  handlers: {},
  effects: {},
  policy: { unmatched: 'generate', maxGeneratedCallsPerRun: 20 },
};

const { provisionSealedBindings } = await import('../sealedBindings.js');

describe('provisionSealedBindings', () => {
  beforeEach(() => {
    inserted.length = 0;
    mockWriteArtifact.mockReset().mockResolvedValue({ revision: 1 });
    // Writing the artifact mints its own empty baseline, so the copied world is
    // never version 1 in the fixture space.
    mockSeedBaseline.mockReset().mockResolvedValue({ baseline: { version: 2 } });
  });

  const run = () =>
    provisionSealedBindings({
      db: {} as never,
      tenantId: 'a0000000-0000-0000-0000-000000000001' as never,
      homeSpaceId: 'home',
      fixtureSpaceId: 'fixture',
      seed: 'eval:rev-1',
      sources: { 'bnpl-desk': { simulationRevision: 4, baselineVersion: 7 } },
      bindings: [
        {
          integrationId: 'bnpl-core',
          mode: 'stub',
          simulationId: 'bnpl-desk',
          personaId: 'cus_99',
        },
      ],
    });

  it('refuses when the source artifact moved after the batch pinned it', async () => {
    // A simulation keeps no revision history, so a later trial cannot be given
    // the artifact the first one ran. Answering with the current revision would
    // measure a different subject under the same case.
    await expect(
      provisionSealedBindings({
        db: {} as never,
        tenantId: 'a0000000-0000-0000-0000-000000000001' as never,
        homeSpaceId: 'home',
        fixtureSpaceId: 'fixture',
        seed: 'eval:rev-1',
        sources: { 'bnpl-desk': { simulationRevision: 3, baselineVersion: 7 } },
        bindings: [{ integrationId: 'bnpl-core', mode: 'stub', simulationId: 'bnpl-desk' }],
      }),
    ).rejects.toThrow(/was at revision 3 .* and is now at 4/);
  });

  it('pins the version the seed actually created, not the first one', async () => {
    const pins = await run();
    // Pinning 1 here would hand the trial the empty baseline the artifact write
    // mints, which `unmatched: 'generate'` answers by inventing the world.
    expect(pins.baselineVersions).toEqual({ 'bnpl-desk': 2 });
  });

  it('carries the persona and the case-derived seed onto the run', async () => {
    const pins = await run();
    expect(pins.personaIds).toEqual({ 'bnpl-desk': 'cus_99' });
    expect(pins.seed).toBe('eval:rev-1');
  });

  it('gives the fixture binding the source egress policy, not an invented one', async () => {
    await run();
    const binding = inserted.find((row) => row['fulfillmentMode'] === 'simulated');
    expect(binding?.['egressPolicyJson']).toEqual(HOME_EGRESS);
    expect(binding?.['simulationId']).toBe('bnpl-desk');
    expect(binding?.['enabled']).toBe(1);
  });

  it('never carries a credential into the fixture space', async () => {
    await run();
    const binding = inserted.find((row) => row['fulfillmentMode'] === 'simulated');
    expect(binding?.['authJson']).toEqual({ type: 'none' });
  });
});
