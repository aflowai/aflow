import { describe, expect, it } from 'vitest';
import type { Workflow, SkillDiagnostic } from '@aflow/schemas';
import {
  runCapabilityBindingProposalValidations,
  runWorkflowProposalValidations,
  isProposalReadinessSafe,
  type ProposalReadiness,
  type ProposalValidationSnapshot,
} from '../stagedChange/proposalValidations.js';

// ============================================================================
// Fixtures + helpers
// ============================================================================

function makeWorkflow(overrides?: Partial<Workflow>): Workflow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'propose-and-execute-trade',
    name: 'Propose and Execute Trade',
    description: '',
    outcomes: [
      {
        id: 'order-submitted',
        name: 'Order Submitted',
        evaluator: { type: 'manual', instruction: 'A trade order was submitted.' },
      },
    ],
    mode: 'process',
    tasks: [
      {
        taskId: 'hydrate',
        name: 'Hydrate Inputs',
        goal: 'Read the trade specification from inputs.symbol and inputs.quantity.',
        type: 'agent',
        inputBindings: {
          symbol: { kind: 'run_input', path: 'symbol' },
          quantity: { kind: 'run_input', path: 'quantity' },
        },
        inputContract: {
          bindings: {
            symbol: {
              kind: 'run_input',
              bindAs: 'symbol',
              path: 'symbol',
              schema: { type: 'string' },
            },
            quantity: {
              kind: 'run_input',
              bindAs: 'quantity',
              path: 'quantity',
              schema: { type: 'number' },
            },
          },
        },
      },
      {
        taskId: 'submit-order',
        name: 'Submit Order',
        goal: 'Submit the order using inputs.order via the alpaca binding.',
        type: 'agent',
        dependsOn: ['hydrate'],
        inputBindings: {
          order: { kind: 'task_output', taskId: 'hydrate' },
        },
      },
    ],
    iteration: { auto: false, maxConsecutiveRuns: 1, stopOnOutcomesMet: true, cooldownMs: 0 },
    stateVariables: [],
    revision: 1,
    status: 'approved',
    createdAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY_SNAPSHOT: ProposalValidationSnapshot = { apiBindings: [], mcpBindings: [] };

const ALPACA_SNAPSHOT: ProposalValidationSnapshot = {
  apiBindings: [
    {
      bindingId: 'alpaca-paper-orders-write',
      apiId: 'alpaca-paper',
      endpointIds: ['post_v2_orders', 'get_v2_orders'],
    },
  ],
  mcpBindings: [],
};

const diagDetails = (ds: SkillDiagnostic[]): string => ds.map((d) => d.detail).join('\n');
const hasDimension = (r: ProposalReadiness, dim: SkillDiagnostic['dimension']): boolean =>
  r.contract.diagnostics.some((d) => d.dimension === dim);

// ============================================================================
// runWorkflowProposalValidations
// ============================================================================

describe('runWorkflowProposalValidations', () => {
  it('marks a clean workflow as safe with no diagnostics or capability gaps', () => {
    const r = runWorkflowProposalValidations(makeWorkflow(), EMPTY_SNAPSHOT);
    expect(r.contract.status).toBe('valid');
    expect(r.contract.diagnostics).toHaveLength(0);
    expect(r.contract.advisories).toHaveLength(0);
    expect(r.capability.issues).toHaveLength(0);
    expect(r.capability.warnings).toHaveLength(0);
    expect(isProposalReadinessSafe(r)).toBe(true);
  });

  it('emits a semantic advisory when a goal references inputs.<key> not in inputBindings', () => {
    const wf = makeWorkflow({
      tasks: [
        {
          taskId: 'write-proposal-memo',
          name: 'Write Proposal Memo',
          goal: 'Format inputs.proposal into a memo. Include inputs.approval if available.',
          type: 'agent',
          inputBindings: {
            symbol: { kind: 'run_input', path: 'symbol' },
            policy: { kind: 'run_input', path: 'policy' },
          },
        },
      ],
    });
    const r = runWorkflowProposalValidations(wf, EMPTY_SNAPSHOT);

    const semantic = r.contract.advisories.filter((a) => a.dimension === 'semantic');
    expect(diagDetails(semantic)).toMatch(/write-proposal-memo.*inputs\.proposal/);
    expect(diagDetails(semantic)).toMatch(/write-proposal-memo.*inputs\.approval/);
    // Advisory is non-blocking — the proposal stays safe.
    expect(r.contract.status).toBe('valid');
    expect(isProposalReadinessSafe(r)).toBe(true);
  });

  it('emits no semantic advisory when the goal text references no inputs.<key>', () => {
    const wf = makeWorkflow({
      tasks: [
        {
          taskId: 't1',
          name: 'T1',
          goal: 'Just do the thing. No input references here.',
          type: 'agent',
        },
      ],
    });
    const r = runWorkflowProposalValidations(wf, EMPTY_SNAPSHOT);
    expect(r.contract.advisories.some((a) => a.dimension === 'semantic')).toBe(false);
  });

  // (2) Endpoint-id mismatch → hard capability issue.
  it('flags a hard capability issue when a granted endpointId is not on the binding', () => {
    const wf = makeWorkflow({
      tasks: [
        {
          taskId: 'submit-order',
          name: 'Submit Order',
          goal: 'Submit the order.',
          type: 'agent',
          context: {
            strategy: 'scoped',
            learnings: 'active',
            capabilities: {
              operations: [],
              integrations: [
                {
                  capabilityId: 'alpaca-paper-orders-write',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-paper-orders-write' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-paper',
                  toolNames: [{ toolName: 'post_orders' }],
                  allTools: false,
                },
              ],
            },
          },
        },
      ],
    });

    const r = runWorkflowProposalValidations(wf, ALPACA_SNAPSHOT);
    expect(r.capability.issues.join('\n')).toMatch(
      /submit-order.*endpoint "post_orders".*binding "alpaca-paper-orders-write"/,
    );
    expect(isProposalReadinessSafe(r)).toBe(false);
  });

  it('has no capability issue for a granted endpointId that exists on the binding', () => {
    const wf = makeWorkflow({
      tasks: [
        {
          taskId: 'submit-order',
          name: 'Submit Order',
          goal: 'Submit the order.',
          type: 'agent',
          context: {
            strategy: 'scoped',
            learnings: 'active',
            capabilities: {
              operations: [],
              integrations: [
                {
                  capabilityId: 'alpaca-paper-orders-write',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-paper-orders-write' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-paper',
                  toolNames: [{ toolName: 'post_v2_orders' }],
                  allTools: false,
                },
              ],
            },
          },
        },
      ],
    });
    const r = runWorkflowProposalValidations(wf, ALPACA_SNAPSHOT);
    expect(r.capability.issues).toHaveLength(0);
    expect(isProposalReadinessSafe(r)).toBe(true);
  });

  it('skips per-endpoint integrity when allTools is true', () => {
    const wf = makeWorkflow({
      tasks: [
        {
          taskId: 'submit-order',
          name: 'Submit Order',
          goal: 'Submit anything.',
          type: 'agent',
          context: {
            strategy: 'scoped',
            learnings: 'active',
            capabilities: {
              operations: [],
              integrations: [
                {
                  capabilityId: 'alpaca-paper-orders-write',
                  binding: { kind: 'binding' as const, bindingId: 'alpaca-paper-orders-write' },
                  sourceKind: 'api' as const,
                  integrationId: 'alpaca-paper',
                  toolNames: [],
                  allTools: true,
                },
              ],
            },
          },
        },
      ],
    });
    const r = runWorkflowProposalValidations(wf, ALPACA_SNAPSHOT);
    expect(r.capability.issues).toHaveLength(0);
  });

  // (3) Missing capability binding ref → soft capability warning.
  it('warns (soft) when a granted binding is not present in this space', () => {
    const wf = makeWorkflow({
      tasks: [
        {
          taskId: 'submit-order',
          name: 'Submit Order',
          goal: 'Submit the order.',
          type: 'agent',
          context: {
            strategy: 'scoped',
            learnings: 'active',
            capabilities: {
              operations: [],
              integrations: [
                {
                  capabilityId: 'stripe-payments',
                  binding: { kind: 'binding' as const, bindingId: 'stripe-payments' },
                  sourceKind: 'api' as const,
                  integrationId: 'stripe',
                  toolNames: [{ toolName: 'post_charges' }],
                  allTools: false,
                },
              ],
            },
          },
        },
      ],
    });
    const r = runWorkflowProposalValidations(wf, ALPACA_SNAPSHOT);
    expect(r.capability.warnings.join('\n')).toMatch(/stripe-payments.*not present in this space/);
    // A missing binding can't be endpoint-checked → no hard issue → still safe.
    expect(r.capability.issues).toHaveLength(0);
    expect(isProposalReadinessSafe(r)).toBe(true);
  });

  // (4) Malformed task graph → contract diagnostics.
  it('flags a graph diagnostic when dependsOn references a non-existent task', () => {
    const wf = makeWorkflow({
      tasks: [{ taskId: 'a', name: 'A', goal: 'Do A.', type: 'agent', dependsOn: ['ghost'] }],
    });
    const r = runWorkflowProposalValidations(wf, EMPTY_SNAPSHOT);
    expect(r.contract.status).toBe('invalid');
    expect(diagDetails(r.contract.diagnostics)).toMatch(/depends on "ghost"/);
    expect(isProposalReadinessSafe(r)).toBe(false);
  });

  it('flags a graph diagnostic on a dependency cycle', () => {
    const wf = makeWorkflow({
      tasks: [
        { taskId: 'a', name: 'A', goal: 'Do A.', type: 'agent', dependsOn: ['b'] },
        { taskId: 'b', name: 'B', goal: 'Do B.', type: 'agent', dependsOn: ['a'] },
      ],
    });
    const r = runWorkflowProposalValidations(wf, EMPTY_SNAPSHOT);
    expect(r.contract.status).toBe('invalid');
    expect(diagDetails(r.contract.diagnostics)).toMatch(/cycle/i);
    expect(isProposalReadinessSafe(r)).toBe(false);
  });

  it('flags a diagnostic when an inputBinding references a non-upstream producer', () => {
    const wf = makeWorkflow({
      tasks: [
        { taskId: 'a', name: 'A', goal: 'Do A.', type: 'agent' },
        {
          taskId: 'b',
          name: 'B',
          goal: 'Do B.',
          type: 'agent',
          inputBindings: { x: { kind: 'task_output', taskId: 'a' } },
        },
      ],
    });
    const r = runWorkflowProposalValidations(wf, EMPTY_SNAPSHOT);
    expect(r.contract.status).toBe('invalid');
    expect(diagDetails(r.contract.diagnostics)).toMatch(/upstream/);
    expect(isProposalReadinessSafe(r)).toBe(false);
  });

  // Contract parse dimension.
  it('reports the parse dimension when the workflow schema does not parse', () => {
    const r = runWorkflowProposalValidations({ not: 'a workflow' }, EMPTY_SNAPSHOT);
    expect(r.contract.status).toBe('invalid');
    expect(hasDimension(r, 'parse')).toBe(true);
    expect(isProposalReadinessSafe(r)).toBe(false);
  });
});

// ============================================================================
// runCapabilityBindingProposalValidations — the only signal is the
// SPACE-dependent capability axis ("would this upsert leave any existing skill
// grant referencing an endpoint the new definition doesn't declare?").
// ============================================================================

describe('runCapabilityBindingProposalValidations', () => {
  it('is safe when every existing grant resolves against the new endpoint set', () => {
    const r = runCapabilityBindingProposalValidations(
      ['post_v2_orders', 'get_v2_orders'],
      [
        {
          skillSlug: 'propose-and-execute-trade',
          taskId: 'submit-order',
          apiId: 'alpaca-paper',
          grantedEndpointIds: ['post_v2_orders'],
        },
      ],
    );
    expect(r.capability.issues).toHaveLength(0);
    expect(isProposalReadinessSafe(r)).toBe(true);
  });

  it('flags every granted endpoint the new definition would not declare', () => {
    const r = runCapabilityBindingProposalValidations(
      ['post_v2_orders'],
      [
        {
          skillSlug: 'propose-and-execute-trade',
          taskId: 'submit-order',
          apiId: 'alpaca-paper',
          grantedEndpointIds: ['post_orders'],
        },
      ],
    );
    expect(r.capability.issues.join('\n')).toMatch(
      /propose-and-execute-trade.*submit-order.*post_orders/,
    );
    expect(isProposalReadinessSafe(r)).toBe(false);
  });

  it('emits one issue per (task, missing-endpoint) pair across multiple skills', () => {
    const r = runCapabilityBindingProposalValidations(
      ['post_v2_orders'],
      [
        {
          skillSlug: 'skill-a',
          taskId: 't1',
          apiId: 'alpaca-paper',
          grantedEndpointIds: ['post_orders', 'get_orders'],
        },
        {
          skillSlug: 'skill-b',
          taskId: 't2',
          apiId: 'alpaca-paper',
          grantedEndpointIds: ['post_v2_orders'], // resolves; no issue here
        },
      ],
    );
    expect(r.capability.issues).toHaveLength(2);
    expect(r.capability.issues.join('\n')).toMatch(/skill-a.*post_orders/);
    expect(r.capability.issues.join('\n')).toMatch(/skill-a.*get_orders/);
  });

  it('is safe trivially when no existing grants reference the apiId', () => {
    const r = runCapabilityBindingProposalValidations(['post_v2_orders'], []);
    expect(r.capability.issues).toHaveLength(0);
    expect(isProposalReadinessSafe(r)).toBe(true);
  });

  it('keeps the contract trivially valid (no workflow surface to validate)', () => {
    const r = runCapabilityBindingProposalValidations(['post_v2_orders'], []);
    expect(r.contract.status).toBe('valid');
    expect(r.contract.diagnostics).toHaveLength(0);
    expect(r.contract.advisories).toHaveLength(0);
    expect(r.capability.warnings).toHaveLength(0);
  });
});
