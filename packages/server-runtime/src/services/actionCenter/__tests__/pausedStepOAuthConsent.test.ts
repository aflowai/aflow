/**
 * Paused-step → Action Center item building for the OAuth consent pause
 * (Plan 185 §9.3 Plane A) and the unchanged HITL pauses alongside it.
 *
 * The discriminator is `payload.kind`:
 *   - 'oauth_consent' → a `needs_oauth_consent` launch card (allowedActions
 *     ['connect'], a typed `extension`, no resolutionSchema).
 *   - 'input'         → 'human_input'    (allowedActions ['submit']).
 *   - 'approval'      → 'human_approval' (allowedActions ['approve','reject']).
 *
 * A regression that mis-discriminates would either drop the consent card or
 * expose a resolve affordance on it (it is callback-resumed, not resolvable).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCenterItem, OAuthConsentExtension, TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

const mockWithTenantSchema = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
  sessions: {
    sessionId: 'sessionId',
    spaceId: 'spaceId',
    status: 'status',
    currentStepExecutionId: 'currentStepExecutionId',
    requestedInputRef: 'requestedInputRef',
    pauseReason: 'pauseReason',
    startedAt: 'startedAt',
    hotStateSnapshot: 'hotStateSnapshot',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  isNotNull: (...args: unknown[]) => args,
  desc: (col: unknown) => col,
}));

import { createPausedStepSource, type PausedStepSourceDeps } from '../sources/pausedStepSource.js';
import type { ActionCenterContext } from '../types.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as unknown as TenantId;
const SPACE = '00000000-0000-4000-8000-000000000002';
const STEP_EXEC = '00000000-0000-4000-8000-00000000cccc';

interface FakeSessionRow {
  sessionId: string;
  spaceId: string | null;
  status: string;
  currentStepExecutionId: string | null;
  requestedInputRef: string | null;
  pauseReason: string | null;
  startedAt: Date;
  hotStateSnapshot: unknown;
}

function row(requestedInputRef: string, overrides: Partial<FakeSessionRow> = {}): FakeSessionRow {
  return {
    sessionId: 'sess-1',
    spaceId: SPACE,
    status: 'PAUSED',
    currentStepExecutionId: STEP_EXEC,
    requestedInputRef,
    pauseReason: 'input_required',
    startedAt: new Date('2026-06-24T12:00:00.000Z'),
    hotStateSnapshot: null,
    ...overrides,
  };
}

function inlineRef(payload: Record<string, unknown>): string {
  return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

function makeDeps(rows: FakeSessionRow[]): PausedStepSourceDeps {
  mockWithTenantSchema.mockImplementation(async (_db, _ctx, cb: (tx: unknown) => unknown) => {
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => builder,
      orderBy: () => builder,
      limit: () => Promise.resolve(rows),
    };
    return cb(builder);
  });

  const payloadStore: Pick<PayloadStore, 'retrieve'> = {
    retrieve: async (ref) => {
      const raw = (ref as string).slice('inline:'.length);
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as never;
    },
  };

  return {
    db: {} as never,
    redis: {} as never,
    payloadStore: payloadStore as PayloadStore,
    sessionService: { resumeSession: vi.fn() } as never,
  };
}

function ctx(role: 'admin' | 'editor' | 'viewer' = 'editor'): ActionCenterContext {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    actorUserId: 'user-1',
    actorSpaceRole: role,
    actorIsTenantAdmin: role === 'admin',
  };
}

describe('pausedStepSource — OAuth consent item (Plan 185 §9.3 Plane A)', () => {
  beforeEach(() => {
    mockWithTenantSchema.mockReset();
  });

  it('builds a needs_oauth_consent card with allowedActions [connect] and a typed extension', async () => {
    const deps = makeDeps([
      row(
        inlineRef({
          kind: 'oauth_consent',
          integrationKind: 'mcp',
          resourceKey: 'github',
          bindingId: 'bnd-github',
          ownerScope: 'user',
          reason: 'never_connected',
          consentUrlHint: '/v1/integrations/mcp/bindings/bnd-github/consent',
        }),
      ),
    ]);

    const items = await createPausedStepSource(deps).listOpen(ctx());

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe('needs_oauth_consent');
    expect(projectActionCenterItem(ctx(), item).allowedActions).toEqual(['connect', 'reassign']);
    expect(item.id).toBe(`step:${STEP_EXEC}`);
    expect(item.status).toBe('open');
    // No resolve affordance schema — this is a launch card, not a HITL form.
    expect(item.resolutionSchema).toBeUndefined();

    const extension = item.extension as OAuthConsentExtension | undefined;
    expect(extension).toMatchObject({
      kind: 'oauth_consent',
      integrationKind: 'mcp',
      resourceKey: 'github',
      bindingId: 'bnd-github',
      ownerScope: 'user',
      reason: 'never_connected',
      consentUrlHint: '/v1/integrations/mcp/bindings/bnd-github/consent',
    });
    expect(item.origin.type).toBe('step');
    if (item.origin.type === 'step') {
      expect(item.origin.operationId).toBe('mcp.tool.call');
    }
  });

  it('labels the card as Expired/Reconnect when reason is expired', async () => {
    const deps = makeDeps([
      row(
        inlineRef({
          kind: 'oauth_consent',
          integrationKind: 'mcp',
          resourceKey: 'github',
          bindingId: 'bnd-github',
          ownerScope: 'user',
          reason: 'expired',
        }),
      ),
    ]);
    const item = (await createPausedStepSource(deps).listOpen(ctx()))[0]!;
    expect((item.extension as OAuthConsentExtension).reason).toBe('expired');
    expect(item.summary.toLowerCase()).toContain('expired');
  });

  it('gives a viewer no connect affordance on a consent card', async () => {
    const deps = makeDeps([
      row(
        inlineRef({
          kind: 'oauth_consent',
          integrationKind: 'mcp',
          resourceKey: 'github',
          bindingId: 'bnd-github',
          ownerScope: 'user',
          reason: 'never_connected',
        }),
      ),
    ]);
    const item = (await createPausedStepSource(deps).listOpen(ctx('viewer')))[0]!;
    expect(projectActionCenterItem(ctx('viewer'), item).allowedActions).toEqual([]);
  });

  it('still routes an input pause to a human_input HITL item', async () => {
    const deps = makeDeps([
      row(inlineRef({ kind: 'input', title: 'Need a value', prompt: 'What is X?' })),
    ]);
    const item = (await createPausedStepSource(deps).listOpen(ctx()))[0]!;
    expect(item.kind).toBe('human_input');
    expect(projectActionCenterItem(ctx(), item).allowedActions).toEqual(['submit', 'reassign']);
    expect(item.extension).toBeUndefined();
  });

  it('still routes an approval pause to a human_approval HITL item', async () => {
    const deps = makeDeps([
      row(inlineRef({ kind: 'approval', title: 'Approve?', description: 'Please review.' })),
    ]);
    const item = (await createPausedStepSource(deps).listOpen(ctx('admin')))[0]!;
    expect(item.kind).toBe('human_approval');
    expect(projectActionCenterItem(ctx('admin'), item).allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
  });

  it('drops a paused step whose payload kind is unrecognised', async () => {
    const deps = makeDeps([row(inlineRef({ kind: 'something_else' }))]);
    const items = await createPausedStepSource(deps).listOpen(ctx());
    expect(items).toEqual([]);
  });

  it('does not surface a consent card for a harness-routed run (Phase 2b owns those)', async () => {
    const deps = makeDeps([
      row(
        inlineRef({
          kind: 'oauth_consent',
          integrationKind: 'mcp',
          resourceKey: 'github',
          bindingId: 'bnd-github',
          ownerScope: 'user',
          reason: 'never_connected',
        }),
        {
          hotStateSnapshot: {
            runHotState: {
              workflowExecution: { runId: 'run-1', taskId: 'task-1', attempt: 1 },
            },
          },
        },
      ),
    ]);
    const items = await createPausedStepSource(deps).listOpen(ctx());
    expect(items).toEqual([]);
  });
});
