import { describe, it, expect } from 'vitest';
import type { ExecutorLogger } from '@aflow/executor-runtime';
import type { TenantId, SessionId } from '@aflow/schemas';

import { SessionManager, makeSessionKey } from '../sessionManager.js';

const TENANT = 'tenant-1' as TenantId;
const RUN = '00000000-0000-0000-0000-000000000001' as SessionId;

function silentLogger(): ExecutorLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function newManager(): SessionManager {
  return new SessionManager({ log: silentLogger() });
}

describe('SessionManager.validateWorkspaceConfig (Plan 114 C1)', () => {
  it('returns undefined when no live session exists (caller will hydrate)', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    expect(sm.validateWorkspaceConfig(key, true, 'space-1')).toBeUndefined();
    expect(sm.validateWorkspaceConfig(key, false, 'space-1')).toBeUndefined();
  });

  it('returns undefined when session and request match (no workspace)', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    // Inject a synthetic entry without going through createSession (which
    // would shell out to Docker). This is a direct white-box test of the
    // validate logic.
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, {
      key,
      // workspace undefined — session was created without workspace mode
    });
    expect(sm.validateWorkspaceConfig(key, false, undefined)).toBeUndefined();
  });

  it('rejects enabling workspace mid-session', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, { key });
    const err = sm.validateWorkspaceConfig(key, true, 'space-1');
    expect(err).toBeDefined();
    expect(err).toMatch(/created without workspace mode/);
  });

  it('rejects disabling workspace mid-session', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, {
      key,
      workspace: {
        hostDir: '/tmp/x',
        spaceId: 'space-1',
        quotas: { maxBytes: 1_000_000, maxFileBytes: 100_000, maxFileCount: 100 },
      },
    });
    const err = sm.validateWorkspaceConfig(key, false, undefined);
    expect(err).toBeDefined();
    expect(err).toMatch(/cannot disable mid-session/);
  });

  it('rejects spaceId drift between calls', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, {
      key,
      workspace: {
        hostDir: '/tmp/x',
        spaceId: 'space-1',
        quotas: { maxBytes: 1_000_000, maxFileBytes: 100_000, maxFileCount: 100 },
      },
    });
    const err = sm.validateWorkspaceConfig(key, true, 'space-2');
    expect(err).toBeDefined();
    expect(err).toMatch(/cannot switch to space-2/);
  });

  it('accepts matching workspace + spaceId', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, {
      key,
      workspace: {
        hostDir: '/tmp/x',
        spaceId: 'space-1',
        quotas: { maxBytes: 1_000_000, maxFileBytes: 100_000, maxFileCount: 100 },
      },
    });
    expect(sm.validateWorkspaceConfig(key, true, 'space-1')).toBeUndefined();
  });
});

describe('SessionManager.getSessionWorkspace (Plan 114 C1)', () => {
  it('returns undefined when no live session exists', () => {
    const sm = newManager();
    expect(sm.getSessionWorkspace(makeSessionKey(TENANT, RUN))).toBeUndefined();
  });

  it('returns the session workspace metadata when present', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, {
      key,
      workspace: {
        hostDir: '/tmp/abc',
        spaceId: 'space-7',
        quotas: { maxBytes: 100, maxFileBytes: 50, maxFileCount: 5 },
      },
    });
    expect(sm.getSessionWorkspace(key)).toEqual({
      hostDir: '/tmp/abc',
      spaceId: 'space-7',
      quotas: { maxBytes: 100, maxFileBytes: 50, maxFileCount: 5 },
    });
  });

  it('returns undefined when session exists but has no workspace', () => {
    const sm = newManager();
    const key = makeSessionKey(TENANT, RUN);
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, { key });
    expect(sm.getSessionWorkspace(key)).toBeUndefined();
  });
});

describe('SessionDestroyPayload carries resolved quotas (reviewer fix)', () => {
  it('beforeDestroy hook receives the same quotas the session was created with', async () => {
    let captured: { quotas?: unknown } | undefined;
    const sm = new SessionManager({
      log: silentLogger(),
      lifecycleHooks: {
        beforeDestroy: async (payload) => {
          captured = payload.workspace;
        },
      },
    });
    const key = makeSessionKey(TENANT, RUN);
    const quotas = { maxBytes: 4242, maxFileBytes: 100, maxFileCount: 7 };
    (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(key, {
      key,
      hostOutputDir: '/tmp/output-irrelevant',
      runnerProcess: undefined,
      containerName: 'irrelevant',
      workspace: { hostDir: '/tmp/ws', spaceId: 'space-1', quotas },
    });

    // Drive fireBeforeDestroy via the public release() path. release() also
    // tries to call destroySession (docker rm) which will no-op gracefully
    // when the container doesn't exist, but the beforeDestroy hook fires
    // first with the payload we want to verify.
    await sm.release(key).catch(() => {});

    expect(captured).toBeDefined();
    expect(captured!.quotas).toEqual(quotas);
  });
});
