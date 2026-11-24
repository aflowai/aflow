import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { skillTaskRunner } from '@aflow/cybernetic-runtime';
import { StoreRehearsalLedgerSchema } from '@aflow/schemas';
import { BUNDLE_REHEARSAL_PLANS } from '../rehearsal/plans.js';
import { smokeBundle } from '../rehearsal/smokeBundle.js';
import { getBundleSmokeFixtures, listSmokedBundles } from '../rehearsal/smokeFixtures/index.js';

/**
 * The smoke run of every rehearsed Store bundle (`yarn store:smoke`): its plan,
 * run end to end against mock integrations. A bundle whose plan cannot run all
 * the way fails here, before it ships. A step a mock cannot run is skipped
 * only where its fixtures say why. A smoke pass recorded in storeSmokes.json
 * satisfies the Plan 346 gate, so a recorded pass of this content and these
 * plan steps must be what a fresh run gives.
 */
describe('the Store bundle smoke run', () => {
  it('has smoke fixtures for every bundle with a rehearsal plan', () => {
    expect(listSmokedBundles().sort()).toEqual(
      BUNDLE_REHEARSAL_PLANS.map((p) => p.catalogId).sort(),
    );
  });

  describe.each(listSmokedBundles())('%s', (catalogId) => {
    it('runs every step of its plan, and none fails', async () => {
      const fixtures = getBundleSmokeFixtures(catalogId)!;
      const result = await smokeBundle(catalogId, skillTaskRunner, fixtures);
      expect(result.steps.filter((s) => s.outcome === 'fail')).toEqual([]);
      const plan = BUNDLE_REHEARSAL_PLANS.find((p) => p.catalogId === catalogId)!;
      const declared = new Set(
        plan.steps.flatMap((s) =>
          s.kind === 'run' && fixtures.unmockable?.[s.skillCatalogId] !== undefined
            ? [s.stepId]
            : [],
        ),
      );
      const skipped = result.steps.filter((s) => s.outcome !== 'pass').map((s) => s.stepId);
      expect(skipped.filter((id) => !declared.has(id))).toEqual([]);
      if (declared.size === 0) expect(result.outcome).toBe('pass');
    });

    it('passes again wherever storeSmokes.json records a pass of this content and plan', async () => {
      const ledger = StoreRehearsalLedgerSchema.parse(
        JSON.parse(readFileSync(new URL('../storeSmokes.json', import.meta.url), 'utf8')),
      );
      const result = await smokeBundle(catalogId, skillTaskRunner);
      const recorded = (ledger[catalogId] ?? []).filter(
        (r) =>
          r.outcome === 'pass' &&
          r.version === result.version &&
          r.contentHash === result.contentHash &&
          r.planStepsHash === result.planStepsHash,
      );
      if (recorded.length > 0) expect(result.outcome).toBe('pass');
    });
  });
});
