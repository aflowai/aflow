import { describe, it, expect } from 'vitest';
import {
  AGENT_SLUG_RESERVED,
  SPACE_SLUG_RESERVED,
  slugify,
  validateAgentSlug,
  validateSpaceSlug,
} from './slugReservation.js';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp');
  });

  it('collapses runs of non-alphanumeric characters into one hyphen', () => {
    expect(slugify('Stargate (Phase 2)')).toBe('stargate-phase-2');
    expect(slugify('  Acme—Corp__v3 ')).toBe('acme-corp-v3');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('--foo--')).toBe('foo');
  });

  it('drops non-ascii characters', () => {
    expect(slugify('🚀 launch')).toBe('launch');
    expect(slugify('café')).toBe('caf');
  });

  it('returns empty string when nothing slug-worthy remains', () => {
    expect(slugify('🌟')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('is idempotent on already-slugified input', () => {
    const s = slugify('Acme Corp');
    expect(slugify(s)).toBe(s);
  });

  it('truncates to 64 chars at a hyphen boundary when possible', () => {
    const long = 'a'.repeat(40) + ' ' + 'b'.repeat(40);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(64);
    expect(result).toBe('a'.repeat(40));
  });

  it('hard-truncates when no hyphen exists within 64 chars', () => {
    const result = slugify('a'.repeat(80));
    expect(result).toBe('a'.repeat(64));
  });
});

describe('validateSpaceSlug', () => {
  it('accepts well-formed slugs', () => {
    expect(validateSpaceSlug('acme-corp')).toEqual({ ok: true });
    expect(validateSpaceSlug('general')).toEqual({ ok: true });
    expect(validateSpaceSlug('a1')).toEqual({ ok: true });
  });

  it('rejects bad syntax with SLUG_INVALID', () => {
    const r1 = validateSpaceSlug('Acme');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('SLUG_INVALID');

    const r2 = validateSpaceSlug('-leading');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('SLUG_INVALID');

    const r3 = validateSpaceSlug('trailing-');
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe('SLUG_INVALID');

    const r4 = validateSpaceSlug('double--hyphen');
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.code).toBe('SLUG_INVALID');

    const r5 = validateSpaceSlug('');
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.code).toBe('SLUG_INVALID');
  });

  it('rejects UUID-shaped strings with SLUG_INVALID', () => {
    const r = validateSpaceSlug('a0000000-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_INVALID');
  });

  it('rejects reserved slugs with SLUG_RESERVED', () => {
    for (const reserved of SPACE_SLUG_RESERVED) {
      const r = validateSpaceSlug(reserved);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
    }
  });
});

describe('validateAgentSlug', () => {
  it('accepts well-formed slugs', () => {
    expect(validateAgentSlug('research-bot')).toEqual({ ok: true });
    expect(validateAgentSlug('helmsman')).toEqual({ ok: true });
  });

  it('rejects sub-route collisions with SLUG_RESERVED', () => {
    const r = validateAgentSlug('new');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
  });

  it('shares the reserved-set discipline with spaces', () => {
    // Currently the two sets overlap; assert each entry is rejected.
    for (const reserved of AGENT_SLUG_RESERVED) {
      const r = validateAgentSlug(reserved);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
    }
  });

  it('rejects UUID-shaped strings with SLUG_INVALID', () => {
    const r = validateAgentSlug('a0000000-0000-0000-0000-000000000001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_INVALID');
  });
});
