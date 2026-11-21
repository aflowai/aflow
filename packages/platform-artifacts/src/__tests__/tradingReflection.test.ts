/**
 * The after-close reflection on the harness (Plan 343 Part C), driven as the
 * scheduler drives it: the day read, the analyst and the writes answered by a
 * script, every decision the skill's own rule.
 */
import { describe, expect, it } from 'vitest';
import AjvModule from 'ajv';
import {
  HostFilePutInputSchema,
  HostHarnessRunInputSchema,
  MemoryPutInputSchema,
  type WorkflowTask,
} from '@aflow/schemas';
import { getSkillBundleEntry } from '../skillBundleCatalog.js';
import { getSkillCatalogEntry } from '../skillCatalog.js';
import {
  ANALYST_TASK_ID,
  READ_DAY_TASK_ID,
  REFLECTION_ANALYST_TASK,
  TRADING_REFLECTION,
  TRADING_REFLECTION_SLUG,
  WRITE_FOLDER_JOURNAL_TASK_ID,
  WRITE_JOURNAL_TASK_ID,
} from '../skillCatalog/tradingReflection.js';
import { runSkillTasks, type TaskAnswer } from './runSkillTasks.js';

const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;
const ajv = new AjvCtor({ allErrors: true, strict: false });

const wf = TRADING_REFLECTION.bundle.workflow;
const tasks = wf.tasks as unknown as WorkflowTask[];
const TRADING_DAY = '2026-07-14';
const INPUTS = { bindingId: 'hb_desk', tradingDay: TRADING_DAY };

const DAY = {
  cycles: [
    { path: `/portfolio/theses/cycles/${TRADING_DAY}-after_close.json`, slot: 'after_close' },
  ],
  deskRecords: [{ path: `/research/${TRADING_DAY}/desk-open.json`, outcome: 'set_written' }],
  deskRuns: [],
  lensReviews: [{ path: `/research/${TRADING_DAY}/lens-reviews/open-run-1-round-1.json` }],
  resolutions: [{ path: '/portfolio/theses/resolved/aapl-1.json', outcome: 'falsified' }],
  snapshot: null,
  journal: [],
  readNote: 'Read the day. No snapshot yet.',
};

const ENTRY = `# ${TRADING_DAY}\n\nThe macro lens vetoed one candidate. One thesis falsified.`;

function reflect(overrides: Record<string, TaskAnswer> = {}) {
  return runSkillTasks(
    tasks,
    INPUTS,
    (taskId, input) => {
      if (taskId in overrides) return overrides[taskId]!;
      if (taskId === 'read-campaign') {
        return { campaigns: [{ campaign: { config: { regimeName: 'momentum-1' } } }] };
      }
      if (taskId === READ_DAY_TASK_ID) return DAY;
      if (taskId === ANALYST_TASK_ID) {
        return {
          result: {
            tradingDay: TRADING_DAY,
            headline: 'A veto held, and a falsification taught.',
            entry: ENTRY,
            followUps: ['Weigh the macro veto rate against tomorrow’s resolutions.'],
          },
          harness: { id: 'claude' },
        };
      }
      return { path: input['path'] ?? null };
    },
    wf.stateVariables,
    { runId: 'run-reflect-0714' },
  );
}

describe('Trading Reflection', () => {
  it('ships in the alpaca-thesis-trading bundle', () => {
    expect(getSkillCatalogEntry(TRADING_REFLECTION_SLUG)).toEqual(TRADING_REFLECTION);
    expect(getSkillBundleEntry('alpaca-thesis-trading')!.skillCatalogIds).toContain(
      TRADING_REFLECTION_SLUG,
    );
  });

  it('the reflection harness run writes the journal entry to the journal path the bundle defines', () => {
    const run = reflect();
    const call = HostHarnessRunInputSchema.parse(run.inputs.get(ANALYST_TASK_ID));
    expect(call.task).toBe(REFLECTION_ANALYST_TASK);
    expect(call.bindingId).toBe('hb_desk');
    // The analyst reads the day's cycle docs, desk records, lens records, resolutions and journal.
    expect(call.inputs).toMatchObject({ tradingDay: TRADING_DAY, day: DAY });
    const validate = ajv.compile(call.outputSchema!);
    expect(validate({ tradingDay: TRADING_DAY, headline: 'h', entry: 'e', followUps: [] })).toBe(
      true,
    );
    expect(validate({ tradingDay: '2026-07-13', headline: 'h', entry: 'e', followUps: [] })).toBe(
      false,
    );

    const journal = MemoryPutInputSchema.parse(run.inputs.get(WRITE_JOURNAL_TASK_ID));
    expect(journal.path).toBe(`/research/journal/${TRADING_DAY}.md`);
    expect(journal.content).toEqual({ inlineText: ENTRY });
    const folder = HostFilePutInputSchema.parse(run.inputs.get(WRITE_FOLDER_JOURNAL_TASK_ID));
    expect(folder).toMatchObject({ path: `journal/${TRADING_DAY}.md`, content: ENTRY });
    expect(run.state).toMatchObject({
      reflectionOutcome: 'written',
      journalPath: `/research/journal/${TRADING_DAY}.md`,
      headline: 'A veto held, and a falsification taught.',
    });
    // The bundle defines the same path, and the desk reads it.
    const doc = getSkillBundleEntry('alpaca-thesis-trading')!.memorySeed[0]!.content;
    expect(doc).toContain('## Journal — `/research/journal/{tradingDay}.md`');
  });

  it('runs the analysis on the harness alone: the Runner only reads, and the writes are operations', () => {
    const harness = tasks.filter((t) => t.operation === 'host.harness.run').map((t) => t.taskId);
    expect(harness).toEqual([ANALYST_TASK_ID]);
    const agents = tasks.filter((t) => t.type === 'agent');
    expect(agents.map((t) => t.taskId)).toEqual([READ_DAY_TASK_ID]);
    expect(agents[0]!.context?.capabilities?.operations).toEqual([
      'memory.store.query',
      'memory.store.get',
    ]);
    for (const taskId of [WRITE_JOURNAL_TASK_ID, WRITE_FOLDER_JOURNAL_TASK_ID]) {
      expect(tasks.find((t) => t.taskId === taskId)?.type).toBe('operation');
    }
  });

  it('a day it cannot read writes no entry, and says why', () => {
    const run = reflect({ [READ_DAY_TASK_ID]: 'fail' });
    expect(run.ran).not.toContain(ANALYST_TASK_ID);
    expect(run.statuses.get(WRITE_JOURNAL_TASK_ID)).toBe('skipped');
    expect(run.state['reflectionOutcome']).toBe('day_unread');
    const noAnalyst = reflect({ [ANALYST_TASK_ID]: 'fail' });
    expect(noAnalyst.state['reflectionOutcome']).toBe('no_entry');
  });

  it('the Helmsman schedule fires it and keeps only supervision', () => {
    const bundle = getSkillBundleEntry('alpaca-thesis-trading')!;
    const hints = bundle.helmsmanHints.join('\n');
    expect(hints).toContain('45 16 * * 1-5');
    expect(hints).toContain('starts trading-reflection');
    expect(hints).toContain('write no reflection');
    expect(hints).not.toContain('reflect on the day after the close');
    expect(bundle.description).toContain(
      'the Helmsman supervises the run and writes no reflection',
    );
  });
});
