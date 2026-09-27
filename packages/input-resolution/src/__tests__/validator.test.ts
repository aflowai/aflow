import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateInput } from '../validator.js';

describe('validateInput', () => {
  it('returns parsed data on success', () => {
    const schema = z.object({ name: z.string() });
    const result = validateInput({ name: 'x' }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'x' });
    }
  });

  it('names the offending keys on a strict-schema rejection', () => {
    const schema = z.object({ runId: z.string() }).strict('Allowed keys: runId.');
    const result = validateInput({ runId: 'r1', wait: 'until_pause' }, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect(issue!.message).toBe('Unknown input key(s): "wait". Allowed keys: runId.');
    }
  });
});
