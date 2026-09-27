import { describe, it, expect } from 'vitest';
import type { ActiveMemoryRegister } from '@aflow/schemas';
import { resolveActiveMemoryInjection } from './agentTurnIntegration.js';

const NOW = '2026-01-01T00:00:00.000Z';

function registerWith(
  status: 'candidate' | 'active',
  sourceClass: 'agent_inference' | 'user_asserted',
): ActiveMemoryRegister {
  return {
    version: 1,
    revision: 1,
    entries: [
      {
        id: 'e1',
        kind: 'fact',
        statement: 'the data lives at /data/x',
        status,
        sourceClass,
        ...(status === 'active' ? { assertedByUserId: 'promoter' } : {}),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

describe('resolveActiveMemoryInjection — the two load-bearing gates', () => {
  it('injects for a personal space with a promoted active entry', () => {
    const injection = resolveActiveMemoryInjection(
      { singleOwner: true, register: registerWith('active', 'user_asserted') },
      NOW,
    );
    expect(injection).not.toBeNull();
    expect(injection!.memoryText).toContain('the data lives at /data/x');
  });

  it('never injects when not single-owner (personal space with an added member)', () => {
    expect(
      resolveActiveMemoryInjection(
        { singleOwner: false, register: registerWith('active', 'user_asserted') },
        NOW,
      ),
    ).toBeNull();
  });

  it('never injects candidates', () => {
    expect(
      resolveActiveMemoryInjection(
        { singleOwner: true, register: registerWith('candidate', 'agent_inference') },
        NOW,
      ),
    ).toBeNull();
  });

  it('never injects a forged active status without promoted provenance', () => {
    expect(
      resolveActiveMemoryInjection(
        { singleOwner: true, register: registerWith('active', 'agent_inference') },
        NOW,
      ),
    ).toBeNull();
  });

  it('yields null for a missing space or unusable register', () => {
    expect(resolveActiveMemoryInjection(null, NOW)).toBeNull();
    expect(
      resolveActiveMemoryInjection({ singleOwner: true, register: 'garbage' }, NOW),
    ).toBeNull();
  });
});
