/**
 * A step paused on an approval → its approve/deny item, for both variants of
 * the approval payload, and the resolve that is the only place a grant is
 * minted (Plan 253; Plan 320 D7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { Redis as RedisType } from 'ioredis';
import { getWriteApprovalGrant } from '@aflow/redis';
import {
  ActionCenterItemSchema,
  type BrowserWriteApprovalRequestPayload,
  type TenantId,
} from '@aflow/schemas';
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
const SESSION = 'sess-1';

const BROWSER_REQUEST: BrowserWriteApprovalRequestPayload = {
  kind: 'write_approval',
  target: 'browser',
  profileId: 'default',
  pageOrigin: 'https://shop.example.com',
  pageTitle: 'Checkout',
  action: 'type',
  element: { ref: 'e3', role: 'textbox', name: 'Note' },
  value: { kind: 'text', length: 17, excerpt: 'leave at the door', submit: true },
  askedBy: { kind: 'posture' },
  screenshotRef: 'inline:shot',
  requestHash: 'browser-hash-1',
};

const API_REQUEST = {
  kind: 'write_approval',
  target: 'api',
  apiId: 'etoro-trading',
  endpointId: 'createOrder',
  method: 'POST',
  urlHost: 'public-api.etoro.com',
  writeRiskTier: 'high',
  requestHash: 'api-hash-1',
};

function inlineRef(payload: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

let redis: RedisType;
let resumeSession: ReturnType<typeof vi.fn>;

function makeDeps(payload: unknown): PausedStepSourceDeps {
  const rows = [
    {
      sessionId: SESSION,
      spaceId: SPACE,
      status: 'PAUSED',
      currentStepExecutionId: STEP_EXEC,
      requestedInputRef: inlineRef(payload),
      pauseReason: 'input_required',
      startedAt: new Date('2026-10-04T12:00:00.000Z'),
      hotStateSnapshot: null,
    },
  ];
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
    redis: redis as never,
    payloadStore: payloadStore as PayloadStore,
    sessionService: { resumeSession } as never,
  };
}

function ctx(): ActionCenterContext {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    actorUserId: 'user-1',
    actorSpaceRole: 'editor',
    actorIsTenantAdmin: false,
  };
}

beforeEach(async () => {
  mockWithTenantSchema.mockReset();
  redis = new Redis() as unknown as RedisType;
  await redis.flushall();
  resumeSession = vi.fn().mockResolvedValue(undefined);
});

describe('pausedStepSource — a browser action waiting on the operator', () => {
  it('builds the same approve/deny item, carrying the browser variant', async () => {
    const source = createPausedStepSource(makeDeps(BROWSER_REQUEST));
    const item = (await source.listOpen(ctx()))[0]!;

    expect(item.kind).toBe('write_approval');
    expect(projectActionCenterItem(ctx(), item).allowedActions).toEqual([
      'approve',
      'reject',
      'reassign',
    ]);
    expect(item.extension).toEqual({
      kind: 'write_approval',
      target: 'browser',
      profileId: 'default',
      pageOrigin: 'https://shop.example.com',
      pageTitle: 'Checkout',
      action: 'type',
      element: { ref: 'e3', role: 'textbox', name: 'Note' },
      value: { kind: 'text', length: 17, excerpt: 'leave at the door', submit: true },
      askedBy: { kind: 'posture' },
      screenshotRef: 'inline:shot',
    });
    expect(item.title).toBe(
      'Approve in the browser: type 17 characters into textbox “Note” and press Enter on shop.example.com',
    );
    expect(item.summary).toContain('“Checkout”');
    expect(item.summary).toContain('asks before every action');
    if (item.origin.type === 'step') expect(item.origin.operationId).toBe('browser.page.act');
    expect(() =>
      ActionCenterItemSchema.parse({ ...item, allowedActions: [], audience: 'anyone' }),
    ).not.toThrow();
  });

  it('still builds the API variant as before', async () => {
    const item = (await createPausedStepSource(makeDeps(API_REQUEST)).listOpen(ctx()))[0]!;
    expect(item.extension).toMatchObject({ kind: 'write_approval', target: 'api', method: 'POST' });
    expect(item.priority).toBe('high');
  });

  it('mints the grant at the resolve, keyed by run and request hash, then resumes', async () => {
    const source = createPausedStepSource(makeDeps(BROWSER_REQUEST));
    const item = (await source.listOpen(ctx()))[0]!;
    expect(await getWriteApprovalGrant(redis, TENANT, SESSION, 'browser-hash-1')).toBeNull();

    await source.resolve(ctx(), item, { kind: 'approve' });

    expect(await getWriteApprovalGrant(redis, TENANT, SESSION, 'browser-hash-1')).toMatchObject({
      requestHash: 'browser-hash-1',
      decision: 'approved',
      approvedBy: 'user-1',
    });
    expect(resumeSession).toHaveBeenCalledOnce();
  });

  it('records a denial with the operator’s reason', async () => {
    const source = createPausedStepSource(makeDeps(BROWSER_REQUEST));
    const item = (await source.listOpen(ctx()))[0]!;
    await source.resolve(ctx(), item, { kind: 'reject', reason: 'Not this card.' });
    expect(await getWriteApprovalGrant(redis, TENANT, SESSION, 'browser-hash-1')).toMatchObject({
      decision: 'denied',
      reason: 'Not this card.',
    });
  });
});
