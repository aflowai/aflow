import { describe, it, expect, vi } from 'vitest';
import type { SkillManifest } from '@aflow/schemas';

const mockGetByPath = vi.fn();

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return { ...actual, createMemoryDocRepository: () => ({ getByPath: mockGetByPath }) };
});

const { loadSkillAuthoringSnapshot, manifestAuthoringToken } =
  await import('../skillAuthoringSnapshot.js');

function manifest(over: Partial<SkillManifest>): SkillManifest {
  return { goal: { type: 'subjective', rubric: ['x'] }, ...over } as unknown as SkillManifest;
}

describe('manifestAuthoringToken', () => {
  it('depends only on goal + campaign, not other manifest fields', () => {
    const base = manifest({});
    const withCaps = manifest({ requiredCapabilities: ['cap:a'] } as Partial<SkillManifest>);
    expect(manifestAuthoringToken(base)).toBe(manifestAuthoringToken(withCaps));
  });

  it('changes when the goal changes', () => {
    const a = manifest({});
    const b = manifest({ goal: { type: 'subjective', rubric: ['y'] } } as Partial<SkillManifest>);
    expect(manifestAuthoringToken(a)).not.toBe(manifestAuthoringToken(b));
  });
});

describe('loadSkillAuthoringSnapshot', () => {
  it('returns null when the workflow doc is absent', async () => {
    mockGetByPath.mockResolvedValue(null);
    const result = await loadSkillAuthoringSnapshot(
      { db: {} as never, tenantId: '00000000-0000-4000-8000-000000000001', spaceId: 'space-1' },
      'my-skill',
    );
    expect(result).toBeNull();
  });
});
