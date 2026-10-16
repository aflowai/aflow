/**
 * `host.commit.check`: a connected folder's declared checks, run on one
 * commit before a publication pushes it, and what they answer.
 */
import { z } from 'zod';

import {
  HostBindingRef,
  HostCheckReceiptSchema,
  HostCommitShaSchema,
  HostSandboxPostureSchema,
} from './host.js';

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

/**
 * How many of the tests that ran out of time a check names in its answer. A
 * run that lost a whole suite to load names the rest by count in its summary;
 * the stored output carries every line.
 */
export const HOST_CHECK_TEST_TIMEOUTS_MAX = 20;

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
  testTimeouts: z
    .array(z.string())
    .max(HOST_CHECK_TEST_TIMEOUTS_MAX)
    .optional()
    .describe(
      'The tests that ran out of their time, each as `<file> › <suite> › <test>`, present only ' +
        'where the checks exited on their own and reported, in the file `AFLOW_CHECK_REPORT` ' +
        'names, that nothing else failed — what a machine under load does to a passing commit. ' +
        'At most `HOST_CHECK_TEST_TIMEOUTS_MAX`; the summary counts the rest.',
    ),
  clearedOrRetriableSha: z
    .string()
    .optional()
    .describe(
      'The commit as a full sha, present where the checks passed, the folder declares none, ' +
        'or only `testTimeouts` failed them. A publication’s first run of the checks reads ' +
        'this, so every other failure fails it and a run lost to load alone is run once more.',
    ),
  receipt: HostCheckReceiptSchema.optional().describe(
    'What a push of the commit must carry as `check.receipt`, present wherever the checks ran, ' +
      'passed or not: it names the folder, the commit, the base, the checks, the posture they ran under, ' +
      'how many tests that listen on a port of their own they skipped and whether they passed, ' +
      'and a push takes only one that says they did. Absent where the folder declares ' +
      'none. Valid on this executor only, and only for a day.',
  ),
  sandbox: HostSandboxPostureSchema.optional().describe(
    'The sandbox posture the checks ran under, which their `receipt` carries and a push ' +
      'records. Absent where the folder declares none.',
  ),
  skippedListenerTests: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'How many tests that listen on a port of their own the checks skipped, as they reported ' +
        'it in the file `AFLOW_CHECK_REPORT` names; the `receipt` carries the same count. Such ' +
        'a test cannot listen under the sandbox on macOS, and runs in the pull request’s ' +
        'checks instead. Absent where the checks reported nothing.',
    ),
});
