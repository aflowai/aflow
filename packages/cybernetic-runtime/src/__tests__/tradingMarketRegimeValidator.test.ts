import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupValidator, RuntimeValidatorFault } from '@aflow/schemas';
import { marketRegimeIssues } from '@aflow/platform-artifacts';
import { decodeTaskOutput } from '../humanTaskHydration.js';
import { loadRunById } from '../ledger.js';
import {
  TRADING_INDEX_READ_TASK_ID,
  TRADING_MARKET_REGIME_VALIDATOR_REF,
} from '../scheduling/tradingMarketRegime.js';

vi.mock('@aflow/platform-artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aflow/platform-artifacts')>()),
  marketRegimeIssues: vi.fn(),
}));
vi.mock('../ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ledger.js')>()),
  loadRunById: vi.fn(),
}));
vi.mock('../humanTaskHydration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../humanTaskHydration.js')>()),
  decodeTaskOutput: vi.fn(),
}));

const payloadStore = { retrieve: vi.fn() };
const ctx = {
  tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
  spaceId: '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69',
  workflowRunId: 'run-cycle-0714',
  db: {},
  payloadStore,
};
const READ = { bars: { SPY: [], QQQ: [], IWM: [] }, nextPageToken: null };
const OUTPUT = { tradingDay: '2026-07-14' };

function validator() {
  const v = lookupValidator(TRADING_MARKET_REGIME_VALIDATOR_REF);
  if (v?.kind !== 'runtime') throw new Error('market-regime validator is not a runtime validator');
  return v.fn;
}

function runWith(tasks: Array<{ taskId: string; status: string; outputRef: string | null }>) {
  vi.mocked(loadRunById).mockResolvedValue({ tasks } as unknown as Awaited<
    ReturnType<typeof loadRunById>
  >);
}

beforeEach(() => {
  vi.mocked(marketRegimeIssues)
    .mockReset()
    .mockReturnValue([{ path: ['indexCloses', 'SPY'], message: 'skips 2026-07-01.' }]);
  vi.mocked(decodeTaskOutput).mockReset().mockResolvedValue(READ);
  runWith([{ taskId: TRADING_INDEX_READ_TASK_ID, status: 'succeeded', outputRef: 'gs://read' }]);
});

describe('trading.market-regime', () => {
  it('holds the output to the read-index-bars output of its own run', async () => {
    expect(await validator()(OUTPUT, ctx)).toEqual([
      { code: 'custom', path: ['indexCloses', 'SPY'], message: 'skips 2026-07-01.' },
    ]);
    expect(loadRunById).toHaveBeenCalledWith(ctx.db, ctx.tenantId, ctx.spaceId, ctx.workflowRunId);
    expect(decodeTaskOutput).toHaveBeenCalledWith('gs://read', payloadStore);
    expect(marketRegimeIssues).toHaveBeenCalledWith(OUTPUT, READ);
  });

  it('holds the output to no read when the run has no succeeded read', async () => {
    runWith([{ taskId: TRADING_INDEX_READ_TASK_ID, status: 'failed', outputRef: null }]);
    await validator()(OUTPUT, ctx);
    expect(decodeTaskOutput).not.toHaveBeenCalled();
    expect(marketRegimeIssues).toHaveBeenLastCalledWith(OUTPUT, null);

    const { workflowRunId: _none, ...withoutRun } = ctx;
    vi.mocked(loadRunById).mockClear();
    await validator()(OUTPUT, withoutRun);
    expect(loadRunById).not.toHaveBeenCalled();
    expect(marketRegimeIssues).toHaveBeenLastCalledWith(OUTPUT, null);
  });

  it('holds the output to no read when the succeeded read recorded no output', async () => {
    runWith([{ taskId: TRADING_INDEX_READ_TASK_ID, status: 'succeeded', outputRef: null }]);
    await validator()(OUTPUT, ctx);
    expect(decodeTaskOutput).not.toHaveBeenCalled();
    expect(marketRegimeIssues).toHaveBeenLastCalledWith(OUTPUT, null);
  });

  it('refuses the output with a platform fault when the DB fails', async () => {
    vi.mocked(loadRunById).mockRejectedValueOnce(new Error('connection terminated'));
    const dbFault = validator()(OUTPUT, ctx);
    await expect(dbFault).rejects.toBeInstanceOf(RuntimeValidatorFault);
    await expect(dbFault).rejects.toMatchObject({
      validatorRef: TRADING_MARKET_REGIME_VALIDATOR_REF,
      message: expect.stringContaining('connection terminated'),
    });
    expect(marketRegimeIssues).not.toHaveBeenCalled();
  });

  it('refuses the output with a platform fault when the payload store fails the recorded read', async () => {
    // The real decodeTaskOutput: it absorbs the store's failure and resolves null.
    const actual = await vi.importActual<typeof import('../humanTaskHydration.js')>(
      '../humanTaskHydration.js',
    );
    vi.mocked(decodeTaskOutput).mockImplementation(actual.decodeTaskOutput);
    payloadStore.retrieve.mockRejectedValueOnce(new Error('payload-store unreachable'));
    await expect(actual.decodeTaskOutput('gs://read', payloadStore as never)).resolves.toBeNull();

    payloadStore.retrieve.mockRejectedValueOnce(new Error('payload-store unreachable'));
    const storeFault = validator()(OUTPUT, ctx);
    await expect(storeFault).rejects.toBeInstanceOf(RuntimeValidatorFault);
    await expect(storeFault).rejects.toMatchObject({
      validatorRef: TRADING_MARKET_REGIME_VALIDATOR_REF,
      message: expect.stringContaining('gs://read'),
    });
    expect(marketRegimeIssues).not.toHaveBeenCalled();
  });
});
