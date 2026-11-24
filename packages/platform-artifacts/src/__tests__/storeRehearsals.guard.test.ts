/**
 * The go-live rehearsal gate (Plan 346), as the publication's checks read
 * it. A rehearsed bundle's published version counts as done only on a
 * passing rehearsal of that version and content hash, recorded in
 * storeRehearsals.json by `yarn store:rehearse`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BundleRehearsalResultSchema,
  rehearsalPlanStepsHash,
  StoreRehearsalLedgerSchema,
  type BundleRehearsalResult,
} from '@aflow/schemas';
import { getBundleRehearsalPlan, BUNDLE_REHEARSAL_PLANS } from '../rehearsal/plans.js';
import { publicationRehearsalRefusals, rehearsalRefusal } from '../rehearsal/publicationGate.js';
import { committedStoreCatalogHashes } from './bundleVersionFloor.js';

function committedLedger(): unknown {
  return JSON.parse(readFileSync(new URL('../storeRehearsals.json', import.meta.url), 'utf8'));
}

describe('store rehearsal ledger', () => {
  const ledger = StoreRehearsalLedgerSchema.parse(committedLedger());

  it('records only bundles that have a rehearsal plan, each under its own id', () => {
    for (const [catalogId, record] of Object.entries(ledger)) {
      expect(getBundleRehearsalPlan(catalogId), catalogId).not.toBeNull();
      expect(record.catalogId).toBe(catalogId);
    }
  });

  it('every rehearsed bundle’s published version has passed its rehearsal', () => {
    const refusals = publicationRehearsalRefusals(committedStoreCatalogHashes(), ledger);
    expect(
      refusals.map((r) => `${r.catalogId}: ${r.reason}`),
      'A rehearsed bundle was published at a version without a passing rehearsal of it.',
    ).toEqual([]);
  });
});

describe('the rehearsal gate', () => {
  const plan = BUNDLE_REHEARSAL_PLANS[0]!;
  const published = { version: plan.gateFromVersion, contentHash: 'hash-a' };
  const record = (over: Partial<BundleRehearsalResult>): BundleRehearsalResult =>
    BundleRehearsalResultSchema.parse({
      catalogId: plan.catalogId,
      version: published.version,
      contentHash: published.contentHash,
      planStepsHash: rehearsalPlanStepsHash(plan),
      spaceId: null,
      outcome: 'pass',
      steps: [{ stepId: 'install', kind: 'install', outcome: 'pass', detail: 'installed' }],
      uncovered: [],
      startedAt: '2026-11-24T14:00:00.000Z',
      finishedAt: '2026-11-24T14:10:00.000Z',
      ...over,
    });

  it('holds no version below the plan’s gate', () => {
    expect(
      rehearsalRefusal(plan, { ...published, version: plan.gateFromVersion - 1 }, undefined),
    ).toBeNull();
  });

  it('a version with no rehearsal on record does not count', () => {
    expect(rehearsalRefusal(plan, published, undefined)).toContain('has no rehearsal on record');
  });

  it('a pass of another version or content does not count', () => {
    expect(rehearsalRefusal(plan, { ...published, contentHash: 'hash-b' }, record({}))).toContain(
      'has not been rehearsed',
    );
  });

  it('a pass run with other plan steps does not count, so a step added later needs a rehearsal', () => {
    const added = {
      ...plan,
      steps: [...plan.steps, { ...plan.steps.at(-1)!, stepId: 'added-step' }],
    };
    expect(rehearsalRefusal(added, published, record({}))).toContain(
      "has not been rehearsed with the plan's current steps",
    );
  });

  it('a failure names its step', () => {
    const failed = record({
      outcome: 'fail',
      failingStep: { stepId: 'cycle-open', detail: 'Task decide failed' },
      steps: [{ stepId: 'cycle-open', kind: 'run', outcome: 'fail', detail: 'Task decide failed' }],
    });
    expect(rehearsalRefusal(plan, published, failed)).toContain(
      'failed at cycle-open: Task decide failed',
    );
  });

  it('a skip is no pass, and says why', () => {
    const skipped = record({
      outcome: 'skipped',
      skipReason: 'install: not installed',
      steps: [{ stepId: 'install', kind: 'install', outcome: 'skipped', detail: 'not installed' }],
    });
    expect(rehearsalRefusal(plan, published, skipped)).toContain(
      'a skip is no pass: install: not installed',
    );
  });

  it('a pass of the published version and content counts', () => {
    expect(rehearsalRefusal(plan, published, record({}))).toBeNull();
  });
});
