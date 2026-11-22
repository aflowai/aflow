/**
 * Boundary authoring on the harness (Plan 343 Part C), driven as the
 * scheduler drives it: the ledger read, the strategist and the lenses
 * answered by a script, the verdict and the settlement the skill's own rules.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import { HostHarnessRunInputSchema, MemoryPutInputSchema, type WorkflowTask } from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  BOUNDARY_LENS_READS,
  BOUNDARY_OUTCOMES,
  boundaryLensTaskId,
  CAMPAIGN_SUCCESSOR,
  CAMPAIGN_SUCCESSOR_SLUG,
  DRAFT_TASK_ID,
  READ_LEDGER_TASK_ID,
  VERDICT_TASK_ID,
  WRITE_DRAFT_TASK_ID,
} from '../skillCatalog/campaignSuccessor.js';
import { DAILY_TRADING_CYCLE_CAMPAIGN } from '../skillCatalog/dailyTradingCycleCampaign.js';
import { BOUNDARY_LENSES, type BoundaryLens } from '../skillCatalog/campaignSuccessorProse.js';
import { runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = CAMPAIGN_SUCCESSOR.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];
const task = (taskId: string) => tasks.find((t) => t.taskId === taskId)!;
const RUN_ID = 'run-boundary-1';
const CAMPAIGN_ID = '8c1f2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const CONFIG = {
  regimeName: 'momentum-breakouts-1',
  hypotheses: [
    {
      id: 'momentum-breakouts',
      name: 'Momentum breakouts',
      statement: 'Momentum breakouts on liquid large-caps resolve within 1-5 days.',
      thesisBudgetPerDay: 2,
    },
  ],
  universe: ['AAPL', 'MSFT', 'SPY'],
  maxThesesPerDay: 3,
  maxPositionSizePct: 8,
  maxGrossExposurePct: 60,
  minHorizonTradingDays: 1,
  maxHorizonTradingDays: 5,
  windowTradingDays: 20,
  pooledSampleFloor: 30,
  expectancyFloorR: 0.2,
  calibrationRule: { low: 0.4, medium: 0.55, high: 0.7, maxGap: 0.15 },
};

const SUCCESSOR = { ...CONFIG, regimeName: 'momentum-breakouts-2', maxThesesPerDay: 2 };

const LEDGER = {
  resolvedTheses: [{ path: '/portfolio/theses/resolved/aapl-1.json', outcome: 'falsified' }],
  openTheses: [],
  armTable: null,
  lensReviews: [],
  journal: [],
  ledgerNote: 'Read the campaign ledger.',
};

function boundary(verdicts: Partial<Record<BoundaryLens, string | 'fail'>> = {}, campaigns = true) {
  return runSkillTasks(
    tasks,
    { bindingId: 'hb_desk' },
    (taskId, input): TaskAnswer => {
      if (taskId === 'read-campaign') {
        return {
          campaigns: campaigns ? [{ campaign: { campaignId: CAMPAIGN_ID, config: CONFIG } }] : [],
        };
      }
      if (taskId === READ_LEDGER_TASK_ID) return LEDGER;
      if (taskId === DRAFT_TASK_ID) {
        return {
          result: {
            successor: SUCCESSOR,
            arms: [{ hypothesisId: 'momentum-breakouts', decision: 'carry', reason: 'Earned.' }],
            rationale: 'The arm cleared its expectancy floor.',
            memo: '# Boundary memo',
          },
          harness: { id: 'claude' },
        };
      }
      const lens = BOUNDARY_LENSES.find((l) => taskId === boundaryLensTaskId(l));
      if (lens !== undefined) {
        const verdict = verdicts[lens] ?? 'approved';
        if (verdict === 'fail') return 'fail';
        return { result: { lens, verdict, reason: `The ${lens} lens: ${verdict}.` } };
      }
      return { path: input['path'] ?? null };
    },
    wf.stateVariables,
    { runId: RUN_ID },
  );
}

const DRAFT_PATH = `/research/campaigns/${CONFIG.regimeName}/successor-${RUN_ID}.json`;

describe('Campaign Successor', () => {
  it('ships in the alpaca-thesis-trading bundle', () => {
    expect(getSkillCatalogEntry(CAMPAIGN_SUCCESSOR_SLUG)).toEqual(CAMPAIGN_SUCCESSOR);
    expect(getSkillBundleEntry('alpaca-thesis-trading')!.skillCatalogIds).toContain(
      CAMPAIGN_SUCCESSOR_SLUG,
    );
  });

  it('the strategist drafts the successor on the harness, held to the campaign contract', () => {
    const run = boundary();
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(DRAFT_TASK_ID));
    expect(call.inputs).toMatchObject({ campaign: CONFIG, ledger: LEDGER });
    expect((call.inputs as { goals: unknown[] }).goals.length).toBeGreaterThan(0);
    const validate = ajv.compile(call.outputSchema!);
    const draft = { successor: SUCCESSOR, arms: [], rationale: 'r', memo: 'm' };
    expect(validate(draft)).toBe(true);
    // The successor names a new regime, and carries every field the contract declares.
    expect(validate({ ...draft, successor: CONFIG })).toBe(false);
    const { pooledSampleFloor: _floor, ...partial } = SUCCESSOR;
    expect(validate({ ...draft, successor: partial })).toBe(false);
    expect(validate({ ...draft, successor: { ...SUCCESSOR, maxThesesPerDay: 11 } })).toBe(false);
    expect(Object.keys(DAILY_TRADING_CYCLE_CAMPAIGN.fields).sort()).toEqual(
      Object.keys(SUCCESSOR).sort(),
    );
  });

  it('the boundary draft is reviewed by every lens before it is data', () => {
    const run = boundary();
    const write = run.ran.indexOf(WRITE_DRAFT_TASK_ID);
    expect(write).toBeGreaterThan(-1);
    for (const lens of BOUNDARY_LENSES) {
      expect(run.ran.indexOf(boundaryLensTaskId(lens)), lens).toBeLessThan(write);
      expect(task(WRITE_DRAFT_TASK_ID).dependsOn).toContain(boundaryLensTaskId(lens));
      const call = HostHarnessRunInputSchema.parse(run.inputs.get(boundaryLensTaskId(lens)));
      expect((call.inputs as { focus: string }).focus).toBe(lens);
      expect(Object.keys((call.inputs as { ledger: object }).ledger).sort(), lens).toEqual(
        ['ledgerNote', ...BOUNDARY_LENS_READS[lens]].sort(),
      );
    }
    expect(task(WRITE_DRAFT_TASK_ID).dependsOn).toContain(VERDICT_TASK_ID);
    const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_DRAFT_TASK_ID));
    expect(put.path).toBe(DRAFT_PATH);
    expect(put.content.inlineJson).toMatchObject({
      fromCampaignId: CAMPAIGN_ID,
      verdict: 'approved',
      config: SUCCESSOR,
      lenses: { risk: { verdict: 'approved', reason: 'The risk lens: approved.' } },
    });
    expect(run.state).toMatchObject({
      boundaryOutcome: 'draft_approved',
      draftVerdict: 'approved',
      draftPath: DRAFT_PATH,
    });
  });

  it('one lens rejection rejects the draft, and the record says which lens said what', () => {
    const run = boundary({ risk: 'rejected', macro: 'revise' });
    expect(run.state['draftVerdict']).toBe('rejected');
    expect(run.state['boundaryOutcome']).toBe('draft_rejected');
    expect(run.state['boundaryReason']).toBe(BOUNDARY_OUTCOMES.draft_rejected);
    const put = MemoryPutInputSchema.parse(run.inputs.get(WRITE_DRAFT_TASK_ID));
    expect(put.content.inlineJson).toMatchObject({
      verdict: 'rejected',
      lenses: { risk: { verdict: 'rejected' }, macro: { verdict: 'revise' } },
    });
    expect(boundary({ technical: 'revise' }).state['boundaryOutcome']).toBe('draft_revise');
  });

  it('a draft no lens could review never becomes data', () => {
    const run = boundary({ priorLearnings: 'fail' });
    expect(run.state['draftVerdict']).toBe('review_failed');
    expect(run.statuses.get(WRITE_DRAFT_TASK_ID)).toBe('skipped');
    expect(run.state['boundaryOutcome']).toBe('review_failed');
    expect(run.state).not.toHaveProperty('draftPath');
  });

  it('starts and ends no campaign: the boundary applies an approved draft', () => {
    const operations = tasks.map((t) => t.operation);
    expect(operations).not.toContain('workflow.campaign.start');
    expect(operations).not.toContain('workflow.campaign.end');
    expect(wf.usage?.next?.[0]?.when).toContain('draft_approved');
    const none = boundary({}, false);
    expect(none.ran).not.toContain(DRAFT_TASK_ID);
    expect(none.state['boundaryOutcome']).toBe('unframed');
  });
});
