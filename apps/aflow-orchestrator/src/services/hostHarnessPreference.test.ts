/**
 * Contract: the space's preferred coding agent rides a harness run's job, only
 * a harness run's, and a preference that cannot be read leaves the machine
 * deciding rather than failing the dispatch.
 */
import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({
  value: [] as Array<{ preferredHarness: string | null }>,
  fail: false,
}));

vi.mock('@aflow/database', () => ({
  createTenantContext: () => ({}),
  spaces: { id: {}, preferredHarness: {} },
  withTenantSchema: () =>
    rows.fail ? Promise.reject(new Error('column does not exist')) : Promise.resolve(rows.value),
}));

import { preferredHarnessFor } from './hostHarnessPreference.js';

const db = {} as never;

describe("a space's preferred coding agent at dispatch", () => {
  it('is read for a harness run', async () => {
    rows.value = [{ preferredHarness: 'codex' }];
    rows.fail = false;
    expect(await preferredHarnessFor(db, 't', 's', 'host.harness.run')).toBe('codex');
  });

  it('is read for the read of a folder that answers for the harness such a run would get', async () => {
    rows.value = [{ preferredHarness: 'codex' }];
    rows.fail = false;
    expect(await preferredHarnessFor(db, 't', 's', 'host.binding.inspect')).toBe('codex');
  });

  it('is never read for any other operation', async () => {
    rows.value = [{ preferredHarness: 'codex' }];
    expect(await preferredHarnessFor(db, 't', 's', 'host.process.exec')).toBeUndefined();
  });

  it('is absent where the space chose none, or cannot be read', async () => {
    rows.value = [{ preferredHarness: null }];
    expect(await preferredHarnessFor(db, 't', 's', 'host.harness.run')).toBeUndefined();
    rows.fail = true;
    expect(await preferredHarnessFor(db, 't', 's', 'host.harness.run')).toBeUndefined();
  });
});
