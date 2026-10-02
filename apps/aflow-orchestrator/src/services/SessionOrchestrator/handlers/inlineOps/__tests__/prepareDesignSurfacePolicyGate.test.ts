import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';
import { createMemoryPayloadStore } from '@aflow/payload-store';

// A policy-gated prefix nothing in the handler knows how to read must still be
// refused. This file adds one to `SPACE_POLICY_OPERATION_PREFIXES` — the set a
// future lane joins — and asserts the space state that never learned to read it
// leaves it OFF rather than waving it through.
const UNREAD_POLICY_PREFIX = vi.hoisted(() => 'telescope');

vi.mock('@aflow/schemas', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    SPACE_POLICY_OPERATION_PREFIXES: new Set([
      ...(orig['SPACE_POLICY_OPERATION_PREFIXES'] as ReadonlySet<string>),
      UNREAD_POLICY_PREFIX,
    ]),
  };
});

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: vi.fn(async () => null),
}));

vi.mock('@aflow/database', () => {
  const spaces = { __table: 'spaces', id: 'id' };
  const table = (name: string) => ({ __table: name });
  return {
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn({
        // The coding-lane column is asked about before it is read; a statement
        // naming a column that does not exist would abort the transaction the
        // caller runs in.
        execute: () => Promise.resolve([{ '?column?': 1 }]),
        select: () => ({
          from: (t: { __table: string }) => ({
            where: () =>
              Promise.resolve(
                t.__table === 'spaces'
                  ? [{ computePolicy: { enabled: true }, codePolicy: { enabled: true } }]
                  : [],
              ),
          }),
        }),
      }),
    ),
    apiDefinitions: table('apiDefinitions'),
    apiBindings: table('apiBindings'),
    mcpServerDefinitions: table('mcpServerDefinitions'),
    mcpServerBindings: table('mcpServerBindings'),
    spaces,
  };
});

function decodeInline(ref: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function makeArgs(intent: Record<string, unknown>): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      traceId: 'trace-1',
      actorContext: {},
      agentDefinition: { steps: [] },
      spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
    } as never,
    stepDef: {
      stepId: 'prepare_design_surface',
      stepType: 'skill',
      operation: 'skill.compose.prepare_surface',
      config: {},
      tags: [],
      role: 'compose-skill-prepare-surface',
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: `inline:${Buffer.from(JSON.stringify({ intent })).toString('base64')}`,
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

describe('prepare-design-surface — policy gate fails closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks a policy-gated prefix the space state cannot answer for', async () => {
    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({
        intent: 'Point a telescope',
        iterationModel: 'process',
        requiredCapabilities: [
          {
            kind: 'operation',
            identifier: `${UNREAD_POLICY_PREFIX}.mount.slew`,
            rationale: 'aims the mount',
          },
        ],
      }),
    );

    const msg = mockAddStepResult.mock.calls.at(-1)?.[1] as {
      status: string;
      requestedInputRef: string;
    };
    expect(msg.status).toBe('PAUSED');
    const payload = decodeInline(msg.requestedInputRef);
    expect(payload['status']).toBe('blocked');
    expect(payload['reason']).toBe('policy_disabled');
    expect(payload['missing']).toEqual([
      expect.objectContaining({ kind: 'policy', identifier: UNREAD_POLICY_PREFIX }),
    ]);
  });

  it('withholds its operations from the design surface', async () => {
    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({ intent: 'Summarise a document', iterationModel: 'process' }),
    );

    const msg = mockAddStepResult.mock.calls.at(-1)?.[1] as { status: string; outputRef: string };
    expect(msg.status).toBe('SUCCEEDED');
    const surface = decodeInline(msg.outputRef)['designSurface'] as Record<string, unknown>;
    expect((surface['policies'] as Record<string, boolean>)[UNREAD_POLICY_PREFIX]).toBe(false);
    expect(surface['operations']).not.toContain(`${UNREAD_POLICY_PREFIX}.mount.slew`);
  });
});
