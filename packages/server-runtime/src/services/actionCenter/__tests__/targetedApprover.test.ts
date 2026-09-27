/**
 * A named-approver request must be resolvable only by the people it names.
 *
 * `user.interaction.approve` takes an `approvers` list and the user executor
 * writes it into the pause payload, but the Action Center item built from that
 * pause never read it — so a request addressed to one person could be approved
 * by any editor in the space. The request was captured and ignored.
 *
 * Targeting only: multi-party sign-off is expressed as separate approval steps
 * in the skill's workflow, never as a vote count on one item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@aflow/schemas';
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
import {
  assertResolutionAllowed,
  projectActionCenterItem,
  ActionCenterAuthzError,
} from '../authz.js';
import type { ActionCenterContext } from '../types.js';

const TENANT = '00000000-0000-4000-8000-000000000001' as unknown as TenantId;
const SPACE = '00000000-0000-4000-8000-000000000002';
const STEP_EXEC = '00000000-0000-4000-8000-00000000cccc';

function inlineRef(payload: Record<string, unknown>): string {
  return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

function approvalRow(approvers?: unknown) {
  return {
    sessionId: 'sess-1',
    spaceId: SPACE,
    status: 'PAUSED',
    currentStepExecutionId: STEP_EXEC,
    requestedInputRef: inlineRef({
      kind: 'approval',
      title: 'Deploy to production',
      description: 'Ship build 42.',
      requestedAt: '2026-06-24T12:00:00.000Z',
      ...(approvers === undefined ? {} : { approvers }),
    }),
    pauseReason: 'input_required',
    startedAt: new Date('2026-06-24T12:00:00.000Z'),
    hotStateSnapshot: null,
  };
}

function makeDeps(rows: ReturnType<typeof approvalRow>[]): PausedStepSourceDeps {
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
    retrieve: async (ref) =>
      JSON.parse(
        Buffer.from((ref as string).slice('inline:'.length), 'base64').toString('utf8'),
      ) as never,
  };

  return {
    db: {} as never,
    redis: {} as never,
    payloadStore: payloadStore as PayloadStore,
    sessionService: { resumeSession: vi.fn() } as never,
  };
}

function ctx(
  actorUserId: string,
  role: 'admin' | 'editor' | 'viewer' = 'editor',
): ActionCenterContext {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    actorUserId,
    actorSpaceRole: role,
    actorIsTenantAdmin: role === 'admin',
  };
}

/**
 * The item as this reader receives it. The source no longer bakes a reader in,
 * so the assertions below run against the same read-time projection the
 * realtime topic applies at emit.
 */
async function itemFor(approvers: unknown, actor: ActionCenterContext) {
  const source = createPausedStepSource(makeDeps([approvalRow(approvers)]));
  if (source.rowScope !== 'space') throw new Error('pausedStep is space-scoped');
  const items = await source.listOpen(actor);
  expect(items).toHaveLength(1);
  const pooled = items[0]!;
  return { ...projectActionCenterItem(actor, pooled), resolverAuthority: pooled.resolverAuthority };
}

describe('pausedStepSource — targeted approvers', () => {
  beforeEach(() => {
    mockWithTenantSchema.mockReset();
  });

  it('lets a named approver approve', async () => {
    const item = await itemFor(['sara'], ctx('sara'));

    expect(item.resolverPolicy?.candidateResolvers).toEqual(['sara']);
    expect(item.allowedActions).toEqual(['approve', 'reject', 'reassign']);
    expect(() =>
      assertResolutionAllowed(item, 'approve', {
        actorUserId: 'sara',
        actorSpaceRole: 'editor',
        actorIsTenantAdmin: false,
      }),
    ).not.toThrow();
  });

  it('stops an editor who was not named — the live authorization defect', async () => {
    const item = await itemFor(['sara'], ctx('karim'));

    expect(item.allowedActions).toEqual(['reassign']);
    expect(() =>
      assertResolutionAllowed(item, 'approve', {
        actorUserId: 'karim',
        actorSpaceRole: 'editor',
        actorIsTenantAdmin: false,
      }),
    ).toThrow(ActionCenterAuthzError);
  });

  it('accepts a role name as a target', async () => {
    const named = await itemFor(['admin'], ctx('karim', 'admin'));
    expect(named.allowedActions).toEqual(['approve', 'reject', 'reassign']);

    const other = await itemFor(['admin'], ctx('karim', 'editor'));
    expect(other.allowedActions).toEqual(['reassign']);
  });

  it('leaves an untargeted request open to any editor', async () => {
    const item = await itemFor(undefined, ctx('anyone'));

    expect(item.resolverPolicy).toBeUndefined();
    expect(item.allowedActions).toEqual(['approve', 'reject', 'reassign']);
  });

  it('treats an empty or malformed list as untargeted rather than locking everyone out', async () => {
    expect((await itemFor([], ctx('anyone'))).allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
    expect((await itemFor([''], ctx('anyone'))).allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
    expect((await itemFor('sara', ctx('anyone'))).allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
    expect((await itemFor([42], ctx('anyone'))).allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
  });

  it('keeps viewers read-only even when named', async () => {
    const item = await itemFor(['sara'], ctx('sara', 'viewer'));
    expect(item.allowedActions).toEqual([]);
  });
});
