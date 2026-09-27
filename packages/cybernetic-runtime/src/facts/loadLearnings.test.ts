import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { CoachLearning } from '@aflow/schemas';
import { formatLearningsForPrompt, loadRecentLearnings } from './loadLearnings.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mocks = vi.hoisted(() => ({
  listDurableCoachLearnings: vi.fn(),
}));

vi.mock('../coachLearningsStore.js', () => ({
  listDurableCoachLearnings: mocks.listDurableCoachLearnings,
}));

function learning(over: Partial<CoachLearning> & { learningId: string }): CoachLearning {
  return {
    learningId: over.learningId,
    coachSessionId: '00000000-0000-0000-0000-000000000001',
    scope: {
      kind: 'campaign',
      campaignId: '00000000-0000-0000-0000-000000000077',
      skillSlug: 'my-skill',
    },
    kind: 'observation',
    statement: 'placeholder',
    evidence: {
      digestRef: '/coach/digests/abc.json',
      digestSha256: 'a'.repeat(64),
      citations: [{ runId: '00000000-0000-0000-0000-000000000111' }],
    },
    confidence: 'medium',
    supersedes: [],
    authorityLevel: 'auto_record',
    status: 'auto_recorded',
    createdAt: '2026-05-26T00:00:00.000Z',
    ...over,
  };
}

const STUB_DB = {} as never;
const TENANT = '00000000-0000-0000-0000-0000000000aa';
const SPACE = '00000000-0000-0000-0000-0000000000bb';
const ID = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

describe('loadRecentLearnings — table read-through', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries the durable tier scoped to space + skill (campaigns admitted by skill)', async () => {
    const rows = [learning({ learningId: ID(1) }), learning({ learningId: ID(2) })];
    mocks.listDurableCoachLearnings.mockResolvedValue(rows);

    const out = await loadRecentLearnings({
      db: STUB_DB,
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: 'my-skill',
      limit: 25,
    });

    expect(out).toEqual(rows);
    expect(mocks.listDurableCoachLearnings).toHaveBeenCalledWith(STUB_DB, TENANT, {
      spaceId: SPACE,
      skillSlug: 'my-skill',
      campaignScope: { mode: 'skill-campaigns' },
      limit: 25,
    });
  });

  it('returns empty on a query failure instead of breaking the trigger pipeline', async () => {
    mocks.listDurableCoachLearnings.mockRejectedValue(new Error('relation missing'));
    const out = await loadRecentLearnings({
      db: STUB_DB,
      tenantId: TENANT,
      spaceId: SPACE,
      workflowSlug: 'my-skill',
    });
    expect(out).toEqual([]);
  });
});

describe('formatLearningsForPrompt', () => {
  it('returns empty string when no learnings', () => {
    expect(formatLearningsForPrompt([])).toBe('');
  });

  it('renders durable learnings with id + scope + kind + confidence + statement', () => {
    const out = formatLearningsForPrompt([
      learning({
        learningId: ID(1),
        kind: 'heuristic',
        statement: 'Prefer GBM over RF on this dataset.',
        confidence: 'high',
        status: 'auto_recorded',
      }),
    ]);
    expect(out).toContain('## Durable learnings');
    expect(out).toContain(`- ${ID(1)} [heuristic, campaign:`);
    expect(out).toContain('high');
    expect(out).toContain('Prefer GBM over RF on this dataset.');
    expect(out).not.toContain('Active injected set');
  });

  it('surfaces the active-set state and consolidation pressure when provided', () => {
    const out = formatLearningsForPrompt([learning({ learningId: ID(1) })], {
      activeSetSize: 23,
      budget: 20,
      consolidationDue: true,
    });
    expect(out).toContain('Active injected set: 23 of budget 20');
    expect(out).toContain('consolidation due (learner.learning.consolidate)');

    const calm = formatLearningsForPrompt([learning({ learningId: ID(1) })], {
      activeSetSize: 5,
      budget: 20,
      consolidationDue: false,
    });
    expect(calm).toContain('Active injected set: 5 of budget 20.');
    expect(calm).not.toContain('consolidation due');
  });
});
