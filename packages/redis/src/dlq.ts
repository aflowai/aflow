/**
 * Dead Letter Queue (DLQ) Utilities
 *
 * Provides inspection and replay functionality for failed messages.
 *
 * HOT-PATH: NO
 * - These are admin/operational utilities, not used during normal execution
 */

import type { Redis } from 'ioredis';
import { StreamKeys } from '@aflow/schemas';

// =============================================================================
// Types
// =============================================================================

export interface DLQMessage {
  messageId: string;
  streamKey: string;
  timestamp: Date;
  originalPayload: Record<string, string>;
  errorReason: string | undefined;
  failureCount: number | undefined;
  tenantId: string | undefined;
  runId: string | undefined;
  stepExecutionId: string | undefined;
}

export interface DLQStats {
  streamKey: string;
  messageCount: number;
  oldestMessageId: string | undefined;
  newestMessageId: string | undefined;
  oldestTimestamp: Date | undefined;
  newestTimestamp: Date | undefined;
}

export interface ReplayResult {
  messageId: string;
  success: boolean;
  newMessageId: string | undefined;
  error: string | undefined;
}

// =============================================================================
// DLQ Inspector
// =============================================================================

export class DLQInspector {
  constructor(private redis: Redis) {}

  /**
   * Get stats for a DLQ stream.
   */
  async getStats(streamKey: string): Promise<DLQStats> {
    const length = await this.redis.xlen(streamKey);

    if (length === 0) {
      return {
        streamKey,
        messageCount: 0,
        oldestMessageId: undefined,
        newestMessageId: undefined,
        oldestTimestamp: undefined,
        newestTimestamp: undefined,
      };
    }

    // Get oldest and newest entries
    const [oldest] = await this.redis.xrange(streamKey, '-', '+', 'COUNT', 1);
    const [newest] = await this.redis.xrevrange(streamKey, '+', '-', 'COUNT', 1);

    return {
      streamKey,
      messageCount: length,
      oldestMessageId: oldest?.[0],
      newestMessageId: newest?.[0],
      oldestTimestamp: oldest?.[0] ? this.parseMessageIdTimestamp(oldest[0]) : undefined,
      newestTimestamp: newest?.[0] ? this.parseMessageIdTimestamp(newest[0]) : undefined,
    };
  }

  /**
   * Get all DLQ stats across all known streams.
   */
  async getAllStats(): Promise<DLQStats[]> {
    const stats: DLQStats[] = [];

    // Check results DLQ
    stats.push(await this.getStats(StreamKeys.dlqResultsStream));

    // Check job DLQs for common step types
    // In production, you'd want to discover these dynamically
    const stepTypes = [
      'ai.generate',
      'api.http.call',
      'compute.sandbox.exec',
      'user.interaction.ask',
    ];
    for (const stepType of stepTypes) {
      const streamKey = StreamKeys.dlqJobStream(stepType);
      const stat = await this.getStats(streamKey);
      if (stat.messageCount > 0) {
        stats.push(stat);
      }
    }

    return stats;
  }

  /**
   * List messages in a DLQ stream.
   */
  async listMessages(
    streamKey: string,
    options: {
      start?: string;
      end?: string;
      count?: number;
    } = {},
  ): Promise<DLQMessage[]> {
    const { start = '-', end = '+', count = 100 } = options;

    const entries = await this.redis.xrange(streamKey, start, end, 'COUNT', count);

    return entries.map(([messageId, fields]) => {
      const payload: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key && value) {
          payload[key] = value;
        }
      }

      return {
        messageId,
        streamKey,
        timestamp: this.parseMessageIdTimestamp(messageId),
        originalPayload: payload,
        errorReason: payload['error_reason'],
        failureCount: payload['failure_count'] ? parseInt(payload['failure_count'], 10) : undefined,
        tenantId: payload['tenant_id'],
        runId: payload['run_id'],
        stepExecutionId: payload['step_execution_id'],
      };
    });
  }

  /**
   * Get a single message by ID.
   */
  async getMessage(streamKey: string, messageId: string): Promise<DLQMessage | null> {
    const entries = await this.redis.xrange(streamKey, messageId, messageId);
    const entry = entries[0];

    if (!entry) {
      return null;
    }

    const [id, fields] = entry;
    const payload: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];
      if (key && value) {
        payload[key] = value;
      }
    }

    return {
      messageId: id,
      streamKey,
      timestamp: this.parseMessageIdTimestamp(id),
      originalPayload: payload,
      errorReason: payload['error_reason'],
      failureCount: payload['failure_count'] ? parseInt(payload['failure_count'], 10) : undefined,
      tenantId: payload['tenant_id'],
      runId: payload['run_id'],
      stepExecutionId: payload['step_execution_id'],
    };
  }

  /**
   * Delete a message from the DLQ (e.g., after manual review).
   */
  async deleteMessage(streamKey: string, messageId: string): Promise<boolean> {
    const deleted = await this.redis.xdel(streamKey, messageId);
    return deleted === 1;
  }

  /**
   * Delete multiple messages from the DLQ.
   */
  async deleteMessages(streamKey: string, messageIds: string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    return await this.redis.xdel(streamKey, ...messageIds);
  }

  /**
   * Purge all messages from a DLQ stream.
   * WARNING: This is destructive and cannot be undone.
   */
  async purge(streamKey: string): Promise<number> {
    const length = await this.redis.xlen(streamKey);
    if (length === 0) return 0;

    // XTRIM with MINID and very high ID to remove all
    await this.redis.del(streamKey);
    return length;
  }

  private parseMessageIdTimestamp(messageId: string): Date {
    const [timestampMs] = messageId.split('-');
    return new Date(parseInt(timestampMs ?? '0', 10));
  }
}

// =============================================================================
// DLQ Replayer
// =============================================================================

export class DLQReplayer {
  constructor(private redis: Redis) {}

  /**
   * Replay a single message from DLQ back to its original stream.
   *
   * @param dlqStreamKey - The DLQ stream key where the message currently resides
   * @param messageId - The message ID to replay
   * @param targetStreamKey - The stream to replay to (usually the original job/result stream)
   * @param options - Replay options
   */
  async replayMessage(
    dlqStreamKey: string,
    messageId: string,
    targetStreamKey: string,
    options: {
      /** Delete from DLQ after successful replay */
      deleteOnSuccess?: boolean;
      /** Additional fields to add/override */
      additionalFields?: Record<string, string>;
    } = {},
  ): Promise<ReplayResult> {
    const { deleteOnSuccess = true, additionalFields = {} } = options;

    try {
      // Get the original message
      const entries = await this.redis.xrange(dlqStreamKey, messageId, messageId);
      const entry = entries[0];

      if (!entry) {
        return {
          messageId,
          success: false,
          newMessageId: undefined,
          error: 'Message not found in DLQ',
        };
      }

      const [, fields] = entry;

      // Build the replay payload
      const payload: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const value = fields[i + 1];
        if (key && value) {
          // Skip DLQ metadata fields
          if (!key.startsWith('dlq_') && key !== 'error_reason' && key !== 'failure_count') {
            payload[key] = value;
          }
        }
      }

      // Add replay metadata
      payload['replayed_at'] = new Date().toISOString();
      payload['replayed_from_dlq'] = dlqStreamKey;
      payload['original_dlq_message_id'] = messageId;

      // Add any additional fields
      Object.assign(payload, additionalFields);

      // Convert to array for XADD
      const fieldArray: string[] = [];
      for (const [key, value] of Object.entries(payload)) {
        fieldArray.push(key, value);
      }

      // Add to target stream
      const newMessageId = await this.redis.xadd(targetStreamKey, '*', ...fieldArray);

      // Delete from DLQ if successful
      if (deleteOnSuccess) {
        await this.redis.xdel(dlqStreamKey, messageId);
      }

      return {
        messageId,
        success: true,
        newMessageId: newMessageId ?? undefined,
        error: undefined,
      };
    } catch (error) {
      return {
        messageId,
        success: false,
        newMessageId: undefined,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Replay multiple messages from DLQ.
   */
  async replayMessages(
    dlqStreamKey: string,
    messageIds: string[],
    targetStreamKey: string,
    options: {
      deleteOnSuccess?: boolean;
      additionalFields?: Record<string, string>;
    } = {},
  ): Promise<ReplayResult[]> {
    const results: ReplayResult[] = [];

    for (const messageId of messageIds) {
      const result = await this.replayMessage(dlqStreamKey, messageId, targetStreamKey, options);
      results.push(result);
    }

    return results;
  }

  /**
   * Replay all messages from a DLQ to their original streams.
   * Infers the target stream from message metadata.
   */
  async replayAll(
    dlqStreamKey: string,
    options: {
      deleteOnSuccess?: boolean;
      batchSize?: number;
    } = {},
  ): Promise<{ total: number; succeeded: number; failed: number }> {
    const { deleteOnSuccess = true, batchSize = 100 } = options;

    let succeeded = 0;
    let failed = 0;
    let cursor = '-';
    let total = 0;

    while (true) {
      const entries = await this.redis.xrange(dlqStreamKey, cursor, '+', 'COUNT', batchSize);

      if (entries.length === 0) break;

      for (const [messageId, fields] of entries) {
        total++;

        // Extract original stream from metadata
        let originalStream: string | undefined;
        for (let i = 0; i < fields.length; i += 2) {
          if (fields[i] === 'original_stream') {
            originalStream = fields[i + 1];
            break;
          }
        }

        if (!originalStream) {
          // Try to infer from step_type for job DLQs
          for (let i = 0; i < fields.length; i += 2) {
            if (fields[i] === 'step_type') {
              originalStream = StreamKeys.jobStream(fields[i + 1] ?? 'unknown');
              break;
            }
          }
        }

        if (!originalStream) {
          failed++;
          continue;
        }

        const result = await this.replayMessage(dlqStreamKey, messageId, originalStream, {
          deleteOnSuccess,
        });

        if (result.success) {
          succeeded++;
        } else {
          failed++;
        }
      }

      // Move cursor past the last processed message
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        cursor = `(${lastEntry[0]}`;
      }
    }

    return { total, succeeded, failed };
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

export function createDLQInspector(redis: Redis): DLQInspector {
  return new DLQInspector(redis);
}

export function createDLQReplayer(redis: Redis): DLQReplayer {
  return new DLQReplayer(redis);
}
