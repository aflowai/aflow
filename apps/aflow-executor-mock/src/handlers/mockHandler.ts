/**
 * Mock step handler for contract testing.
 *
 * This is DEV-ONLY: it exists to validate wiring (streams + payload store + result emission)
 * before real executor business logic is implemented.
 */
import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError, pausedWithRequest } from '@aflow/executor-runtime';
import type { AflowError } from '@aflow/schemas';

interface MockDirective {
  status?: 'SUCCEEDED' | 'FAILED' | 'PAUSED';
  delayMs?: number;
  output?: unknown;
  prompt?: string;
  error?: { code?: string; message?: string };
}

function extractMockDirective(input: unknown): MockDirective | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const raw = record['__mock'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  return raw as MockDirective;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      resolve();
    }, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Aborted'));
      },
      { once: true },
    );
  });
}

export class MockHandler implements StepHandler {
  readonly stepType: string;

  constructor(stepType: string) {
    this.stepType = stepType;
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const input = await ctx.readPayload(ctx.job.inputRef);
    const mock = extractMockDirective(input);

    const delayMs = mock?.delayMs ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs, ctx.signal);
    }

    const requestedStatus = mock?.status ?? 'SUCCEEDED';

    if (requestedStatus === 'PAUSED') {
      return pausedWithRequest(ctx, {
        prompt: mock?.prompt ?? `Mock pause from ${ctx.job.operationId}`,
        inputSchema: { type: 'object', additionalProperties: true },
      });
    }

    if (requestedStatus === 'FAILED') {
      const code = mock?.error?.code ?? 'MOCK_FAILED';
      const message = mock?.error?.message ?? 'Mock failure (dev-only)';
      const error: AflowError = {
        code,
        message,
        classification: 'internal',
        retryable: false,
        timestamp: new Date().toISOString(),
      };
      return failureWithError(ctx, error);
    }

    // SUCCEEDED — check for special operations first

    // agent.control.end: return proper output structure
    if (ctx.job.operationId === 'agent.control.end') {
      const endFlowInput =
        input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const endFlowOutput = {
        ended: true as const,
        reason: (endFlowInput['reason'] as string | undefined) ?? undefined,
      };
      return successWithData(ctx, endFlowOutput);
    }

    const output =
      mock?.output ??
      ({
        ok: true,
        mock: true,
        stepType: ctx.job.stepType,
        operationId: ctx.job.operationId,
        receivedInput: input,
        finishedAt: new Date().toISOString(),
      } satisfies Record<string, unknown>);

    return successWithData(ctx, output);
  }
}
