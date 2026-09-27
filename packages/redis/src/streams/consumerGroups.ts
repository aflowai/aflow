import type { Redis } from 'ioredis';
import { StreamKeys, ConsumerGroups, EXECUTOR_JOB_STEP_TYPES } from '@aflow/schemas';
// ============================================================================
// Consumer Group Management
// ============================================================================

/**
 * Ensure a consumer group exists for a stream.
 * Creates the stream and group if they don't exist.
 */
export async function ensureConsumerGroup(
  redis: Redis,
  streamKey: string,
  groupName: string,
): Promise<void> {
  try {
    // Try to create the group, starting from the beginning of the stream
    await redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
  } catch (error) {
    // Group already exists - this is fine
    if (error instanceof Error && error.message.includes('BUSYGROUP')) {
      return;
    }
    throw error;
  }
}

/**
 * Ensure all job stream consumer groups exist.
 */
export async function ensureJobStreamGroups(redis: Redis): Promise<void> {
  await Promise.all(
    EXECUTOR_JOB_STEP_TYPES.map((stepType) =>
      ensureConsumerGroup(redis, StreamKeys.jobStream(stepType), ConsumerGroups.executor(stepType)),
    ),
  );
}
