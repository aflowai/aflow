import { describe, it, expect, vi, beforeAll } from 'vitest';
import { configureLogging } from '@aflow/observability';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockResolve = vi.fn();
const mockWrite = vi.fn();
vi.mock('@aflow/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/database')>();
  return { ...actual, resolveWorkflowForStart: (...a: unknown[]) => mockResolve(...a) };
});
vi.mock('../goldenDatasetStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../goldenDatasetStore.js')>();
  return { ...actual, applyGoldenCaseAddBatch: (...a: unknown[]) => mockWrite(...a) };
});

const { applyEvalCaseDraftOps } = await import('../stagedChange/evalCaseDraftApply.js');
const { GoldenCaseContentSchema } = await import('@aflow/schemas');

const ctx = { tenantId: 't', spaceId: 's', db: {} } as never;

const caseContent = (over: Record<string, unknown> = {}) =>
  GoldenCaseContentSchema.parse({
    title: 'A refund is overdue from the merchant',
    stratum: { scenario: 'refund-status', direction: 'should_pause', tier: 'capability' },
    trigger: { kind: 'chat', message: 'where is my refund?', inputs: {} },
    fixture: { tier: 'seeded' },
    provenance: { source: 'curated', workflowRevision: 1 },
    requirements: [{ id: 'no-case', statement: 'Opens no handover case.', kind: 'must_not_do' }],
    expectations: [
      {
        kind: 'simulation',
        name: 'opened no case',
        claims: ['no-case'],
        check: { op: 'mutated', collection: 'handover_cases', expect: 'none' },
      },
    ],
    rubrics: [],
    ...over,
  });

const proposal = (content: unknown) =>
  ({
    id: '00000000-0000-4000-8000-00000000000a',
    kind: 'eval_case_draft',
    targetWorkflowSlug: 'cs-desk-conversation',
    proposal: {
      ops: [
        {
          op: 'eval_case_draft',
          workflowSlug: 'cs-desk-conversation',
          content,
          authoredBySkillId: 'eval-suite-design',
        },
      ],
    },
  }) as never;

describe('ratifying a drafted case runs the same gate as writing one by hand', () => {
  it('writes a case whose checks can fail', async () => {
    mockResolve.mockResolvedValue({ tasks: [] });
    mockWrite.mockResolvedValue({
      datasetId: 'd',
      datasetVersion: 1,
      caseIds: ['c'],
      replayed: false,
    });
    const result = await applyEvalCaseDraftOps(ctx, proposal(caseContent()));
    expect(result.applied).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('refuses a case that cannot fail, however it was authored', async () => {
    // The point of the seam: a skill's own report that its cases are sound is
    // input to review, never proof. Ratification re-runs the gate.
    mockResolve.mockResolvedValue({ tasks: [] });
    mockWrite.mockClear();
    const inverted = caseContent({
      expectations: [
        {
          kind: 'simulation',
          name: 'opened a case',
          claims: ['no-case'],
          check: { op: 'mutated', collection: 'handover_cases', expect: 'any' },
        },
      ],
    });
    await expect(applyEvalCaseDraftOps(ctx, proposal(inverted))).rejects.toThrow(
      /case_requirement_polarity/,
    );
    expect(mockWrite, 'nothing is written when the gate refuses').not.toHaveBeenCalled();
  });

  it('refuses a case for a skill this space does not have', async () => {
    mockResolve.mockResolvedValue(null);
    mockWrite.mockClear();
    await expect(applyEvalCaseDraftOps(ctx, proposal(caseContent()))).rejects.toThrow(
      /measures an existing skill/,
    );
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('a suite lands whole or not at all', () => {
  it('writes nothing when a later case fails the gate', async () => {
    // The observed failure: a suite refused on its third case left the first
    // two active in the dataset, under a proposal reporting failure, with one
    // version bump each.
    mockResolve.mockResolvedValue({ tasks: [] });
    mockWrite.mockClear();
    const bad = caseContent({
      expectations: [
        {
          kind: 'simulation',
          name: 'opened a case',
          claims: ['no-case'],
          check: { op: 'mutated', collection: 'handover_cases', expect: 'any' },
        },
      ],
    });
    const twoGoodThenBad = {
      id: '00000000-0000-4000-8000-00000000000b',
      kind: 'eval_case_draft',
      targetWorkflowSlug: 'cs-desk-conversation',
      proposal: {
        ops: [caseContent(), caseContent(), bad].map((content) => ({
          op: 'eval_case_draft',
          workflowSlug: 'cs-desk-conversation',
          content,
          authoredBySkillId: 'eval-suite-design',
        })),
      },
    } as never;

    await expect(applyEvalCaseDraftOps(ctx, twoGoodThenBad)).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('writes the whole suite in one call, at one version', async () => {
    mockResolve.mockResolvedValue({ tasks: [] });
    mockWrite.mockClear();
    mockWrite.mockResolvedValue({
      datasetId: 'd',
      datasetVersion: 2,
      caseIds: ['a', 'b'],
      replayed: false,
    });
    const twoGood = {
      id: '00000000-0000-4000-8000-00000000000b',
      kind: 'eval_case_draft',
      targetWorkflowSlug: 'cs-desk-conversation',
      proposal: {
        ops: [caseContent(), caseContent()].map((content) => ({
          op: 'eval_case_draft',
          workflowSlug: 'cs-desk-conversation',
          content,
          authoredBySkillId: 'eval-suite-design',
        })),
      },
    } as never;

    const result = await applyEvalCaseDraftOps(ctx, twoGood);
    expect(result.applied).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite.mock.calls[0]?.[2]).toMatchObject({ contents: [{}, {}] });
  });
});

describe('a proposal measures exactly one skill', () => {
  it('refuses ops that disagree with the target', async () => {
    // The batch writes every case under one slug. Ops that disagree would each
    // be validated against their own skill and then all stored under the first.
    mockResolve.mockResolvedValue({ tasks: [] });
    mockWrite.mockClear();
    const mixed = {
      id: '00000000-0000-4000-8000-00000000000c',
      kind: 'eval_case_draft',
      targetWorkflowSlug: 'cs-desk-conversation',
      proposal: {
        ops: [
          {
            op: 'eval_case_draft',
            workflowSlug: 'cs-desk-conversation',
            content: caseContent(),
            authoredBySkillId: 'eval-suite-design',
          },
          {
            op: 'eval_case_draft',
            workflowSlug: 'some-other-skill',
            content: caseContent(),
            authoredBySkillId: 'eval-suite-design',
          },
        ],
      },
    } as never;

    await expect(applyEvalCaseDraftOps(ctx, mixed)).rejects.toThrow(/target skill/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('keys the write on the proposal so a replayed apply cannot double-insert', async () => {
    mockResolve.mockResolvedValue({ tasks: [] });
    mockWrite.mockClear();
    mockWrite.mockResolvedValue({
      datasetId: 'd',
      datasetVersion: 3,
      caseIds: ['a'],
      replayed: true,
    });
    await applyEvalCaseDraftOps(ctx, proposal(caseContent()));
    expect(mockWrite.mock.calls[0]?.[2]).toMatchObject({
      idempotencyKey: '00000000-0000-4000-8000-00000000000a',
    });
  });
});
