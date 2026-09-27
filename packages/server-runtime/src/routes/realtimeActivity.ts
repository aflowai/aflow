import { z } from 'zod';
import { broadcastActivityToSubscribers } from './realtimeTopics/activity.js';

const ActivitySignalSchema = z.object({
  type: z.literal('activity'),
  scope: z.enum(['run', 'session']),
  tenantId: z.string(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  stepExecutionId: z.string().optional(),
  stepType: z.string().optional(),
  operationId: z.string().optional(),
  label: z.string().max(200),
  source: z.enum(['orchestrator', 'executor', 'ui']).optional(),
  startedAtMs: z.number(),
  ttlMs: z.number().default(6000),
});
type ActivitySignal = z.infer<typeof ActivitySignalSchema>;

export function broadcastActivity(signal: ActivitySignal): void {
  const validated = ActivitySignalSchema.parse(signal);
  broadcastActivityToSubscribers({
    tenantId: validated.tenantId,
    ...(validated.sessionId ? { sessionId: validated.sessionId } : {}),
    ...(validated.runId ? { runId: validated.runId } : {}),
    ...(validated.stepExecutionId ? { stepExecutionId: validated.stepExecutionId } : {}),
    ...(validated.stepType ? { stepType: validated.stepType } : {}),
    ...(validated.operationId ? { operationId: validated.operationId } : {}),
    label: validated.label,
    ...(validated.source ? { source: validated.source } : {}),
    startedAtMs: validated.startedAtMs,
    ttlMs: validated.ttlMs,
  });
}

export function sendStepActivity(params: {
  tenantId: string;
  runId: string;
  stepExecutionId: string;
  stepType: string;
  operationId?: string;
  label: string;
}): void {
  broadcastActivity({
    type: 'activity',
    scope: 'run',
    tenantId: params.tenantId,
    runId: params.runId,
    stepExecutionId: params.stepExecutionId,
    stepType: params.stepType,
    operationId: params.operationId,
    label: params.label,
    source: 'orchestrator',
    startedAtMs: Date.now(),
    ttlMs: 6000,
  });
}

export function sendThinkingActivity(tenantId: string, runId: string): void {
  broadcastActivity({
    type: 'activity',
    scope: 'run',
    tenantId,
    runId,
    label: 'Thinking…',
    source: 'orchestrator',
    startedAtMs: Date.now(),
    ttlMs: 6000,
  });
}
