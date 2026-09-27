import { describe, expect, it } from 'vitest';
import { isLiveAtVersion } from '@aflow/schemas';
import { rowToCaseRevision, tryRowToCaseRevision } from '../goldenDatasetStore.js';

/**
 * Requirements are declared independently of the checks that claim them, and
 * the table had nowhere to keep them: the writer dropped them, the reader
 * rebuilt the case without them, and the schema then refused any check whose
 * `claims` named one. A case that declared a requirement could not be read
 * back — and because the read parsed inside a map, that one row failed every
 * eval batch for the skill.
 */
function row(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    caseId: '22222222-2222-2222-2222-222222222222',
    datasetId: '33333333-3333-3333-3333-333333333333',
    spaceId: '44444444-4444-4444-4444-444444444444',
    addedInVersion: 1,
    removedInVersion: null,
    status: 'active',
    tier: 'capability',
    direction: 'should_succeed',
    scenario: 'refund-overdue',
    source: 'curated',
    workflowRevision: 1,
    title: 'A refund is pending far past its approved window',
    notes: null,
    triggerJson: { inputs: { message: 'where is my refund?' } },
    fixtureJson: { tier: 'seeded' },
    requirementsJson: [
      { id: 'overdue-investigate', kind: 'must_do', statement: 'Opens a handover case.' },
    ],
    expectationsJson: [
      {
        kind: 'reply',
        claims: ['overdue-investigate'],
        check: { op: 'contains', pattern: 'investigat' },
      },
    ],
    rubricsJson: [],
    provenanceJson: { source: 'curated', workflowRevision: 1 },
    createdByUserId: null,
    createdAt: new Date(),
    ...over,
  } as never;
}

describe('a requirement survives the round trip', () => {
  it('reads back the requirements the case declared', () => {
    const revision = rowToCaseRevision(row());
    expect(revision.case.requirements).toEqual([
      { id: 'overdue-investigate', kind: 'must_do', statement: 'Opens a handover case.' },
    ]);
  });

  it('accepts a check that claims one, which is the case that used to be unreadable', () => {
    expect(() => rowToCaseRevision(row())).not.toThrow();
  });

  it('still refuses a claim naming a requirement the case does not declare', () => {
    // The rule is right; it was the storage that could not hold the other half.
    const orphaned = row({ requirementsJson: [] });
    expect(() => rowToCaseRevision(orphaned)).toThrow(/does not declare/);
  });
});

describe('one unreadable row does not take the dataset with it', () => {
  it('reports the row instead of throwing, naming the case and the reason', () => {
    const parsed = tryRowToCaseRevision(row({ requirementsJson: [] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.unreadable.caseId).toBe('22222222-2222-2222-2222-222222222222');
    expect(parsed.unreadable.title).toContain('refund is pending');
    expect(parsed.unreadable.reason).toMatch(/does not declare/);
  });

  it('returns the case when it reads', () => {
    const parsed = tryRowToCaseRevision(row());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.revision.case.title).toContain('refund is pending');
  });

  it('carries its interval, so a version it is not live at can ignore it', () => {
    // Without this a revision removed three versions ago refuses every batch
    // forever, including the versions that still read cleanly.
    const parsed = tryRowToCaseRevision(
      row({ requirementsJson: [], addedInVersion: 2, removedInVersion: 5 }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(isLiveAtVersion(parsed.unreadable, 3)).toBe(true);
    expect(isLiveAtVersion(parsed.unreadable, 7)).toBe(false);
    expect(isLiveAtVersion(parsed.unreadable, 1)).toBe(false);
  });
});
