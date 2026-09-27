/**
 * Post-commit fanout for a committed applet action: the realtime delta for
 * mounted views, then the attention-cache bump — the Active-applets block is
 * cached per space, and a stale line naming the wrong waitingOn reads as
 * authoritative (§4.13). Both halves swallow their own failures, so fanout
 * never fails the write that produced it.
 */
import type { Redis } from 'ioredis';
import { bumpAttentionGeneration } from '@aflow/cybernetic-runtime';
import { publishAppletInstanceDelta } from '@aflow/redis';
import type { AppletDeltaPublisher } from './appletHandler.js';

export function createAppletDeltaFanout(redis: Redis): AppletDeltaPublisher {
  return async (tenantId, spaceId, delta) => {
    await publishAppletInstanceDelta(redis, tenantId, delta);
    await bumpAttentionGeneration(redis, tenantId, spaceId);
  };
}
