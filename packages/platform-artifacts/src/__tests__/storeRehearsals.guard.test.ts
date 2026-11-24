/**
 * The rehearsal gate (Plan 346), as the publication's checks and the store
 * hash script read it. From a plan's `gateFromVersion` on, a rehearsed
 * bundle's published version counts as done only on a pass of that version
 * and content hash. A smoke pass in storeSmokes.json (`yarn store:smoke
 * --record`) satisfies it. A go-live rehearsal pass in storeRehearsals.json
 * (`yarn store:rehearse`) satisfies it too.
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
import { SMOKE_SPACE_ID } from '../rehearsal/smokeBundle.js';
import { committedStoreCatalogHashes } from './bundleVersionFloor.js';

function committedLedger(file: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
}

describe('store rehearsal and smoke ledgers', () => {
  const ledgers = {
    smokes: StoreRehearsalLedgerSchema.parse(committedLedger('storeSmokes.json')),
    rehearsals: StoreRehearsalLedgerSchema.parse(committedLedger('storeRehearsals.json')),
  };

  it('record only bundles that have a rehearsal plan, each under its own id', () => {
    for (const ledger of [ledgers.smokes, ledgers.rehearsals]) {
      for (const [catalogId, records] of Object.entries(ledger)) {
        expect(getBundleRehearsalPlan(catalogId), catalogId).not.toBeNull();
        expect(records.map((r) => r.catalogId)).toEqual(records.map(() => catalogId));
      }
    }
  });

  it('the smoke ledger holds only smoke runs, and the rehearsal ledger holds none', () => {
    for (const records of Object.values(ledgers.smokes)) {
      expect(records.map((r) => r.spaceId)).toEqual(records.map(() => SMOKE_SPACE_ID));
    }
    for (const records of Object.values(ledgers.rehearsals)) {
      expect(records.filter((r) => r.spaceId === SMOKE_SPACE_ID)).toEqual([]);
    }
  });

  it('every rehearsed bundle’s published version has a passing smoke run or rehearsal', () => {
    const refusals = publicationRehearsalRefusals(committedStoreCatalogHashes(), ledgers);
    expect(
      refusals.map((r) => `${r.catalogId}: ${r.reason}`),
      'A rehearsed bundle was published at a version with no passing smoke run or rehearsal of it.',
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
      rehearsalRefusal(plan, { ...published, version: plan.gateFromVersion - 1 }, {}),
    ).toBeNull();
  });

  it('a version with no rehearsal on record does not count', () => {
    expect(rehearsalRefusal(plan, published, {})).toContain(
      'Go-live rehearsal: none is on record.',
    );
  });

  it('a pass of another version or content does not count', () => {
    expect(
      rehearsalRefusal(plan, { ...published, contentHash: 'hash-b' }, { rehearsals: [record({})] }),
    ).toContain(`the last one on record is of version ${String(published.version)}`);
  });

  it('a pass run with other plan steps does not count, so a step added later needs a rehearsal', () => {
    const added = {
      ...plan,
      steps: [...plan.steps, { ...plan.steps.at(-1)!, stepId: 'added-step' }],
    };
    expect(rehearsalRefusal(added, published, { rehearsals: [record({})] })).toContain(
      "ran other steps than the plan's current steps",
    );
  });

  it('a failure names its step', () => {
    const failed = record({
      outcome: 'fail',
      failingStep: { stepId: 'cycle-open', detail: 'Task decide failed' },
      steps: [{ stepId: 'cycle-open', kind: 'run', outcome: 'fail', detail: 'Task decide failed' }],
    });
    expect(rehearsalRefusal(plan, published, { rehearsals: [failed] })).toContain(
      'failed at cycle-open: Task decide failed',
    );
  });

  it('a skip is no pass, and says why', () => {
    const skipped = record({
      outcome: 'skipped',
      skipReason: 'install: not installed',
      steps: [{ stepId: 'install', kind: 'install', outcome: 'skipped', detail: 'not installed' }],
    });
    expect(rehearsalRefusal(plan, published, { rehearsals: [skipped] })).toContain(
      'a skip is no pass: install: not installed',
    );
  });

  it('a pass of the published version and content counts', () => {
    expect(rehearsalRefusal(plan, published, { rehearsals: [record({})] })).toBeNull();
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
    const reason = rehearsalRefusal(plan, published, { rehearsals: [notDueLater()] });
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
      expect(rehearsalRefusal(plan, published, { rehearsals: [record({}), later] })).toBeNull();
    }
  });

  it('records a later skip beside a pass, never over it', () => {
    const pass = record({});
    const kept = recordRehearsal(recordRehearsal(undefined, pass), skippedLater());
    expect(kept.map((r) => r.outcome)).toEqual(['pass', 'skipped']);
    expect(rehearsalRefusal(plan, published, { rehearsals: kept })).toBeNull();
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

  describe('as the store hash script reads it, from the smoke and rehearsal ledgers', () => {
    const smoke = (over: Partial<BundleRehearsalResult>) =>
      record({ spaceId: SMOKE_SPACE_ID, ...over });
    const failedSmoke = () =>
      smoke({
        outcome: 'fail',
        failingStep: { stepId: 'cycle-open', detail: 'Task decide failed' },
        steps: [
          { stepId: 'cycle-open', kind: 'run', outcome: 'fail', detail: 'Task decide failed' },
        ],
      });
    const skippedSmoke = () =>
      smoke({
        outcome: 'skipped',
        skipReason: 'desk-charter: no fixture runs it',
        steps: [
          {
            stepId: 'desk-charter',
            kind: 'run',
            outcome: 'skipped',
            detail: 'no fixture runs it',
          },
        ],
      });
    const refusals = (
      smokes: BundleRehearsalResult[] | undefined,
      rehearsals: BundleRehearsalResult[] | undefined,
    ) =>
      publicationRehearsalRefusals(
        { [plan.catalogId]: published },
        {
          smokes: smokes ? { [plan.catalogId]: smokes } : {},
          rehearsals: rehearsals ? { [plan.catalogId]: rehearsals } : {},
        },
      );

    it('accepts a re-stamp with a passing smoke record and no ledger record', () => {
      expect(refusals([smoke({})], undefined)).toEqual([]);
    });

    it('accepts a re-stamp with a passing go-live rehearsal and no smoke record', () => {
      expect(refusals(undefined, [record({})])).toEqual([]);
    });

    it('accepts a passing rehearsal beside a failing smoke record', () => {
      expect(refusals([failedSmoke()], [record({})])).toEqual([]);
    });

    it('refuses a re-stamp with neither record, and names what satisfies the gate', () => {
      const [refusal, ...rest] = refusals(undefined, undefined);
      expect(rest).toEqual([]);
      expect(refusal?.catalogId).toBe(plan.catalogId);
      expect(refusal?.reason).toContain('has no passing smoke run or go-live rehearsal');
      expect(refusal?.reason).toContain('Smoke run: none is on record.');
      expect(refusal?.reason).toContain('Go-live rehearsal: none is on record.');
      expect(refusal?.reason).toContain(`yarn store:smoke ${plan.catalogId} --record`);
      expect(refusal?.reason).toContain('A passing smoke run satisfies the gate.');
      expect(refusal?.reason).toContain('and it is optional');
    });

    it('refuses a re-stamp whose smoke record failed, naming its step', () => {
      const [refusal] = refusals([failedSmoke()], undefined);
      expect(refusal?.reason).toContain('Smoke run: it failed at cycle-open: Task decide failed');
    });

    it('refuses a re-stamp whose smoke record was skipped, because a skip is no pass', () => {
      const [refusal] = refusals([skippedSmoke()], undefined);
      expect(refusal?.reason).toContain(
        'Smoke run: it was skipped, and a skip is no pass: desk-charter: no fixture runs it',
      );
    });

    it('refuses a smoke pass of other content or other plan steps', () => {
      expect(refusals([smoke({ contentHash: 'hash-b' })], undefined)).toHaveLength(1);
      expect(refusals([smoke({ planStepsHash: 'f'.repeat(64) })], undefined)).toHaveLength(1);
    });

    it('keeps a smoke pass when a later smoke of the version fails', () => {
      const kept = recordRehearsal(recordRehearsal(undefined, smoke({})), failedSmoke());
      expect(refusals(kept, undefined)).toEqual([]);
    });
  });
});
