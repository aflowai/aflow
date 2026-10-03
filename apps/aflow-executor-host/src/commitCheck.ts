/**
 * Running a connected folder's declared checks on one commit.
 *
 * The checkout is prepared as a commission's is — detached at the commit, the
 * folder's installed dependencies linked so nothing is installed — and the
 * command runs there as a coding agent does, under the sandbox and the folder's
 * posture: the checkout writable and the folder itself not, and the network
 * the posture opens — every host and loopback under `open`, none but the
 * sandbox's own under `confined`. What it printed is kept in the order it came,
 * and from both ends where there is too much of it: its start says what ran,
 * and a failing check says why last.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HOST_CHECK_OUTPUT_HEAD_BYTES,
  HOST_CHECK_OUTPUT_TAIL_BYTES,
  HOST_CHECK_TAIL_BYTES,
  type HostCommitCheckOutputSchema,
} from '@aflow/schemas';
import type { z } from 'zod';

import type { HostBinding } from './bindings.js';
import { SHORT_SHA_LENGTH } from './checkReceipt.js';
import { createChatterStripper } from './egressRefusals.js';
import { formatMinutes } from './folderChecks.js';
import { runUnderFolderPosture } from './folderRun.js';
import type { SandboxedRunResult } from './sandboxedRun.js';
import { NO_REPLACE_OBJECTS_ENV, prepareWorktree, removeWorktree } from './worktree.js';

type HostCommitCheckOutput = z.infer<typeof HostCommitCheckOutputSchema>;

/** The directories under the temp root a check's checkout is added in, so the boot sweep knows them. */
export const CHECK_SCRATCH_PREFIX = 'aflow-check-';

/**
 * Text kept from its end, by bytes, as it arrives. Chunks are held whole and
 * dropped from the front once the total passes the limit, so the cost stays
 * proportional to what is kept rather than to what was printed.
 */
export function createTailBuffer(maxBytes: number): {
  push: (text: string | Buffer) => void;
  text: () => { text: string; droppedBytes: number };
} {
  const chunks: Buffer[] = [];
  let held = 0;
  let dropped = 0;
  return {
    push(text: string | Buffer): void {
      if (text.length === 0) return;
      const chunk = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
      chunks.push(chunk);
      held += chunk.length;
      while (chunks.length > 1 && held - (chunks[0]?.length ?? 0) >= maxBytes) {
        const first = chunks.shift();
        held -= first?.length ?? 0;
        dropped += first?.length ?? 0;
      }
    },
    text(): { text: string; droppedBytes: number } {
      const whole = Buffer.concat(chunks);
      const over = Math.max(0, whole.length - maxBytes);
      return { text: utf8Suffix(whole, maxBytes), droppedBytes: dropped + over };
    },
  };
}

/**
 * The last `maxBytes` of UTF-8 text, never starting inside a character: the
 * cut moves forward past continuation bytes, so the result is at most that
 * long and always decodes.
 */
export function utf8Suffix(text: string | Buffer, maxBytes: number): string {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  let start = bytes.length - maxBytes;
  // 0b10xxxxxx is a continuation byte: the middle of a character.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** How many leading bytes of `bytes`, at most `maxBytes`, end on a character boundary. */
function utf8PrefixLength(bytes: Buffer, maxBytes: number): number {
  if (bytes.length <= maxBytes) return bytes.length;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Text kept from both ends, by bytes, as it arrives: the first `headBytes`,
 * and the last `tailBytes` as `createTailBuffer` keeps them. A run's start
 * says what ran and its end why it failed, so it is the middle that goes; the
 * head then ends and the tail starts at whole lines, with a line between
 * saying how much was not kept.
 */
export function createHeadTailBuffer(
  headBytes: number,
  tailBytes: number,
): {
  push: (text: string) => void;
  text: () => string;
} {
  const head: Buffer[] = [];
  let headHeld = 0;
  const tail = createTailBuffer(tailBytes);
  return {
    push(text: string): void {
      const chunk = Buffer.from(text, 'utf8');
      const taken = utf8PrefixLength(chunk, headBytes - headHeld);
      if (taken > 0) {
        head.push(chunk.subarray(0, taken));
        headHeld += taken;
      }
      tail.push(chunk.subarray(taken));
    },
    text(): string {
      const start = Buffer.concat(head).toString('utf8');
      const end = tail.text();
      if (end.droppedBytes === 0) return `${start}${end.text}`;
      const headLineEnd = start.lastIndexOf('\n') + 1;
      const keptHead = headLineEnd === 0 ? `${start}\n` : start.slice(0, headLineEnd);
      const tailLineStart = end.text.indexOf('\n') + 1;
      const keptTail =
        tailLineStart === 0 || tailLineStart === end.text.length
          ? end.text
          : end.text.slice(tailLineStart);
      const dropped =
        end.droppedBytes +
        Buffer.byteLength(start.slice(keptHead.length)) +
        Buffer.byteLength(end.text.slice(0, end.text.length - keptTail.length));
      return `${keptHead}[${String(dropped)} bytes printed here were not kept]\n${keptTail}`;
    },
  };
}

/** The tail a person reads: whole lines where the cut fell inside one and a later line exists. */
export function checkTail(output: string): string {
  const tail = utf8Suffix(output, HOST_CHECK_TAIL_BYTES);
  if (tail.length === output.length) return tail;
  const newline = tail.indexOf('\n');
  return newline === -1 || newline === tail.length - 1 ? tail : tail.slice(newline + 1);
}

export interface FolderCheckRun {
  readonly result: SandboxedRunResult;
  /** Standard output and error together: the start and the end of them, the cut marked, where there was more. */
  readonly output: string;
}

export interface FolderCheckInput {
  readonly binding: HostBinding;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Full shas, already resolved in the folder. */
  readonly sha: string;
  readonly base: string;
  readonly toolPaths: readonly string[];
  readonly ownerRunId: string;
  readonly signal: AbortSignal;
  /** What the check prints, as it prints it. */
  readonly onDelta?: (text: string) => void;
  readonly onOutput?: () => void;
}

export async function runFolderChecks(input: FolderCheckInput): Promise<FolderCheckRun> {
  const scratch = await mkdtemp(join(tmpdir(), CHECK_SCRATCH_PREFIX));
  let worktreePath: string | undefined;
  try {
    const worktree = await prepareWorktree(input.binding.root, scratch, 'check', {
      at: input.sha,
    });
    worktreePath = worktree.path;
    const kept = createHeadTailBuffer(HOST_CHECK_OUTPUT_HEAD_BYTES, HOST_CHECK_OUTPUT_TAIL_BYTES);
    const visible = createChatterStripper();
    const take = (text: string): void => {
      if (text === '') return;
      kept.push(text);
      input.onDelta?.(text);
    };
    const result = await runUnderFolderPosture({
      binding: input.binding,
      argv: [...input.argv],
      cwd: worktree.path,
      env: {},
      trustedEnv: {
        AFLOW_CHECK_SHA: input.sha,
        AFLOW_CHECK_BASE: input.base,
        // A script reading the range reads the commits a push sends, never
        // what a `refs/replace/` ref shows in their place.
        ...NO_REPLACE_OBJECTS_ENV,
      },
      timeoutMs: input.timeoutMs,
      scratchDir: scratch,
      // No host named: a check in a `confined` folder reaches none, and one
      // in an `open` folder reaches every host without being told.
      widening: {
        authPaths: [],
        allowedDomains: [],
        writableRoot: worktree.path,
        withholdBindingWrite: true,
      },
      toolPaths: input.toolPaths,
      idPrefix: 'hc',
      ownerRunId: input.ownerRunId,
      signal: input.signal,
      closeStdin: true,
      // Both streams, interleaved as they arrive: a compiler and a test runner
      // report failures on standard error, and the order is what reads.
      liveStderr: true,
      onDelta: (text) => {
        take(visible.push(text));
      },
      ...(input.onOutput !== undefined ? { onOutput: input.onOutput } : {}),
    });
    take(visible.flush());
    return { result, output: kept.text() };
  } finally {
    if (worktreePath !== undefined) await removeWorktree(input.binding.root, worktreePath);
    await rm(scratch, { recursive: true, force: true });
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** What a folder that declares no checks answers, before anything is touched. */
export function skippedCheck(bindingId: string, sha: string): HostCommitCheckOutput {
  return {
    passed: true,
    skipped: true,
    exitCode: null,
    durationMs: 0,
    tail: '',
    summary:
      `\`${bindingId}\` declares no checks, so none ran and ${sha.slice(0, SHORT_SHA_LENGTH)} ` +
      'was not checked on this machine. The operator declares them on the machine holding ' +
      `the folder: \`aflow harness checks ${bindingId} -- <program> [args...]\`.`,
    clearedSha: sha,
  };
}

/** The check's answer, from what ran. */
export function checkOutcome(params: {
  readonly bindingId: string;
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly sha: string;
  readonly run: FolderCheckRun;
  readonly outputRef: string;
}): HostCommitCheckOutput {
  const { result } = params.run;
  const passed = !result.timedOut && result.exitCode === 0;
  const tail = checkTail(params.run.output);
  const command = `\`${params.argv.join(' ')}\``;
  const short = params.sha.slice(0, SHORT_SHA_LENGTH);
  const printed =
    tail.trim() === ''
      ? ' It printed nothing.'
      : ` The last of what it printed:\n${tail}${tail.endsWith('\n') ? '' : '\n'}`;
  let summary: string;
  if (passed) {
    summary = `${command} passed on ${short} in ${seconds(result.durationMs)}.`;
  } else if (result.timedOut) {
    summary =
      `${command} was still running on ${short} when the folder's \`checksTimeoutMs\`, ` +
      `${formatMinutes(params.timeoutMs)}, ran out, and was stopped: the check failed. Where ` +
      'the checks are slow rather than stuck, give them longer on the machine holding the ' +
      `folder: \`aflow harness checks ${params.bindingId} --timeout-minutes <n>\`.${printed}`;
  } else {
    const ending =
      result.exitCode === null
        ? `was ended by ${result.signal ?? 'a signal'}`
        : `exited ${String(result.exitCode)}`;
    summary = `${command} ${ending} on ${short} after ${seconds(result.durationMs)}: the check failed.${printed}`;
  }
  return {
    passed,
    checks: [...params.argv],
    ...(result.timedOut ? { timedOut: true } : {}),
    exitCode: result.timedOut ? null : result.exitCode,
    durationMs: result.durationMs,
    outputRef: params.outputRef,
    tail,
    summary,
    ...(passed ? { clearedSha: params.sha } : {}),
  };
}
