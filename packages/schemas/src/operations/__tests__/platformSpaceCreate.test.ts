import { describe, expect, it } from 'vitest';
import { PlatformSpaceCreateInputSchema } from '../platform.js';

/**
 * The value this operation supplies becomes `spaces.slug`, and the `/s/<slug>`
 * route parses that column with the same schema. Anything this contract accepts
 * but the route rejects is a space no URL can reach, so the two must not drift.
 */
describe('PlatformSpaceCreateInputSchema.slug', () => {
  const parse = (slug: string) => PlatformSpaceCreateInputSchema.safeParse({ slug, name: 'Vault' });

  it('accepts kebab-case', () => {
    expect(parse('vault-i').success).toBe(true);
  });

  it.each([
    ['4769485d-ca5e-4616-a171-69fa7d16eb47', 'a UUID'],
    ['Vault I', 'spaces and uppercase'],
    ['-leading', 'a leading hyphen'],
    ['trailing-', 'a trailing hyphen'],
    ['under_score', 'an underscore'],
    ['', 'an empty string'],
  ])('rejects %j — %s', (slug) => {
    expect(parse(slug).success).toBe(false);
  });

  it('names the constraint when handed a UUID', () => {
    const result = parse('4769485d-ca5e-4616-a171-69fa7d16eb47');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('Must not be a UUID');
  });
});
