/**
 * Pure ID generation utilities for SessionOrchestrator.
 */
import type { StepExecutionId } from '@aflow/schemas';

export function generateStepExecutionId(): StepExecutionId {
  return crypto.randomUUID() as StepExecutionId;
}

export function generateEventId(): string {
  return crypto.randomUUID();
}
