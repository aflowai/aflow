import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';
import { createMemoryPayloadStore } from '@aflow/payload-store';

// The design surface offers only operations whose lane this deployment
// composes: a task drafted on a lane with no executor can only fail mid-run.
const lanes = vi.hoisted(() => ({
  current: {
    edition: 'enterprise',
    codeLane: 'present',
    hostLane: 'absent',
    browserLane: 'absent',
  } as Record<string, string>,
}));

vi.mock('@aflow/schemas', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, processEditionDescriptor: () => lanes.current };
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

describe('prepare-design-surface — lane composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function surfaceOperations(): Promise<string[]> {
    const { handlePrepareDesignSurfaceInline } = await import('../prepareDesignSurface.js');
    await handlePrepareDesignSurfaceInline(
      makeArgs({ intent: 'Summarise a document', iterationModel: 'process' }),
    );
    const msg = mockAddStepResult.mock.calls.at(-1)?.[1] as { status: string; outputRef: string };
    expect(msg.status).toBe('SUCCEEDED');
    const surface = decodeInline(msg.outputRef)['designSurface'] as { operations: string[] };
    return surface.operations;
  }

  it('offers no browser or host operation where the deployment composes neither lane', async () => {
    lanes.current = {
      edition: 'enterprise',
      codeLane: 'present',
      hostLane: 'absent',
      browserLane: 'absent',
    };
    const operations = await surfaceOperations();
    expect(operations.filter((op) => op.startsWith('browser.') || op.startsWith('host.'))).toEqual(
      [],
    );
    expect(operations).toContain('search.web.fetch');
  });

  it('offers the browser operations where the browser lane is composed', async () => {
    lanes.current = {
      edition: 'community-local',
      codeLane: 'absent',
      hostLane: 'present',
      browserLane: 'present',
    };
    const operations = await surfaceOperations();
    expect(operations).toContain('browser.page.open');
    expect(operations).toContain('browser.profile.list');
    expect(operations.filter((op) => op.startsWith('code.'))).toEqual([]);
  });
});
