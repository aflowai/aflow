import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitted: { success: unknown[]; errors: { code: string; message: string }[] } = {
  success: [],
  errors: [],
};
let opInput: unknown = undefined;

vi.mock('../helpers.js', () => ({
  readInlineOpInputRecord: () => Promise.resolve(opInput),
  emitStepSuccess: (_args: unknown, output: unknown) => {
    emitted.success.push(output);
    return Promise.resolve();
  },
  emitStepError: (_args: unknown, code: string, message: string) => {
    emitted.errors.push({ code, message });
    return Promise.resolve();
  },
}));

const put = vi.fn(() => Promise.resolve());
const ensureParentDirs = vi.fn(() => Promise.resolve());

vi.mock('@aflow/database', () => ({
  getDatabase: () => ({}),
  createTenantContext: (t: string) => ({ tenantId: t }),
  createMemoryDocRepository: () => ({ put }),
  createMemoryDirRepository: () => ({ ensureParentDirs }),
}));

import { StagedChangeSchema } from '@aflow/schemas';
import { handleEvalCaseProposeInline } from '../evalCasePropose.js';
import type { InlineHandlerArgs } from '../types.js';

const validCase = (over: Record<string, unknown> = {}) => ({
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

const args = {
  context: {
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    runId: '11111111-2222-4333-8444-555555555555',
    spaceId: '00000000-0000-0000-0000-000000000aaa',
  },
} as unknown as InlineHandlerArgs;

function writtenStagedChange(): Record<string, unknown> {
  const call = put.mock.calls[0]?.[0] as { inlineContent: string };
  return JSON.parse(call.inlineContent) as Record<string, unknown>;
}

describe('eval.case.propose writes a draft and never a case', () => {
  beforeEach(() => {
    emitted.success = [];
    emitted.errors = [];
    put.mockClear();
    ensureParentDirs.mockClear();
  });

  it('stages one draft op per case, for an operator to ratify', async () => {
    opInput = {
      workflowSlug: 'cs-desk-conversation',
      cases: [validCase(), validCase({ title: 'The merchant never shipped' })],
      rationale: 'Covers the refusal path in both directions.',
    };
    await handleEvalCaseProposeInline(args);

    expect(emitted.errors).toEqual([]);
    const staged = writtenStagedChange() as {
      kind: string;
      status: string;
      authorityLevel: string;
      proposal: { ops: { op: string; workflowSlug: string }[] };
    };
    expect(staged.kind).toBe('eval_case_draft');
    expect(staged.status).toBe('proposed');
    // The whole point of the seam: the skill cannot land a case itself.
    expect(staged.authorityLevel).toBe('require_operator');
    expect(staged.proposal.ops).toHaveLength(2);
    expect(staged.proposal.ops.every((o) => o.op === 'eval_case_draft')).toBe(true);
    expect(emitted.success[0]).toMatchObject({ caseCount: 2 });
  });

  it('writes a document the readers can actually parse', async () => {
    // proposal.list and every other reader parse this and skip silently on a
    // mismatch, so an unparseable write is a proposal that reports success and
    // is invisible to the operator it was written for.
    opInput = {
      workflowSlug: 'cs-desk-conversation',
      cases: [validCase()],
      rationale: 'Covers the refusal path.',
    };
    await handleEvalCaseProposeInline(args);

    const parsed = StagedChangeSchema.safeParse(writtenStagedChange());
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('stores a suite as large as the op accepts', async () => {
    // The op takes twenty cases and the stored record takes one op per case. A
    // record narrower than its writers refuses whole suites for being thorough,
    // and the refusal arrives after the drafting turn has ended.
    opInput = {
      workflowSlug: 'cs-desk-conversation',
      cases: Array.from({ length: 20 }, (_, i) => validCase({ title: `Case number ${String(i)}` })),
      rationale: 'Twenty cases, which the op permits.',
    };
    await handleEvalCaseProposeInline(args);

    expect(emitted.errors).toEqual([]);
    expect(emitted.success[0]).toMatchObject({ caseCount: 20 });
  });

  it('refuses a malformed case without writing anything', async () => {
    opInput = {
      workflowSlug: 'cs-desk-conversation',
      // `claims` names a requirement that was never declared, and the gate at
      // ratification cannot repair a draft the schema already rejects.
      cases: [validCase({ expectations: [{ kind: 'simulation', name: 'nope' }] })],
      rationale: 'Malformed on purpose.',
    };
    await handleEvalCaseProposeInline(args);

    expect(emitted.success).toEqual([]);
    expect(emitted.errors[0]?.code).toBe('EVAL_CASE_PROPOSE_INVALID_INPUT');
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a check that fails when its requirement is met', async () => {
    // The subtle one: the check CAN fail, so a can-it-fail test passes it. It
    // just fails on the good behaviour — a must_not_do requirement covered by
    // a check asserting the thing is present.
    opInput = {
      workflowSlug: 'cs-desk-conversation',
      cases: [
        validCase({
          expectations: [
            {
              kind: 'simulation',
              name: 'opened a case',
              claims: ['no-case'],
              check: { op: 'mutated', collection: 'handover_cases', expect: 'any' },
            },
          ],
        }),
      ],
      rationale: 'Inverted on purpose.',
    };
    await handleEvalCaseProposeInline(args);

    expect(emitted.success).toEqual([]);
    expect(emitted.errors[0]?.code).toBe('EVAL_CASE_PROPOSE_CHECK_POLARITY');
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses when the workflow engine resolved no input', async () => {
    opInput = undefined;
    await handleEvalCaseProposeInline(args);

    expect(emitted.errors[0]?.code).toBe('EVAL_CASE_PROPOSE_NO_INPUT');
    expect(put).not.toHaveBeenCalled();
  });
});
