import { describe, expect, it } from 'vitest';
import {
  GateContextSchema,
  UserRequestApprovalInputSchema,
  UserRequestInputInputSchema,
} from '../user.js';
import { getOperation } from '../../catalog/registry.js';

describe('UserRequestInputInputSchema (user.interaction.ask)', () => {
  it('accepts a minimal request with just a prompt', () => {
    const parsed = UserRequestInputInputSchema.parse({ prompt: 'What city?' });
    expect(parsed.prompt).toBe('What city?');
  });

  it('accepts the new `choices` uiHints.mode', () => {
    const parsed = UserRequestInputInputSchema.parse({
      prompt: 'Pick one',
      inputSchema: { type: 'string', enum: ['a', 'b'] },
      uiHints: { mode: 'choices', submitLabel: 'Use this' },
    });
    expect(parsed.uiHints?.mode).toBe('choices');
  });

  it('accepts gateContext and relatesTo', () => {
    const parsed = UserRequestInputInputSchema.parse({
      prompt: 'p',
      gateContext: {
        operationId: 'memory.store.delete',
        reason: 'op_always_requires_approval',
        sources: ['op'],
        riskModifiers: ['external_side_effect'],
        callInputRef: 'inline:e30=',
        gateRequestId: 'gate-abc',
      },
      relatesTo: [{ kind: 'step', id: 's-1', label: 'parent step' }],
    });
    expect(parsed.gateContext?.gateRequestId).toBe('gate-abc');
    expect(parsed.relatesTo).toHaveLength(1);
  });
});

describe('UserRequestApprovalInputSchema (user.interaction.approve)', () => {
  it('requires title and description; rejects empty', () => {
    expect(() => UserRequestApprovalInputSchema.parse({})).toThrow();
    expect(() => UserRequestApprovalInputSchema.parse({ title: '', description: '' })).toThrow();
  });

  it('accepts the canonical fields (title/description/reviewData/policy/timeoutSeconds)', () => {
    const parsed = UserRequestApprovalInputSchema.parse({
      title: 'Delete 432 rows',
      description: 'Permanently removes rows where ...',
      reviewData: { affectedRows: 432 },
      policy: { minApprovals: 1, requireAll: false },
      timeoutSeconds: 3600,
      defaultOnTimeout: 'reject',
    });
    expect(parsed.title).toBe('Delete 432 rows');
    expect(parsed.policy?.minApprovals).toBe(1);
    expect(parsed.timeoutSeconds).toBe(3600);
  });

  it('rejects the legacy `prompt`/`contextData`/`timeoutMs` fields (no longer permitted)', () => {
    // The schema is strict on its declared fields — these extras are stripped,
    // not raised — but the required `title`/`description` are still enforced.
    const parsed = UserRequestApprovalInputSchema.safeParse({
      // @ts-expect-error: legacy fields are no longer on the type surface.
      prompt: 'old shape',
      // @ts-expect-error: legacy
      contextData: { foo: 1 },
      // @ts-expect-error: legacy
      timeoutMs: 5_000,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts gateContext (for synthetic gate steps inserted by the orchestrator)', () => {
    const parsed = UserRequestApprovalInputSchema.parse({
      title: 'Approve MCP call',
      description: 'mcp_stripe.charges.create requires approval',
      gateContext: {
        operationId: 'mcp.tool.call',
        reason: 'binding_requires_approval',
        sources: ['binding'],
        bindingId: 'stripe-default',
        callInputRef: 'inline:e30=',
        gateRequestId: 'gate-xyz',
      },
    });
    expect(parsed.gateContext?.bindingId).toBe('stripe-default');
  });
});

describe('GateContextSchema', () => {
  it('accepts every documented reason value', () => {
    for (const reason of [
      'op_always_requires_approval',
      'op_configurable_and_enabled',
      'binding_requires_approval',
      'capability_profile_gated',
    ] as const) {
      expect(() =>
        GateContextSchema.parse({
          operationId: 'memory.store.delete',
          reason,
          callInputRef: 'inline:e30=',
          gateRequestId: 'g-1',
        }),
      ).not.toThrow();
    }
  });
});

describe('OperationDescriptor.opTaskOnly (Plan 167 default resolution)', () => {
  it('user.interaction.ask defaults to opTaskOnly: false', () => {
    const desc = getOperation('user.interaction.ask');
    expect(desc).toBeDefined();
    expect(desc?.opTaskOnly).toBe(false);
  });

  it('user.notification.list_emails defaults to opTaskOnly: false', () => {
    const desc = getOperation('user.notification.list_emails');
    expect(desc).toBeDefined();
    expect(desc?.opTaskOnly).toBe(false);
  });

  it('user.notification.email defaults to opTaskOnly: false', () => {
    const desc = getOperation('user.notification.email');
    expect(desc).toBeDefined();
    expect(desc?.opTaskOnly).toBe(false);
  });
});
