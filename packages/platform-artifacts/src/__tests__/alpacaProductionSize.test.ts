/**
 * alpaca-thesis-trading at production size: a 30-member universe over the
 * regime's 100-day lookback, as a live space reads it. Hand-sized fixtures of
 * three members passed two defects that only these sizes expose. The 226 KB
 * universe read is offloaded behind a dataRef, which the projection once
 * failed to read. And an output that copies the regime's 750 closes runs out
 * of a model's output budget.
 */
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  estimatePinnedOutputTokens,
  loadProjectionSource,
  materializeAndValidateSkillConfig,
  outputBudgetDiagnostics,
  projectTaskOutput,
} from '@aflow/cybernetic-runtime';
import {
  getRunDeriver,
  MAX_INLINE_PAYLOAD_BYTES,
  substituteTemplateBinds,
  WorkflowRunDeriveInputSchema,
  type WorkflowTask,
  type WorkflowTaskOutputProjection,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  INDEX_LOOKBACK_SESSIONS,
  MEMBER_LOOKBACK_SESSIONS,
  READ_INDEX_BARS_TASK_ID,
  READ_UNIVERSE_BARS_TASK_ID,
  REGIME_INDEXES,
} from '../skillCatalog/dailyTradingCycleRegime.js';
import {
  REGIME_BARS_LOOKBACK_DAYS,
  universeCoverageGaps,
} from '../skillCatalog/dailyTradingCycleUniverse.js';
import { ALPACA_REHEARSAL_CAMPAIGN } from '../rehearsal/plans.js';
import {
  alpacaBarsBody,
  apiCallOutput,
  byteLength,
  payloadStoreOf,
  PRODUCTION_UNIVERSE,
  weekdaySessions,
} from './productionSize.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const cycle = getSkillCatalogEntry('daily-trading-cycle')!;
const tasks = cycle.bundle.workflow.tasks;
const task = (id: string) => tasks.find((t) => t.taskId === id)!;
const contract = cycle.bundle.manifest.campaign!;

/** An after_close cycle on a Monday, its read ending on that session. */
const TRADING_DAY = '2026-11-23';
const CLOCK = {
  timestamp: `${TRADING_DAY}T16:23:00-05:00`,
  isOpen: false,
  nextOpen: '2026-11-24T09:30:00-05:00',
  nextClose: '2026-11-24T16:00:00-05:00',
};
const SESSIONS = weekdaySessions(TRADING_DAY, REGIME_BARS_LOOKBACK_DAYS);
const INDEX_BODY = alpacaBarsBody(REGIME_INDEXES, SESSIONS);
const UNIVERSE_BODY = alpacaBarsBody(PRODUCTION_UNIVERSE, SESSIONS);

async function projectRead(taskId: string, body: unknown) {
  const stored = new Map<string, unknown>();
  const raw = apiCallOutput(body, `gs://run/${taskId}/1/body.json`, stored);
  const t = task(taskId);
  const projection = t.outputProjection as WorkflowTaskOutputProjection;
  const source = await loadProjectionSource(projection, raw, payloadStoreOf(stored));
  const projected = projectTaskOutput(projection, source, null);
  if (!projected.ok) throw new Error(JSON.stringify(projected.failures));
  return { raw, output: projected.value };
}

describe('alpaca-thesis-trading at production size', () => {
  it('runs the campaign contract’s ceiling: 30 members, the size the rehearsal starts', () => {
    expect(PRODUCTION_UNIVERSE).toHaveLength(30);
    expect(contract.fields['universe']?.schema).toMatchObject({ maxItems: 30 });
    expect(ALPACA_REHEARSAL_CAMPAIGN.universe).toEqual([...PRODUCTION_UNIVERSE]);
    // The regime reads 50 sessions of each index and 20 of every member.
    expect(
      REGIME_INDEXES.length * INDEX_LOOKBACK_SESSIONS +
        PRODUCTION_UNIVERSE.length * MEMBER_LOOKBACK_SESSIONS,
    ).toBe(750);
  });

  it('the universe read is larger than the inline payload limit, so it is offloaded', async () => {
    expect(byteLength(UNIVERSE_BODY)).toBeGreaterThan(MAX_INLINE_PAYLOAD_BYTES * 3);
    const { raw } = await projectRead(READ_UNIVERSE_BARS_TASK_ID, UNIVERSE_BODY);
    expect(raw).toHaveProperty('dataRef');
  });

  it('both reads project the full body behind the dataRef, and their contracts hold it', async () => {
    for (const [taskId, body] of [
      [READ_INDEX_BARS_TASK_ID, INDEX_BODY],
      [READ_UNIVERSE_BARS_TASK_ID, UNIVERSE_BODY],
    ] as const) {
      const { output } = await projectRead(taskId, body);
      expect(output['bars']).toEqual(body.bars);
      const schema = task(taskId).outputContract!.schema as Record<string, unknown>;
      expect(ajv.compile(schema)(output), taskId).toBe(true);
    }
  });

  it('gather-regime computes the regime of all 30 members by rule, and its output stays small', async () => {
    const indexRead = await projectRead(READ_INDEX_BARS_TASK_ID, INDEX_BODY);
    const universeRead = await projectRead(READ_UNIVERSE_BARS_TASK_ID, UNIVERSE_BODY);
    const t = task('gather-regime');
    const bound = {
      tradingDay: TRADING_DAY,
      slot: 'after_close',
      clockTimestamp: CLOCK.timestamp,
      marketIsOpen: CLOCK.isOpen,
      nextOpen: CLOCK.nextOpen,
      nextClose: CLOCK.nextClose,
      indexBars: indexRead.output['bars'],
      memberBars: universeRead.output['bars'],
      universe: [...PRODUCTION_UNIVERSE],
    };
    const input = WorkflowRunDeriveInputSchema.parse(
      substituteTemplateBinds(
        t.inputTemplate as Record<string, unknown>,
        bound,
        new Set(Object.keys(t.inputBindings ?? {})),
      ),
    );
    const derived = getRunDeriver(input.deriver)!(input.args);
    if (!derived.ok) throw new Error(derived.message);
    const projected = projectTaskOutput(
      t.outputProjection as WorkflowTaskOutputProjection,
      { deriver: input.deriver, value: derived.value },
      input,
    );
    if (!projected.ok) throw new Error(JSON.stringify(projected.failures));
    const regime = projected.value as {
      marketRegime: { asOf: string; breadth: { total: number } };
    };
    expect(regime.marketRegime.asOf).toBe(TRADING_DAY);
    expect(regime.marketRegime.breadth.total).toBe(30);
    expect(ajv.compile(t.outputContract!.schema as Record<string, unknown>)(projected.value)).toBe(
      true,
    );
    expect(byteLength(projected.value)).toBeLessThan(2_000);
  });

  it('campaign start’s universe check accepts the 30 members over the lookback', () => {
    expect(universeCoverageGaps(PRODUCTION_UNIVERSE, UNIVERSE_BODY.bars, TRADING_DAY)).toEqual([]);
  });

  it('no agent task of the bundle needs more output than a model the space may assign can give', () => {
    const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
    const flagged = bundle.skillCatalogIds.flatMap((id) => {
      const skill = getSkillCatalogEntry(id)!;
      const { validity } = materializeAndValidateSkillConfig({
        tasks: skill.bundle.workflow.tasks,
        campaign: { contract: skill.bundle.manifest.campaign },
      });
      return [...validity.diagnostics, ...validity.advisories]
        .filter((d) => d.code === 'output_budget_exceeded')
        .map((d) => `${id}/${d.taskId ?? '?'}: ${d.detail}`);
    });
    expect(flagged).toEqual([]);
  });

  it('flags the agent gather-regime that copied the 750 closes, at this size and not at three members', () => {
    const copier = legacyAgentGatherRegime();
    const atProduction = outputBudgetDiagnostics([copier], contract);
    expect(atProduction.map((d) => d.code)).toEqual(['output_budget_exceeded']);
    const three = {
      ...contract,
      fields: {
        ...contract.fields,
        universe: { ...contract.fields['universe']!, schema: { type: 'array', maxItems: 3 } },
      },
    };
    expect(outputBudgetDiagnostics([copier], three)).toEqual([]);
    const estimate = estimatePinnedOutputTokens(copier, [copier], contract)!;
    expect(estimate.scaled).toEqual([
      { path: '$.memberCloses', count: 30, source: '$campaign.universe' },
    ]);
  });
});

/**
 * gather-regime as it was before the regime was computed by rule: an agent
 * whose pinned output held fifty closes of each index and twenty of every
 * member, the member count bound to the campaign universe.
 */
function legacyAgentGatherRegime(): WorkflowTask {
  const bars = (sessions: number) => ({
    type: 'array',
    minItems: sessions,
    maxItems: sessions,
    items: {
      type: 'object',
      required: ['t', 'c'],
      properties: { t: { type: 'string', minLength: 10 }, c: { type: 'number' } },
    },
  });
  return {
    taskId: 'gather-regime',
    name: 'Gather the market regime',
    goal: 'Report the closes and the regime they give.',
    type: 'agent',
    outputContract: {
      schema: {
        type: 'object',
        required: ['indexCloses', 'memberCloses'],
        properties: {
          indexCloses: {
            type: 'object',
            required: [...REGIME_INDEXES],
            properties: Object.fromEntries(
              REGIME_INDEXES.map((i) => [i, bars(INDEX_LOOKBACK_SESSIONS)]),
            ),
          },
          memberCloses: {
            type: 'array',
            items: {
              type: 'object',
              required: ['symbol', 'closes'],
              properties: { symbol: { type: 'string' }, closes: bars(MEMBER_LOOKBACK_SESSIONS) },
            },
          },
        },
      },
      derivedFrom: [
        {
          bindingId: 'regime-member-floor',
          from: '$campaign',
          binding: 'count:$.universe',
          target: '$.memberCloses.minItems',
        },
      ],
    },
  } as WorkflowTask;
}
