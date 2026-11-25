/**
 * The desk's goals and principles as files in the connected folder (Plan 343
 * Part E). The Desk Charter skill writes them once its reviewer approves.
 * The Strategy Desk's principles lens reads them, and the Performance Review
 * judges each period against them. The paths are skill inputs with these
 * defaults. A missing file is read as absent, never as a failure. A read that
 * fails for any other reason, such as a path that names a directory, is a
 * failed read. The Performance Review decides on the two under notes of its
 * own, and applies no correction that rests on a file it could not read.
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
    goal: `Read the ${file} file from the connected folder. A folder without it answers found: false, and that is no failure. Any other failure of the read fails this task.`,
    type: 'operation' as const,
    operation: 'host.file.get',
    dependsOn: [...args.dependsOn],
    ...(args.when !== undefined ? { when: args.when } : {}),
    // A missing file succeeds with found: false. Any other failure fails the task, and binds nothing.
    optional: true,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: { bindingId: runInput('bindingId'), [input]: runInput(input) },
    context: ctx('host.file.get'),
    inputTemplate: { bindingId: bind('bindingId'), path: template(), ifMissing: 'absent' },
    outputProjection: {
      path: { path: 'path', onMissing: 'null' as const },
      // false where the file is missing, null where it was read.
      found: { path: 'found', onMissing: 'null' as const },
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

/** What each status says to the skill that reads it, in that skill's own terms. */
export interface PrinciplesFilesNotes {
  readonly goal: string;
  readonly absent: string;
  readonly readFailed: string;
  readonly present: string;
  /** Where given, what a report states where a read failed, whatever was applied. */
  readonly readFailedReport?: string;
}

/**
 * A file neither read nor found missing: its read failed. A read that found
 * the file always carries its revision, so the decision binds the revision
 * and never the content.
 */
const readFailed = (
  file: 'goals' | 'principles',
  notes: PrinciplesFilesNotes,
): WorkflowRunDecideRule => ({
  when: { allOf: [`state.${file}Found != false`, `state.${file}Revision == null`] },
  decision: 'read_failed',
  reason: notes.readFailed,
  value: {
    status: 'read_failed',
    verdicts: ['rejected'],
    ...(notes.readFailedReport !== undefined ? { reportNote: notes.readFailedReport } : {}),
  },
});

export function principlesFilesRules(notes: PrinciplesFilesNotes): WorkflowRunDecideRule[] {
  return [
    readFailed('goals', notes),
    readFailed('principles', notes),
    {
      when: { allOf: ['state.goalsFound == false', 'state.principlesFound == false'] },
      decision: 'absent',
      reason: notes.absent,
      value: { status: 'absent', verdicts: ['approved'] },
    },
  ];
}

export function principlesFilesOtherwise(notes: PrinciplesFilesNotes) {
  return {
    decision: 'present',
    reason: notes.present,
    value: { status: 'present', verdicts: [...REVIEWER_VERDICTS] },
  };
}

export function principlesFilesTask(args: { when: When; notes: PrinciplesFilesNotes }) {
  const { notes } = args;
  return {
    taskId: PRINCIPLES_FILES_TASK_ID,
    name: 'Decide whether the principles apply',
    goal: notes.goal,
    type: 'operation' as const,
    operation: 'workflow.run.decide',
    dependsOn: [READ_GOALS_TASK_ID, READ_PRINCIPLES_TASK_ID],
    when: args.when,
    retryability: 'safe' as const,
    maxAttempts: 1,
    inputBindings: {
      goalsFound: out(READ_GOALS_TASK_ID, 'found'),
      goalsRevision: out(READ_GOALS_TASK_ID, 'revision'),
      principlesFound: out(READ_PRINCIPLES_TASK_ID, 'found'),
      principlesRevision: out(READ_PRINCIPLES_TASK_ID, 'revision'),
    },
    context: ctx('workflow.run.decide'),
    inputTemplate: {
      // A read that failed binds nothing, so its found and revision both read null.
      state: {
        goalsFound: bind('goalsFound'),
        goalsRevision: bind('goalsRevision'),
        principlesFound: bind('principlesFound'),
        principlesRevision: bind('principlesRevision'),
      },
      rules: principlesFilesRules(notes),
      otherwise: principlesFilesOtherwise(notes),
    },
    outputProjection: {
      status: { path: 'value.status', onMissing: 'error' as const },
      verdicts: { path: 'value.verdicts', onMissing: 'error' as const },
      note: { path: 'reason', onMissing: 'error' as const },
      reportNote: { path: 'value.reportNote', onMissing: 'null' as const },
    },
  };
}
