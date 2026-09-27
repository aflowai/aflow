import { describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import {
  ControlMessageSchema,
  StreamKeys,
  type ControlMessage,
  type IdempotencyKey,
  type PayloadRef,
  type SessionId,
  type StepExecutionId,
  type SystemRole,
  type TenantId,
  type TraceId,
} from '@aflow/schemas';
import { addControlMessage, deserializeMessage } from '../streams.js';
import { shardFor } from '../shard.js';

const TENANT = 'a0000000-0000-4000-8000-000000000001' as TenantId;
const RUN = 'b0000000-0000-4000-8000-000000000002' as SessionId;
const STEP = 'c0000000-0000-4000-8000-000000000003' as StepExecutionId;

function startCommand(clientMessageId: string): ControlMessage {
  return {
    messageVersion: 1,
    type: 'start_run',
    tenantId: TENANT,
    runId: RUN,
    target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' as SystemRole },
    agentVersion: '1',
    inputRef: 'inline:e30=' as PayloadRef,
    traceId: 'trace-1' as TraceId,
    idempotencyKey: 'idem-start-1' as IdempotencyKey,
    requestedAtMs: Date.now(),
    clientMessageId,
  };
}

function resumeCommand(clientMessageId: string): ControlMessage {
  return {
    messageVersion: 1,
    type: 'resume_run',
    tenantId: TENANT,
    runId: RUN,
    stepExecutionId: STEP,
    inputRef: 'inline:e30=' as PayloadRef,
    traceId: 'trace-2' as TraceId,
    idempotencyKey: 'idem-resume-1' as IdempotencyKey,
    requestedAtMs: Date.now(),
    clientMessageId,
  };
}

async function roundTrip(redis: RedisType, command: ControlMessage): Promise<ControlMessage> {
  await addControlMessage(redis, command);
  const streamKey = StreamKeys.shardControlStream(shardFor(RUN));
  const entries = (await redis.xrange(streamKey, '-', '+')) as Array<[string, string[]]>;
  const last = entries[entries.length - 1];
  expect(last).toBeDefined();
  if (!last) throw new Error('no stream entry');
  const fieldObj: Record<string, string> = {};
  const fields = last[1];
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) fieldObj[key] = value;
  }
  const parsed = ControlMessageSchema.safeParse(deserializeMessage(fieldObj));
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('control message failed to re-parse');
  return parsed.data;
}

describe('clientMessageId control-stream round-trip (Plan 192 Phase 1)', () => {
  it('start_run carries a UUID clientMessageId through write → deserialize → parse', async () => {
    const redis = new RedisMock() as unknown as RedisType;
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const message = await roundTrip(redis, startCommand(id));
    expect(message.type).toBe('start_run');
    expect(message.type === 'start_run' && message.clientMessageId).toBe(id);
  });

  it('resume_run carries a surface-action chip id through write → deserialize → parse', async () => {
    const redis = new RedisMock() as unknown as RedisType;
    const id = 'surface-action-1f2e3d4c-aaaa-4bbb-8ccc-444455556666';
    const message = await roundTrip(redis, resumeCommand(id));
    expect(message.type).toBe('resume_run');
    expect(message.type === 'resume_run' && message.clientMessageId).toBe(id);
  });

  it('refuses JSON-scalar-shaped ids at the producer instead of wedging the consumer', async () => {
    const redis = new RedisMock() as unknown as RedisType;
    // "123" would deserialize to number 123 on read, failing safeParse and
    // leaving the whole start_run unacked forever — reject at write time.
    await expect(addControlMessage(redis, startCommand('123'))).rejects.toThrow();
    await expect(addControlMessage(redis, resumeCommand('"quoted"'))).rejects.toThrow();
  });
});
