/**
 * The space-rules stored cap must equal the injection cap — otherwise the
 * settings UI accepts rules that silently never reach agent context.
 */
import { describe, it, expect } from 'vitest';
import { SpaceRulesSchema, SPACE_CONTEXT_LIMITS } from './spaceContext.js';

describe('SpaceRulesSchema', () => {
  it('stored cap equals the injection cap', () => {
    const atCap = Array.from({ length: SPACE_CONTEXT_LIMITS.rules }, (_, i) => ({
      text: `rule ${String(i)}`,
    }));
    expect(SpaceRulesSchema.safeParse(atCap).success).toBe(true);

    const overCap = [...atCap, { text: 'one too many' }];
    expect(SpaceRulesSchema.safeParse(overCap).success).toBe(false);
  });

  it('rejects an empty rule string', () => {
    expect(SpaceRulesSchema.safeParse([{ text: '' }]).success).toBe(false);
  });
});
