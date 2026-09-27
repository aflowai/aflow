import { describe, expect, it } from 'vitest';
import { ClientMessageIdSchema } from '../runtime/streamMessages.js';

describe('ClientMessageIdSchema (Plan 192 Phase 1)', () => {
  it('accepts the id shapes the chat client mints', () => {
    // crypto.randomUUID() — hyphens keep it non-JSON even with a digit prefix
    expect(ClientMessageIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(
      true,
    );
    expect(ClientMessageIdSchema.safeParse('1f2e3d4c-aaaa-4bbb-8ccc-444455556666').success).toBe(
      true,
    );
    expect(
      ClientMessageIdSchema.safeParse('surface-action-1f2e3d4c-aaaa-4bbb-8ccc-444455556666')
        .success,
    ).toBe(true);
  });

  it('rejects JSON-parseable ids that the stream round-trip would re-type or re-value', () => {
    for (const id of ['123', '1e3', '-4.5', 'true', 'false', 'null', '"quoted"', '{}', '[1]']) {
      expect(ClientMessageIdSchema.safeParse(id).success, `expected rejection: ${id}`).toBe(false);
    }
  });

  it('rejects empty and over-long ids', () => {
    expect(ClientMessageIdSchema.safeParse('').success).toBe(false);
    expect(ClientMessageIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});
