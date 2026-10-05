/**
 * The attention block reads whose a run is from the projected `sessions` row of
 * the conversation that drove it, and the block is cached per space until its
 * generation moves. So the projection that writes a conversation's end moves
 * it, after the row is written, as a run's own transition does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionHotState } from '@aflow/redis';

const TENANT = 'a0000000-0000-4000-8000-000000000743';
const SPACE = '5e1d0000-0000-4000-8000-000000000743';
const SESSION = 'c01d0000-0000-4000-8000-000000000743';

const hot = vi.hoisted(() => ({
  state: undefined as SessionHotState | undefined,
  /** What happened, in order: the sessions row written, the generation bumped. */
  log: [] as string[],
}));

vi.mock('@aflow/redis', async () => {
  const actual = await vi.importActual<typeof import('@aflow/redis')>('@aflow/redis');
  return {
    ...actual,
    claimProjectionCandidates: () =>
      Promise.resolve([
        { tenantId: TENANT, runId: SESSION, version: 1, leaseUntilMs: Date.now() + 30_000 },
      ]),
    getSessionStateSafe: () => Promise.resolve({ ok: true, state: hot.state }),
    readDurableEventEntries: () => Promise.resolve({ entries: [], lastId: '0', oldestId: null }),
    ackProjection: () => Promise.resolve(true),
    publishActionCenterWake: () => undefined,
    deleteRecoveryData: () => Promise.resolve(),
  };
});
vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  const chain = (result: unknown): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) =>
        key === 'then'
          ? (resolve: (value: unknown) => void) => resolve(result)
          : () => chain(result),
    });
  const tx = {
    insert: () => {
      hot.log.push('sessions row written');
      return chain([{ sessionId: SESSION }]);
    },
    select: () => chain([{ cursor: null, status: null }]),
    update: () => chain([]),
  };
  return {
    ...actual,
    withTenantSchema: (_db: unknown, _ctx: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
});
vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    bumpAttentionGeneration: (_redis: unknown, tenantId: string, spaceId: string) => {
      hot.log.push(`generation bumped for ${tenantId}:${spaceId}`);
      return Promise.resolve();
    },
  };
});
vi.mock('../hotStateSnapshot.js', () => ({ buildHotStateSnapshot: () => Promise.resolve(null) }));
vi.mock('../pauseNotificationRouter.js', () => ({
  routePauseNotifications: () => Promise.resolve(),
}));
vi.mock('../errorReportAssembly.js', () => ({ assembleErrorReport: () => Promise.resolve() }));

const { createProjectionWorker } = await import('../ProjectionWorker.js');

const HELMSMAN = { kind: 'platform-role', systemRole: 'cybernetic-helmsman' };
const RUNNER = { kind: 'platform-role', systemRole: 'cybernetic-runner' };

function session(target: object, status: string): SessionHotState {
  const now = Date.now();
  return {
    tenantId: TENANT,
    sessionId: SESSION,
    spaceId: SPACE,
    target,
    agentVersion: '1',
    status,
    createdAt: now,
    startedAt: now,
    lastUpdatedAt: now,
  } as unknown as SessionHotState;
}

async function project(state: SessionHotState): Promise<void> {
  hot.state = state;
  const worker = createProjectionWorker({ redis: {} as never, db: {} as never });
  const stats = await worker.runOnce();
  expect(stats.flushedCount).toBe(1);
}

beforeEach(() => {
  hot.log = [];
});

describe("a Helmsman conversation's end is an attention transition", () => {
  it.each(['SUCCEEDED', 'CANCELLED'])(
    'a conversation projected %s bumps its space’s attention generation once its row is written',
    async (status) => {
      await project(session(HELMSMAN, status));

      expect(hot.log).toEqual(['sessions row written', `generation bumped for ${TENANT}:${SPACE}`]);
    },
  );

  it('a FAILED conversation, which can be retried and keeps its runs, bumps nothing', async () => {
    await project(session(HELMSMAN, 'FAILED'));

    expect(hot.log).toEqual(['sessions row written']);
  });

  it('a session that is not a Helmsman conversation owns no runs, and its end bumps nothing', async () => {
    await project(session(RUNNER, 'SUCCEEDED'));

    expect(hot.log).toEqual(['sessions row written']);
  });
});
