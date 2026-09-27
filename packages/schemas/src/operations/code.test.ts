import { describe, it, expect } from 'vitest';
import { getOperation, getOperationCapability } from '../catalog/registry.js';
import { CodeRepoPushInputSchema, CodeRepoPushOutputSchema, type PayloadRef } from '../index.js';

describe('code.repo.push registration', () => {
  it('is registered as an opTaskOnly, mutating, write operation', () => {
    const op = getOperation('code.repo.push');
    expect(op).toBeDefined();
    expect(op?.stepType).toBe('code');
    expect(op?.group).toBe('repo');
    expect(op?.opTaskOnly).toBe(true);
    expect(op?.mutates).toBe(true);
    expect(op?.idempotency).toBe('non_idempotent');
    expect(op?.accessMode).toBe('write');
    expect(op?.riskModifiers).toContain('external_side_effect');
  });

  it('derives the capability group code.repo (from stepType.group)', () => {
    const cap = getOperationCapability('code.repo.push');
    expect(cap?.capabilityGroupId).toBe('code.repo');
    expect(cap?.accessMode).toBe('write');
  });

  it('validates a well-formed input/output', () => {
    const input = CodeRepoPushInputSchema.safeParse({
      repo: 'munchist/duality',
      branch: 'phoenix/fix-typo',
      patchRef: 'inline:bundle' as PayloadRef,
    });
    expect(input.success).toBe(true);

    const output = CodeRepoPushOutputSchema.safeParse({
      pushed: true,
      branch: 'phoenix/fix-typo',
      remoteSha: 'abc123',
    });
    expect(output.success).toBe(true);
  });
});
