/**
 * Plan 327 §6: the recipient is never chosen. No `channel.*` operation accepts
 * a user, chat or channel id, so an agent cannot point a message at anyone but
 * the person its run works for.
 */
import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { getAllOperations, getOperation } from '../../catalog/registry.js';
import { CHANNEL_MESSAGE_SEND_OPERATION_ID } from '../channel.js';

/** Every property name anywhere in a JSON schema, nested ones included. */
function propertyNames(schema: unknown): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const record = schema as Record<string, unknown>;
  const own =
    typeof record['properties'] === 'object' && record['properties'] !== null
      ? Object.keys(record['properties'])
      : [];
  return [...own, ...Object.values(record).flatMap((value) => propertyNames(value))];
}

const RECIPIENT_FIELD = /user|chat|channel|recipient|^to$|email|phone|member|team|conversation/i;

describe('channel operations', () => {
  const channelOperations = [...getAllOperations().values()].filter(
    (op) => op.stepType === 'channel',
  );

  it('registers channel.message.send on the channel lane', () => {
    expect(channelOperations.map((op) => op.operationId)).toContain(
      CHANNEL_MESSAGE_SEND_OPERATION_ID,
    );
  });

  it('accepts no field that could name a recipient, in any channel operation', () => {
    const offending = channelOperations.flatMap((op) =>
      propertyNames(zodToJsonSchema(op.inputZod))
        .filter((name) => RECIPIENT_FIELD.test(name))
        .map((name) => `${op.operationId}: ${name}`),
    );
    expect(offending).toEqual([]);
  });

  it('refuses an unknown field rather than dropping it', () => {
    const send = getOperation(CHANNEL_MESSAGE_SEND_OPERATION_ID);
    expect(send?.inputZod.safeParse({ text: 'hello', userId: 'U123' }).success).toBe(false);
    expect(send?.inputZod.safeParse({ text: 'hello' }).success).toBe(true);
  });

  it('is chosen for an operator who must act and may be away, never for progress reports', () => {
    const send = getOperation(CHANNEL_MESSAGE_SEND_OPERATION_ID);
    expect(send?.usage.whenToUse[0]).toBe('the operator must act and may be away from the machine');
    expect(send?.usage.whenNotToUse).toContain('progress reports nobody asked for');
  });
});
