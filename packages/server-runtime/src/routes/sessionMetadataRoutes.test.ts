/**
 * PATCH /v1/sessions/:sessionId/metadata tells the space about a rename
 * whenever what a window holds of the name changed — its text, summary,
 * revision, source or editor — and only then: every `entity.session.described`
 * is a refetch of the conversation list in every window open on the space.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const mocks = vi.hoisted(() => ({
  appendEntityEvent: vi.fn(),
  readSessionMetadata: vi.fn(),
  setManualSessionTitle: vi.fn(),
}));

vi.mock('@aflow/redis', () => ({
  appendEntityEvent: mocks.appendEntityEvent,
  requestSessionMetadataNow: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  markSessionTitleRefreshable: vi.fn(),
  readSessionMetadata: mocks.readSessionMetadata,
  setManualSessionTitle: mocks.setManualSessionTitle,
}));

vi.mock('../lib/sessionSpaceAccess.js', () => ({
  assertSessionSpaceAccess: async () => true,
  resolveSessionSpaceId: async () => ({ found: true, spaceId: SPACE_ID }),
}));

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';
const USER_ID = '00000000-0000-4000-8000-0000000000bb';

const { registerSessionMetadataRoutes } = await import('./sessionMetadataRoutes.js');

function stored(names: {
  title: string | null;
  manualTitle: string | null;
  revision?: number;
  editedBy?: string | null;
}) {
  return {
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    createdBy: null,
    executionAuthority: null,
    status: 'COMPLETED',
    startedAt: new Date(0),
    lastActivityAt: new Date(0),
    title: names.title,
    titleState: 'established',
    manualTitle: names.manualTitle,
    summary: 'Tracing three unpaid invoices.',
    summaryCoverage: 'full',
    metadataRevision: names.revision ?? 1,
    metadataEvidenceRevision: 1,
    metadataUpdatedAt: new Date(0),
    metadataEditedBy: names.editedBy ?? null,
    record: {},
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: {}, redis: {} };
  app.addHook('onRequest', async (request: FastifyRequest) => {
    (request as unknown as { requireTenant: () => Promise<{ tenantId: string }> }).requireTenant =
      async () => ({ tenantId: TENANT_ID });
    (request as unknown as { authUser: unknown }).authUser = { userId: USER_ID };
  });
  await app.register(
    async (instance) => {
      registerSessionMetadataRoutes(instance);
    },
    { prefix: '/v1/sessions' },
  );
  await app.ready();
  return app;
}

async function rename(
  before: ReturnType<typeof stored>,
  after: ReturnType<typeof stored>,
  title: string | null,
): Promise<number> {
  mocks.readSessionMetadata.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
  const app = await buildTestApp();
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/sessions/${SESSION_ID}/metadata`,
    payload: { title },
  });
  await app.close();
  return res.statusCode;
}

describe('renaming a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setManualSessionTitle.mockResolvedValue({ ok: true, revision: 2 });
  });

  it('tells the space when the name it reads changed', async () => {
    const status = await rename(
      stored({ title: 'Missing Q3 invoices', manualTitle: null }),
      stored({ title: 'Missing Q3 invoices', manualTitle: 'Q3 chase' }),
      'Q3 chase',
    );

    expect(status).toBe(200);
    expect(mocks.appendEntityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendEntityEvent.mock.calls[0]?.[1]).toMatchObject({
      spaceId: SPACE_ID,
      event: { eventType: 'entity.session.described', causedBySessionId: SESSION_ID },
    });
  });

  it('tells the space when a rename to the same text moved the revision', async () => {
    const status = await rename(
      stored({
        title: 'Missing Q3 invoices',
        manualTitle: 'Q3 chase',
        revision: 1,
        editedBy: USER_ID,
      }),
      stored({
        title: 'Missing Q3 invoices',
        manualTitle: 'Q3 chase',
        revision: 2,
        editedBy: USER_ID,
      }),
      'Q3 chase',
    );

    expect(status).toBe(200);
    expect(mocks.appendEntityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendEntityEvent.mock.calls[0]?.[1]).toMatchObject({
      spaceId: SPACE_ID,
      event: { eventType: 'entity.session.described', causedBySessionId: SESSION_ID },
    });
  });

  it('tells the space when the same text passes from the automatic name to a person', async () => {
    const status = await rename(
      stored({ title: 'Q3 chase', manualTitle: null }),
      stored({ title: 'Q3 chase', manualTitle: 'Q3 chase', editedBy: USER_ID }),
      'Q3 chase',
    );

    expect(status).toBe(200);
    expect(mocks.appendEntityEvent).toHaveBeenCalledTimes(1);
  });

  it('stays silent when nothing a window holds of the name changed', async () => {
    const status = await rename(
      stored({ title: 'Missing Q3 invoices', manualTitle: 'Q3 chase', editedBy: USER_ID }),
      stored({ title: 'Missing Q3 invoices', manualTitle: 'Q3 chase', editedBy: USER_ID }),
      'Q3 chase',
    );

    expect(status).toBe(200);
    expect(mocks.appendEntityEvent).not.toHaveBeenCalled();
  });
});
