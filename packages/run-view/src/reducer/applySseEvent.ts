import type { SessionEvent } from '../types.js';
import type { RunViewState } from './state.js';
import { applyMcpElicitationEvent } from './events/mcpElicitation.js';
import { applySessionLifecycleEvents } from './events/sessionLifecycle.js';
import { applyStepEvents } from './events/stepEvents.js';
import { applySurfaceEvents } from './events/surfaceEvents.js';
import { applyWorkflowEvents } from './events/workflowEvents.js';
import { settleHarnessActivity } from './events/harnessActivity.js';
import { applyRunWakeupEvent } from './events/runWakeup.js';

export function applySseEvent(
  state: RunViewState,
  event: SessionEvent,
  flowName?: string,
): RunViewState {
  const eventTimestampMs = ((): number => {
    const ms = Date.parse(event.timestamp);
    return Number.isNaN(ms) ? 0 : ms;
  })();

  const stepSenderName = ((): string | undefined => {
    const metaName = event.metadata?.stepName ?? event.data.stepName;
    if (typeof metaName === 'string' && metaName) return metaName;
    if (event.data.stepId) return event.data.stepId;
    if (event.data.stepType) return event.data.stepType;
    return flowName;
  })();

  let stepDetailCacheNext = state._stepDetailCache;
  const stepDetail = ((): string | undefined => {
    const detail = event.metadata?.stepDetail ?? event.data.stepDetail;
    const stepExecId = event.stepExecutionId;
    if (typeof detail === 'string' && detail) {
      if (stepExecId) {
        stepDetailCacheNext = { ...stepDetailCacheNext, [stepExecId]: detail };
      }
      return detail;
    }
    return stepExecId ? stepDetailCacheNext[stepExecId] : undefined;
  })();

  const ctx = {
    flowName,
    eventTimestampMs,
    stepSenderName,
    stepDetail,
    stepDetailCacheNext,
  };

  let next = applySessionLifecycleEvents(state, event, ctx);
  next = applyStepEvents(next, event, ctx);
  next = applySurfaceEvents(next, event, ctx);
  next = applyWorkflowEvents(next, event, ctx);
  next = applyMcpElicitationEvent(next, event);
  next = settleHarnessActivity(next, event);
  next = applyRunWakeupEvent(next, event);
  return next;
}
