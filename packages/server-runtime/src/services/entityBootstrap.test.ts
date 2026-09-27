import { describe, it, expect } from 'vitest';
import { CYBERNETIC_ROLES } from './entityBootstrap.js';
import { CYBERNETIC_AGENTS } from '@aflow/database';

describe('CYBERNETIC_ROLES ↔ CYBERNETIC_AGENTS contract (102h Phase 2)', () => {
  it('every role the resolver looks for has a matching seed', () => {
    const seededRoles = CYBERNETIC_AGENTS.map((a) => a.flowId).sort();
    const resolvedRoles = [...CYBERNETIC_ROLES].sort();
    expect(seededRoles).toEqual(resolvedRoles);
  });

  it('exactly three roles (helmsman, runner, coach) — Plan 132v2 §Phase 6 deleted Driver', () => {
    expect(CYBERNETIC_ROLES).toHaveLength(3);
    expect(CYBERNETIC_ROLES).toContain('cybernetic-helmsman');
    expect(CYBERNETIC_ROLES).toContain('cybernetic-runner');
    expect(CYBERNETIC_ROLES).toContain('cybernetic-coach');
  });

  it('every role uses the `cybernetic-` prefix (grep-ability invariant)', () => {
    for (const role of CYBERNETIC_ROLES) {
      expect(role.startsWith('cybernetic-')).toBe(true);
    }
  });
});
