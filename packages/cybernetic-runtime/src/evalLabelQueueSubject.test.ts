/**
 * The queue-item hydration must make an item labelable — rubric plus the
 * judge's own evidence — and must degrade to a TYPED marker when the trial's
 * run rows are gone, never to a 500 and never to an empty rendering that
 * would read as "the run produced nothing".
 *
 * The two silent divergences get the same treatment as the loud one: an
 * artifact that no longer retrieves is COUNTED (the pack is narrower than the
 * judge's), and a live suite rubric that no longer hashes to the item's judge
 * version is FLAGGED (the question changed under the label's stamp).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GoldenCase, GoldenCaseRevision, TenantId } from '@aflow/schemas';

vi.mock('./evalBatchStore.js', () => ({
  getGoldenCaseRevisionsByIds: vi.fn(),
  loadTrialRunSnapshot: vi.fn(),
}));
vi.mock('./evalRunner.js', () => ({ loadEvalSuite: vi.fn() }));
vi.mock('./modelResolution.js', () => ({ loadSpaceDirectives: vi.fn() }));

const { getGoldenCaseRevisionsByIds, loadTrialRunSnapshot } = await import('./evalBatchStore.js');
const { loadEvalSuite } = await import('./evalRunner.js');
const { loadSpaceDirectives } = await import('./modelResolution.js');
const { computeJudgeVersion } = await import('./judgeVersion.js');
const { buildLabelQueueSubjectViews } = await import('./evalLabelQueueSubject.js');

const revisionsMock = vi.mocked(getGoldenCaseRevisionsByIds);
const snapshotMock = vi.mocked(loadTrialRunSnapshot);
const suiteMock = vi.mocked(loadEvalSuite);
const directivesMock = vi.mocked(loadSpaceDirectives);

const JUDGE_MODEL = 'judge-model-x';
const SUITE_RUBRIC = [
  { criterion: 'Reads clearly', scale: 'binary' as const, description: 'No jargon.' },
];

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const REV_ID = '00000000-0000-4000-8000-0000000000c1';

function goldenCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    caseId: '00000000-0000-4000-8000-0000000000c0',
    datasetId: '00000000-0000-4000-8000-0000000000d0',
    title: 'Summarize a weekly digest',
    stratum: { scenario: 'digest', tier: 'regression', direction: 'should_succeed' },
    trigger: { inputs: {} },
    fixture: { tier: 'none' },
    expectations: [],
    rubrics: [
      {
        kind: 'case_local',
        criterion: {
          type: 'judge',
          name: 'faithfulness',
          rubric: [
            {
              criterion: 'No fabricated numbers',
              scale: 'binary',
              description: 'Every figure in the summary appears in the source digest.',
            },
          ],
          referenceAnswer: 'Revenue was 4.2M.',
        },
      },
    ],
    provenance: { source: 'curated', workflowRevision: 3 },
    ...overrides,
  } as GoldenCase;
}

function revision(caseOverrides: Partial<GoldenCase> = {}): GoldenCaseRevision {
  return {
    revisionId: REV_ID,
    caseId: '00000000-0000-4000-8000-0000000000c0',
    datasetId: '00000000-0000-4000-8000-0000000000d0',
    addedInVersion: 1,
    status: 'active',
    case: goldenCase(caseOverrides),
  };
}

const SUBJECT = {
  itemId: '00000000-0000-4000-8000-0000000000e1',
  caseRevisionId: REV_ID,
  runId: 'run-7',
  criterionId: 'faithfulness',
  scopeKey: 'case_local',
  workflowSlug: 'summarize-weekly',
  judgeVersion: null,
};

function snapshot(): unknown {
  return {
    run: { runId: 'run-7', status: 'completed', pausedReason: null, failureJson: null },
    tasks: [
      {
        taskId: 'write-summary',
        status: 'completed',
        operationId: null,
        outputRef: 'inline:abc',
        summary: 'Wrote the digest summary.',
        metricsJson: null,
        durationMs: 1200,
        costCents: 2,
        completedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ],
  };
}

function suiteRevision(): GoldenCaseRevision {
  return revision({ rubrics: [{ kind: 'suite_criterion', criterionId: 'clarity' }] });
}

function suiteDoc(rubric = SUITE_RUBRIC): unknown {
  return {
    goalCriteria: [{ type: 'judge', name: 'clarity', rubric }],
    taskCriteria: {},
    trajectoryCriteria: [],
  };
}

beforeEach(() => {
  revisionsMock.mockReset();
  snapshotMock.mockReset();
  suiteMock.mockReset();
  directivesMock.mockReset();
  directivesMock.mockResolvedValue({ modelDefaults: { judge: JUDGE_MODEL } } as never);
});

describe('buildLabelQueueSubjectViews', () => {
  it('carries the rubric under judgement and the evidence the judge received', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
      retrievePayload: (ref) => Promise.resolve({ ref, summary: 'Revenue was 4.2M.' }),
    });

    const view = views.get(SUBJECT.itemId);
    expect(view).toBeDefined();
    expect(view?.rubric).toEqual({
      criterionId: 'faithfulness',
      scopeKey: 'case_local',
      name: 'faithfulness',
      entries: [
        {
          criterion: 'No fabricated numbers',
          scale: 'binary',
          description: 'Every figure in the summary appears in the source digest.',
        },
      ],
      referenceAnswer: 'Revenue was 4.2M.',
    });
    expect(view?.evidence.status).toBe('available');
    if (view?.evidence.status !== 'available') throw new Error('expected available evidence');
    expect(view.evidence.taskSummaries).toEqual([
      { taskId: 'write-summary', status: 'completed', summary: 'Wrote the digest summary.' },
    ]);
    expect(view.evidence.taskOutputs).toHaveLength(1);
    expect(view.evidence.taskOutputs[0]?.taskId).toBe('write-summary');
    expect(view.evidence.taskOutputs[0]?.content).toContain('Revenue was 4.2M.');
  });

  it('a reaped trial run stays listable with a typed marker, never a throw', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(null);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
      retrievePayload: () => Promise.resolve(null),
    });

    const view = views.get(SUBJECT.itemId);
    // The rubric survives the reap — the case revision is durable, the run is not.
    expect(view?.rubric.entries).toHaveLength(1);
    expect(view?.evidence).toMatchObject({ status: 'unavailable', reason: 'run_reaped' });
    if (view?.evidence.status !== 'unavailable') throw new Error('expected unavailable evidence');
    expect(view.evidence.detail).not.toBe('');
  });

  it('reads a frozen pack without touching the run it was built from', async () => {
    // The whole point: the fixture space is long gone, and the item is still
    // reviewable from the evidence it carries.
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(null);

    const frozen = {
      status: 'available' as const,
      taskSummaries: [],
      taskOutputs: [],
      conversation: { request: 'Where is my refund?', reply: 'It is with the merchant.' },
      toolResults: [
        { sequence: 0, endpointId: 'order_inspect', status: 200, body: '{"refund":"pending"}' },
      ],
      unresolvedArtifacts: 0,
    };

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [{ ...SUBJECT, frozenEvidence: frozen }],
      retrievePayload: () => Promise.resolve(null),
    });

    expect(snapshotMock).not.toHaveBeenCalled();
    const evidence = views.get(SUBJECT.itemId)?.evidence;
    expect(evidence).toMatchObject({ status: 'available', toolResults: frozen.toolResults });
  });

  it('falls back to the live rebuild when the frozen pack does not parse', async () => {
    // A row written by an older shape is not handed to a reviewer as evidence
    // nobody can vouch for.
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(null);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [{ ...SUBJECT, frozenEvidence: { status: 'available', bogus: true } }],
      retrievePayload: () => Promise.resolve(null),
    });

    expect(snapshotMock).toHaveBeenCalled();
    expect(views.get(SUBJECT.itemId)?.evidence).toMatchObject({ status: 'unavailable' });
  });

  it('an unresolvable criterion returns the id alone rather than failing the listing', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision({ rubrics: [] })]]));
    snapshotMock.mockResolvedValue(snapshot() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
      retrievePayload: () => Promise.resolve(null),
    });

    const rubric = views.get(SUBJECT.itemId)?.rubric;
    expect(rubric?.criterionId).toBe('faithfulness');
    expect(rubric?.entries).toEqual([]);
    expect(rubric?.unresolved).toContain('faithfulness');
  });

  it('resolves a suite-criterion rubric through the skill’s eval suite, once per slug', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, suiteRevision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);
    suiteMock.mockResolvedValue(suiteDoc() as never);

    const suiteSubject = { ...SUBJECT, criterionId: 'clarity', scopeKey: 'suite' };
    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [suiteSubject, { ...suiteSubject, itemId: '00000000-0000-4000-8000-0000000000e2' }],
      retrievePayload: () => Promise.resolve(null),
    });

    expect(views.get(suiteSubject.itemId)?.rubric.entries).toEqual([
      { criterion: 'Reads clearly', scale: 'binary', description: 'No jargon.' },
    ]);
    expect(suiteMock).toHaveBeenCalledTimes(1);
    expect(snapshotMock).toHaveBeenCalledTimes(1);
  });

  it('types a missing payload store instead of rendering evidence that was never fetched', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
    });

    expect(views.get(SUBJECT.itemId)?.evidence).toMatchObject({
      status: 'unavailable',
      reason: 'payload_store_unavailable',
    });
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('counts artifacts that no longer retrieve — a narrowed pack never passes as the judge’s', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
      retrievePayload: () => Promise.reject(new Error('object expired')),
    });

    const evidence = views.get(SUBJECT.itemId)?.evidence;
    expect(evidence?.status).toBe('available');
    if (evidence?.status !== 'available') throw new Error('expected available evidence');
    // Summaries survive (they are Postgres rows), so only the count reveals the gap.
    expect(evidence.taskSummaries).toHaveLength(1);
    expect(evidence.taskOutputs).toEqual([]);
    expect(evidence.unresolvedArtifacts).toBe(1);
  });

  it('reports zero unresolved artifacts when the whole pack replays', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
      retrievePayload: () => Promise.resolve({ summary: 'Revenue was 4.2M.' }),
    });

    const evidence = views.get(SUBJECT.itemId)?.evidence;
    if (evidence?.status !== 'available') throw new Error('expected available evidence');
    expect(evidence.unresolvedArtifacts).toBe(0);
  });

  it('flags a suite rubric that no longer hashes to the judge version the label is stamped with', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, suiteRevision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);
    suiteMock.mockResolvedValue(
      suiteDoc([
        { criterion: 'Reads clearly', scale: 'binary', description: 'Edited after the batch ran.' },
      ]) as never,
    );

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [
        {
          ...SUBJECT,
          criterionId: 'clarity',
          scopeKey: 'suite',
          judgeVersion: computeJudgeVersion(SUITE_RUBRIC, JUDGE_MODEL),
        },
      ],
      retrievePayload: () => Promise.resolve(null),
    });

    const rubric = views.get(SUBJECT.itemId)?.rubric;
    expect(rubric?.entries[0]?.description).toBe('Edited after the batch ran.');
    expect(rubric?.judgeVersionDrift).toContain('clarity');
  });

  it('stays silent when the live suite still hashes to the item’s judge version', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, suiteRevision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);
    suiteMock.mockResolvedValue(suiteDoc() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [
        {
          ...SUBJECT,
          criterionId: 'clarity',
          scopeKey: 'suite',
          judgeVersion: computeJudgeVersion(SUITE_RUBRIC, JUDGE_MODEL),
        },
      ],
      retrievePayload: () => Promise.resolve(null),
    });

    expect(views.get(SUBJECT.itemId)?.rubric.judgeVersionDrift).toBeUndefined();
  });

  it('never flags a case-local rubric — an immutable revision cannot drift', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [{ ...SUBJECT, judgeVersion: 'a-version-from-another-model' }],
      retrievePayload: () => Promise.resolve(null),
    });

    expect(views.get(SUBJECT.itemId)?.rubric.judgeVersionDrift).toBeUndefined();
    expect(directivesMock).not.toHaveBeenCalled();
  });

  it('fetches a trial’s artifacts once for all its criteria, and does not re-ask for a failed one', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockResolvedValue(snapshot() as never);
    const retrieve = vi.fn(() => Promise.reject(new Error('object expired')));

    await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [
        SUBJECT,
        { ...SUBJECT, itemId: '00000000-0000-4000-8000-0000000000e2', criterionId: 'clarity' },
      ],
      retrievePayload: retrieve,
    });

    expect(snapshotMock).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('a failed snapshot read is not reported as a reaped run — retry, do not dismiss', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));
    snapshotMock.mockRejectedValue(new Error('connection terminated'));

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [SUBJECT],
      retrievePayload: () => Promise.resolve(null),
    });

    expect(views.get(SUBJECT.itemId)?.evidence).toMatchObject({
      status: 'unavailable',
      reason: 'rebuild_failed',
    });
  });

  it('an item with no trial run says so, even where no payload store is configured', async () => {
    revisionsMock.mockResolvedValue(new Map([[REV_ID, revision()]]));

    const views = await buildLabelQueueSubjectViews({
      db: {} as never,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      subjects: [{ ...SUBJECT, runId: null }],
    });

    expect(views.get(SUBJECT.itemId)?.evidence).toMatchObject({
      status: 'unavailable',
      reason: 'no_trial_run',
    });
  });
});
