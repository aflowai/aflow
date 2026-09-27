/**
 * Run-plane "Connect {provider}" Action Center source (Plan 185 §9.3 Plane B).
 *
 * A workflow RUN paused with `paused_reason = 'needs_oauth_consent'` carries the
 * typed cause in its stored `WorkflowResumeContract.oauthConsent`. This source
 * lifts that into a `needs_oauth_consent` item (kind + `oauth_consent`
 * extension + `connect` action) so the existing `OAuthConsentCard` renders it
 * unchanged — the same item shape the step plane (Plane A) produces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfacedResumeContract } from '@aflow/cybernetic-runtime';

vi.mock('@aflow/database', () => ({
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(),
  workflowRuns: {
    runId: 'run_id',
    spaceId: 'space_id',
    status: 'status',
    pausedReason: 'paused_reason',
    startedAt: 'started_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (..._args: unknown[]) => ({ __op: 'and' }),
  desc: (..._args: unknown[]) => ({ __op: 'desc' }),
  eq: (..._args: unknown[]) => ({ __op: 'eq' }),
}));

const cyberneticMocks = vi.hoisted(() => ({
  surfaceWorkflowResumeContract: vi.fn(),
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  surfaceWorkflowResumeContract: cyberneticMocks.surfaceWorkflowResumeContract,
}));

import { createWorkflowOAuthConsentSource } from '../sources/workflowOAuthConsentSource.js';
import { withTenantSchema } from '@aflow/database';
import { ActionCenterResolveError, type ActionCenterContext } from '../types.js';
import { projectActionCenterItem } from '../authz.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-0000-0000-000000000002';
const RUN_ID = '00000000-0000-0000-0000-000000000010';
const SESSION_ID = '00000000-0000-0000-0000-000000000020';

function ctx(): ActionCenterContext {
  return {
    tenantId: TENANT_ID as never,
    spaceId: SPACE_ID,
    actorUserId: '00000000-0000-0000-0000-000000000004',
    actorSpaceRole: 'admin',
    actorIsTenantAdmin: true,
  };
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    spaceId: SPACE_ID,
    workflowSlug: 'kaggle-competition-optimizer',
    status: 'paused',
    pausedReason: 'needs_oauth_consent',
    pauseVersion: 4,
    sessionId: SESSION_ID,
    startedAt: new Date('2026-06-01T09:00:00.000Z'),
    ...overrides,
  };
}

function surfaced(oauthConsent: Record<string, unknown> | undefined): SurfacedResumeContract {
  return {
    contract: {
      pauseCause: 'needs_oauth_consent',
      resumePrompt: 'Connect the provider to continue.',
      ...(oauthConsent ? { oauthConsent } : {}),
    },
    pauseVersion: 4,
    pausedReason: 'needs_oauth_consent',
    resumeAttemptCount: 0,
  } as unknown as SurfacedResumeContract;
}

function makeSource() {
  return createWorkflowOAuthConsentSource({
    db: {} as never,
    redis: {} as never,
    payloadStore: {} as never,
  });
}

beforeEach(() => {
  vi.mocked(withTenantSchema).mockReset();
  cyberneticMocks.surfaceWorkflowResumeContract.mockReset();
});

describe('workflowOAuthConsentSource — listOpen', () => {
  it('builds a needs_oauth_consent item from the run pause cause', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([runRow()]);
    cyberneticMocks.surfaceWorkflowResumeContract.mockResolvedValueOnce(
      surfaced({
        integrationKind: 'mcp',
        resourceKey: 'gmail',
        bindingId: 'binding-1',
        ownerScope: 'user',
        reason: 'never_connected',
        consentUrlHint: '/v1/integrations/mcp/bindings/binding-1/consent',
      }),
    );

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toBe(`workflow-oauth-consent:${RUN_ID}`);
    expect(item.kind).toBe('needs_oauth_consent');
    expect(projectActionCenterItem(ctx(), item).allowedActions).toEqual(['connect', 'reassign']);
    expect(item.title).toBe('Connect gmail');
    expect(item.origin).toEqual({
      type: 'workflow_task',
      runId: RUN_ID,
      taskId: 'oauth_consent',
      pauseVersion: 4,
    });
    expect(item.extension).toEqual({
      kind: 'oauth_consent',
      integrationKind: 'mcp',
      resourceKey: 'gmail',
      bindingId: 'binding-1',
      ownerScope: 'user',
      reason: 'never_connected',
      consentUrlHint: '/v1/integrations/mcp/bindings/binding-1/consent',
    });
    expect(item.requestedBy.sessionId).toBe(SESSION_ID);
  });

  it('drops a needs_oauth_consent run whose contract carries no typed cause', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([runRow()]);
    cyberneticMocks.surfaceWorkflowResumeContract.mockResolvedValueOnce(surfaced(undefined));

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(0);
  });

  it('drops a run whose resume contract is unreadable', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([runRow()]);
    cyberneticMocks.surfaceWorkflowResumeContract.mockResolvedValueOnce(null);

    const items = await makeSource().listOpen(ctx());
    expect(items).toHaveLength(0);
  });

  it('labels an expired connection differently', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([runRow()]);
    cyberneticMocks.surfaceWorkflowResumeContract.mockResolvedValueOnce(
      surfaced({
        integrationKind: 'api',
        resourceKey: 'stripe',
        bindingId: 'binding-9',
        ownerScope: 'space',
        reason: 'expired',
      }),
    );

    const items = await makeSource().listOpen(ctx());
    const item = items[0]!;
    expect(item.extension?.kind).toBe('oauth_consent');
    expect(item.summary).toContain('expired');
  });
});

describe('workflowOAuthConsentSource — getById', () => {
  it('returns null for ids without the run-consent prefix', async () => {
    const item = await makeSource().getById(ctx(), `workflow-task:${RUN_ID}:approve`);
    expect(item).toBeNull();
    expect(withTenantSchema).not.toHaveBeenCalled();
  });

  it('returns the item when the run is still consent-paused', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([runRow()]);
    cyberneticMocks.surfaceWorkflowResumeContract.mockResolvedValueOnce(
      surfaced({
        integrationKind: 'mcp',
        resourceKey: 'gmail',
        bindingId: 'binding-1',
        ownerScope: 'user',
        reason: 'never_connected',
      }),
    );

    const item = await makeSource().getById(ctx(), `workflow-oauth-consent:${RUN_ID}`);
    expect(item?.id).toBe(`workflow-oauth-consent:${RUN_ID}`);
  });

  it('returns null when no consent-paused run matches', async () => {
    vi.mocked(withTenantSchema).mockResolvedValueOnce([]);
    const item = await makeSource().getById(ctx(), `workflow-oauth-consent:${RUN_ID}`);
    expect(item).toBeNull();
  });
});

describe('workflowOAuthConsentSource — resolve', () => {
  it('refuses resolution — consent is callback-driven', async () => {
    const src = makeSource();
    await expect(
      src.resolve(ctx(), {} as never, { kind: 'submit' } as never),
    ).rejects.toBeInstanceOf(ActionCenterResolveError);
    await expect(
      src.resolve(ctx(), {} as never, { kind: 'submit' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_RESOLUTION' });
  });
});
