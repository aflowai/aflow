import { describe, it, expect } from 'vitest';
import {
  CampaignSchema,
  SkillCampaignContractSchema,
  SkillManifestSchema,
  deriveGoalRef,
  extractCampaignIdentityValues,
  hashCampaignContract,
  hashCampaignIdentity,
  isCampaignFieldMutable,
  stableHash,
  stableStringify,
  type SkillCampaignContract,
  type SkillGoal,
} from '../index.js';

const kaggleContract: SkillCampaignContract = {
  fields: {
    competitionSlug: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Competition slug',
      description: 'Kaggle competition identifier, e.g. "titanic".',
    },
    metricName: {
      schema: { type: 'string', minLength: 1 },
      label: 'Metric name',
    },
    metricDirection: {
      schema: { type: 'string', enum: ['minimize', 'maximize'] },
      label: 'Metric direction',
    },
    targetScore: {
      schema: { type: 'number' },
      label: 'Target score',
    },
    dailySubmissionLimit: {
      schema: { type: 'integer', minimum: 1 },
      label: 'Daily submission limit',
    },
  },
};

const numericGoal: SkillGoal = {
  type: 'numeric',
  metricKey: 'lbValue',
  direction: 'maximize',
};

describe('Plan 195 §4.1 — SkillCampaignContractSchema', () => {
  it('parses a full Kaggle-shaped contract', () => {
    const parsed = SkillCampaignContractSchema.safeParse(kaggleContract);
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty fields record (omit `campaign` for config-less skills)', () => {
    const parsed = SkillCampaignContractSchema.safeParse({ fields: {} });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/at least one field/);
    }
  });

  it('rejects non-identifier field keys (they feed $campaign refs and campaign_input paths)', () => {
    const parsed = SkillCampaignContractSchema.safeParse({
      fields: {
        'bad-key.with.dots': { schema: { type: 'string' }, label: 'Bad' },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /campaign field key/.test(i.message))).toBe(true);
    }
  });

  it('rejects identity: true + mutable: true (identity fields are immutable)', () => {
    const parsed = SkillCampaignContractSchema.safeParse({
      fields: {
        competitionSlug: {
          schema: { type: 'string' },
          identity: true,
          mutable: true,
          label: 'Competition slug',
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => /immutable/.test(i.message))).toBe(true);
      expect(parsed.error.issues[0]?.path).toEqual(['fields', 'competitionSlug', 'mutable']);
    }
  });

  it('accepts identity: true with explicit mutable: false', () => {
    const parsed = SkillCampaignContractSchema.safeParse({
      fields: {
        competitionSlug: {
          schema: { type: 'string' },
          identity: true,
          mutable: false,
          label: 'Competition slug',
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown keys on a field declaration (strict)', () => {
    const parsed = SkillCampaignContractSchema.safeParse({
      fields: {
        targetScore: { schema: { type: 'number' }, label: 'Target', extra: true },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('requires a label', () => {
    const parsed = SkillCampaignContractSchema.safeParse({
      fields: { targetScore: { schema: { type: 'number' } } },
    });
    expect(parsed.success).toBe(false);
  });

  it('isCampaignFieldMutable: identity never mutable; non-identity default true', () => {
    expect(isCampaignFieldMutable({ schema: {}, identity: true, label: 'X' })).toBe(false);
    expect(isCampaignFieldMutable({ schema: {}, label: 'X' })).toBe(true);
    expect(isCampaignFieldMutable({ schema: {}, label: 'X', mutable: false })).toBe(false);
    expect(isCampaignFieldMutable({ schema: {}, label: 'X', mutable: true })).toBe(true);
  });
});

describe('Plan 195 §4.1 — SkillManifestSchema.campaign', () => {
  const baseManifest = {
    skillId: 'skill-1',
    name: 'Kaggle Competition Optimizer',
    goal: numericGoal,
    origin: 'platform',
    workflowSlug: 'kaggle-competition-optimizer',
    createdAt: '2026-06-11T00:00:00.000Z',
    updatedAt: '2026-06-11T00:00:00.000Z',
  };

  it('parses a manifest with a campaign contract', () => {
    const parsed = SkillManifestSchema.safeParse({ ...baseManifest, campaign: kaggleContract });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data.campaign?.fields ?? {})).toContain('competitionSlug');
    }
  });

  it('parses a manifest without a campaign contract (config-less skill)', () => {
    const parsed = SkillManifestSchema.safeParse(baseManifest);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.campaign).toBeUndefined();
  });

  it('rejects a manifest whose campaign contract violates the identity/mutable rule', () => {
    const parsed = SkillManifestSchema.safeParse({
      ...baseManifest,
      campaign: {
        fields: {
          competitionSlug: {
            schema: { type: 'string' },
            identity: true,
            mutable: true,
            label: 'Slug',
          },
        },
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('Plan 195 §4.2 — deriveGoalRef with the instance dimension', () => {
  it('config-less ({}) reduces to the pre-195 shape exactly', () => {
    expect(deriveGoalRef('my-skill', numericGoal, {})).toBe('my-skill:numeric:lbValue:maximize');
    expect(
      deriveGoalRef(
        'my-skill',
        { type: 'objective', criteria: [{ id: 'c', description: 'd' }] },
        {},
      ),
    ).toBe('my-skill:objective');
    expect(deriveGoalRef('my-skill', { type: 'subjective', rubric: ['r'] }, {})).toBe(
      'my-skill:subjective',
    );
  });

  it('identity values append a 16-hex identity hash', () => {
    const ref = deriveGoalRef('my-skill', numericGoal, { competitionSlug: 'titanic' });
    expect(ref).toMatch(/^my-skill:numeric:lbValue:maximize:[0-9a-f]{16}$/);
  });

  it('is stable across identity key insertion order', () => {
    const a = deriveGoalRef('my-skill', numericGoal, { a: 1, b: 'x' });
    const b = deriveGoalRef('my-skill', numericGoal, { b: 'x', a: 1 });
    expect(a).toBe(b);
  });

  it('different identity values are different campaigns (the §1d fix)', () => {
    const titanic = deriveGoalRef('my-skill', numericGoal, { competitionSlug: 'titanic' });
    const housePrices = deriveGoalRef('my-skill', numericGoal, {
      competitionSlug: 'house-prices',
    });
    expect(titanic).not.toBe(housePrices);
  });

  it('undefined-valued identity keys reduce to the config-less shape', () => {
    expect(deriveGoalRef('my-skill', numericGoal, { competitionSlug: undefined })).toBe(
      'my-skill:numeric:lbValue:maximize',
    );
  });
});

describe('Plan 195 §4.2 — identity extraction + hashing', () => {
  it('extractCampaignIdentityValues picks only identity fields present in config', () => {
    expect(
      extractCampaignIdentityValues(kaggleContract, {
        competitionSlug: 'titanic',
        metricName: 'accuracy',
        targetScore: 0.8,
      }),
    ).toEqual({ competitionSlug: 'titanic' });
  });

  it('extractCampaignIdentityValues omits absent identity values', () => {
    expect(extractCampaignIdentityValues(kaggleContract, { metricName: 'accuracy' })).toEqual({});
  });

  it('hashCampaignIdentity ignores undefined-valued keys and key order', () => {
    expect(hashCampaignIdentity({ a: 1, b: undefined })).toBe(hashCampaignIdentity({ a: 1 }));
    expect(hashCampaignIdentity({ a: 1, b: 2 })).toBe(hashCampaignIdentity({ b: 2, a: 1 }));
    expect(hashCampaignIdentity({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashCampaignContract is stable across field key order and busts on schema change', () => {
    const reordered: SkillCampaignContract = {
      fields: Object.fromEntries(Object.entries(kaggleContract.fields).reverse()),
    };
    expect(hashCampaignContract(reordered)).toBe(hashCampaignContract(kaggleContract));

    const tightened: SkillCampaignContract = {
      fields: {
        ...kaggleContract.fields,
        targetScore: { schema: { type: 'number', minimum: 0 }, label: 'Target score' },
      },
    };
    expect(hashCampaignContract(tightened)).not.toBe(hashCampaignContract(kaggleContract));
  });
});

describe('Plan 195 §4.2 — Campaign schema row extensions', () => {
  const baseCampaign = {
    campaignId: '11111111-1111-4111-8111-111111111111',
    spaceId: '22222222-2222-4222-8222-222222222222',
    workflowSlug: 'kaggle-competition-optimizer',
    goalRef: 'kaggle-competition-optimizer:numeric:lbValue:maximize:0123456789abcdef',
    scoreMetricKey: 'lbValue',
    direction: 'maximize',
    status: 'active',
    startedAt: '2026-06-11T00:00:00.000Z',
  };

  it('accepts config + contractHash', () => {
    const parsed = CampaignSchema.safeParse({
      ...baseCampaign,
      config: { competitionSlug: 'titanic', targetScore: 0.8 },
      contractHash: hashCampaignContract(kaggleContract),
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a config-less campaign (both fields absent)', () => {
    expect(CampaignSchema.safeParse(baseCampaign).success).toBe(true);
  });
});

describe('shared stableHash util (Plan 190 hashWorkflowConfig semantics)', () => {
  it('stableStringify sorts object keys recursively, preserves array order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(stableStringify([2, 1])).toBe('[2,1]');
    expect(stableStringify({ a: undefined })).toBe('{"a":null}');
  });

  it('stableHash is deterministic and key-order independent', () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
