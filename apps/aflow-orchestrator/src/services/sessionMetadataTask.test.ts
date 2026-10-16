/**
 * The space hears `entity.session.described` when a conversation's described
 * title or summary changed, and not for a pass that wrote back what it already
 * had — every event is a refetch of the conversation list in every window open
 * on the space.
 */
import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendEntityEvent: vi.fn(),
  applyGeneratedSessionMetadata: vi.fn(),
  readSessionMetadata: vi.fn(),
  generateSessionMetadata: vi.fn(),
}));

vi.mock('@aflow/redis', () => ({
  claimSessionMetadataCandidates: async () => [
    {
      tenantId: '00000000-0000-0000-0000-000000000001',
      sessionId: 'session-1',
      evidenceRevision: 3,
      leaseUntilMs: Date.now() + 60_000,
      attempts: 0,
    },
  ],
  getSessionState: async () => null,
  settleSessionMetadata: async () => undefined,
  sessionMetadataLeaseHeld: async () => true,
  appendEntityEvent: mocks.appendEntityEvent,
}));

vi.mock('@aflow/database', () => ({
  applyGeneratedSessionMetadata: mocks.applyGeneratedSessionMetadata,
  readSessionMetadata: mocks.readSessionMetadata,
  readSessionEvidence: async () => ({
    openingRequest: 'Find the missing Q3 invoices',
    exchanges: [{ speaker: 'user', text: 'Find the missing Q3 invoices', at: 1 }],
    complete: true,
  }),
  recordSessionMetadataDiagnostic: async () => undefined,
}));

vi.mock('@aflow/cybernetic-runtime', () => ({
  decideSessionMetadataWork: () => ({ title: true, summary: true }),
  generateSessionMetadata: mocks.generateSessionMetadata,
  loadSpaceDirectives: async () => null,
  loadTenantAgentModelAllowlist: async () => null,
  nextSessionTitleState: () => 'provisional',
  resolveClerkModel: () => ({
    resolved: true,
    modelRef: 'clerk',
    modelId: 'clerk-1',
    providerId: 'provider',
    mode: 'auto',
  }),
  SESSION_METADATA_MAX_TURNS: 20,
  SESSION_METADATA_PROMPT_VERSION: 'test',
}));

vi.mock('@aflow/credential-resolver', () => ({
  ByokCredentialError: class ByokCredentialError extends Error {},
  createByokAiClientFactory: () => ({ getClientForModel: async () => ({ client: {} }) }),
}));

const { createSessionMetadataTask } = await import('./sessionMetadataTask.js');

const DESCRIBED = { title: 'Missing Q3 invoices', summary: 'Tracing three unpaid invoices.' };

function stored(described: { title: string; summary: string }) {
  return {
    sessionId: 'session-1',
    spaceId: '00000000-0000-0000-0000-0000000000a1',
    createdBy: null,
    executionAuthority: null,
    status: 'COMPLETED',
    startedAt: new Date(0),
    lastActivityAt: new Date(0),
    title: described.title,
    titleState: 'provisional',
    manualTitle: null,
    summary: described.summary,
    summaryCoverage: 'full',
    metadataRevision: 1,
    metadataEvidenceRevision: 2,
    metadataUpdatedAt: new Date(0),
    metadataEditedBy: null,
    record: {},
  };
}

async function describeOnce(proposal: { title?: string; summary?: string }): Promise<void> {
  mocks.generateSessionMetadata.mockResolvedValue({
    proposal,
    promptTokens: 1,
    completionTokens: 1,
    costCents: undefined,
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const task = createSessionMetadataTask({
    redis: {} as Redis,
    db: {} as PostgresJsDatabase,
    logger,
  });
  await task.runOnce();
  expect(logger.warn).not.toHaveBeenCalled();
}

function describedEvents(): unknown[] {
  return mocks.appendEntityEvent.mock.calls.filter(
    ([, params]) =>
      (params as { event: { eventType: string } }).event.eventType === 'entity.session.described',
  );
}

describe('telling the space a conversation was described', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSessionMetadata.mockResolvedValue(stored(DESCRIBED));
    mocks.applyGeneratedSessionMetadata.mockResolvedValue(true);
  });

  it('stays silent when the pass describes the conversation as it already was', async () => {
    await describeOnce(DESCRIBED);

    expect(mocks.applyGeneratedSessionMetadata).toHaveBeenCalledTimes(1);
    expect(describedEvents()).toHaveLength(0);
  });

  it('stays silent when the pass proposes nothing', async () => {
    await describeOnce({});

    expect(describedEvents()).toHaveLength(0);
  });

  it('tells the space once when the title changed', async () => {
    await describeOnce({ ...DESCRIBED, title: 'Unpaid Q3 invoices' });

    expect(describedEvents()).toHaveLength(1);
  });

  it('tells the space once when the summary changed', async () => {
    await describeOnce({ ...DESCRIBED, summary: 'Two of three invoices found.' });

    expect(describedEvents()).toHaveLength(1);
  });

  it('stays silent when the write found no conversation to change', async () => {
    mocks.applyGeneratedSessionMetadata.mockResolvedValue(false);

    await describeOnce({ ...DESCRIBED, title: 'Unpaid Q3 invoices' });

    expect(describedEvents()).toHaveLength(0);
  });
});
