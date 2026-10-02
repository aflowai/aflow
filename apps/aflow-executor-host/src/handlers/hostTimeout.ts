/**
 * How long a host job may run before the executor reaps it.
 *
 * The executor-wide default is a flat clock sized for a file read. A harness
 * or a command is a stream: it is alive while it talks, and it can be silent
 * for a long tool call without being dead. So those two get a sliding idle
 * deadline under a ceiling the operation's own `timeoutMs` already names, with
 * room for the handler's own kill to return first — the same pairing the AI
 * and compute executors declare. A check is neither: see `checkDeadlineMs`.
 */
import type { ExecutorContext, TimeoutSpec } from '@aflow/executor-runtime';
import { positiveMsEnv } from '@aflow/lib';
import {
  HostCommitCheckInputSchema,
  HostHarnessRunInputSchema,
  HostProcessExecInputSchema,
} from '@aflow/schemas';

import { loadHostPolicy } from '../bindings.js';
import { checksOf } from '../folderChecks.js';

/** Silence tolerated on a streaming host job; a harness thinks longer than it talks. */
export const HOST_STREAM_IDLE_MS = positiveMsEnv('HOST_STREAM_IDLE_TIMEOUT_MS', 900_000);

/** Room for the handler's own kill to report before the executor reaps the step. */
export const HOST_OUTER_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Room around a check for adding its checkout, linking the folder's
 * dependencies into it and taking it away — seconds on an ordinary disk, and
 * never part of the time the operator gave the checks themselves.
 */
export const HOST_CHECK_CHECKOUT_MARGIN_MS = 120_000;

/**
 * A check's deadline is the folder's, read from the machine's policy: the step
 * names no time, so that no caller can choose how long the operator's checks
 * get. A folder that declares none answers at once, on the executor's clock.
 *
 * It is a flat deadline with no idle window. A check is a batch program, not a
 * stream: a test suite or a build can print nothing for longer than any idle
 * window and still be working, so silence says nothing about it. Only the
 * folder's `checksTimeoutMs` stops it, and the handler's own kill at that time
 * reports it as the check's timeout before this deadline is reached.
 */
async function checkDeadlineMs(raw: unknown, policyPath: string): Promise<number | undefined> {
  const parsed = HostCommitCheckInputSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const binding = (await loadHostPolicy(policyPath).catch(() => undefined))?.bindings.get(
    parsed.data.bindingId,
  );
  if (binding === undefined) return undefined;
  const { argv, timeoutMs } = checksOf(binding);
  return argv === undefined
    ? undefined
    : timeoutMs + HOST_CHECK_CHECKOUT_MARGIN_MS + HOST_OUTER_TIMEOUT_MARGIN_MS;
}

function streamCeilingMs(operationId: string, raw: unknown): number | undefined {
  if (operationId === 'host.harness.run') {
    const parsed = HostHarnessRunInputSchema.safeParse(raw);
    return parsed.success ? parsed.data.timeoutMs : undefined;
  }
  if (operationId === 'host.process.exec') {
    const parsed = HostProcessExecInputSchema.safeParse(raw);
    // A detached process returns its handle at once; the step is not the process.
    return parsed.success && !parsed.data.detach ? parsed.data.timeoutMs : undefined;
  }
  return undefined;
}

export async function resolveHostTimeout(
  ctx: ExecutorContext,
  policyPath: string,
): Promise<TimeoutSpec | undefined> {
  // A number the operator set on the step is a number: it stays a flat clock.
  if (ctx.stepDefinition?.timeout?.executionTimeoutMs !== undefined) return undefined;
  const input = await ctx.readPayload(ctx.job.inputRef);
  if (ctx.operationId === 'host.commit.check') return await checkDeadlineMs(input, policyPath);
  const ceiling = streamCeilingMs(ctx.operationId, input);
  if (ceiling === undefined) return undefined;
  const maxMs = ceiling + HOST_OUTER_TIMEOUT_MARGIN_MS;
  return { idleMs: Math.min(HOST_STREAM_IDLE_MS, maxMs), maxMs };
}
