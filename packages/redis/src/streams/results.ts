import type { Redis } from 'ioredis';
import { StepResultMessageSchema, StreamKeys, type StepResultMessage } from '@aflow/schemas';
import { shardFor } from '../shard.js';
import { serializeMessage } from './serialization.js';
import { armRetentionCandidate, firstReplyString } from './retention.js';
// ============================================================================
// Result Stream Operations (Executors → Orchestrator)
// ============================================================================

/**
 * Add a step result to the shard-scoped results stream.
 * Routes to aflow:shard:{shardId}:results based on runId.
 */
export async function addStepResult(redis: Redis, result: StepResultMessage): Promise<string> {
  // Validate the result message
  const validatedResult = StepResultMessageSchema.parse(result);

  const fields = serializeMessage(validatedResult);
  const shardKey = validatedResult.sessionId ?? validatedResult.workflowExecution!.runId;
  const shardId = shardFor(shardKey);
  const streamKey = StreamKeys.shardResultsStream(shardId);
  const pipeline = redis.pipeline().xadd(streamKey, '*', ...fields);
  armRetentionCandidate(pipeline, streamKey);
  const messageId = firstReplyString(await pipeline.exec());
  if (messageId === null) {
    throw new Error('Failed to add result to stream');
  }
  return messageId;
}
