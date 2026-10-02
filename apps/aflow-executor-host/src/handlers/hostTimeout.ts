/**
 * How long a host job may run before the executor reaps it.
 *
 * The executor-wide default is a flat clock sized for a file read. A harness
 * or a command is a stream: it is alive while it talks, and it can be silent
 * for a long tool call without being dead. So those two get a sliding idle
 * deadline under a ceiling the operation's own `timeoutMs` already names, with
 * room for the handler's own kill to return first — the same pairing the AI
 * and compute executors declare.
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
 * A check's ceiling is the folder's, read from the machine's policy: the step
 * names no time, so that no caller can choose how long the operator's checks
 * get. A folder that declares none answers at once, on the flat clock.
 */
async function checkCeilingMs(raw: unknown, policyPath: string): Promise<number | undefined> {
  const parsed = HostCommitCheckInputSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const binding = (await loadHostPolicy(policyPath).catch(() => undefined))?.bindings.get(
    parsed.data.bindingId,
  );
  if (binding === undefined) return undefined;
  const { argv, timeoutMs } = checksOf(binding);
  return argv === undefined ? undefined : timeoutMs + HOST_CHECK_CHECKOUT_MARGIN_MS;
}

async function streamCeilingMs(
  operationId: string,
  raw: unknown,
  policyPath: string,
): Promise<number | undefined> {
  if (operationId === 'host.harness.run') {
    const parsed = HostHarnessRunInputSchema.safeParse(raw);
    return parsed.success ? parsed.data.timeoutMs : undefined;
  }
  if (operationId === 'host.process.exec') {
    const parsed = HostProcessExecInputSchema.safeParse(raw);
    // A detached process returns its handle at once; the step is not the process.
    return parsed.success && !parsed.data.detach ? parsed.data.timeoutMs : undefined;
  }
  if (operationId === 'host.commit.check') return await checkCeilingMs(raw, policyPath);
  return undefined;
}

export async function resolveHostTimeout(
  ctx: ExecutorContext,
  policyPath: string,
): Promise<TimeoutSpec | undefined> {
  // A number the operator set on the step is a number: it stays a flat clock.
  if (ctx.stepDefinition?.timeout?.executionTimeoutMs !== undefined) return undefined;
  const ceiling = await streamCeilingMs(
    ctx.operationId,
    await ctx.readPayload(ctx.job.inputRef),
    policyPath,
  );
  if (ceiling === undefined) return undefined;
  const maxMs = ceiling + HOST_OUTER_TIMEOUT_MARGIN_MS;
  return { idleMs: Math.min(HOST_STREAM_IDLE_MS, maxMs), maxMs };
}
