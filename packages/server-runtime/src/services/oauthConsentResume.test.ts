/**
 * Dual-plane consent resume (Plan 185 §9.3).
 *
 * `resumeSessionsForCompletedConsent` is the security-relevant join between a
 * just-completed OAuth consent and the sessions parked on it. This pins the
 * three behaviours a silent regression would break:
 *   1. owner gating — a `user`-scope consent only un-blocks the consenting
 *      user's parked session; a different owner's session is skipped.
 *   2. identity matching — a session whose consent payload targets a different
 *      (integrationKind, resourceKey, bindingId, ownerScope) is skipped.
 *   3. plane routing — a direct session (`workflowExecution` unset) is
 *      step-plane resumed here; a harness-routed session (`workflowExecution`
 *      set) is resumed on the RUN plane via the run-resume authority.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayloadStore } from '@aflow/payload-store';

const mockWithTenantSchema = vi.fn();
const mockGetSessionState = vi.fn();
const mockLoadRunById = vi.fn();

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (...args: unknown[]) => mockWithTenantSchema(...args),
  sessions: {
    sessionId: 'sessionId',
    currentStepExecutionId: 'currentStepExecutionId',
    requestedInputRef: 'requestedInputRef',
    createdBy: 'createdBy',
    hotStateSnapshot: 'hotStateSnapshot',
    spaceId: 'spaceId',
    status: 'status',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  isNotNull: (...args: unknown[]) => args,
}));

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  loadRunById: (...args: unknown[]) => mockLoadRunById(...args),
}));

import {
  resumeSessionsForCompletedConsent,
  type CompletedConsentIdentity,
} from './oauthConsentResume.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const SPACE = '00000000-0000-4000-8000-000000000002';

interface FakeRow {
  sessionId: string;
  currentStepExecutionId: string | null;
  requestedInputRef: string | null;
  createdBy: string | null;
  hotStateSnapshot?: unknown;
}

/**
 * Mirror of the durable `hot_state_snapshot` shape the projection worker writes
 * for a paused harness-routed run — the run-plane routing authority, identical
 * to the surfacing plane's `isHarnessRoutedRun`.
 */
function harnessSnapshot(runId: string): unknown {
  return { runHotState: { workflowExecution: { runId, taskId: 'task-1', attempt: 1 } } };
}

function consent(overrides: Partial<CompletedConsentIdentity> = {}): CompletedConsentIdentity {
  return {
    tenantId: TENANT,
    spaceId: SPACE,
    integrationKind: 'mcp',
    resourceKey: 'github',
    bindingId: 'bnd-github',
    ownerScope: 'user',
    ownerId: 'user-alice',
    ...overrides,
  };
}

function consentPayloadRef(
  payload: Partial<{
    integrationKind: 'mcp' | 'api';
    resourceKey: string;
    bindingId: string;
    ownerScope: 'user' | 'space' | 'tenant';
  }> = {},
): string {
  const full = {
    kind: 'oauth_consent',
    integrationKind: 'mcp',
    resourceKey: 'github',
    bindingId: 'bnd-github',
    ownerScope: 'user',
    reason: 'never_connected',
    ...payload,
  };
  return `inline:${Buffer.from(JSON.stringify(full)).toString('base64')}`;
}

function makeDeps(opts: {
  rows: FakeRow[];
  hotStateBySession?: Record<string, { workflowExecution?: unknown } | null>;
  runsById?: Record<string, { status: string; pausedReason: string; pauseVersion: number } | null>;
  resumeImpl?: () => Promise<unknown>;
  runResumeImpl?: () => Promise<{ ok: boolean }>;
}): {
  deps: Parameters<typeof resumeSessionsForCompletedConsent>[0];
  resumeSpy: ReturnType<typeof vi.fn>;
  runResumeSpy: ReturnType<typeof vi.fn>;
} {
  const rows = opts.rows.map((row) => ({
    hotStateSnapshot: null,
    ...row,
  }));
  mockWithTenantSchema.mockImplementation(async (_db, _ctx, cb: (tx: unknown) => unknown) => {
    // The query builder is mocked away; the source only consumes the returned
    // rows. Return a thenable-free builder whose terminal call yields the rows.
    const builder = {
      select: () => builder,
      from: () => builder,
      where: () => Promise.resolve(rows),
    };
    return cb(builder);
  });

  mockGetSessionState.mockImplementation(async (_redis, _tenantId, sessionId: string) => {
    return opts.hotStateBySession?.[sessionId] ?? null;
  });

  mockLoadRunById.mockImplementation(async (_db, _tenantId, _spaceId, runId: string) => {
    return opts.runsById?.[runId] ?? null;
  });

  const resumeSpy = vi.fn(opts.resumeImpl ?? (async () => ({})));
  const runResumeSpy = vi.fn(opts.runResumeImpl ?? (async () => ({ ok: true })));

  const payloadStore: Pick<PayloadStore, 'retrieve'> = {
    retrieve: async (ref) => {
      const raw = (ref as string).slice('inline:'.length);
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as never;
    },
  };

  const deps = {
    db: {} as never,
    redis: {} as never,
    payloadStore: payloadStore as PayloadStore,
    sessionService: { resumeSession: resumeSpy } as never,
    resumeRunPlane: runResumeSpy,
  };
  return { deps, resumeSpy, runResumeSpy };
}

describe('resumeSessionsForCompletedConsent', () => {
  beforeEach(() => {
    mockWithTenantSchema.mockReset();
    mockGetSessionState.mockReset();
    mockLoadRunById.mockReset();
  });

  it('resumes a direct (non-harness) session whose consent identity matches', async () => {
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-1',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: { 'sess-1': null },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedSessionIds).toEqual(['sess-1']);
    expect(result.resumedRunIds).toEqual([]);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      sessionId: 'sess-1',
      stepExecutionId: 'step-1',
    });
  });

  it('states nothing about who is present, so the session stays as attended as it was', async () => {
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-1',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: { 'sess-1': null },
    });

    await resumeSessionsForCompletedConsent(deps, consent());

    expect(resumeSpy.mock.calls[0]![0]).not.toHaveProperty('activatedByPerson');
  });

  it('skips a user-scope consent for a session owned by a different user', async () => {
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-bob',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-bob',
        },
      ],
      hotStateBySession: { 'sess-bob': null },
    });

    const result = await resumeSessionsForCompletedConsent(
      deps,
      consent({ ownerId: 'user-alice' }),
    );

    expect(result.resumedSessionIds).toEqual([]);
    expect(result.resumedRunIds).toEqual([]);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('resumes regardless of session owner for a space-scope consent', async () => {
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-space',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef({ ownerScope: 'space' }),
          createdBy: 'user-bob',
        },
      ],
      hotStateBySession: { 'sess-space': null },
    });

    const result = await resumeSessionsForCompletedConsent(
      deps,
      consent({ ownerScope: 'space', ownerId: SPACE }),
    );

    expect(result.resumedSessionIds).toEqual(['sess-space']);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
  });

  it('skips a session whose consent payload targets a different binding', async () => {
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-other',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef({ bindingId: 'bnd-other' }),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: { 'sess-other': null },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedSessionIds).toEqual([]);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('skips a session whose consent payload targets a different resourceKey/integrationKind', async () => {
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-api',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef({ integrationKind: 'api', resourceKey: 'stripe' }),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: { 'sess-api': null },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedSessionIds).toEqual([]);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('resumes a harness-routed session (workflowExecution set) on the run plane', async () => {
    const { deps, resumeSpy, runResumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-runner',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: {
        'sess-runner': { workflowExecution: { runId: 'run-1', taskId: 'task-1' } },
      },
      runsById: {
        'run-1': { status: 'paused', pausedReason: 'needs_oauth_consent', pauseVersion: 3 },
      },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedSessionIds).toEqual([]);
    expect(result.resumedRunIds).toEqual(['run-1']);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(runResumeSpy).toHaveBeenCalledTimes(1);
    expect(runResumeSpy.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      spaceId: SPACE,
      userId: 'user-alice',
      runId: 'run-1',
      pauseVersion: 3,
    });
  });

  it('routes a harness-routed run to the run plane from the durable DB snapshot when Redis hot state has TTLd out', async () => {
    // The consent completes after the worker sub-session's Redis hot state
    // expires (24h TTL); only the durable `hot_state_snapshot` survives. Routing
    // must still reach the run plane, never dead-end on the step plane and strand
    // the still-surfaced run.
    const { deps, resumeSpy, runResumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-runner',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
          hotStateSnapshot: harnessSnapshot('run-1'),
        },
      ],
      hotStateBySession: { 'sess-runner': null },
      runsById: {
        'run-1': { status: 'paused', pausedReason: 'needs_oauth_consent', pauseVersion: 7 },
      },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedSessionIds).toEqual([]);
    expect(result.resumedRunIds).toEqual(['run-1']);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(runResumeSpy).toHaveBeenCalledTimes(1);
    expect(runResumeSpy.mock.calls[0]![0]).toMatchObject({
      runId: 'run-1',
      pauseVersion: 7,
    });
  });

  it('does not resume a run paused on a different cause', async () => {
    const { deps, runResumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-runner',
          currentStepExecutionId: 'step-1',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: {
        'sess-runner': { workflowExecution: { runId: 'run-1', taskId: 'task-1' } },
      },
      runsById: {
        'run-1': { status: 'paused', pausedReason: 'needs_decision', pauseVersion: 1 },
      },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedRunIds).toEqual([]);
    expect(runResumeSpy).not.toHaveBeenCalled();
  });

  it('routes each matching session to exactly one plane in a mixed batch', async () => {
    const { deps, resumeSpy, runResumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-direct',
          currentStepExecutionId: 'step-a',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
        {
          sessionId: 'sess-runner',
          currentStepExecutionId: 'step-b',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
        {
          sessionId: 'sess-bob',
          currentStepExecutionId: 'step-c',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-bob',
        },
      ],
      hotStateBySession: {
        'sess-direct': null,
        'sess-runner': { workflowExecution: { runId: 'run-1' } },
        'sess-bob': null,
      },
      runsById: {
        'run-1': { status: 'paused', pausedReason: 'needs_oauth_consent', pauseVersion: 1 },
      },
    });

    const result = await resumeSessionsForCompletedConsent(
      deps,
      consent({ ownerId: 'user-alice' }),
    );

    expect(result.resumedSessionIds).toEqual(['sess-direct']);
    expect(result.resumedRunIds).toEqual(['run-1']);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(runResumeSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows a resume failure for one session without aborting the batch', async () => {
    let calls = 0;
    const { deps, resumeSpy } = makeDeps({
      rows: [
        {
          sessionId: 'sess-fail',
          currentStepExecutionId: 'step-a',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
        {
          sessionId: 'sess-ok',
          currentStepExecutionId: 'step-b',
          requestedInputRef: consentPayloadRef(),
          createdBy: 'user-alice',
        },
      ],
      hotStateBySession: { 'sess-fail': null, 'sess-ok': null },
      resumeImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('session moved on');
        return {};
      },
    });

    const result = await resumeSessionsForCompletedConsent(deps, consent());

    expect(result.resumedSessionIds).toEqual(['sess-ok']);
    expect(resumeSpy).toHaveBeenCalledTimes(2);
  });
});
