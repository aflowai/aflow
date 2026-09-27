import { SnoozeInputSchema, clampSnoozeDurationMs } from '@aflow/schemas';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';

export async function handleScheduleSnoozeInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  try {
    let input: unknown = {};
    try {
      input = await args.payloadStore.retrieve(args.resolvedInputRef);
    } catch {
      /* empty input — fails validation below */
    }

    const parsed = SnoozeInputSchema.safeParse(input);
    if (!parsed.success) {
      // Defense-in-depth: both legs validate before scheduling the timer
      // (session: step input validation; workflow: dispatchTask pre-claim).
      await emitStepError(
        args,
        'SNOOZE_INVALID_INPUT',
        `Invalid snooze input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        startTime,
        'validation',
      );
      return;
    }

    const requestedMs = parsed.data.durationMs;
    const waitedMs = clampSnoozeDurationMs(requestedMs);
    await emitStepSuccess(
      args,
      { requestedMs, waitedMs, resumedAt: new Date().toISOString() },
      startTime,
    );
  } catch (err) {
    await emitStepError(
      args,
      'SNOOZE_FAILED',
      err instanceof Error ? err.message : String(err),
      startTime,
      'internal',
    );
  }
}
