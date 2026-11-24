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
import {
  publicationRehearsalRefusals,
  recordRehearsal,
  rehearsalRefusal,
} from '../rehearsal/publicationGate.js';
import { committedStoreCatalogHashes } from './bundleVersionFloor.js';

function committedLedger(): unknown {
  return JSON.parse(readFileSync(new URL('../storeRehearsals.json', import.meta.url), 'utf8'));
}

describe('store rehearsal ledger', () => {
  const ledger = StoreRehearsalLedgerSchema.parse(committedLedger());

  it('records only bundles that have a rehearsal plan, each under its own id', () => {
    for (const [catalogId, records] of Object.entries(ledger)) {
      expect(getBundleRehearsalPlan(catalogId), catalogId).not.toBeNull();
      expect(records.map((r) => r.catalogId)).toEqual(records.map(() => catalogId));
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
      window: null,
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
    expect(rehearsalRefusal(plan, { ...published, contentHash: 'hash-b' }, [record({})])).toContain(
      'has not been rehearsed',
    );
  });

  it('a pass run with other plan steps does not count, so a step added later needs a rehearsal', () => {
    const added = {
      ...plan,
      steps: [...plan.steps, { ...plan.steps.at(-1)!, stepId: 'added-step' }],
    };
    expect(rehearsalRefusal(added, published, [record({})])).toContain(
      "has not been rehearsed with the plan's current steps",
    );
  });

  it('a failure names its step', () => {
    const failed = record({
      outcome: 'fail',
      failingStep: { stepId: 'cycle-open', detail: 'Task decide failed' },
      steps: [{ stepId: 'cycle-open', kind: 'run', outcome: 'fail', detail: 'Task decide failed' }],
    });
    expect(rehearsalRefusal(plan, published, [failed])).toContain(
      'failed at cycle-open: Task decide failed',
    );
  });

  it('a skip is no pass, and says why', () => {
    const skipped = record({
      outcome: 'skipped',
      skipReason: 'install: not installed',
      steps: [{ stepId: 'install', kind: 'install', outcome: 'skipped', detail: 'not installed' }],
    });
    expect(rehearsalRefusal(plan, published, [skipped])).toContain(
      'a skip is no pass: install: not installed',
    );
  });

  it('a pass of the published version and content counts', () => {
    expect(rehearsalRefusal(plan, published, [record({})])).toBeNull();
  });

  const skippedLater = () =>
    record({
      outcome: 'skipped',
      skipReason: 'install: the API did not answer',
      steps: [{ stepId: 'install', kind: 'install', outcome: 'skipped', detail: 'no API' }],
      startedAt: '2026-11-25T14:00:00.000Z',
      finishedAt: '2026-11-25T14:00:01.000Z',
    });
  const notDueLater = () => {
    const notDue = {
      stepId: 'window',
      window: 'session_closed' as const,
      detail: 'Window session_closed is closed: the market is open at 11:00.',
      nextOpensAt: '2026-11-25T16:00',
    };
    return record({
      outcome: 'not_due',
      notDue,
      window: plan.window ?? null,
      steps: [
        { stepId: 'window', kind: 'window', outcome: 'not_due', detail: notDue.detail, notDue },
      ],
      startedAt: '2026-11-25T15:00:00.000Z',
      finishedAt: '2026-11-25T15:00:01.000Z',
    });
  };

  it('a not_due record is no pass, and names the window and when it next opens', () => {
    const reason = rehearsalRefusal(plan, published, [notDueLater()]);
    expect(reason).toContain(
      'is not_due: the exchange window session_closed was closed when step window was due.',
    );
    expect(reason).toContain('next opens at 2026-11-25T16:00');
    expect(reason).toContain(plan.window?.schedule);
  });

  it('a pass still counts when a later rehearsal of the version skips, fails or is not_due', () => {
    const failed = record({
      outcome: 'fail',
      failingStep: { stepId: 'cycle-open', detail: 'Task decide failed' },
      steps: [{ stepId: 'cycle-open', kind: 'run', outcome: 'fail', detail: 'Task decide failed' }],
    });
    for (const later of [skippedLater(), failed, notDueLater()]) {
      expect(rehearsalRefusal(plan, published, [record({}), later])).toBeNull();
    }
  });

  it('records a later skip beside a pass, never over it', () => {
    const pass = record({});
    const kept = recordRehearsal(recordRehearsal(undefined, pass), skippedLater());
    expect(kept.map((r) => r.outcome)).toEqual(['pass', 'skipped']);
    expect(rehearsalRefusal(plan, published, kept)).toBeNull();
  });

  it('keeps the newest record that is no pass, and one pass per version, content and steps', () => {
    const older = recordRehearsal([record({}), skippedLater()], notDueLater());
    expect(older.map((r) => r.outcome)).toEqual(['pass', 'not_due']);
    const repeated = recordRehearsal(older, record({ startedAt: '2026-11-26T21:00:00.000Z' }));
    expect(repeated.map((r) => [r.outcome, r.startedAt])).toEqual([
      ['pass', '2026-11-26T21:00:00.000Z'],
    ]);
    const nextVersion = record({ version: published.version + 1, contentHash: 'hash-c' });
    expect(recordRehearsal(repeated, nextVersion).map((r) => r.version)).toEqual([
      published.version,
      published.version + 1,
    ]);
  });
});
