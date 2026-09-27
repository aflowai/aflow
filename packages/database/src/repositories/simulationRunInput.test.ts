/**
 * Reading a run's pins from the durable row.
 *
 * The hot-state copy is written into a session's create literal, so it exists
 * only for runs that pass through `start_run`. An operation task is dispatched
 * straight to an executor job stream and never does — this read is its only
 * record of what the run was started with, and before it existed those tasks
 * silently ran as the simulation's default persona against a derived seed.
 */
import { describe, expect, it, vi } from 'vitest';

const rows: unknown[] = [];
vi.mock('../tenant/queries.js', () => ({
  withTenantSchema: (_db: unknown, _ctx: unknown, cb: (tx: unknown) => Promise<unknown>) => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return cb(chain);
  },
}));

const { readDurableSimulationRunInput, SimulationRunInputUnreadable } =
  await import('./simulationRunContext.js');

const KEY = {
  db: {} as never,
  tenantId: 'a0000000-0000-0000-0000-000000000001' as never,
  spaceId: 'space',
  runId: 'run',
};

function storeRow(pins: unknown): void {
  rows.length = 0;
  rows.push({ pins });
}

describe('readDurableSimulationRunInput', () => {
  it('returns the pins the run was started with', async () => {
    storeRow({
      seed: 'eval:rev-1',
      personaIds: { 'bnpl-desk': 'cus_99' },
      baselineVersions: { 'bnpl-desk': 2 },
    });

    const pins = await readDurableSimulationRunInput(KEY);

    expect(pins?.seed).toBe('eval:rev-1');
    expect(pins?.personaIds).toEqual({ 'bnpl-desk': 'cus_99' });
    expect(pins?.baselineVersions).toEqual({ 'bnpl-desk': 2 });
  });

  it('reports no pins for a run that was started with none', async () => {
    storeRow(null);
    await expect(readDurableSimulationRunInput(KEY)).resolves.toBeNull();
  });

  it('reports no pins when the run row is missing entirely', async () => {
    rows.length = 0;
    await expect(readDurableSimulationRunInput(KEY)).resolves.toBeNull();
  });

  it('refuses an unreadable row rather than answering as an unpinned run', async () => {
    // The two are not interchangeable. No row means the run was started without
    // pins; an unreadable row means it WAS pinned and nobody can say to what.
    // Returning null for the second reopens the split this read closes — an
    // agent task refusing the same row while an operation task quietly runs as
    // another persona, producing a measurement that reads as valid.
    storeRow({ baselineVersions: { 'bnpl-desk': 0 } });
    await expect(readDurableSimulationRunInput(KEY)).rejects.toThrow(SimulationRunInputUnreadable);
  });
});
