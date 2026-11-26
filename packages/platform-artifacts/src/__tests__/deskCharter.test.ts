/**
 * The Desk Charter (Plan 343 Part E), driven as the scheduler drives it: the
 * file reads, the analyst, the reviewer and the writes answered by a script.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  HostFilePutInputSchema,
  HostHarnessRunInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  CHARTER_DRAFT_SCHEMA,
  DESK_CHARTER,
  DESK_CHARTER_SLUG,
  DRAFT_TASK_ID,
  GOAL_HORIZONS,
  GOAL_LAYERS,
  PRINCIPLE_KINDS,
  REVIEW_TASK_ID,
  WRITE_GOALS_TASK_ID,
  WRITE_FAILED_REASONS,
  WRITE_PRINCIPLES_TASK_ID,
} from '../skillCatalog/deskCharter.js';
import { DEFAULT_GOALS_PATH, DEFAULT_PRINCIPLES_PATH } from '../skillCatalog/strategyPrinciples.js';
import { CAMPAIGN_CONTRACT_FIELDS } from '../skillCatalog/tradingCampaignRead.js';
import { runSkillTasks, type TaskAnswer } from '@aflow/cybernetic-runtime';
import { PRODUCTION_UNIVERSE } from './productionSize.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = DESK_CHARTER.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];

const DRAFT = {
  goals: {
    markdown: '# Goals\n\nBeat SPY over the window.',
    thresholds: GOAL_LAYERS.flatMap((layer) =>
      GOAL_HORIZONS.map((horizon) => ({
        id: `${layer}-${horizon}`,
        layer,
        horizon,
        metric: layer === 'layer1' ? 'cycle reliability' : 'excess return over SPY',
        comparator: '>=',
        value: layer === 'layer1' ? 0.95 : 0,
        statement: `The ${layer} bar per ${horizon}.`,
      })),
    ),
  },
  principles: {
    markdown: '# Principles\n\nNever average into a falsified thesis.',
    rules: PRINCIPLE_KINDS.map((kind) => ({
      id: kind.replace(/_/g, '-'),
      kind,
      rule: `The ${kind} rule.`,
    })),
  },
  rationale: 'From the plan doc, part E, and the campaign contract.',
};

function charter(
  review: 'approved' | 'revise' | 'rejected' | 'fail',
  existing: { goals?: string } = {},
  overrides: Record<string, TaskAnswer> = {},
) {
  return runSkillTasks(
    tasks,
    { bindingId: 'hb_desk', planPath: 'plans/343.md' },
    (taskId, input) => {
      if (taskId in overrides) return overrides[taskId]!;
      if (taskId === 'read-campaign') {
        return { campaigns: [{ campaign: { config: { regimeName: 'momentum-1' } } }] };
      }
      if (taskId === 'read-goals') {
        return existing.goals === undefined
          ? { path: input['path'], found: false }
          : { path: input['path'], content: existing.goals, revision: 'rev-goals' };
      }
      if (taskId === 'read-principles') return { path: input['path'], found: false };
      if (taskId === DRAFT_TASK_ID) return { result: DRAFT, harness: { id: 'claude' } };
      if (taskId === REVIEW_TASK_ID) {
        return review === 'fail'
          ? 'fail'
          : { result: { verdict: review, findings: [], reason: `The drafts are ${review}.` } };
      }
      return { path: input['path'], revision: 'rev-new', created: true, bytesWritten: 10 };
    },
    wf.stateVariables,
    { runId: 'run-charter-1' },
  );
}

describe('Desk Charter', () => {
  it('ships in the alpaca-thesis-trading bundle', () => {
    expect(getSkillCatalogEntry(DESK_CHARTER_SLUG)).toEqual(DESK_CHARTER);
    expect(getSkillBundleEntry('alpaca-thesis-trading')!.skillCatalogIds).toContain(
      DESK_CHARTER_SLUG,
    );
  });

  it('writes nothing before its reviewer pass approves', () => {
    for (const verdict of ['revise', 'rejected', 'fail'] as const) {
      const run = charter(verdict);
      expect(run.statuses.get(WRITE_GOALS_TASK_ID)).toBe('skipped');
      expect(run.statuses.get(WRITE_PRINCIPLES_TASK_ID)).toBe('skipped');
      expect(run.state['charterOutcome']).toBe(
        verdict === 'fail' ? 'review_failed' : 'not_approved',
      );
    }
    const approved = charter('approved');
    const reviewedAt = approved.ran.indexOf(REVIEW_TASK_ID);
    for (const write of [WRITE_GOALS_TASK_ID, WRITE_PRINCIPLES_TASK_ID]) {
      expect(approved.ran.indexOf(write)).toBeGreaterThan(reviewedAt);
    }
    expect(approved.state['charterOutcome']).toBe('written');
    const goals = HostFilePutInputSchema.parse(approved.inputs.get(WRITE_GOALS_TASK_ID));
    expect(goals).toMatchObject({
      bindingId: 'hb_desk',
      path: DEFAULT_GOALS_PATH,
      content: DRAFT.goals.markdown,
    });
    // A file the folder did not hold is created.
    expect(goals.expectedRevision).toBeUndefined();
    const principles = HostFilePutInputSchema.parse(approved.inputs.get(WRITE_PRINCIPLES_TASK_ID));
    expect(principles).toMatchObject({
      path: DEFAULT_PRINCIPLES_PATH,
      content: DRAFT.principles.markdown,
    });
  });

  it('the analyst and the reviewer read only the fields the campaign contract declares', () => {
    const declared = Object.fromEntries(CAMPAIGN_CONTRACT_FIELDS.map((field) => [field, null]));
    const current = { ...declared, regimeName: 'momentum-1', universe: [...PRODUCTION_UNIVERSE] };
    const legacy = {
      ...current,
      maxThesesPerDay: 3,
      maxPositionSizePct: 8,
      maxGrossExposurePct: 60,
      regimeCaps: { stressed: 27 },
    };
    const run = charter(
      'approved',
      {},
      {
        'read-campaign': { campaigns: [{ campaign: { config: legacy } }] },
      },
    );
    for (const id of [DRAFT_TASK_ID, REVIEW_TASK_ID]) {
      const harness = HostHarnessRunInputSchema.parse(run.inputs.get(id));
      expect(harness.inputs?.['campaign'], id).toEqual(current);
      expect(JSON.stringify(harness.inputs), id).not.toMatch(
        /maxThesesPerDay|maxPositionSizePct|maxGrossExposurePct|regimeCaps/,
      );
      expect(harness.task, id).toContain('No rule caps a size, a count or an exposure.');
    }
    // With no active campaign the analyst still drafts, every declared field null.
    const none = charter('approved', {}, { 'read-campaign': { campaigns: [] } });
    const bare = HostHarnessRunInputSchema.parse(none.inputs.get(DRAFT_TASK_ID));
    expect(bare.inputs?.['campaign']).toEqual(declared);
  });

  it('writes only to the folder binding: no memory write, no order, no campaign change', () => {
    const writes = tasks.filter(
      (t) => t.operation !== undefined && /\.(put|start|end|update|patch|call)$/.test(t.operation),
    );
    expect(writes.map((t) => t.operation)).toEqual(['host.file.put', 'host.file.put']);
    expect(tasks.some((t) => t.type === 'agent')).toBe(false);
  });

  it('replaces a file already there at the revision it read, so an edit since is a conflict', () => {
    const run = charter('approved', { goals: '# Old goals' });
    const draft = HostHarnessRunInputSchema.parse(run.inputs.get(DRAFT_TASK_ID));
    expect(draft.inputs).toMatchObject({
      planPath: 'plans/343.md',
      current: { goals: '# Old goals' },
    });
    const goals = HostFilePutInputSchema.parse(run.inputs.get(WRITE_GOALS_TASK_ID));
    expect(goals.expectedRevision).toBe('rev-goals');
    const failed = charter('approved', {}, { [WRITE_PRINCIPLES_TASK_ID]: 'fail' });
    expect(failed.state['charterOutcome']).toBe('write_failed');
  });

  it('creates the strategy directory on a first run, so a folder without one is written', () => {
    const run = charter('approved');
    for (const write of [WRITE_GOALS_TASK_ID, WRITE_PRINCIPLES_TASK_ID]) {
      expect(HostFilePutInputSchema.parse(run.inputs.get(write)).createParents).toBe(true);
    }
    expect(run.state['charterOutcome']).toBe('written');
  });

  it('says why a file was not written, from what the run read before the write', () => {
    const created = charter('approved', {}, { [WRITE_GOALS_TASK_ID]: 'fail' });
    expect(created.state).toMatchObject({
      charterOutcome: 'write_failed',
      charterReason: WRITE_FAILED_REASONS.created('goals'),
    });
    const changed = charter('approved', { goals: '# Old' }, { [WRITE_GOALS_TASK_ID]: 'fail' });
    expect(changed.state['charterReason']).toBe(WRITE_FAILED_REASONS.changed('goals'));
    expect(changed.state['charterReason']).toContain('changed or removed since');
    const unread = charter(
      'approved',
      {},
      { 'read-principles': 'fail', [WRITE_PRINCIPLES_TASK_ID]: 'fail' },
    );
    expect(unread.state['charterReason']).toBe(WRITE_FAILED_REASONS.read_failed('principles'));
    expect(unread.state['charterReason']).toContain('read-principles');
  });

  it('the draft holds every principle kind and a threshold for each layer and horizon', () => {
    const validate = ajv.compile(CHARTER_DRAFT_SCHEMA);
    expect(validate(DRAFT)).toBe(true);
    const noHalt = {
      ...DRAFT,
      principles: {
        ...DRAFT.principles,
        rules: [
          ...DRAFT.principles.rules.filter((r) => r.kind !== 'mid_window_halt'),
          DRAFT.principles.rules[0],
        ],
      },
    };
    expect(validate(noHalt)).toBe(false);
    const noQuarter = {
      ...DRAFT,
      goals: {
        ...DRAFT.goals,
        thresholds: DRAFT.goals.thresholds.map((t) => ({ ...t, horizon: 'window' })),
      },
    };
    expect(validate(noQuarter)).toBe(false);
  });
});
