import { describe, expect, it, vi } from 'vitest';
import { lookupValidator, type RuntimeValidatorContext } from '@aflow/schemas';

const sources = vi.hoisted(() => ({
  docs: [] as Array<{ path: string; content: string | null }>,
}));

vi.mock('../scheduling/tradingArmTable.js', () => ({
  loadCycleLedgerDocs: () => Promise.resolve(sources.docs),
}));

const { TRADING_CLOSE_REASONS_VALIDATOR_REF, TRADING_DAY_RESOLUTIONS_VALIDATOR_REF } =
  await import('../scheduling/tradingDayResolutionsValidator.js');

const ctx: RuntimeValidatorContext = {
  tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
  spaceId: '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69',
  db: {},
};

const DAY = '2026-07-14';
sources.docs = [
  {
    path: `/portfolio/theses/cycles/${DAY}-open.json`,
    content: JSON.stringify({
      thesesResolved: [{ thesisId: 'msft-long', hypothesisId: 'gap-fade', outcome: 'confirmed' }],
      thesesOpened: ['aapl-long'],
    }),
  },
];

async function validate(ref: string, data: unknown) {
  const registered = lookupValidator(ref);
  if (registered?.kind !== 'runtime') throw new Error(`${ref} is not registered`);
  return registered.fn(data, ctx);
}

const reason = (outcome: string) => ({
  tradingDay: DAY,
  reasons: [
    { thesisId: 'msft-long', hypothesisId: 'gap-fade', outcome, slotKey: 'open', reason: 'r' },
  ],
});

describe('the close report rules over the space’s cycle docs', () => {
  it('holds the reflection’s reasons to the day’s resolutions', async () => {
    expect(await validate(TRADING_CLOSE_REASONS_VALIDATOR_REF, reason('confirmed'))).toEqual([]);
    expect(await validate(TRADING_CLOSE_REASONS_VALIDATOR_REF, reason('expired'))).toEqual([
      expect.objectContaining({ code: 'custom', path: ['reasons', 0, 'outcome'] }),
    ]);
  });

  it('holds the ledger read to the day’s resolutions and openings', async () => {
    const cycleDocPath = `/portfolio/theses/cycles/${DAY}-open.json`;
    const read = (resolved: string, opened: string) => ({
      tradingDay: DAY,
      resolutions: [
        {
          cycleDocPath,
          slotKey: 'open',
          thesisId: resolved,
          hypothesisId: 'gap-fade',
          outcome: 'confirmed',
        },
      ],
      thesesOpened: [{ cycleDocPath, slotKey: 'open', thesisId: opened }],
    });
    const paths = async (data: unknown) =>
      (await validate(TRADING_DAY_RESOLUTIONS_VALIDATOR_REF, data)).map((i) => i.path);
    expect(await paths(read('msft-long', 'aapl-long'))).toEqual([]);
    expect(await paths(read('nvda-long', 'aapl-long'))).toEqual([
      ['resolutions', 0, 'thesisId'],
      ['resolutions'],
    ]);
    expect(await paths(read('msft-long', 'nvda-long'))).toEqual([
      ['thesesOpened', 0, 'thesisId'],
      ['thesesOpened'],
    ]);
  });
});
