/**
 * Real-DB proof of the campaign-end synthesis packet: the loaders reused by
 * the brief (getCampaignById / getCampaignScoreSeries / listCandidatesByCampaign
 * / listDurableCoachLearnings) compose into a packet that carries the
 * campaign's durable survivors, its pending candidates, and the skill's
 * current skill/space-scope durable set — and nothing that was superseded or
 * belongs to another campaign.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  createDatabase,
  withTenantSchema,
  createTenantContext,
  campaigns,
  coachLearnings,
  coachCandidateLearnings,
} from '@aflow/database';
import type { CoachLearning, TenantId, WorkflowLearning } from '@aflow/schemas';
import { eq } from 'drizzle-orm';
import {
  insertCoachLearning,
  writeCandidateLearnings,
  resolveCandidate,
  listDurableCoachLearnings,
  loadCampaignSynthesisEvidence,
  formatCampaignSynthesisForPrompt,
} from '../index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;
const SPACE_ID = '234c1111-0000-0000-0000-000000000001';
const SLUG = 'campaign-end-packet-test-skill';
const COACH_SESSION = '234c1111-0000-0000-0000-000000000002';
const CAMPAIGN_ID = '234c1111-0000-0000-0000-000000000003';
const OTHER_CAMPAIGN_ID = '234c1111-0000-0000-0000-000000000004';
const RUN_A = '234c1111-0000-0000-0000-0000000000a1';
const RUN_B = '234c1111-0000-0000-0000-0000000000a2';

const SURVIVOR = '234c2222-0000-0000-0000-000000000001';
const SUPERSEDED = '234c2222-0000-0000-0000-000000000002';
const SKILL_SCOPE = '234c2222-0000-0000-0000-000000000003';
const SPACE_SCOPE = '234c2222-0000-0000-0000-000000000004';
const OTHER_CAMPAIGN = '234c2222-0000-0000-0000-000000000005';
const PROPOSED_SKILL = '234c2222-0000-0000-0000-000000000006';

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('campaign-end synthesis packet (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  let schemaReady = false;

  function learning(
    learningId: string,
    scope: CoachLearning['scope'],
    statement: string,
    status: CoachLearning['status'],
  ): CoachLearning {
    return {
      learningId,
      coachSessionId: COACH_SESSION,
      scope,
      kind: 'heuristic',
      statement,
      evidence: { citations: [{ runId: RUN_A }] },
      confidence: 'medium',
      supersedes: [],
      authorityLevel: 'auto_record',
      status,
      createdAt: new Date().toISOString(),
    };
  }

  function runLearning(id: string, observation: string): WorkflowLearning {
    return {
      id,
      category: 'hypothesis',
      kind: 'observation',
      observation,
      evidence: { runId: RUN_A },
      confidence: 'low',
      source: 'agent',
    };
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(coachLearnings).where(eq(coachLearnings.spaceId, SPACE_ID));
      await tx.delete(coachCandidateLearnings).where(eq(coachCandidateLearnings.spaceId, SPACE_ID));
      await tx.delete(campaigns).where(eq(campaigns.id, CAMPAIGN_ID));
    });
  }

  beforeAll(async () => {
    configureLogging({ service: 'test', level: 'silent' });
    const rows = await sql<{ ok: boolean }[]>`
      SELECT (
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA}
          AND (table_name, column_name) IN (
            ('coach_learnings', 'resolution_note'),
            ('coach_candidate_learnings', 'space_id')
          )
      ) = 2 AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (schemaReady) await cleanup();
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  it('the packet carries the campaign survivors, pending candidates, and the skill/space durable set', async (ctx: TestContext) => {
    if (!schemaReady) {
      ctx.skip(
        `tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\` (skipped in CI unit job)`,
      );
      return;
    }

    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(campaigns).values({
        id: CAMPAIGN_ID,
        spaceId: SPACE_ID,
        workflowSlug: SLUG,
        goalRef: `${SLUG}:numeric:rmsle`,
        scoreMetricKey: 'rmsle',
        direction: 'minimize',
        config: { competition: 'titanic' },
        status: 'ended',
        startedAt: new Date('2026-06-01T00:00:00.000Z'),
        endedAt: new Date('2026-07-06T00:00:00.000Z'),
        endedReason: 'goal_met',
      });
    });

    const campaignScope = {
      kind: 'campaign',
      campaignId: CAMPAIGN_ID,
      skillSlug: SLUG,
    } as const;
    for (const l of [
      learning(
        SURVIVOR,
        campaignScope,
        'log-transform the target before training',
        'auto_recorded',
      ),
      learning(SUPERSEDED, campaignScope, 'an absorbed duplicate claim', 'superseded'),
      learning(
        OTHER_CAMPAIGN,
        { kind: 'campaign', campaignId: OTHER_CAMPAIGN_ID, skillSlug: SLUG },
        'a claim from a different campaign',
        'auto_recorded',
      ),
      learning(
        SKILL_SCOPE,
        { kind: 'skill', skillSlug: SLUG },
        'validate the submission format locally first',
        'ratified',
      ),
      learning(
        SPACE_SCOPE,
        { kind: 'space', spaceId: SPACE_ID },
        'the sandbox has no network access',
        'ratified',
      ),
      learning(
        PROPOSED_SKILL,
        { kind: 'skill', skillSlug: SLUG },
        'a staged claim awaiting ratification',
        'proposed',
      ),
    ]) {
      await insertCoachLearning(db, TENANT_ID, { spaceId: SPACE_ID, learning: l });
    }

    const [pendingEntry] = await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: SLUG,
      campaignId: CAMPAIGN_ID,
      runId: RUN_A,
      learnings: [runLearning('l-pending', 'shrinking the CV-LB gap may cost LB score')],
    });
    const [rejectedEntry] = await writeCandidateLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: SLUG,
      campaignId: CAMPAIGN_ID,
      runId: RUN_B,
      learnings: [runLearning('l-rejected', 'more trees always help')],
    });
    expect(pendingEntry).toBeDefined();
    expect(rejectedEntry).toBeDefined();
    await resolveCandidate(db, TENANT_ID, {
      entryId: rejectedEntry!.entryId,
      status: 'reviewed-rejected',
      spaceId: SPACE_ID,
    });

    const evidence = await loadCampaignSynthesisEvidence({
      db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      workflowSlug: SLUG,
      campaignId: CAMPAIGN_ID,
    });
    expect(evidence).not.toBeNull();

    // The partitions are loaded scoped: survivors carry exactly this
    // campaign's durable rows; the skill/space set carries no campaign rows
    // but does carry the proposed row awaiting ratification.
    expect(evidence!.campaignSurvivors.map((l) => l.learningId)).toEqual([SURVIVOR]);
    expect(evidence!.skillAndSpaceSet.map((l) => l.scope.kind).sort()).toEqual([
      'skill',
      'skill',
      'space',
    ]);
    const proposedRow = evidence!.skillAndSpaceSet.find((l) => l.learningId === PROPOSED_SKILL);
    expect(proposedRow?.status).toBe('proposed');

    // The default durable read (the Runner-facing active-set path) still
    // excludes proposed rows — ratification stays the injection gate.
    const durableOnly = await listDurableCoachLearnings(db, TENANT_ID, {
      spaceId: SPACE_ID,
      skillSlug: SLUG,
      campaignScope: { mode: 'exclude' },
      limit: 50,
    });
    expect(durableOnly.map((l) => l.learningId)).not.toContain(PROPOSED_SKILL);
    expect(durableOnly.map((l) => l.learningId).sort()).toEqual([SKILL_SCOPE, SPACE_SCOPE].sort());

    const packet = formatCampaignSynthesisForPrompt({ evidence: evidence! });

    expect(packet).toContain(`Campaign ${CAMPAIGN_ID} of skill "${SLUG}" — ended (goal_met).`);
    expect(packet).toContain('- objective: minimize rmsle');
    expect(packet).toContain('"competition":"titanic"');

    // Survivors of in-campaign consolidation — superseded rows and other
    // campaigns' rows never render.
    expect(packet).toContain('log-transform the target before training');
    expect(packet).not.toContain('an absorbed duplicate claim');
    expect(packet).not.toContain('a claim from a different campaign');

    // Pending candidates render as unresolved; the rejected one as negative evidence.
    expect(packet).toContain('shrinking the CV-LB gap may cost LB score');
    expect(packet).toContain('PENDING (decide: promote, reject, or noise)');
    expect(packet).toContain('ALREADY REJECTED');
    expect(packet).toContain('more trees always help');

    // The current skill/space durable set — the generalize-without-duplicating context.
    expect(packet).toContain('validate the submission format locally first');
    expect(packet).toContain('the sandbox has no network access');

    // Proposed rows render visibly marked so the Coach neither duplicates
    // them nor treats them as operator-approved.
    expect(packet).toContain('[pending ratification] a staged claim awaiting ratification');
  });
});
