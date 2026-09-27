/**
 * Host lane — operations that reach the operator's own machine through the
 * paired native executor.
 *
 * Distinct from `compute.sandbox.*`, which runs supplied code over supplied
 * data with no ambient authority. These reach the operator's real projects,
 * installed toolchains and devices, which is the point of the local edition and
 * the reason every one of them is bound to an operator-created host binding.
 *
 * A binding names what the job may reach; the OS boundary enforces it. Neither
 * the operation nor its inputs can widen a binding, so an agent asking for a
 * path outside one is refused rather than negotiated with.
 */
import { z } from 'zod';
import { coerceJsonObjectArg } from './jsonObjectArg.js';

import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { PayloadRefSchema } from '../runtime/payloadRef.js';

/**
 * What a branch name and a branch prefix may be, in one place.
 *
 * Both halves of the host lane read these — the appliance recording what the
 * operator declared, the machine enforcing it, and the patch operation naming a
 * branch to create — and a rule spelled twice is a rule that drifts. The
 * characters refused are the ones that stop a name being a name: a leading `-`
 * reads as an option wherever the value reaches a command line, whitespace
 * splits it, and `..` is how a path climbs.
 */
export const HOST_BRANCH_PREFIX_MAX_LENGTH = 100;
export const HOST_BRANCH_NAME_MAX_LENGTH = 200;

function branchTokenIssue(value: string): string | undefined {
  if (value.startsWith('-')) return 'cannot start with `-`';
  if (/\s/.test(value)) return 'cannot contain whitespace';
  if (value.includes('..')) return 'cannot contain `..`';
  return undefined;
}

function branchToken(maxLength: number, subject: string): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .superRefine((value, ctx) => {
      const issue = branchTokenIssue(value);
      if (issue !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `A ${subject} ${issue}.` });
      }
    });
}

export const HostBranchPrefixSchema = branchToken(
  HOST_BRANCH_PREFIX_MAX_LENGTH,
  'branch prefix',
).describe(
  'Branches this folder may be pushed to, as a prefix — `aflow/` admits `aflow/anything` ' +
    'and nothing else. Absent, the folder pushes nothing.',
);

export const HostBranchNameSchema = branchToken(HOST_BRANCH_NAME_MAX_LENGTH, 'branch name');

/**
 * A commit named the way a person names one — a branch, a tag or a sha. The
 * branch-name rule admits all three; the machine resolves it and refuses a ref
 * the folder does not have.
 */
export const HostBaseRefSchema = branchToken(HOST_BRANCH_NAME_MAX_LENGTH, 'base');

/** Which operator-created binding this job runs against. */
const HostBindingRef = z
  .string()
  .min(1)
  .describe(
    'Id of the host binding to run against. Bindings are created by the operator and ' +
      'name the roots, tools and egress a job may reach; an operation cannot widen one.',
  );

export const HostFileListInputSchema = z.object({
  bindingId: HostBindingRef,
  path: z
    .string()
    .default('.')
    .describe('Path relative to the binding root. Absolute paths and traversal are refused.'),
  recursive: z.boolean().default(false).describe('Descend into subdirectories.'),
  limit: z.number().int().min(1).max(2000).default(200).describe('Maximum entries returned.'),
});

export const HostFileListOutputSchema = z.object({
  entries: z.array(
    z.object({
      path: z.string().describe('Path relative to the binding root.'),
      kind: z.enum(['file', 'directory', 'symlink', 'other']),
      sizeBytes: z.number().int().nonnegative().optional(),
      modifiedAt: z.string().optional(),
    }),
  ),
  truncated: z.boolean().describe('True when more entries exist than `limit` returned.'),
});

export const HostFileGetInputSchema = z.object({
  bindingId: HostBindingRef,
  path: z.string().min(1).describe('File to read, relative to the binding root.'),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .default(1_000_000)
    .describe('Refuse rather than truncate above this size; read it as a payload instead.'),
});

export const HostFileGetOutputSchema = z.object({
  path: z.string(),
  /** The revision a later `host.file.put` must present to replace this file. */
  revision: z
    .string()
    .describe(
      'Content hash at read time. Pass it back to `host.file.put` so a change made ' +
        'outside Aflow is reported as a conflict rather than silently overwritten.',
    ),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const HostFilePutInputSchema = z.object({
  bindingId: HostBindingRef,
  path: z.string().min(1).describe('File to write, relative to the binding root.'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  content: z.string().describe('Bytes to write, in the declared encoding.'),
  /**
   * Absent means create-only. A blind overwrite is not offered: the operator's
   * editor is a second writer, and last-write-wins loses their work silently.
   */
  expectedRevision: z
    .string()
    .optional()
    .describe(
      'Revision from a prior `host.file.get`. Omit to create a file that must not already ' +
        'exist. A mismatch fails as a conflict and writes nothing.',
    ),
});

export const HostFilePutOutputSchema = z.object({
  path: z.string(),
  revision: z.string().describe('Content hash after the write.'),
  created: z.boolean(),
  bytesWritten: z.number().int().nonnegative(),
});

/**
 * Argv rather than a command line. A string would have to be split by something,
 * and whichever shell did the splitting would also expand, glob and substitute —
 * turning a binding's boundary into a quoting exercise.
 */
const Argv = z
  .array(z.string().min(1))
  .min(1)
  .max(64)
  .describe('Program and arguments, unsplit. `["npm", "test"]`, never `"npm test"`.');

export const HostProcessExecInputSchema = z.object({
  bindingId: HostBindingRef,
  command: Argv,
  cwd: z.string().default('.').describe('Working directory relative to the binding root.'),
  env: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      'Extra environment for this process. The binding decides what it inherits; ' +
        'entries here are added to that, never a way around it.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000)
    .describe('Kill the process and its descendants after this long.'),
  detach: z
    .boolean()
    .default(false)
    .describe(
      'Return a handle as soon as it starts instead of waiting for it to finish. ' +
        'Use for something long-running to talk to — a dev server, a REPL, a watch. ' +
        'Read what it says with `host.process.inspect`, answer it with `host.process.input`, ' +
        'and end it with `host.process.stop`. It does not outlive the executor.',
    ),
});

export const HostProcessExecOutputSchema = z.object({
  processId: z
    .string()
    .describe('Handle for `host.process.inspect` and `host.process.stop` while it runs.'),
  /**
   * What ran and where, echoed back so a reader of the result does not have to
   * hold the request to understand it. The handle identifies the process and
   * says nothing about it; these two say which folder and which command, which
   * is what a person scanning a transcript is actually looking for.
   */
  bindingId: z.string().describe('The connected folder this ran in.'),
  command: z.string().describe('The command as it was run, joined for display.'),
  exitCode: z
    .number()
    .int()
    .nullable()
    .describe(
      'The status the command itself ended with, as a shell reports it: its own code, ' +
        'or 128 plus the signal number when a signal killed it (137 for SIGKILL). ' +
        'A pipe closed by a reader that had read enough is the exception — SIGPIPE is 0, ' +
        'because that is success for `… | head` and the output asked for was produced. ' +
        'Null only where nothing could be observed: the process never started, or it was ' +
        'killed before it could report, which a timeout does.',
    ),
  signal: z
    .string()
    .nullable()
    .describe(
      'The signal that killed the command, when one did — named even where `exitCode` is 0, ' +
        'which for SIGPIPE it is. Null when it ended on its own.',
    ),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string().optional().describe('Omitted when the output went to a payload instead.'),
  stderr: z.string().optional(),
  outputRef: z.string().optional().describe('PayloadRef when output exceeded the inline cap.'),
  truncated: z.boolean().describe('True when captured output was capped.'),
  confined: z
    .boolean()
    .describe(
      'Whether the command ran inside the sandbox. A permitted push runs as the ' +
        "operator's own git and does not.",
    ),
  boundaryNote: z
    .string()
    .optional()
    .describe(
      'Why a command could not start, when the reason was the boundary rather than the ' +
        'command. Present only when something was refused.',
    ),
  detached: z
    .boolean()
    .optional()
    .describe('True when this returned a handle rather than a finished process.'),
});

export const HostProcessInputInputSchema = z.object({
  bindingId: HostBindingRef,
  processId: z.string().min(1).describe('The handle `host.process.exec` returned.'),
  input: z
    .string()
    .max(64 * 1024)
    .describe('Written to the process verbatim. Include a trailing newline if it reads lines.'),
});

export const HostProcessInputOutputSchema = z.object({
  state: z
    .enum(['written', 'exited', 'no_stdin'])
    .describe('`exited` means the process ended before this arrived; nothing was written.'),
});

const LocalMcpServerRef = z
  .string()
  .min(1)
  .describe('An MCP server the operator configured on that machine.');

export const HostMcpListToolsInputSchema = z.object({
  bindingId: HostBindingRef,
  serverId: LocalMcpServerRef,
});

export const HostMcpListToolsOutputSchema = z.object({
  serverId: z.string(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export const HostMcpCallInputSchema = z.object({
  bindingId: HostBindingRef,
  serverId: LocalMcpServerRef,
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const HostMcpCallOutputSchema = z.object({
  content: z.unknown().describe('The content blocks the server returned, as it returned them.'),
  isError: z
    .boolean()
    .describe(
      "The server's own judgement that the call failed. Not a failure of this step — " +
        'read it and decide, the way an HTTP status is read.',
    ),
});

export const HostFilePatchInputSchema = z.object({
  bindingId: HostBindingRef,
  patch: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024)
    .describe('A unified diff, as `host.harness.run` returns it.'),
  mode: z
    .enum(['clean', 'merge'])
    .default('clean')
    .describe(
      '`clean` applies only if the diff still fits exactly, and changes nothing otherwise. ' +
        '`merge` reconciles a diff whose base has moved and may leave conflict markers in ' +
        'the files it could not settle — those files are named in the result.',
    ),
  commit: z
    .object({
      branch: HostBranchNameSchema.describe(
        "Branch the commit lands on. A new one is created at the folder's HEAD. An existing " +
          'one takes the commit on top of its head, and only with `base` naming that head.',
      ),
      message: z
        .string()
        .min(1)
        .max(20_000)
        .describe('Commit message, verbatim. The first line is the subject, as git reads it.'),
      base: HostBaseRefSchema.optional().describe(
        'The commit the patch was made against, as the commission reported it in `baseSha`. ' +
          "Required when `branch` exists, and it must be that branch's head. For a new branch " +
          "it may be omitted; given, it must be the folder's HEAD. A base that does not match " +
          'is refused, never merged.',
      ),
    })
    .optional()
    .describe(
      'Land the diff as a commit on a branch instead of changing the working tree. ' +
        "The operator's checkout, index and current branch are untouched: the patch is " +
        'applied in a checkout the executor makes for itself — at HEAD for a new branch, at ' +
        "the branch's head for an existing one — committed there, and the branch ref is " +
        'created or advanced by that one commit. That commit is what a publication pushes.',
    ),
});

export const HostFilePatchOutputSchema = z.object({
  state: z
    .enum(['applied', 'conflict', 'empty'])
    .describe(
      '`conflict` in `clean` mode means the folder was not touched at all. In `merge` ' +
        'mode it means the tree WAS written and the files named in `conflicts` carry ' +
        'markers — check `filesChanged` rather than assuming nothing happened. With ' +
        '`commit` a conflict leaves no commit and no branch, and the folder untouched in ' +
        'either mode.',
    ),
  filesChanged: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Zero only when nothing was written — the folder byte-identical to before, or, with ' +
        '`commit`, no commit made. With `commit` it counts what the commit carries; the ' +
        'working tree is untouched either way.',
    ),
  files: z.array(z.string()).describe('Paths the diff touched, relative to the binding root.'),
  conflicts: z
    .array(z.string())
    .describe('Files that could not be settled. Empty when `state` is `applied`.'),
  detail: z.string().optional().describe('What git could not place, when there was a conflict.'),
  commit: z
    .object({
      branch: z.string().describe('The branch that now exists in the repository.'),
      sha: z.string().describe('The commit the branch points at.'),
      baseSha: z
        .string()
        .describe(
          "The parent of the new commit: HEAD as it was found for a new branch, the branch's " +
            'previous head for an append.',
        ),
      appended: z
        .boolean()
        .describe('True when the branch existed and the commit was appended to it.'),
    })
    .optional()
    .describe(
      'Present only when `commit` was asked for and the diff applied. A conflict leaves no ' +
        'commit and no branch created or moved.',
    ),
});

export const HostHarnessRunInputSchema = z.object({
  bindingId: HostBindingRef,
  harness: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Which coding harness to run, by the id the operator configured on that machine. ' +
        'The machine decides what that id runs; nothing here can name an executable. ' +
        'Omit it and the machine uses the harness it offers when it offers exactly one; ' +
        'where it offers several the run is refused and the refusal lists the ids.',
    ),
  task: z
    .string()
    .min(1)
    .max(32_000)
    .describe('What the harness should do, in prose. Passed through verbatim as one argument.'),
  inputs: z
    .preprocess(coerceJsonObjectArg, z.record(z.unknown()))
    .optional()
    .describe(
      'Structured inputs of the task — the values the prose refers to by name, such as a ' +
        'revision range, a ticket, a target file. Appended to the task as JSON, so a workflow ' +
        'binds per-run values here and keeps the prose fixed.',
    ),
  outputSchema: z
    .preprocess(coerceJsonObjectArg, z.record(z.unknown()))
    .optional()
    .describe(
      'JSON Schema for the result this task must produce. The harness is told where to ' +
        'write its final result as JSON and what shape it takes, and the run returns it as ' +
        '`result`, validated against this schema. Give one whenever the answer matters — ' +
        'an assessment, a summary, a decision — rather than reading it out of `stdout`. ' +
        'Without one the run reports only what it changed.',
    ),
  resultRetries: z
    .number()
    .int()
    .min(0)
    .max(3)
    .default(1)
    .describe(
      'Further turns the harness gets to correct a missing or invalid result, each carrying ' +
        'the validation error. Only meaningful alongside `outputSchema`.',
    ),
  base: HostBaseRefSchema.optional().describe(
    'The branch, tag or commit the isolated checkout starts from. Absent, the run starts from ' +
      "the folder's last commit. The patch comes back relative to it, so a fix to a reviewed " +
      'branch names that branch here and its patch lands on it. An unknown ref is refused.',
  ),
  continueFrom: z
    .string()
    .optional()
    .describe(
      'A `sessionRef` from an earlier run, to add a turn to that conversation instead of ' +
        'starting one. The earlier checkout and everything the harness remembers about it ' +
        'are still there, so "now fix the test that broke" works as an instruction. Only ' +
        'the run that started a session can continue it.',
    ),
  maxTurns: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'The number of assistant turns the harness may take before it must answer. Absent means ' +
        'the harness decides. A harness the machine configured without a turn budget refuses ' +
        'the run rather than ignoring it, and the refusal names it.',
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The model the harness should run, spelled as that harness names it. Absent means the ' +
        'harness uses its own default, which is the right answer unless the run has a reason ' +
        'to pin one. A harness the machine configured without a model argument refuses the ' +
        'run rather than ignoring it, and the refusal names it.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(7_200_000)
    .default(1_800_000)
    .describe('Kill the harness and its descendants after this long.'),
});

export const HostHarnessRunOutputSchema = z.object({
  runId: z.string().describe('Handle for `host.process.inspect` and `host.process.stop`.'),
  harness: z
    .object({
      id: z.string(),
      label: z.string().optional().describe('What the operator calls it, when the machine says.'),
    })
    .describe(
      'The harness that ran, as the machine configured it. Present whether or not the call ' +
        'named one, so a result stands on its own rather than needing the input read back.',
    ),
  sessionRef: z
    .string()
    .optional()
    .describe(
      'Pass to `continueFrom` on a later run to add a turn to this conversation. Absent ' +
        'when the harness did not say how it resumes one, which is a fact about the ' +
        'harness rather than a failure.',
    ),
  continued: z
    .boolean()
    .describe('True when this added a turn to an existing conversation rather than starting one.'),
  baseSha: z
    .string()
    .describe(
      "Commit the isolated worktree started from — `base` resolved, or the folder's HEAD. " +
        'A publication that appends to a branch passes this as its `base`.',
    ),
  result: z
    .unknown()
    .optional()
    .describe(
      'What the harness reported as its result, validated against the `outputSchema` the ' +
        'task carried. Absent only when the task carried none — a run asked for a result ' +
        'and unable to produce a valid one fails instead of returning without it.',
    ),
  patch: z
    .string()
    .optional()
    .describe(
      'Unified diff of what the harness changed, against `baseSha`. Absent when nothing changed.',
    ),
  filesChanged: z.number().int().nonnegative(),
  patchTruncated: z
    .boolean()
    .describe('True when the diff was too large to return whole; `filesChanged` still holds.'),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdout: z
    .string()
    .optional()
    .describe(
      'What the harness said when it finished. A harness that narrates its work as an event ' +
        'stream has that narration on the live feed and only its closing answer here. Never ' +
        'the typed result, which is `result`, and never what changed, which is `patch`.',
    ),
  activityRef: PayloadRefSchema.optional().describe(
    'The activity feed of this run — every tool call and result as one line — stored once ' +
      'for the run view.',
  ),
  stderr: z
    .string()
    .optional()
    .describe(
      'Diagnostics from the run. Never the failure signal — harnesses narrate progress here ' +
        'while working normally, and a step that failed says so as a step.',
    ),
  truncated: z.boolean(),
  applies: z
    .enum(['clean', 'conflict', 'empty'])
    .describe(
      'Whether the diff still fits the repository as it stands now. A run that ' +
        'took a while can be overtaken by the operator committing or editing the same lines.',
    ),
  applyConflict: z
    .string()
    .optional()
    .describe('What git could not place, when `applies` is `conflict`.'),
  headMoved: z
    .boolean()
    .describe(
      "True when the folder's HEAD has moved off `baseSha` since the run started. A run " +
        'given a `base` is judged against that base, not the HEAD, and reports false.',
    ),
  blockedDomains: z
    .array(z.string())
    .describe(
      'Hosts the boundary refused during the run. A harness that produced nothing while this ' +
        'is non-empty was cut off from what it needed, not idle.',
    ),
  boundaryNote: z
    .string()
    .optional()
    .describe(
      'What the boundary refused and who can widen it. Present only when something was ' +
        'refused, and it says whether the run reached its result anyway — a refusal on a run ' +
        'that finished is a note about what it could not reach, not a reason it failed.',
    ),
});

export const HostProcessInspectInputSchema = z.object({
  bindingId: HostBindingRef,
  processId: z.string().min(1),
});

export const HostProcessInspectOutputSchema = z.object({
  processId: z.string(),
  state: z
    .enum(['running', 'exited', 'unknown'])
    .describe(
      '`unknown` means this executor cannot say — the process was never here, ' +
        'belongs to another run, or predates a restart.',
    ),
  startedAt: z.string().optional(),
  exitCode: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Read the same way as `host.process.exec`: the command’s own status.'),
  descendantCount: z.number().int().nonnegative().optional(),
  output: z
    .string()
    .optional()
    .describe(
      'What a detached process said since it was last inspected. Reading it clears it, ' +
        'so each inspection returns what is new rather than everything again.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe('True when output was dropped because nobody read it in time.'),
});

export const HostProcessStopInputSchema = z.object({
  bindingId: HostBindingRef,
  processId: z
    .string()
    .min(1)
    .optional()
    .describe('Omit to stop every process this run started in this binding.'),
  graceMs: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(5_000)
    .describe('Time between the polite signal and the one that cannot be declined.'),
});

export const HostProcessStopOutputSchema = z.object({
  stopped: z.array(z.string()).describe('Process ids that were running and are not now.'),
  alreadyExited: z.array(z.string()),
});

export const HostOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'host',
    group: 'file',
    verb: 'list',
    name: 'List Host Files',
    actionLabel: 'Listing files…',
    groupDisplayName: 'Host files',
    groupDescription:
      'Read and write files in a folder the operator connected, in place on their machine.',
    semanticDescription:
      'List entries inside a folder the operator connected through a host binding. ' +
      'Reads the live filesystem — not a Memory snapshot — so it reflects what the ' +
      'operator sees in their own file browser. Needs no execution authority: a ' +
      'file-only binding grants this without granting a shell.',
    tags: ['host', 'files', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    usage: {
      oneLine: 'List files in a connected folder on the operator machine.',
      minimalExampleInput: { bindingId: 'hb_project', path: 'src' },
      whenToUse: [
        'Discovering what is in a folder the operator connected before reading specific files',
        'Checking whether a file the workflow expects to exist is present',
      ],
      whenNotToUse: [
        'Searching Memory documents — that is memory.store, a different store with different authority',
        'Reading file contents — use host.file.get once the path is known',
      ],
      pitfalls: [
        'Paths are relative to the binding root. An absolute path or a `..` segment is refused, not resolved.',
        'A binding may be read-only; listing it says nothing about whether writes are permitted.',
      ],
    },
    inputZod: HostFileListInputSchema,
    outputZod: HostFileListOutputSchema,
  },
  {
    stepType: 'host',
    group: 'file',
    verb: 'get',
    name: 'Read Host File',
    actionLabel: 'Reading file…',
    semanticDescription:
      'Read one file from a connected folder on the operator machine. Returns a revision ' +
      'alongside the content; pass that revision to host.file.put so a change made in the ' +
      "operator's editor between read and write is reported as a conflict rather than lost.",
    tags: ['host', 'files', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    usage: {
      oneLine: 'Read a file from a connected folder, with the revision needed to write it back.',
      minimalExampleInput: { bindingId: 'hb_project', path: 'README.md' },
      whenToUse: [
        'Reading a config, source file or dataset the operator connected',
        'Getting the current revision before proposing a change to that file',
      ],
      whenNotToUse: [
        'Reading a file larger than the cap — raise maxBytes deliberately or work through a payload',
      ],
      pitfalls: [
        'The revision is only meaningful to host.file.put on the same binding; it is a content hash, not a version number.',
        'A file over maxBytes is refused rather than truncated. Raise the cap deliberately; there is no partial read.',
      ],
    },
    inputZod: HostFileGetInputSchema,
    outputZod: HostFileGetOutputSchema,
  },
  {
    stepType: 'host',
    group: 'file',
    verb: 'put',
    name: 'Write Host File',
    actionLabel: 'Writing file…',
    semanticDescription:
      'Write one file into a connected folder on the operator machine, in place, so their ' +
      'editor and other applications see it immediately. Requires a binding that grants ' +
      'writes. Supply expectedRevision from host.file.get to replace an existing file; omit ' +
      'it to create a file that must not already exist. A mismatch writes nothing.',
    tags: ['host', 'files', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Write a file into a connected folder, conflict-checked against its revision.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        path: 'notes.md',
        content: '# Notes\n',
      },
      whenToUse: [
        'Writing content the operator gave verbatim, or content that one file already read fully determines',
        'Saving a result where the operator asked for it, in their own folder',
      ],
      whenNotToUse: [
        "Any change that needs the folder's or the repository's facts read or judged, however small — that is host.harness.run",
        'An edit spanning more than one file — that is host.harness.run, in one task',
        'Writing somewhere the operator did not connect — a binding cannot be widened by an operation',
        'Storing durable platform state — that is Memory, not the operator filesystem',
      ],
      pitfalls: [
        'A note needing facts the caller does not hold — which account, which script, what a module does — is not a small change, whatever its length.',
        "Composing from more than the one file read is the harness's task; read-then-write covers exactly one file.",
        'Omitting expectedRevision means create-only. It is not a blind overwrite, because the operator is a second writer and last-write-wins loses their work.',
        'A read-only binding refuses this operation; that is the binding, not the path.',
      ],
    },
    inputZod: HostFilePutInputSchema,
    outputZod: HostFilePutOutputSchema,
  },
  {
    stepType: 'host',
    group: 'file',
    verb: 'patch',
    inputZod: HostFilePatchInputSchema,
    outputZod: HostFilePatchOutputSchema,
    name: 'Apply a Patch on Host',
    actionLabel: 'Applying patch…',
    semanticDescription:
      'Take a diff into a connected folder — the change a coding harness produced, once ' +
      'someone has decided to keep it. Applies whole or not at all: a diff that no longer ' +
      'fits leaves the folder exactly as it was and says what it could not place. With ' +
      '`commit` it lands as a commit instead — on a new branch, or appended to the branch ' +
      'it was made on — leaving the working tree as it was. Nothing here pushes; what ' +
      'becomes of the change stays with the operator.',
    tags: ['host', 'file', 'patch', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Apply a diff to a connected folder, whole or not at all.',
      minimalExampleInput: { bindingId: 'hb_project', patch: 'diff --git a/x.ts b/x.ts\n…' },
      whenToUse: [
        'Keeping the change a `host.harness.run` produced, after it has been reviewed — the check that follows a delegation',
        'Reapplying a diff that was held while something else moved',
        'Preparing a publication: with `commit`, the diff lands as a commit on a new branch and the working tree is left alone',
        "A patch made from a commission that started at a branch lands on that branch when `commit.branch` names it and `commit.base` is the `baseSha` the commission reported; a fresh branch takes a patch made at the folder's HEAD",
      ],
      whenNotToUse: [
        'Authoring a change here; a diff is something a harness produced and someone read, never something written for this call',
        'Writing one known file — that is host.file.put, which needs no diff',
        'Publishing the result; a commit is as far as this reaches, and pushing is a command the folder allows or does not',
      ],
      pitfalls: [
        "The review is the caller's, and the diff is applied whole or not at all — there is no keeping only the part that was read.",
        'Without `commit` the patch changes the working tree in place, where the operator is a second writer.',
        'A diff whose base has moved fails in `clean` mode rather than applying approximately. That is the point.',
        '`merge` can leave conflict markers in the working tree. The files carrying them come back in `conflicts`.',
        'Paths inside a repository `.git` are refused, whatever the diff says.',
        'An existing branch is appended to only when `commit.base` is its head. A branch that moved since the commission started refuses the append rather than merging it — commission the fix again from the branch.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'input',
    inputZod: HostProcessInputInputSchema,
    outputZod: HostProcessInputOutputSchema,
    name: 'Answer a Running Process',
    actionLabel: 'Sending input…',
    semanticDescription:
      'Write to the standard input of a process this run started and left running. ' +
      'For a command that asks something, or a session that takes a line at a time. ' +
      'Only the run that started a process can address it.',
    tags: ['host', 'process', 'terminal', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Send text to the standard input of a detached process this run started.',
      minimalExampleInput: { bindingId: 'hb_project', processId: 'hp_x', input: 'yes\n' },
      whenToUse: [
        'Answering a prompt from a command started with `detach`',
        'Driving a REPL or an interactive tool a line at a time',
      ],
      whenNotToUse: [
        'A command that takes its input as arguments — pass them in `command` instead',
        'A process another run started; handles are not shared and will read as unknown',
      ],
      pitfalls: [
        'Nothing is appended. A process reading lines waits until the text carries a newline.',
        'A process that already exited reports `exited` rather than failing; the text is discarded.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'mcp',
    verb: 'list_tools',
    inputZod: HostMcpListToolsInputSchema,
    outputZod: HostMcpListToolsOutputSchema,
    name: 'List Tools of a Local MCP Server',
    actionLabel: 'Listing local MCP tools…',
    groupDisplayName: 'Local MCP servers',
    groupDescription:
      "Use MCP servers installed on the operator's machine, inside the boundary their binding declares.",
    semanticDescription:
      "Ask an MCP server running on the operator's own machine what it can do. Unlike a " +
      'remote server, this one has their filesystem underneath it, so what it can reach is ' +
      'the binding it runs in rather than what the server promises about itself.',
    tags: ['host', 'mcp', 'local'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Discover what a local MCP server offers.',
      minimalExampleInput: { bindingId: 'hb_project', serverId: 'sqlite' },
      whenToUse: ['Finding out what a machine-local MCP server exposes before calling it'],
      whenNotToUse: ['A server reachable over the network — that is the mcp lane'],
      pitfalls: [
        'The server runs only while the question is being answered; nothing is kept warm between calls.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'mcp',
    verb: 'call',
    inputZod: HostMcpCallInputSchema,
    outputZod: HostMcpCallOutputSchema,
    name: 'Call a Local MCP Tool',
    actionLabel: 'Calling local MCP tool…',
    semanticDescription:
      "Call a tool on an MCP server running on the operator's own machine. The server runs " +
      "inside the binding's boundary — it reaches the folder that binding names and nothing " +
      'else, enforced by the operating system rather than by the server behaving.',
    tags: ['host', 'mcp', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Call a tool on a local MCP server, inside its binding.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        serverId: 'sqlite',
        toolName: 'query',
        arguments: { sql: 'select 1' },
      },
      whenToUse: ['Using a tool from a server the operator installed and configured locally'],
      whenNotToUse: ['A server reachable over the network — that is the mcp lane'],
      pitfalls: [
        '`isError` is the server saying the call failed. The step still succeeded; read it and decide.',
        'What the server can reach is its binding. A tool asking for more fails rather than being rewritten.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'harness',
    verb: 'run',
    inputZod: HostHarnessRunInputSchema,
    outputZod: HostHarnessRunOutputSchema,
    name: 'Run Harness on Host',
    actionLabel: 'Running harness…',
    groupDisplayName: 'Host harnesses',
    groupDescription:
      'Put an agent the operator already installed and signed in to work over a connected folder.',
    semanticDescription:
      'Delegate a whole task over the files in a connected folder to a harness installed on ' +
      "the operator's machine — the same tool they use themselves, already authenticated, " +
      'with their toolchain around it. It executes any work over those files: analysis, ' +
      'documents, data and code alike. The run happens in an isolated checkout at the ' +
      'current commit, or at the branch or commit it names, so their uncommitted work is ' +
      'untouched, and a run that moves any ref of the repository is refused. Given an `outputSchema` it ' +
      'returns a validated `result`; where it changed files it returns a diff to review, ' +
      'committed, pushed and merged nowhere.',
    tags: ['host', 'harness', 'files', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Delegate work over a connected folder to an installed harness.',
      minimalExampleInput: {
        bindingId: 'hb_project',
        task: 'Add a test covering the empty-input case in the parser.',
      },
      whenToUse: [
        "Any change that needs the folder's facts, however small — the harness holds them and the caller does not",
        'Any task over the files in a connected folder — assessing a codebase, revising a document set, reconciling a ledger, making a code change',
        'Answering a question about a folder that needs the files read and reasoned over, with `outputSchema` naming the shape of the answer',
        'Producing a reviewable diff rather than editing the working copy in place',
        "A fix to a reviewed range starts from the branch the review covered, `base: <branch>`, so its patch is relative to that branch and lands on it; absent, the run starts from the folder's last commit",
        'A smoke test or a brief look, with `maxTurns` naming how many turns brief means',
        'Pinning the model for a run that has a reason to — a comparison, a cost ceiling, a capability the default lacks; otherwise leave it to the harness',
      ],
      whenNotToUse: [
        'Running a build or a test suite — that is host.process.exec, which needs no worktree',
        'Reading one known file — that is host.file.get',
        'Folders reached over the network; this operates on one already on the machine',
      ],
      pitfalls: [
        "Send the intent and the acceptance criteria, and an `outputSchema` when the answer matters — never a draft. A draft written without the folder's facts is what the harness is here to avoid.",
        'Without `outputSchema` the run returns only a diff, and an assessment comes back as loose text. Name the shape of the answer to get one.',
        'The diff is returned, never applied. The operator decides what becomes of it.',
        'A continued run returns the diff of the whole conversation against its original starting commit, not only the latest turn — unless it names a `base`, which continues the conversation in a fresh checkout at that base.',
        "A patch made from a `base` is relative to that base, not the folder's HEAD: publish it onto the branch it started from, with the run's `baseSha`.",
        'A harness only runs if the operator configured it on that machine; the id here cannot introduce one. Omitted, it resolves to the one offered machine-side — the space context lists them.',
        'A harness needs egress to its provider. `blockedDomains` names every host it could not reach, and `boundaryNote` says whether that stopped the run or only narrowed it.',
        'The folder must be a git repository with at least one commit — the run needs a base to diff against.',
        'A `maxTurns` budget the task cannot meet ends the run with whatever the harness had reached, and that result is still validated against `outputSchema` — a budget too small for the task fails the step rather than returning a partial answer.',
        '`model` is spelled the way the harness spells it, not as this platform names a model in its own catalog — the harness resolves the name, and an id from the catalog is one it has never heard of.',
      ],
    },
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'exec',
    name: 'Run Command on Host',
    actionLabel: 'Running command…',
    groupDisplayName: 'Host processes',
    groupDescription: "Run the operator's own tools, inside the boundary their binding declares.",
    semanticDescription:
      "Run a command on the operator's machine, inside a binding, using the toolchain they " +
      'actually installed — their interpreter version, their virtualenv, their compilers. ' +
      'Output streams while it runs and the step completes when the process does. ' +
      'What the command may read, write and reach is the binding, enforced by the operating ' +
      'system rather than by inspecting the command; a command asking for more fails rather ' +
      'than being rewritten.',
    tags: ['host', 'process', 'terminal', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: "Run a command in a connected project using the operator's installed toolchain.",
      minimalExampleInput: { bindingId: 'hb_project', command: ['npm', 'test'] },
      whenToUse: [
        'The one command that proves a delegated result — a test file, a typecheck, a build',
        'Running a build, a test suite or a script in a project the operator connected',
        'Using a CLI that only exists on their machine, or needs their login',
      ],
      whenNotToUse: [
        'Doing through a sequence of commands the work a harness does in one task — that is host.harness.run',
        'Running generated code over supplied data — that is compute.sandbox.exec, which has no ambient authority and needs no binding',
        'Anything the operator has not connected a binding for; a binding cannot be widened by an argument',
      ],
      pitfalls: [
        'Pass argv, not a command line: ["npm", "test"] rather than "npm test". Nothing splits a string for you, deliberately.',
        'Descendants are killed with the process on timeout or stop, so a backgrounded child does not outlive the step.',
        'Egress follows the binding. A command that reaches the network may find it closed even though it runs.',
        "A push runs as the operator's own git, outside the sandbox, only to a branch under the folder's `branchPrefix`, never with force, with the branch named on the command and no environment or git global option; a folder without a prefix pushes nothing.",
      ],
    },
    inputZod: HostProcessExecInputSchema,
    outputZod: HostProcessExecOutputSchema,
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'inspect',
    name: 'Inspect Host Process',
    actionLabel: 'Inspecting process…',
    semanticDescription:
      'Report whether a process started by this binding is still running, and how many ' +
      'descendants it has. Useful between a long command and a decision to stop it.',
    tags: ['host', 'process', 'local'],
    idempotency: 'idempotent',
    accessMode: 'read',
    usage: {
      oneLine: 'Check whether a host process is still running.',
      minimalExampleInput: { bindingId: 'hb_project', processId: 'hp_01J' },
      whenToUse: ['Deciding whether a long-running command needs stopping'],
      whenNotToUse: ['Reading its output — that arrives with the exec step that started it'],
      pitfalls: [
        'A process id is meaningful only to the binding that started it, and only until the executor restarts.',
      ],
    },
    inputZod: HostProcessInspectInputSchema,
    outputZod: HostProcessInspectOutputSchema,
  },
  {
    stepType: 'host',
    group: 'process',
    verb: 'stop',
    name: 'Stop Host Process',
    actionLabel: 'Stopping…',
    semanticDescription:
      'Stop a process this binding started, and its descendants. Omit the process id to ' +
      'stop everything the binding is running, which is the control an operator reaches for ' +
      'when something is loose.',
    tags: ['host', 'process', 'local'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Stop a host process and its descendants, or all of them.',
      minimalExampleInput: { bindingId: 'hb_project', processId: 'hp_01J' },
      whenToUse: [
        'Cancelling a command that is taking too long or doing the wrong thing',
        'Stopping everything a binding is running, by omitting the process id',
      ],
      whenNotToUse: ['Stopping a process another binding started — ids do not cross bindings'],
      pitfalls: [
        'Stopping is not undoing. Whatever the process already wrote, sent or deleted stays done.',
      ],
    },
    inputZod: HostProcessStopInputSchema,
    outputZod: HostProcessStopOutputSchema,
  },
];
