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
import { HostHarnessRunInputSchema, HostProcessExecInputSchema } from '@aflow/schemas';

/** Silence tolerated on a streaming host job; a harness thinks longer than it talks. */
export const HOST_STREAM_IDLE_MS = positiveMsEnv('HOST_STREAM_IDLE_TIMEOUT_MS', 900_000);

/** Room for the handler's own kill to report before the executor reaps the step. */
export const HOST_OUTER_TIMEOUT_MARGIN_MS = 30_000;

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

export async function resolveHostTimeout(ctx: ExecutorContext): Promise<TimeoutSpec | undefined> {
  // A number the operator set on the step is a number: it stays a flat clock.
  if (ctx.stepDefinition?.timeout?.executionTimeoutMs !== undefined) return undefined;
  const ceiling = streamCeilingMs(ctx.operationId, await ctx.readPayload(ctx.job.inputRef));
  if (ceiling === undefined) return undefined;
  const maxMs = ceiling + HOST_OUTER_TIMEOUT_MARGIN_MS;
  return { idleMs: Math.min(HOST_STREAM_IDLE_MS, maxMs), maxMs };
}
