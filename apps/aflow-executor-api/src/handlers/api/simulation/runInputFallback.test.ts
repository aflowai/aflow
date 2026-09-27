/**
 * Where a simulated call finds the pins its run was started with.
 *
 * An agent session carries them in its create literal; an OPERATION task is
 * dispatched straight to an executor job stream and never passes through
 * `start_run`, so the durable run row is its only record. Reading only the
 * first store made every task-dispatched simulated call answer as the
 * simulation's default persona against a derived seed — invisible in the
 * response, and fatal to anything comparing two runs.
 */
import { describe, expect, it, vi } from 'vitest';

const mockHot = vi.fn();
vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return { ...actual, getSimulationRunInput: (...a: unknown[]) => mockHot(...a) };
});

const mockDurable = vi.fn();
vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return { ...actual, readDurableSimulationRunInput: (...a: unknown[]) => mockDurable(...a) };
});

const { resolveRunInput } = await import('./loadSimulation.js');

const PARAMS = {
  redis: {} as never,
  db: {} as never,
  tenantId: 'a0000000-0000-0000-0000-000000000001' as never,
  spaceId: 'space-1',
  runId: 'run-1',
};

const HOT = { seed: 'from-hot-state' };
const DURABLE = { seed: 'from-run-row', personaIds: { 'bnpl-desk': 'cus_99' } };

describe('resolveRunInput', () => {
  it('takes hot state when the session carries the pins', async () => {
    mockHot.mockResolvedValue(HOT);
    mockDurable.mockResolvedValue(DURABLE);

    await expect(resolveRunInput(PARAMS)).resolves.toEqual(HOT);
    // The durable read costs a query; a session that already has the pins must
    // not pay for it.
    expect(mockDurable).not.toHaveBeenCalled();
  });

  it('falls back to the run row when hot state holds nothing', async () => {
    // The operation-task case: no session was ever created for these pins.
    mockHot.mockResolvedValue(null);
    mockDurable.mockResolvedValue(DURABLE);

    await expect(resolveRunInput(PARAMS)).resolves.toEqual(DURABLE);
    expect(mockDurable).toHaveBeenCalledWith({
      db: PARAMS.db,
      tenantId: PARAMS.tenantId,
      spaceId: PARAMS.spaceId,
      runId: PARAMS.runId,
    });
  });

  it('reports no pins when neither store holds any', async () => {
    mockHot.mockResolvedValue(null);
    mockDurable.mockResolvedValue(null);
    await expect(resolveRunInput(PARAMS)).resolves.toBeNull();
  });
});
