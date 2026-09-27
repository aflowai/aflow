/**
 * The version math behind every golden-case write (Plan 269 D4): add/update
 * bump the monotonic datasetVersion and open a new active revision; remove
 * closes the interval; ratifying a draft is the update path; discarding a
 * draft bumps nothing (it never entered a version); a stale precondition
 * conflicts instead of silently clobbering.
 */
import { describe, expect, it } from 'vitest';
import { planGoldenCaseWrite, resolveRequestedDatasetVersion } from '../goldenDatasetStore.js';

describe('planGoldenCaseWrite', () => {
  it('add: bumps the version and opens a new active revision', () => {
    const plan = planGoldenCaseWrite({ action: 'add', currentVersion: 4, openRevision: null });
    expect(plan).toEqual({ ok: true, newVersion: 5, bumpsVersion: true, insertActive: true });
  });

  it('add: refuses a caseId that already has an open revision', () => {
    const plan = planGoldenCaseWrite({
      action: 'add',
      currentVersion: 4,
      openRevision: { revisionId: 'r1', status: 'active' },
    });
    expect(plan).toMatchObject({ ok: false, code: 'case_already_exists' });
  });

  it('update: closes the superseded revision at the bumped version and inserts the new one', () => {
    const plan = planGoldenCaseWrite({
      action: 'update',
      currentVersion: 7,
      openRevision: { revisionId: 'r-old', status: 'active' },
    });
    expect(plan).toEqual({
      ok: true,
      newVersion: 8,
      bumpsVersion: true,
      closeRevisionId: 'r-old',
      insertActive: true,
    });
  });

  it('ratifying a draft is the same update path: draft closes, active enters at the bumped version', () => {
    const plan = planGoldenCaseWrite({
      action: 'update',
      currentVersion: 2,
      openRevision: { revisionId: 'r-draft', status: 'draft' },
    });
    expect(plan).toEqual({
      ok: true,
      newVersion: 3,
      bumpsVersion: true,
      closeRevisionId: 'r-draft',
      insertActive: true,
    });
  });

  it('remove of an active case bumps and closes, inserting nothing', () => {
    const plan = planGoldenCaseWrite({
      action: 'remove',
      currentVersion: 9,
      openRevision: { revisionId: 'r9', status: 'active' },
    });
    expect(plan).toEqual({
      ok: true,
      newVersion: 10,
      bumpsVersion: true,
      closeRevisionId: 'r9',
      insertActive: false,
    });
  });

  it('discarding a draft never bumps — it never entered any version', () => {
    const plan = planGoldenCaseWrite({
      action: 'remove',
      currentVersion: 9,
      openRevision: { revisionId: 'r-draft', status: 'draft' },
    });
    expect(plan).toEqual({
      ok: true,
      newVersion: 9,
      bumpsVersion: false,
      closeRevisionId: 'r-draft',
      insertActive: false,
    });
  });

  it('update/remove of an unknown case reports case_not_found', () => {
    for (const action of ['update', 'remove'] as const) {
      expect(planGoldenCaseWrite({ action, currentVersion: 1, openRevision: null })).toMatchObject({
        ok: false,
        code: 'case_not_found',
      });
    }
  });

  it('a stale expectedDatasetVersion conflicts before any mutation is planned', () => {
    const plan = planGoldenCaseWrite({
      action: 'update',
      currentVersion: 6,
      openRevision: { revisionId: 'r1', status: 'active' },
      expectedDatasetVersion: 5,
    });
    expect(plan).toMatchObject({ ok: false, code: 'version_conflict' });
  });

  it('a matching expectedDatasetVersion passes through', () => {
    const plan = planGoldenCaseWrite({
      action: 'add',
      currentVersion: 5,
      openRevision: null,
      expectedDatasetVersion: 5,
    });
    expect(plan).toMatchObject({ ok: true, newVersion: 6 });
  });
});

describe('resolveRequestedDatasetVersion', () => {
  it('omitted → the current head', () => {
    expect(resolveRequestedDatasetVersion(7, undefined)).toEqual({ ok: true, version: 7 });
  });

  it('a past version (and the head itself) resolves', () => {
    expect(resolveRequestedDatasetVersion(7, 3)).toEqual({ ok: true, version: 3 });
    expect(resolveRequestedDatasetVersion(7, 7)).toEqual({ ok: true, version: 7 });
    expect(resolveRequestedDatasetVersion(0, 0)).toEqual({ ok: true, version: 0 });
  });

  it('a version above the head refuses — never current content labeled as the future', () => {
    expect(resolveRequestedDatasetVersion(7, 8)).toEqual({ ok: false, currentVersion: 7 });
    expect(resolveRequestedDatasetVersion(0, 1)).toEqual({ ok: false, currentVersion: 0 });
  });
});
