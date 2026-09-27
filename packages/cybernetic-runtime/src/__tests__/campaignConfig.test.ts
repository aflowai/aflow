import { describe, it, expect } from 'vitest';
import type { Campaign, SkillCampaignContract } from '@aflow/schemas';
import {
  validateCampaignConfig,
  validateCampaignConfigUpdate,
  deriveCampaignContractJsonSchema,
  describeCampaignContractFields,
  buildCampaignRequiredErrorDetails,
  diffCampaignConfig,
  selectCampaignForRunStart,
  renderCampaignConfigIssues,
} from '../campaignConfig.js';

const CONTRACT: SkillCampaignContract = {
  fields: {
    competitionSlug: {
      schema: { type: 'string', minLength: 1 },
      identity: true,
      label: 'Competition slug',
    },
    metricDirection: {
      schema: { type: 'string', enum: ['maximize', 'minimize'] },
      label: 'Metric direction',
    },
    targetScore: {
      schema: { type: 'number' },
      label: 'Target score',
      description: 'The leaderboard bar.',
    },
    fixedKnob: {
      schema: { type: 'string' },
      label: 'Fixed knob',
      mutable: false,
    },
  },
};

const VALID_CONFIG = {
  competitionSlug: 'titanic',
  metricDirection: 'maximize',
  targetScore: 0.8,
  fixedKnob: 'set-once',
};

function campaign(overrides: Partial<Campaign>): Campaign {
  return {
    campaignId: '11111111-1111-1111-1111-111111111111',
    spaceId: '22222222-2222-2222-2222-222222222222',
    workflowSlug: 'kaggle-competition-optimizer',
    goalRef: 'kaggle-competition-optimizer:numeric:lbValue:maximize:abc',
    scoreMetricKey: 'lbValue',
    direction: 'maximize',
    status: 'active',
    startedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateCampaignConfig (workflow.campaign.start)', () => {
  it('accepts a complete, schema-valid config', () => {
    const result = validateCampaignConfig(CONTRACT, VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.validatedConfig).toEqual(VALID_CONFIG);
  });

  it('rejects a missing field with MISSING_FIELD (all contract fields required)', () => {
    const { targetScore: _omit, ...partial } = VALID_CONFIG;
    const result = validateCampaignConfig(CONTRACT, partial);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({ field: 'targetScore', code: 'MISSING_FIELD' }),
      ]);
    }
  });

  it('rejects an undeclared key with UNKNOWN_FIELD', () => {
    const result = validateCampaignConfig(CONTRACT, { ...VALID_CONFIG, bogus: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        expect.objectContaining({ field: 'bogus', code: 'UNKNOWN_FIELD' }),
      ]);
    }
  });

  it('rejects schema-violating values per field with SCHEMA_VIOLATION', () => {
    const result = validateCampaignConfig(CONTRACT, {
      ...VALID_CONFIG,
      metricDirection: 'sideways',
      targetScore: 'not-a-number',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = Object.fromEntries(result.issues.map((i) => [i.field, i.code]));
      expect(codes).toEqual({
        metricDirection: 'SCHEMA_VIOLATION',
        targetScore: 'SCHEMA_VIOLATION',
      });
    }
  });

  it('renders issues one line per field', () => {
    const result = validateCampaignConfig(CONTRACT, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rendered = renderCampaignConfigIssues('kaggle-competition-optimizer', result.issues);
      expect(rendered).toContain('"competitionSlug" (MISSING_FIELD)');
      expect(rendered).toContain('"targetScore" (MISSING_FIELD)');
    }
  });
});

describe('validateCampaignConfigUpdate (workflow.campaign.update)', () => {
  it('accepts a partial patch of mutable fields', () => {
    const result = validateCampaignConfigUpdate(CONTRACT, { targetScore: 0.85 });
    expect(result.ok).toBe(true);
  });

  it('rejects identity fields with IMMUTABLE_FIELD', () => {
    const result = validateCampaignConfigUpdate(CONTRACT, { competitionSlug: 'house-prices' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        field: 'competitionSlug',
        code: 'IMMUTABLE_FIELD',
      });
      expect(result.issues[0]!.detail).toContain('identity');
    }
  });

  it('rejects mutable:false fields with IMMUTABLE_FIELD', () => {
    const result = validateCampaignConfigUpdate(CONTRACT, { fixedKnob: 'changed' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({ field: 'fixedKnob', code: 'IMMUTABLE_FIELD' });
    }
  });

  it('rejects unknown fields and schema violations', () => {
    const result = validateCampaignConfigUpdate(CONTRACT, {
      bogus: 1,
      targetScore: 'NaNish',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = Object.fromEntries(result.issues.map((i) => [i.field, i.code]));
      expect(codes).toEqual({ bogus: 'UNKNOWN_FIELD', targetScore: 'SCHEMA_VIOLATION' });
    }
  });
});

describe('deriveCampaignContractJsonSchema', () => {
  it('derives an object schema with all fields required and labels as titles', () => {
    const schema = deriveCampaignContractJsonSchema(CONTRACT);
    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toEqual([
      'competitionSlug',
      'metricDirection',
      'targetScore',
      'fixedKnob',
    ]);
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['competitionSlug']).toMatchObject({
      type: 'string',
      minLength: 1,
      title: 'Competition slug',
    });
    expect(properties['targetScore']).toMatchObject({
      type: 'number',
      title: 'Target score',
      description: 'The leaderboard bar.',
    });
  });

  it('describeCampaignContractFields renders field names with types and enum values', () => {
    const desc = describeCampaignContractFields(CONTRACT);
    expect(desc).toContain('competitionSlug (string)');
    expect(desc).toContain('metricDirection (one of: maximize | minimize)');
    expect(desc).toContain('targetScore (number)');
  });

  it('buildCampaignRequiredErrorDetails carries the schema + a run.start create-on-first-run pointer', () => {
    const details = buildCampaignRequiredErrorDetails('kaggle-competition-optimizer', CONTRACT);
    expect(details.campaignContract['type']).toBe('object');
    expect(details.suggestedAction.op).toBe('workflow.run.start');
    expect(details.suggestedAction.args.slug).toBe('kaggle-competition-optimizer');
    expect(details.suggestedAction.args).toHaveProperty('campaignConfig');
    // The guidance must tell the agent to forward the contract schema as-is
    // rather than re-author it (re-authoring is what drops field types).
    expect(details.suggestedAction.preconditions).toMatch(/verbatim/);
  });
});

describe('diffCampaignConfig (idempotent-on-identity start)', () => {
  it('returns [] for structurally identical configs', () => {
    expect(diffCampaignConfig(CONTRACT, VALID_CONFIG, { ...VALID_CONFIG })).toEqual([]);
  });

  it('returns the differing declared keys only', () => {
    expect(
      diffCampaignConfig(CONTRACT, VALID_CONFIG, {
        ...VALID_CONFIG,
        targetScore: 0.9,
        undeclaredKey: 'ignored',
      }),
    ).toEqual(['targetScore']);
  });

  it('treats a present-vs-absent key as a diff', () => {
    const { targetScore: _omit, ...withoutTarget } = VALID_CONFIG;
    expect(diffCampaignConfig(CONTRACT, withoutTarget, VALID_CONFIG)).toEqual(['targetScore']);
  });
});

describe('selectCampaignForRunStart (THE START-TIME INVARIANT selection rule)', () => {
  const c1 = campaign({ campaignId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
  const c2 = campaign({
    campaignId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    goalRef: 'kaggle-competition-optimizer:numeric:lbValue:maximize:def',
  });

  it('explicit campaignId resolves among the active set', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'kaggle-competition-optimizer',
      explicitCampaignId: c2.campaignId,
      activeCampaigns: [c1, c2],
      hasCampaignContract: true,
    });
    expect(result).toEqual({ ok: true, campaign: c2 });
  });

  it('explicit campaignId not in the active set is CAMPAIGN_NOT_FOUND', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'kaggle-competition-optimizer',
      explicitCampaignId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      activeCampaigns: [c1],
      hasCampaignContract: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CAMPAIGN_NOT_FOUND');
  });

  it('implicit selection binds when exactly one active campaign exists', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'kaggle-competition-optimizer',
      activeCampaigns: [c1],
      hasCampaignContract: true,
    });
    expect(result).toEqual({ ok: true, campaign: c1 });
  });

  it('two active campaigns without explicit selection is CAMPAIGN_AMBIGUOUS', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'kaggle-competition-optimizer',
      activeCampaigns: [c1, c2],
      hasCampaignContract: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'CAMPAIGN_AMBIGUOUS') {
      expect(result.activeCampaigns).toEqual([c1, c2]);
    } else {
      throw new Error(`expected CAMPAIGN_AMBIGUOUS, got ${JSON.stringify(result)}`);
    }
  });

  it('no active campaign on a contracted skill is CAMPAIGN_REQUIRED', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'kaggle-competition-optimizer',
      activeCampaigns: [],
      hasCampaignContract: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CAMPAIGN_REQUIRED');
      expect(result.message).toContain('campaignConfig');
      expect(result.message).toContain('workflow.run.start');
    }
  });

  it('no contract + no explicit id returns campaign: null (config-less ensure path)', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'plain-skill',
      activeCampaigns: [],
      hasCampaignContract: false,
    });
    expect(result).toEqual({ ok: true, campaign: null });
  });

  it('no contract + explicit id still validates against the active set', () => {
    const result = selectCampaignForRunStart({
      workflowSlug: 'plain-skill',
      explicitCampaignId: c1.campaignId,
      activeCampaigns: [c1],
      hasCampaignContract: false,
    });
    expect(result).toEqual({ ok: true, campaign: c1 });
  });
});
