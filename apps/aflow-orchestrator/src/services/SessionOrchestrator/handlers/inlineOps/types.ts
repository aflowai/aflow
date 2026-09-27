import type { Redis } from 'ioredis';
import type {
  StepExecutionId,
  StepDefinition,
  IdempotencyKey,
  WorkflowExecutionRef,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { FlowExecutionContext } from '../../types.js';

export interface InlineHandlerArgs {
  redis: Redis;
  payloadStore: PayloadStore;
  context: FlowExecutionContext;
  stepDef: StepDefinition;
  stepExecutionId: StepExecutionId;
  idempotencyKey: IdempotencyKey;
  resolvedInputRef: string;
  attempt: number;
  scheduledAtMs: number;
  parentStepExecutionId?: StepExecutionId;
  workflowExecution?: WorkflowExecutionRef;
}
