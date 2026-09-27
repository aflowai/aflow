import type { Redis } from 'ioredis';
import { StreamKeys, ConsumerGroups } from '@aflow/schemas';
import { SHARD_COUNT } from '../shard.js';
import { ensureConsumerGroup } from './consumerGroups.js';

// ============================================================================
// Shard Stream Consumer Group Setup
// ============================================================================

/**
 * Ensure consumer groups exist on all shard control and result streams.
 * Call at orchestrator startup. Uses MKSTREAM to create streams on demand.
 */
export async function ensureShardStreamGroups(redis: Redis): Promise<void> {
  const promises: Array<Promise<void>> = [];
  for (let shardId = 0; shardId < SHARD_COUNT; shardId++) {
    promises.push(
      ensureConsumerGroup(
        redis,
        StreamKeys.shardControlStream(shardId),
        ConsumerGroups.orchestratorControl,
      ),
    );
    promises.push(
      ensureConsumerGroup(
        redis,
        StreamKeys.shardResultsStream(shardId),
        ConsumerGroups.orchestrator,
      ),
    );
  }
  await Promise.all(promises);
}
