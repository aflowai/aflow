import { describe, it, expect } from 'vitest';
import type { SkillCampaignContract } from '@aflow/schemas';

import { pickMutableConfig } from './CampaignFormDialog.js';

const CONTRACT: SkillCampaignContract = {
  fields: {
    competitionSlug: { schema: { type: 'string' }, identity: true, label: 'Competition' },
    targetScore: { schema: { type: 'number' }, label: 'Target score' },
    seed: { schema: { type: 'number' }, mutable: false, label: 'Seed' },
  },
};

describe('pickMutableConfig', () => {
  it('keeps only mutable, non-identity fields and drops the rest', () => {
    const out = pickMutableConfig(CONTRACT, {
      competitionSlug: 'titanic', // identity → dropped
      targetScore: 0.8, // mutable → kept
      seed: 42, // mutable:false → dropped
      stray: 1, // unknown → dropped
    });
    expect(out).toEqual({ targetScore: 0.8 });
  });

  it('returns an empty patch when only immutable fields are supplied', () => {
    expect(pickMutableConfig(CONTRACT, { competitionSlug: 'titanic', seed: 42 })).toEqual({});
  });
});
