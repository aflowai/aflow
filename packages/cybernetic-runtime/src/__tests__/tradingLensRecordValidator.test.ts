import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupValidator, type RuntimeValidatorContext } from '@aflow/schemas';

const sources = vi.hoisted(() => ({
  set: { status: 'missing' } as { status: string; content?: unknown },
  docs: [] as Array<{ path: string; content: string | null }>,
  setPath: '',
}));

vi.mock('../scheduling/tradingApprovedThesesValidator.js', () => ({
  readApprovedSet: (_ctx: unknown, path: string) => {
    sources.setPath = path;
    return Promise.resolve(sources.set);
  },
}));
vi.mock('../scheduling/tradingArmTable.js', () => ({
  loadThesisLedgerDocs: () => Promise.resolve(sources.docs),
}));

const { TRADING_LENS_RECORD_VALIDATOR_REF } =
  await import('../scheduling/tradingLensRecordValidator.js');

const ctx: RuntimeValidatorContext = {
  tenantId: '5d1e2a4b-7c3f-4e8a-9b6d-0f1e2d3c4b5a',
  spaceId: '0b7c6f1e-58b6-4cf3-9a8f-1e2d3c4b5a69',
  db: {},
};

const LENSES = ['fundamentals', 'macro', 'technical', 'priorLearnings', 'priorDecisions', 'risk'];
const RECORD = Object.fromEntries(
  LENSES.map((lens) => [
    lens,
    {
      verdict: 'approved',
      reason: `${lens} holds`,
      rounds: [{ round: 1, verdict: 'approved', reason: `${lens} holds` }],
    },
  ]),
);

function output(lensRecordGaps: number, opened: unknown, resolved?: unknown) {
  return {
    lensRecordGaps,
    cycleDoc: {
      tradingDay: '2026-07-14',
      slot: 'intraday',
      slotIndex: 2,
      openedApprovals: [
        { thesisId: 'aapl-t', approvedId: 'aapl-breakout-1', reviewRunId: 'run-1', lenses: opened },
      ],
      thesesResolved:
        resolved === undefined
          ? []
          : [{ thesisId: 'msft-t', outcome: 'falsified', lenses: resolved }],
    },
  };
}

function setWith(lenses: unknown) {
  sources.set = {
    status: 'found',
    content: {
      tradingDay: '2026-07-14',
      slots: { 'intraday-2': [{ approvedId: 'aapl-breakout-1', lenses }] },
    },
  };
}

async function validate(data: unknown) {
  const registered = lookupValidator(TRADING_LENS_RECORD_VALIDATOR_REF);
  if (registered?.kind !== 'runtime') throw new Error('the lens-record rule is not registered');
  return registered.fn(data, ctx);
}

describe('trading.lens-record', () => {
  beforeEach(() => {
    sources.set = { status: 'missing' };
    sources.docs = [];
  });

  it('reads the set of the cycle’s day and its slot', async () => {
    setWith(RECORD);
    expect(await validate(output(0, RECORD))).toEqual([]);
    expect(sources.setPath).toBe('/research/2026-07-14/approved-theses.json');
  });

  it('pins a gap where the cycle dropped the record its entry held', async () => {
    setWith(RECORD);
    const issues = await validate(output(0, null));
    expect(issues.map((i) => i.path)).toEqual([['lensRecordGaps']]);
    expect(issues[0]!.message).toContain('opened thesis aapl-t lost the lens record');
    expect(await validate(output(1, null))).toEqual([]);
  });

  it('pins a gap where a resolved thesis lost the record its ledger doc carries', async () => {
    sources.docs = [
      {
        path: '/portfolio/theses/resolved/msft-t.json',
        content: JSON.stringify({ lenses: RECORD }),
      },
    ];
    expect((await validate(output(0, null, null)))[0]!.message).toContain(
      'resolved thesis msft-t lost the lens record',
    );
    expect(await validate(output(0, null, RECORD))).toEqual([]);
  });

  it('counts no gap for an operator’s set or a thesis from before lens records', async () => {
    // The operator's entry carries no lens record, or another value.
    setWith(undefined);
    expect(await validate(output(0, null))).toEqual([]);
    setWith({ note: 'reviewed by hand' });
    expect(await validate(output(0, { note: 'reviewed by hand' }))).toEqual([]);
    // The thesis was opened before lens records, so its ledger doc carries none.
    sources.docs = [
      { path: '/portfolio/theses/resolved/msft-t.json', content: JSON.stringify({ outcome: 'x' }) },
    ];
    expect(await validate(output(0, null, null))).toEqual([]);
    // A gap reported where none exists is refused too.
    expect((await validate(output(1, null, null)))[0]!.message).toContain('must be 0');
  });
});
