/**
 * Restore is undo in a store where nothing is rewritten, and the way it goes
 * wrong is by producing a world that never existed.
 *
 * A seed carries collections it does not supply forward from the LATEST
 * version. So a restore that supplies only the collections the old version held
 * rows in mints the old world blended with the current head — plausible,
 * self-consistent, and not the version anyone asked to go back to.
 */
import { describe, expect, it } from 'vitest';
import { restoredEntities } from './simulationBaselineWrite.js';

const simulation = {
  collections: [
    { collection: 'purchases', identityField: 'purchaseId', schema: {} },
    { collection: 'refunds', identityField: 'refundId', schema: {} },
    { collection: 'disputes', identityField: 'disputeId', schema: {} },
  ],
};

describe('restoring an earlier baseline', () => {
  it('supplies every declared collection, so nothing is carried forward from the head', () => {
    // The old version held no refunds and no disputes. Both must arrive EMPTY
    // rather than absent, or the seed fills them from whatever is latest.
    const entities = restoredEntities(simulation, [
      { collection: 'purchases', body: { purchaseId: 'pur_1' } },
    ]);

    expect(Object.keys(entities).sort()).toEqual(['disputes', 'purchases', 'refunds']);
    expect(entities['refunds']).toEqual([]);
    expect(entities['disputes']).toEqual([]);
  });

  it('carries the rows the version actually held', () => {
    const entities = restoredEntities(simulation, [
      { collection: 'purchases', body: { purchaseId: 'pur_1' } },
      { collection: 'purchases', body: { purchaseId: 'pur_2' } },
      { collection: 'refunds', body: { refundId: 'ref_1' } },
    ]);

    expect(entities['purchases']).toEqual([{ purchaseId: 'pur_1' }, { purchaseId: 'pur_2' }]);
    expect(entities['refunds']).toEqual([{ refundId: 'ref_1' }]);
  });

  it('drops a row whose collection the artifact no longer declares', () => {
    // Same rule the seed's carry-forward follows: an undeclared collection is
    // the artifact saying it does not exist, so restoring it would resurrect a
    // collection nothing can read.
    const entities = restoredEntities(simulation, [
      { collection: 'purchases', body: { purchaseId: 'pur_1' } },
      { collection: 'legacy_orders', body: { orderId: 'ord_1' } },
    ]);

    expect(entities).not.toHaveProperty('legacy_orders');
    expect(entities['purchases']).toHaveLength(1);
  });

  it('restores an empty world as empty rather than as the head', () => {
    expect(restoredEntities(simulation, [])).toEqual({
      purchases: [],
      refunds: [],
      disputes: [],
    });
  });
});

describe('one writer for every baseline surface', () => {
  it('is reached by the operation and the route alike, neither minting its own', async () => {
    // A baseline version is what a run pins for its lifetime. The rules that
    // make one safe — mint never rewrite, carry forward through the process,
    // hold the whole post-copy world to the CURRENT declarations — have to hold
    // whether an agent or the operator's screen asked. A second implementation
    // is the first place they would stop holding.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

    const surfaces = [
      'apps/aflow-orchestrator/src/services/SessionOrchestrator/handlers/inlineOps/simulationWorld.ts',
      'packages/server-runtime/src/routes/integrations/simulations.ts',
    ];
    for (const surface of surfaces) {
      const source = await readFile(`${repoRoot}${surface}`, 'utf8');
      expect(source, `${surface} should call the shared writer`).toMatch(
        /seedSimulationBaseline|freezeSimulationBaseline/,
      );
      // Minting is an insert into simulation_baselines. Either surface doing
      // that itself has forked the invariants.
      expect(source, `${surface} mints a baseline version itself`).not.toContain(
        'insert(simulationBaselines)',
      );
    }
  });
});

describe('what a baseline write refuses', () => {
  it('names a distinct code for each refusal, so a caller knows what to do next', () => {
    // The three are different moves for the operator: re-read and merge, wait
    // for the run to settle, or pick a version that exists. Collapsing them
    // into one code would tell them to do the wrong thing two times in three.
    const codes = [
      'SIMULATION_FREEZE_JOURNAL_MOVED',
      'SIMULATION_FREEZE_CONFLICT',
      'SIMULATION_BASELINE_NOT_FOUND',
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('re-reads the journal head under the same lock a commit takes', async () => {
    // A fold performed outside the transaction can be stale by the time the
    // baseline is written. Re-reading under the commit's own lock is what turns
    // that into a refusal rather than a baseline missing part of the run.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const source = await readFile(
      fileURLToPath(new URL('./simulationBaselineWrite.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('SIMULATION_FREEZE_JOURNAL_MOVED');
    const lockAt = source.indexOf('simulationWorldLockKey');
    const reReadAt = source.indexOf('nowHead');
    expect(lockAt).toBeGreaterThan(-1);
    expect(reReadAt).toBeGreaterThan(lockAt);
  });

  it('compares the revision on every artifact write, not only when one is offered', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const source = await readFile(
      fileURLToPath(new URL('./simulationArtifactWrite.ts', import.meta.url)),
      'utf8',
    );
    // An optional guard is the one every caller forgets, and forgetting it
    // here silently discards somebody else's edit.
    expect(source).not.toContain('params.expectedRevision !== undefined');
    expect(source).toContain('SIMULATION_REVISION_CONFLICT');
  });
});
