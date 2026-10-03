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

import { PayloadRefSchema, STORED_PAYLOAD_REF_PATTERN } from '../runtime/payloadRef.js';
import { DeclaredBrowserProfileIdSchema, EPHEMERAL_BROWSER_PROFILE } from './browserProfile.js';

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

export const HOST_PUSH_APPROVAL_DEFAULT = 'unless-unreviewed';

export const HostPushApprovalSchema = z
  .enum(['always', 'never', 'unless-unreviewed'])
  .describe(
    'When a publication from this folder asks the operator before it pushes. ' +
      '`always`: it asks before every push. ' +
      '`never`: it pushes without asking. ' +
      '`unless-unreviewed`, the default: the publication runs a Local Code Review of ' +
      'everything the push would add and pushes without asking only when that review ' +
      'returns `approve`. ' +
      'Whatever the posture, every publication scans everything the push would add for ' +
      'secrets first and stops with nothing pushed when the scan finds one, which is what ' +
      'lets a review stand in for the operator: the one thing the approval guarded that a ' +
      'review does not read for is a secret leaving the machine. A scan that could not read ' +
      'a file, or found a line marked `aflow-scan: allow`, asks the operator under every ' +
      'posture, `never` included, and a declined push pushes nothing.',
  );
export type HostPushApproval = z.infer<typeof HostPushApprovalSchema>;

export const HostSandboxPostureSchema = z
  .enum(['open', 'confined'])
  .describe(
    'What network a coding agent and the checks have in this folder. Not whether there is a ' +
      "sandbox: under both they run inside the machine's sandbox in a detached checkout of the " +
      "commit, writing the checkout and the run's scratch, never the folder or its `.git`, " +
      "and never reading or writing the machine's host directory, where the policy every gate " +
      'reads and the pairing credential live. ' +
      '`open`: every host and loopback, and the system temporary directory writable. ' +
      "`confined`: only the hosts a harness is allowed, and the machine's loopback closed. " +
      'Declared on the machine; no workspace can set it.',
  );
export type HostSandboxPosture = z.infer<typeof HostSandboxPostureSchema>;

/**
 * `open` in the local edition: the lane runs the operator's own tool on the
 * operator's own repository, and what that tool needs from the machine is the
 * network — its own search and fetch, Corepack and the registry, a test's
 * loopback server. The sandbox still withholds the host directory, the
 * operator's folder and its `.git` under `open`, which is what lets the ref
 * guard, the scan, the check, the review and the push gate stand: each reads
 * its configuration from there. `confined` is the choice for a repository the
 * operator does not trust.
 */
export const HOST_SANDBOX_POSTURE_DEFAULT: HostSandboxPosture = 'open';

/**
 * Tokens in a folder's checks. One program and its arguments; a longer list is
 * a script, and the repository is the place to keep one.
 */
export const HOST_CHECKS_MAX_ARGS = 64;
export const HOST_CHECK_ARG_MAX_LENGTH = 4096;

export const HOST_HARNESS_TASK_MAX_LENGTH = 32_000;
export const HOST_HARNESS_TIMEOUT_MIN_MS = 1_000;
export const HOST_HARNESS_TIMEOUT_DEFAULT_MS = 30 * 60_000;
/** The longest a coding agent runs, and so the longest any host step runs. */
export const HOST_HARNESS_TIMEOUT_MAX_MS = 2 * 60 * 60_000;
/**
 * The turn budget a run gets when it names none, on a harness that can take
 * one. Every tool call is a turn, and a slice of work takes several hundred:
 * a cap sized to a guess ends the run while it is still reading.
 */
export const HOST_HARNESS_MAX_TURNS_DEFAULT = 600;
/**
 * How many coding agents a machine runs at once when the operator chose no
 * number. The machine is usually a laptop that also runs the stack, and two
 * coding agents beside it, each running the project's checks in its own
 * checkout, is what one carries without the stack itself slowing to a crawl.
 */
export const HOST_HARNESS_CONCURRENCY_DEFAULT = 2;

/**
 * How long a folder's checks run when the operator chose no time. A type-check,
 * the builds a test needs and a scoped test run take minutes on a laptop; the
 * limit is there to end a check that hangs, not to hurry one that is slow.
 */
export const HOST_CHECKS_TIMEOUT_DEFAULT_MS = 30 * 60_000;
/** The longest a host step runs at all — a coding agent's ceiling — so a check is never the outlier. */
export const HOST_CHECKS_TIMEOUT_MAX_MS = HOST_HARNESS_TIMEOUT_MAX_MS;
export const HOST_CHECKS_TIMEOUT_MIN_MS = 60_000;

export const HostChecksSchema = z
  .array(z.string().min(1).max(HOST_CHECK_ARG_MAX_LENGTH))
  .min(1)
  .max(HOST_CHECKS_MAX_ARGS)
  .describe(
    'The command a publication from this folder runs before anything leaves the machine: one ' +
      "argv — a program and its arguments, never a shell line — run from the repository's root " +
      "in a detached checkout of the commit, under the folder's sandbox posture. Declared " +
      'by the operator on the machine; no workspace can set it, and no operation takes one.',
  );

/**
 * What leaves the machine about a folder's checks. The arguments never do: an
 * argv can carry a token or a private path, and this reaches every agent in
 * the workspace through its space context.
 */
export const HostPublishedChecksSchema = z
  .object({
    program: z.string().min(1).max(HOST_CHECK_ARG_MAX_LENGTH),
  })
  .describe(
    'The folder declares checks, and `program` is the name of the program they run — only its ' +
      'file name, never its arguments or where it lives. The full command is shown to the ' +
      'operator on their machine and nowhere else.',
  );
export type HostPublishedChecks = z.infer<typeof HostPublishedChecksSchema>;

export const HostChecksTimeoutMsSchema = z
  .number()
  .int()
  .min(HOST_CHECKS_TIMEOUT_MIN_MS)
  .max(HOST_CHECKS_TIMEOUT_MAX_MS)
  .describe(
    "How long the folder's checks may run before they are stopped and the check fails. " +
      'Absent, `HOST_CHECKS_TIMEOUT_DEFAULT_MS` each time it is read.',
  );

/**
 * What a push from a connected folder may do, as the machine holding the folder
 * declares it.
 *
 * The approval posture and the checks live beside the prefix rather than in
 * the skill that publishes, because they are the operator's statement about
 * this folder and hold for every publication from it.
 */
export const HostBindingBranchPolicySchema = z.object({
  branchPrefix: HostBranchPrefixSchema,
  pushApproval: HostPushApprovalSchema.optional().describe(
    'The posture the operator chose for this folder. Absent, the folder takes ' +
      '`HOST_PUSH_APPROVAL_DEFAULT` each time it is read, so a change of default reaches every ' +
      'folder that never chose; nothing writes the default in.',
  ),
  checks: HostChecksSchema.optional().describe(
    'The checks the operator declared for this folder. Absent, a publication runs none and ' +
      'says so.',
  ),
  checksTimeoutMs: HostChecksTimeoutMsSchema.optional(),
});
export type HostBindingBranchPolicy = z.infer<typeof HostBindingBranchPolicySchema>;

/**
 * The branch policy as a publication reads it: the posture chosen, else the
 * default now, and the time its checks get, chosen or the default now.
 */
export const HostResolvedBranchPolicySchema = HostBindingBranchPolicySchema.extend({
  pushApproval: HostPushApprovalSchema,
  checksTimeoutMs: HostChecksTimeoutMsSchema,
});
export type HostResolvedBranchPolicy = z.infer<typeof HostResolvedBranchPolicySchema>;

export function resolveBranchPolicy(policy: HostBindingBranchPolicy): HostResolvedBranchPolicy {
  return {
    ...policy,
    pushApproval: policy.pushApproval ?? HOST_PUSH_APPROVAL_DEFAULT,
    checksTimeoutMs: policy.checksTimeoutMs ?? HOST_CHECKS_TIMEOUT_DEFAULT_MS,
  };
}

export const HostBranchNameSchema = branchToken(HOST_BRANCH_NAME_MAX_LENGTH, 'branch name');

/**
 * A commit named the way a person names one — a branch, a tag or a sha. The
 * branch-name rule admits all three; the machine resolves it and refuses a ref
 * the folder does not have.
 */
export const HostBaseRefSchema = branchToken(HOST_BRANCH_NAME_MAX_LENGTH, 'base');

/**
 * A commit named by its sha alone. A branch name here would resolve to that
 * branch's head, and a base checked against the head it resolved to always
 * matches.
 */
export const HostCommitShaSchema = z.string().regex(/^[0-9a-fA-F]{7,40}$/, {
  message:
    'A commit sha is 7 to 40 hexadecimal characters, as a commission reported it — not a ' +
    'branch or tag name.',
});

/** `<baseSha>..<sha>`: a run of commits named by two shas, so no branch that moves can change it. */
export const HOST_COMMIT_RANGE_PATTERN = /^([0-9a-fA-F]{7,40})\.\.([0-9a-fA-F]{7,40})$/;

export const HostCommitRangeSchema = z.string().regex(HOST_COMMIT_RANGE_PATTERN, {
  message:
    'A range is two shas, `<baseSha>..<sha>` — the `range` or `pushRange` a commit made by ' +
    '`host.file.patch` reports — not a branch, a tag or a single commit.',
});

/**
 * What `host.commit.scan` returns for a range it found no secret in, and what
 * a push of that range must carry. Opaque: the executor that scanned signed
 * it, with a key that lives only as long as that executor runs.
 */
export const HostScanReceiptSchema = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'The `receipt` `host.commit.scan` returned, verbatim. Issued by the executor on the ' +
      'machine that scanned, for one folder and one range — its base and its last commit — ' +
      'and read only by that executor until it restarts.',
  );

/**
 * What `host.commit.check` hands back where the folder's checks ran, passed or
 * not, and what a push of that commit must carry from a folder that declares
 * checks. Opaque and signed as a scan receipt is, by the executor that ran
 * them; it holds nothing of what they printed.
 */
export const HostCheckReceiptSchema = z
  .string()
  .min(1)
  .max(512)
  .describe(
    'The `receipt` `host.commit.check` returned, verbatim. Issued by the executor on the ' +
      'machine that ran the checks, for one folder, one commit, the base it was measured ' +
      'against and the checks as the folder declared them — and read only by that executor ' +
      'until it restarts.',
  );

/**
 * The push an operator approves where its scan asked: what an `approve-push`
 * human task carries as its `approvedCall.input`, and what the approval grant
 * minted when the operator decides it is keyed by. The executor recomputes it
 * from the push it is about to run, so an approval of any other push, folder or
 * scan matches nothing.
 */
export const HostApprovedPushSchema = z.object({
  bindingId: z.string().min(1),
  refspec: z.string().min(1).describe('The one refspec of the push, `<sha>:refs/heads/<branch>`.'),
  receipt: HostScanReceiptSchema,
});
export type HostApprovedPush = z.infer<typeof HostApprovedPushSchema>;

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
  pushBase: HostBranchNameSchema.optional().describe(
    'Required with every push and belongs to no other command: the branch on `origin` the ' +
      'push is measured against — the `pushBase` the commit was made with, by its name ' +
      'alone. In the same step, just before git is spawned, `origin/<pushBase>` is fetched ' +
      'and read, and the push is refused unless it goes to the URL `origin` fetches from and ' +
      'its receipt is for the range from exactly that commit to the one it sends.',
  ),
  scan: z
    .object({
      receipt: HostScanReceiptSchema.describe(
        'The `receipt` `host.commit.scan` returned for the range this push sends: from where ' +
          '`origin/<pushBase>` is to the source of its one refspec.',
      ),
    })
    .optional()
    .describe(
      'Required with every push and belongs to no other command: a push is refused unless ' +
        'it sends, from this folder, the range a scan by this executor found no secret in, ' +
        'and — where that scan did not clear it — unless the operator approved this push in ' +
        'this run.',
    ),
  check: z
    .object({
      receipt: HostCheckReceiptSchema.nullable()
        .optional()
        .describe(
          'The `receipt` `host.commit.check` returned for the source of the push’s one refspec, ' +
            'measured against where `origin/<pushBase>` is. Null or absent where the folder ' +
            'declares no checks, and the check issued none.',
        ),
    })
    .optional()
    .describe(
      'Belongs to a push alone. A push from a folder that declares checks is refused unless ' +
        'they passed, on this executor, on exactly the commit it sends, against the base it ' +
        'measures, as the folder declares them when it pushes. A folder that declares none ' +
        'needs no receipt, and a push from it that carries one is refused.',
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

export const HostFilePatchInputSchema = z
  .object({
    bindingId: HostBindingRef,
    patchRef: z
      .string()
      .regex(
        new RegExp(STORED_PAYLOAD_REF_PATTERN),
        'A stored reference only — the `patchRef` a `host.harness.run` result reports, ' +
          'verbatim. An `inline:` reference carries the bytes themselves; a diff handed over ' +
          'as text goes in `patch`.',
      )
      .optional()
      .describe(
        'The whole diff by reference — the `patchRef` a `host.harness.run` result reports. ' +
          "This is how a commission's change is passed on, whatever its size. Give this or " +
          '`patch`, never both.',
      ),
    patch: z
      .string()
      .min(1)
      .max(4 * 1024 * 1024)
      .optional()
      .describe(
        'A unified diff as text, for a diff the operator hands over. Never the `patch` a ' +
          'commission returns, which is cut at a cap — pass its `patchRef` instead. Give ' +
          'this or `patchRef`, never both.',
      ),
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
          "Branch the commit lands on. A new one is created at `baseSha`, or at the folder's " +
            'HEAD without one. An existing one takes the commit on top of its head, and only ' +
            'with `baseSha` naming that head.',
        ),
        message: z
          .string()
          .min(1)
          .max(20_000)
          .describe('Commit message, verbatim. The first line is the subject, as git reads it.'),
        baseSha: HostCommitShaSchema.optional().describe(
          'The commit the patch was made against, as the commission reported it in `baseSha` — ' +
            'a sha, never a branch or tag name, for a commit the folder has (a commission ' +
            'started from a remote fetched its base into the folder). Required when `branch` ' +
            "exists, and it must be that branch's head; a base that does not match is refused, " +
            'never merged. A new branch is created at this commit, wherever it stands against ' +
            "the folder's HEAD; omitted, the new branch starts at the folder's HEAD.",
        ),
        pushBase: HostBranchNameSchema.optional().describe(
          'The branch on `origin` a push of this commit is measured against — `main`, by ' +
            'name alone — for a commit that is going to be pushed. `origin/<pushBase>` is ' +
            'fetched before anything is made, and the result reports `pushRange`: every commit ' +
            'the push would add, including any of the folder’s own that `origin` does not ' +
            'have yet. A base `origin` cannot give is refused with nothing made.',
        ),
        mergeFrom: HostCommitShaSchema.optional().describe(
          'The commit the commission merged into its checkout, as it reported it in ' +
            '`merge.from`. Only when appending to `branch`: its head merges this commit, ' +
            'fetched from `origin` where the folder lacks it, exactly as the commission did, ' +
            'and the patch is folded into that merge with the commit message, so the branch ' +
            'gains one merge commit whose parents are its old head and this commit. A patch ' +
            'that does not fit the merge is a conflict naming its files, and a patch that ' +
            'leaves conflict markers in a `content` or `add-add` conflict of the merge is ' +
            'refused naming each path and its kind, with nothing committed either way; a ' +
            '`modify-delete` or `delete-modify` conflict, which the merge commits deleted, is ' +
            'left deleted or restored by the patch. Where the commission reported no ' +
            '`patchRef`, its change is the merge alone — a clean catch-up, or a turn that left ' +
            'every deletion standing — and the publication names no diff: the merge commit is ' +
            'the commit. Refused for a new branch, and for a commit the branch already holds.',
        ),
      })
      // Strict so a misspelt base is refused rather than stripped: dropped, it
      // would let a patch land on a new branch with no check of where it was made.
      .strict()
      .optional()
      .describe(
        'Land the diff as a commit on a branch instead of changing the working tree. ' +
          "The operator's checkout, index and current branch are untouched: the patch is " +
          'applied in a checkout the executor makes for itself — at HEAD for a new branch, at ' +
          "the branch's head for an existing one — committed there, and the branch ref is " +
          'created or advanced by that one commit. That commit is what a publication pushes.',
      ),
  })
  .superRefine((input, ctx) => {
    if (
      input.patch === undefined &&
      input.patchRef === undefined &&
      input.commit?.mergeFrom === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patchRef'],
        message:
          'Name the diff to apply: `patchRef` for the change a commission reported, or ' +
          '`patch` for a diff handed over as text. Only a publication with ' +
          '`commit.mergeFrom` goes without one, the merge being its whole change.',
      });
    }
    if (input.patch !== undefined && input.patchRef !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patch'],
        message:
          'Give `patchRef` or `patch`, not both — they would be two diffs. For a ' +
          "commission's change keep `patchRef` and drop `patch`.",
      });
    }
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
        '`commit`, no commit made or a commit that is a merge alone. With `commit` it counts ' +
        'the files the diff carries; the working tree is untouched either way.',
    ),
  files: z.array(z.string()).describe('Paths the diff touched, relative to the binding root.'),
  conflicts: z
    .array(z.string())
    .describe('Files that could not be settled. Empty when `state` is `applied`.'),
  detail: z.string().optional().describe('What git could not place, when there was a conflict.'),
  commit: z
    .object({
      branch: z.string().describe('The branch that now exists in the repository.'),
      sha: HostCommitShaSchema.describe('The commit the branch points at, as its full sha.'),
      message: z.string().describe('The message the commit carries, as git recorded it.'),
      body: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The message after its first line, the blank lines that set it off removed: what ' +
            'the commit says about the change beyond its subject. Absent for a one-line message.',
        ),
      baseSha: z
        .string()
        .describe(
          "The parent of the new commit: HEAD as it was found for a new branch, the branch's " +
            'previous head for an append, and its first parent where it is a merge.',
        ),
      appended: z
        .boolean()
        .describe('True when the branch existed and the commit was appended to it.'),
      merged: z
        .string()
        .optional()
        .describe(
          'The commit `commit.mergeFrom` merged in, as its full sha, when the commit is that ' +
            'merge with the patch folded in: its parents are `baseSha` and this. Absent otherwise.',
        ),
      range: HostCommitRangeSchema.describe(
        'The commit as a revision range, `<baseSha>..<sha>` — two shas and no branch name, so ' +
          'it still names this commit after the branch moves. Where the commit is a merge it ' +
          'also holds the commits `merged` brought in.',
      ),
      pushRange: HostCommitRangeSchema.optional().describe(
        'Everything a push of this commit would add, `<origin base sha>..<sha>`: the commits ' +
          'reachable from it that `origin/<pushBase>`, freshly fetched, does not hold — this ' +
          'commit and every unpushed one under it. Present only when `commit.pushBase` was ' +
          'given. What a publication scans and reviews before the push.',
      ),
      pushBaseSha: HostCommitShaSchema.optional().describe(
        'Where `origin/<pushBase>` stood when it was fetched, as a full sha — the first sha ' +
          "of `pushRange`, and present exactly when it is. What a publication's checks are " +
          'measured against.',
      ),
      pushRefspec: z
        .string()
        .min(1)
        .describe(
          'The refspec that pushes this commit to its branch, `<sha>:refs/heads/<branch>`, ' +
            'carrying with it every commit under it that `origin` does not have — `pushRange` ' +
            'names them. A branch that moved after the commit sends nothing it gained since.',
        ),
    })
    .optional()
    .describe(
      'Present only when `commit` was asked for and the diff applied. A conflict leaves no ' +
        'commit and no branch created or moved.',
    ),
});

export const HostHarnessBrowserSchema = z
  .object({
    profile: z
      .union([z.literal(EPHEMERAL_BROWSER_PROFILE), DeclaredBrowserProfileIdSchema])
      .describe(
        '`ephemeral` — the default choice — is a browser made for this run and deleted with ' +
          'it: no sign-ins, its own Chrome, and it reaches only the hosts this harness may reach ' +
          'and, on this machine, the loopback ports the operator declared for the harness — a ' +
          'dev server the change runs is opened on one of those, at `localhost`, `127.0.0.1` or ' +
          '`[::1]` — `localhost` reaches a server listening on either loopback. ' +
          'A profile id names one the machine declares ' +
          'and this space may use, with its sign-ins, posture and origin rules; it never ' +
          "reaches this machine's own servers.",
      ),
  })
  .describe(
    "A browser for the harness, driven through the operator's Chrome on this machine with the " +
      'same rules as the `browser.page.*` operations: open, navigate, snapshot, read, ' +
      'screenshot, act, list and close as tools, and script evaluation on `ephemeral` only. ' +
      'Ask for one when the change touches a UI that should be looked at — opening the page ' +
      'it changed on the dev server and checking it renders and behaves — and leave it out ' +
      'otherwise. Absent, the harness has no browser.',
  );

/** One browser call a harness made, as `browserLog` records it. Typed text is recorded by length only. */
export const HarnessBrowserLogRecordSchema = z.object({
  at: z.string().describe('When the call ended, ISO 8601.'),
  profile: z.string().describe('`ephemeral`, or the id of the machine profile the run asked for.'),
  action: z.string().describe('The tool called: open, navigate, act, screenshot, evaluate, …'),
  pageId: z.string().optional(),
  origin: z.string().optional().describe('The origin of the page the call ended on.'),
  element: z
    .object({ role: z.string(), name: z.string().optional() })
    .optional()
    .describe('The element acted on, as the outline named it.'),
  typedCharacters: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('For a `type` action: how many characters were entered. Never the text.'),
  outcome: z
    .enum(['performed', 'uncertain_outcome', 'read', 'refused', 'failed', 'abandoned'])
    .describe(
      '`performed`: the call changed or opened a page, or ran a script in one, which can. ' +
        '`read`: it only looked. ' +
        '`uncertain_outcome`: as the operation reports it. `refused`: a rule, posture or ' +
        'ownership check stopped it. `failed`: it was allowed and did not complete. ' +
        '`abandoned`: the run ended with the call still in flight; recorded when the run ' +
        'ended, its answer reached no one, and a page it opened was closed as soon as it ' +
        'existed.',
    ),
  code: z.string().optional().describe('The refusal or failure code, when there is one.'),
  screenshot: PayloadRefSchema.optional().describe(
    'For a screenshot: the image the harness was shown, stored as a payload of its own.',
  ),
});
export type HarnessBrowserLogRecord = z.infer<typeof HarnessBrowserLogRecordSchema>;

const HostHarnessRunInputObjectSchema = z.object({
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
    .max(HOST_HARNESS_TASK_MAX_LENGTH)
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
      'branch names that branch here and its patch lands on it. A ref of the form ' +
      '`<remote>/<ref>`, where `<remote>` is a remote of the folder, is fetched from that ' +
      "remote first, so `origin/main` is the remote's `main` as of now rather than as of the " +
      "folder's last fetch; a remote that cannot be reached is refused, naming it. An unknown " +
      'ref is refused.',
  ),
  mergeFrom: HostBaseRefSchema.optional().describe(
    "A branch on one of the folder's remotes, `<remote>/<branch>` such as `origin/main`, merged " +
      'into the checkout once it stands at `base` — and only with `base`, the branch it is ' +
      'merged into; without one it is refused. It is fetched first and, unless the checkout ' +
      "already holds it, merged as one merge commit under the operator's commit identity, as " +
      "the publication's commit is; a folder where neither its own nor the global git config " +
      'sets `user.name` and `user.email` is refused before anything is checked out, naming ' +
      'the keys to set. A merge that conflicts is committed with markers where git left ' +
      'them and a file one side deleted committed deleted, and each conflict is named ' +
      'with its kind in the task and in `merge.conflicts` for the run to resolve; one that ' +
      'conflicts in a file both sides hold and git merges as binary is refused before any ' +
      'turn runs, naming the files, since that merge has to be made by hand. The diff is then taken against that ' +
      "merge commit, so it holds the work and its resolution and none of the merged branch's " +
      'own changes. A remote the folder does not have, or a branch the fetch cannot find, is ' +
      'refused, naming it.',
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
      'The number of assistant turns the harness may take before it must answer. Absent, a ' +
        `harness that takes a turn budget gets ${String(HOST_HARNESS_MAX_TURNS_DEFAULT)} — ` +
        'several hundred, because every tool call is a turn — and one that takes none runs ' +
        'without. Named, a harness the machine configured without a turn budget refuses the ' +
        'run rather than ignoring it, and the refusal names it.',
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The model the harness should run, spelled as that harness names it. Absent means the ' +
        "model the operator configured for that harness on the machine, or the harness's own " +
        'default when none is configured — the right answer unless the run has a reason to ' +
        'pin one. A harness the machine configured without a model argument refuses the ' +
        'run rather than ignoring it, and the refusal names it — including a run that names ' +
        'no model when the model configured on the machine cannot be passed.',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(HOST_HARNESS_TIMEOUT_MIN_MS)
    .max(HOST_HARNESS_TIMEOUT_MAX_MS)
    .default(HOST_HARNESS_TIMEOUT_DEFAULT_MS)
    .describe('Kill the harness and its descendants after this long.'),
  browser: HostHarnessBrowserSchema.optional(),
});

export const HostHarnessRunInputSchema = HostHarnessRunInputObjectSchema.superRefine(
  (input, ctx) => {
    if (input.mergeFrom !== undefined && input.base === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base'],
        message:
          `\`mergeFrom\` (\`${input.mergeFrom}\`) is given without \`base\`. A merge needs the ` +
          'branch it is merged into: name that branch as `base` — the branch the fix is ' +
          'published onto — or drop `mergeFrom`.',
      });
    }
  },
);

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
      "Commit the isolated worktree started from — `base` resolved, or the folder's HEAD — " +
        'before any merge. A publication that appends to a branch passes this as its ' +
        '`commit.baseSha`.',
    ),
  merge: z
    .object({
      from: z
        .string()
        .describe(
          'The commit merged in, as its full sha. A publication passes it on as ' +
            '`commit.mergeFrom`, which makes the same merge on the branch and lands the patch on it.',
        ),
      conflicts: z
        .array(
          z.object({
            path: z.string(),
            kind: z
              .enum(['content', 'modify-delete', 'delete-modify', 'add-add'])
              .describe(
                'How git left the path unmerged: `content`, both sides changed it; ' +
                  '`modify-delete`, the branch changed it and the merged commit deleted it; ' +
                  '`delete-modify`, the branch deleted it and the merged commit changed it; ' +
                  '`add-add`, both sides added it differently.',
              ),
          }),
        )
        .describe(
          'What the merge left unmerged, each path committed for the run to resolve: ' +
            '`content` and `add-add` with conflict markers, `modify-delete` and ' +
            '`delete-modify` deleted — in a `modify-delete` the merged commit deleted the file ' +
            'and the branch changed it, in a `delete-modify` the branch deleted it and the ' +
            'merged commit changed it — so the deletion stands unless the run restores the ' +
            'file with the changes it needs. A publication refuses a `content` or ' +
            '`add-add` file that still holds the markers, naming the path and the kind. A ' +
            '`modify-delete` or `delete-modify` file is decided whatever the patch does: one ' +
            'the patch leaves alone stays deleted, one it brings back is kept, and either is ' +
            'what the published tree shows. Empty when the merge was clean.',
        ),
    })
    .optional()
    .describe(
      "The merge `mergeFrom` made, or the one a continued session's checkout holds. Absent " +
        'when nothing was merged — no `mergeFrom`, or the checkout already held it. The diff is ' +
        'taken against the merge commit.',
    ),
  result: z
    .unknown()
    .optional()
    .describe(
      'What the harness reported as its result, validated against the `outputSchema` the ' +
        'task carried. Absent only when the task carried none — a run asked for a result ' +
        'and unable to produce a valid one fails instead of returning without it.',
    ),
  patchRef: PayloadRefSchema.optional().describe(
    'The whole diff of what the harness changed, against `baseSha` — or against the merge ' +
      'commit, where `merge` says one was made — stored by reference. ' +
      'This is what a publication takes — pass it on as `patchRef`, never the `patch` text. ' +
      'Absent when nothing changed, or when the diff was too large to keep, which ' +
      '`boundaryNote` then says. Where nothing changed beside a `merge`, the merge is the ' +
      'whole change, and a publication takes it with `commit.mergeFrom` and no diff.',
  ),
  patch: z
    .string()
    .optional()
    .describe(
      'The same diff inline, for reading — cut at a cap when `patchTruncated` says so. Never ' +
        'what a publication takes; that is `patchRef`. Absent when nothing changed.',
    ),
  filesChanged: z.number().int().nonnegative(),
  patchTruncated: z
    .boolean()
    .describe(
      'True when `patch` is only the start of the diff; `patchRef` holds all of it, and ' +
        '`filesChanged` counts every file.',
    ),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stdout: z
    .string()
    .optional()
    .describe(
      'What the harness said when it finished. A harness that narrates its work as an event ' +
        'stream has that narration on the live feed and only its closing answer here. Never ' +
        'the typed result, which is `result`, and never what changed, which is `patchRef`.',
    ),
  activityRef: PayloadRefSchema.optional().describe(
    'The activity feed of this run — every tool call and result as one line — stored once ' +
      'for the run view.',
  ),
  browserLog: PayloadRefSchema.optional().describe(
    'Every browser call the harness made, one JSON record per line: profile, page, origin, ' +
      'action, the element acted on, and the outcome; typed text by its length only, and a ' +
      'screenshot by the payload holding the image. Present ' +
      'when the run asked for `browser` and the harness used it.',
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
      'Whether the diff still fits the repository as it stands now. A run given a `base`, or ' +
        "continuing a session that was, is judged against that ref's current head, where a " +
        "publication would append it; any other run is judged against the folder's working " +
        'tree. A run that took a while can be overtaken by the operator committing or editing ' +
        'the same lines. A run that merged is judged against its merge commit instead, which ' +
        'is where the publication applies the diff, so a branch that moved during the run is ' +
        'not noticed here: the publication refuses it as `stale_base`, and `refChanges` ' +
        'already reports a move in the folder.',
    ),
  applyConflict: z
    .string()
    .optional()
    .describe('What git could not place, when `applies` is `conflict`.'),
  headMoved: z
    .boolean()
    .describe(
      "True when the folder's HEAD has moved off `baseSha` since the run started. A run " +
        'given a `base`, or continuing a session that was, is judged against that base, not ' +
        'the HEAD, and reports false.',
    ),
  refChanges: z
    .array(
      z.object({
        ref: z.string(),
        change: z.enum(['created', 'deleted', 'moved']),
        from: z.string().optional().describe('What it pointed at before; absent when created.'),
        to: z.string().optional().describe('What it points at now; absent when deleted.'),
      }),
    )
    .describe(
      'Every local branch and tag that moved while the run was in flight, whoever moved it: ' +
        "the operator's own work in the folder shows here too. A hook refuses the commission's " +
        'ordinary git in its checkout; a git call that names its own `core.hooksPath`, or ' +
        'pushes locally into the folder, is not refused, and what it moved is recorded here.',
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

export const HostBindingInspectInputSchema = z.object({
  bindingId: HostBindingRef,
});

export const HostBindingInspectOutputSchema = z.object({
  id: z.string(),
  branchPolicy: HostResolvedBranchPolicySchema.optional().describe(
    'Which branches a push from this folder may move, when a publication asks the operator ' +
      'before pushing, and the checks it runs first and for how long. Absent, the folder ' +
      'pushes nothing.',
  ),
  sandbox: HostSandboxPostureSchema.describe(
    'What a coding agent and the checks run under in this folder: the posture the operator ' +
      'chose, else the default now.',
  ),
  maxConcurrentHarnessRuns: z
    .number()
    .int()
    .min(1)
    .describe(
      'How many coding agents the machine holding the folder runs at once. A run past it ' +
        'waits for one to end rather than being refused.',
    ),
});

export const HostCommitScanInputSchema = z.object({
  bindingId: HostBindingRef,
  range: HostCommitRangeSchema.describe(
    'The commits to scan, `<baseSha>..<sha>`: every commit reachable from `sha` and not ' +
      'from `baseSha`.',
  ),
  texts: z
    .record(z.string().min(1).max(100), z.string())
    .optional()
    .describe(
      "Text that leaves the machine beside the commits — a pull request's title and body — " +
        'by a name for each. Each is read line by line under the same rules as a line a ' +
        'commit adds, and a finding in one is reported under its name.',
    ),
});

/**
 * Where a finding or an unscanned item is: a path, a commit's headers or
 * message, or a text passed beside the range.
 */
const HOST_COMMIT_SCAN_PLACE_DESCRIPTION =
  'Where the line is: for a line a commit adds, its path from the repository root; for a ' +
  "line of a commit's headers — author, committer, `mergetag` and any other — " +
  "`<sha> (headers)`; for a line of a commit's message, `<sha> (message)`; for a line of a " +
  "text passed in `texts`, that text's name.";

export const HostCommitScanFindingSchema = z.object({
  file: z.string().describe(HOST_COMMIT_SCAN_PLACE_DESCRIPTION),
  line: z
    .number()
    .int()
    .positive()
    .describe(
      'The line number there: in the file as the commit left it, in the message, or in the text.',
    ),
  pattern: z
    .string()
    .describe(
      'The name of the rule that matched. The matched value is never returned, logged or stored.',
    ),
});

export const HostCommitScanUnscannedReasonSchema = z
  .enum(['binary', 'nul-byte', 'too-large', 'line-too-long', 'lfs'])
  .describe(
    'Why a file was not read whole. `binary`: git prints no lines for it. `nul-byte`: a line it ' +
      'adds holds a NUL byte, and nothing after that line was read. `too-large`: it adds more ' +
      'than the scan reads of one file in one commit, and nothing past that point was read. ' +
      '`line-too-long`: a line it adds is longer than the scan reads of one line; that line was ' +
      'not read, the rest of the file was. `lfs`: what it adds is a Git LFS pointer, and the ' +
      "content the operator's git uploads on push is not in the commit to be read. A message " +
      'or a text is not read whole for the same reasons as a file, `binary` and `lfs` apart.',
  );

export const HostCommitScanUnscannedSchema = z.object({
  file: z.string().describe(HOST_COMMIT_SCAN_PLACE_DESCRIPTION),
  reason: HostCommitScanUnscannedReasonSchema,
});

export const HostCommitScanOutputSchema = z.object({
  clean: z
    .boolean()
    .describe(
      'True only when every file the range adds lines to, the headers and message of every ' +
        'one of its commits and ' +
        'every text in `texts` was read whole and no rule matched any line in them, marked ' +
        'allowed or not. A range with an entry in `unscanned` or a line in `allowed` is never ' +
        'clean, whatever else was found.',
    ),
  findings: z
    .array(HostCommitScanFindingSchema)
    .describe(
      'Where a rule matched, at most one finding per line and capped in number; `summary` ' +
        'says how many there were in all. A file in `unscanned` keeps the findings from the ' +
        'part of it that was read.',
    ),
  unscanned: z
    .array(HostCommitScanUnscannedSchema)
    .describe(
      'Every file, message or text the scan could not read whole, with why, capped in number ' +
        'as findings are. Nothing the scan did not read was cleared.',
    ),
  allowed: z
    .array(HostCommitScanFindingSchema)
    .describe(
      'Lines a rule matched that end in a comment carrying `aflow-scan: allow` — `//`, `#`, ' +
        '`--`, `/* … */` or `<!-- … -->`, the marker the last thing on the line. Reported ' +
        'here rather than in `findings`, and never cleared: whoever wrote the line could have ' +
        'written the comment, so a range with one is not `clean` and the operator reads it.',
    ),
  summary: z
    .string()
    .describe(
      'One paragraph for a person: every finding by where it is, line and rule, how many ' +
        'were left out past the cap, what was not read whole and why, and which lines were ' +
        'marked allowed.',
    ),
  unflaggedRange: z
    .string()
    .optional()
    .describe(
      'The range as two full shas, present when no line that was read — of a file, a ' +
        'message or a text — is in `findings`, whether or not everything was read whole or a ' +
        'line was marked allowed. A step that must stop on a finding reads this, so a range ' +
        'with a finding fails it.',
    ),
  clearedRange: z
    .string()
    .optional()
    .describe(
      'The range this scan cleared, as two full shas — present only when it is clean: every ' +
        'file, message and text read whole, nothing found and nothing marked allowed.',
    ),
  receipt: HostScanReceiptSchema.optional().describe(
    'What a push of the range must carry, present exactly when `unflaggedRange` is: it names ' +
      'the folder, the base and the last commit of the range, and whether the scan cleared ' +
      'it or the operator has to approve the push first. Valid on this executor only, and ' +
      'only for a day.',
  ),
});

/**
 * How much of a check's output is returned inline. A failure message carries
 * it, so it is sized for the end of a type-check's errors or a test run's
 * report — where a failing check says why — and not for the whole run.
 */
export const HOST_CHECK_TAIL_BYTES = 4 * 1024;

/**
 * How much of the start of a check's output is stored: the steps it reports
 * before the first failure — what ran and what passed — with room to spare.
 */
export const HOST_CHECK_OUTPUT_HEAD_BYTES = 64 * 1024;

/**
 * How much of the end of a check's output is stored, where a failing check
 * says why. A test runner's failure block — the assertion, its diff, the code
 * frame and the stack — runs to a few kilobytes, and every failure of a scoped
 * run with its summary fits with room to spare; past this a check is printing
 * in a loop. What falls between the head and this is let go, the cut marked.
 */
export const HOST_CHECK_OUTPUT_TAIL_BYTES = 1024 * 1024;

export const HostCommitCheckInputSchema = z.object({
  bindingId: HostBindingRef,
  sha: HostCommitShaSchema.describe(
    'The commit to check — a publication passes the commit it made. The checks run in a ' +
      'detached checkout of it and see it as `AFLOW_CHECK_SHA`, a full sha.',
  ),
  base: HostCommitShaSchema.describe(
    'What the commit is measured against — a publication passes the first sha of its ' +
      '`pushRange`, where `origin`’s base branch stood. The checks see it as ' +
      '`AFLOW_CHECK_BASE`, a full sha, so a repository’s own script can read what changed.',
  ),
});

export const HostCommitCheckOutputSchema = z.object({
  passed: z
    .boolean()
    .describe(
      'True when the checks exited 0 within their time, or the folder declares none. A ' +
        'check that exited otherwise, was stopped at its time or ended by a signal did not pass.',
    ),
  skipped: z
    .boolean()
    .optional()
    .describe(
      'True where the folder declares no checks: nothing ran, so `passed` says only that ' +
        'nothing failed. Absent where the checks ran.',
    ),
  checks: z
    .array(z.string())
    .optional()
    .describe('The argv that ran, as the folder declares it. Absent where it declares none.'),
  timedOut: z
    .boolean()
    .optional()
    .describe(
      'True when the checks were stopped at the folder’s `checksTimeoutMs`. Present only then.',
    ),
  exitCode: z
    .number()
    .int()
    .nullable()
    .describe('How the checks exited; null where none ran, or a signal or the time ended them.'),
  durationMs: z.number().int().nonnegative(),
  outputRef: z
    .string()
    .optional()
    .describe(
      'Standard output and error together, in the order they came, stored as a payload — where ' +
        'there was more, the first `HOST_CHECK_OUTPUT_HEAD_BYTES` and the last ' +
        '`HOST_CHECK_OUTPUT_TAIL_BYTES` of them, with a line between saying how much was not ' +
        'kept. Absent where nothing ran.',
    ),
  tail: z
    .string()
    .describe(
      'The last `HOST_CHECK_TAIL_BYTES` of that output, inline — where a failing check says ' +
        'why. Empty where nothing ran.',
    ),
  summary: z
    .string()
    .describe(
      'One paragraph for a person: whether the checks passed, failed, ran out of time or were ' +
        'not declared, and, where they did not pass, the tail of what they printed.',
    ),
  clearedSha: z
    .string()
    .optional()
    .describe(
      'The commit as a full sha, present only where the checks passed or the folder declares ' +
        'none. A step that must stop on a failing check reads this, so a failure fails it.',
    ),
  receipt: HostCheckReceiptSchema.optional().describe(
    'What a push of the commit must carry as `check.receipt`, present wherever the checks ran, ' +
      'passed or not: it names the folder, the commit, the base, the checks and whether they ' +
      'passed, and a push takes only one that says they did. Absent where the folder declares ' +
      'none. Valid on this executor only, and only for a day.',
  ),
});
