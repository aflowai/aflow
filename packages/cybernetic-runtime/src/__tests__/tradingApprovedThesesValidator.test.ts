import { describe, expect, it } from 'vitest';
import { lookupValidator } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';
import { TRADING_APPROVED_THESES_VALIDATOR_REF } from '../scheduling/tradingApprovedThesesValidator.js';

const ctx = (db: unknown) => ({ tenantId: 't-1', spaceId: 's-1', db });

function decision(theses: unknown[]) {
  return {
    tradingDay: '2026-07-14',
    slot: 'open',
    slotIndex: null,
    theses,
    projectedGrossExposurePct: 0,
    decisionRationale: 'No approved setup today.',
  };
}

function runtimeValidator() {
  const v = lookupValidator(TRADING_APPROVED_THESES_VALIDATOR_REF);
  if (v?.kind !== 'runtime')
    throw new Error('approved-theses validator is not a runtime validator');
  return v.fn;
}

describe('trading.approved-theses runtime validator', () => {
  it('is the ref the daily-trading-cycle decide contract names', () => {
    const decide = getSkillCatalogEntry('daily-trading-cycle')?.bundle.workflow.tasks.find(
      (t) => t.taskId === 'decide',
    );
    expect(decide?.outputContract?.validatorRefs).toContain(TRADING_APPROVED_THESES_VALIDATOR_REF);
  });

  it('passes a decision that opens nothing without reading the space', async () => {
    const untouchable = new Proxy(
      {},
      {
        get() {
          throw new Error('the database was read');
        },
      },
    );
    expect(await runtimeValidator()(decision([]), ctx(untouchable))).toEqual([]);
  });

  it('refuses the theses when the approved set cannot be read', async () => {
    const thesis = {
      thesisId: 'aapl-2',
      approvedId: 'aapl-breakout-1',
      reviewRunId: 'run-review-0714',
      instrument: 'AAPL',
      direction: 'long',
      sizePct: 5,
      deadlineTradingDays: 3,
    };
    const issues = await runtimeValidator()(decision([thesis]), ctx({}));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'custom', path: ['theses'] });
    expect(issues[0]!.message).toContain('cannot be read');
    expect(issues[0]!.message).toContain('resolve-only');
  });
});
