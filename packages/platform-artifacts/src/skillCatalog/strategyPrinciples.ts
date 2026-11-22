/**
 * The desk's goals and principles as files in the connected folder (Plan 343
 * Part E). The Desk Charter skill writes them once its reviewer approves.
 * The Strategy Desk's principles lens reviews every candidate against them,
 * and the Performance Review judges each period against them. The paths are
 * skill inputs with these defaults. A missing file is read as absent, never
 * as a failure: the principles lens then approves with a note, and the
 * review reports each goal it cannot read as a measurement gap.
 */
import type { WorkflowRunDecideRule } from '@aflow/schemas';
import { REVIEWER_VERDICTS } from './dailyTradingCycleLenses.js';
import { bind, ctx, out, runInput } from './localPrShepherdWiring.js';

export const DEFAULT_GOALS_PATH = 'strategy/goals.md';
export const DEFAULT_PRINCIPLES_PATH = 'strategy/principles.md';

export const READ_GOALS_TASK_ID = 'read-goals';
export const READ_PRINCIPLES_TASK_ID = 'read-principles';
export const PRINCIPLES_FILES_TASK_ID = 'principles-files';

const FOLDER_PATH_SCHEMA = { type: 'string', minLength: 1, maxLength: 256 };

/** The two path inputs every skill that reads or writes the files takes. */
export const STRATEGY_FILE_INPUTS = [
  {
    id: 'goalsPath',
    required: false,
    description: `Where the goals file is in the connected folder, relative to its root. Absent, ${DEFAULT_GOALS_PATH}.`,
    schema: FOLDER_PATH_SCHEMA,
  },
  {
    id: 'principlesPath',
    required: false,
    description: `Where the principles file is in the connected folder, relative to its root. Absent, ${DEFAULT_PRINCIPLES_PATH}.`,
    schema: FOLDER_PATH_SCHEMA,
  },
];

/** The configured path, or its default. */
export const goalsPathOf = () => ({ $firstOf: [bind('goalsPath'), DEFAULT_GOALS_PATH] });
export const principlesPathOf = () => ({
  $firstOf: [bind('principlesPath'), DEFAULT_PRINCIPLES_PATH],
});

export type StrategyFile = 'goals' | 'principles';

/** The run input naming a file's path, and the template giving it or its default. */
export const STRATEGY_FILE_PATH = {
  goals: { input: 'goalsPath', template: goalsPathOf },
  principles: { input: 'principlesPath', template: principlesPathOf },
} as const;

type When =
  { expression: string; onMissingRef: 'skip' } | { allOf: string[]; onMissingRef: 'skip' };

function readFileTask(
  taskId: string,
  file: StrategyFile,
  args: { dependsOn: readonly string[]; when?: When },
) {
  const { input, template } = STRATEGY_FILE_PATH[file];
  return {
    taskId,
    name: `Read the ${file} file`,
    goal: `Read the ${file} file from the connected folder. A folder without it leaves its content null, and that is no failure.`,
    type: 'operation' as const,
    operation: 'host.file.get',
    dependsOn: [...args.dependsOn],
    ...(args.when !== undefined ? { when: args.when } : {}),
    // A missing file fails this read, and its content then reads null.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { bindingId: runInput('bindingId'), [input]: runInput(input) },
    context: ctx('host.file.get'),
    inputTemplate: { bindingId: bind('bindingId'), path: template() },
    outputProjection: {
      path: { path: 'path', onMissing: 'null' as const },
      content: { path: 'content', onMissing: 'null' as const },
      revision: { path: 'revision', onMissing: 'null' as const },
    },
  };
}

/** The two reads, under the caller's gate. */
export function readStrategyFileTasks(args: { dependsOn: readonly string[]; when?: When }) {
  return [
    readFileTask(READ_GOALS_TASK_ID, 'goals', args),
    readFileTask(READ_PRINCIPLES_TASK_ID, 'principles', args),
  ];
}

export const PRINCIPLES_ABSENT_NOTE =
  'Neither the goals file nor the principles file is in the folder at its configured path. The principles lens approves every candidate with this note, because a missing file is never a veto.';

/**
 * Whether the files are there, and so which verdicts the principles lens may
 * give. Where both are absent its schema admits only approved, so it cannot
 * veto on a missing file whatever it is asked.
 */
export const PRINCIPLES_FILES_RULES: readonly WorkflowRunDecideRule[] = [
  {
    when: { allOf: ['state.goals == null', 'state.principles == null'] },
    decision: 'absent',
    reason: PRINCIPLES_ABSENT_NOTE,
    value: { status: 'absent', verdicts: ['approved'] },
  },
];

export const PRINCIPLES_FILES_OTHERWISE = {
  decision: 'present',
  reason:
    'The folder holds the goals file, the principles file or both. The principles lens reviews every candidate against what it holds.',
  value: { status: 'present', verdicts: [...REVIEWER_VERDICTS] },
};

export function principlesFilesTask(args: { when: When }) {
  return {
    taskId: PRINCIPLES_FILES_TASK_ID,
    name: 'Decide whether the principles apply',
    goal: 'Decide by rule whether the folder holds the goals or the principles file. Where it holds neither, the principles lens may only approve, with a note. No model is asked.',
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [READ_GOALS_TASK_ID, READ_PRINCIPLES_TASK_ID],
    when: args.when,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      goals: out(READ_GOALS_TASK_ID, 'content'),
      principles: out(READ_PRINCIPLES_TASK_ID, 'content'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      // A read that failed binds nothing, and its content reads null.
      state: { goals: bind('goals'), principles: bind('principles') },
      rules: PRINCIPLES_FILES_RULES,
      otherwise: PRINCIPLES_FILES_OTHERWISE,
    },
    outputProjection: {
      status: { path: 'value.status', onMissing: 'error' as const },
      verdicts: { path: 'value.verdicts', onMissing: 'error' as const },
      note: { path: 'reason', onMissing: 'error' as const },
    },
  };
}
