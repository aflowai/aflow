import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  resolveConnectionForRepoCoordinate,
  RepoConnectionResolveError,
  findUnpinnedGithubApiTasks,
  resolveConnectionGrantsToBinding,
} from '../repoConnection.js';
import type { WorkflowTask, IntegrationCapabilityGrant } from '@aflow/schemas';

// Table markers double as the `.from(table)` selector + the column refs the
// `eq()` predicates carry. The fake tx runs `select(...).from(table).where(pred)`
// and returns the seeded rows for that table that satisfy the predicate.
const markers = vi.hoisted(() => ({
  repoBindings: {
    __t: 'repo_bindings',
    coordinate: 'coordinate',
    spaceId: 'spaceId',
    connectionBindingId: 'connectionBindingId',
  },
  apiBindings: {
    __t: 'api_bindings',
    bindingId: 'bindingId',
    spaceId: 'spaceId',
    apiId: 'apiId',
    enabled: 'enabled',
  },
}));

interface Store {
  designations: Record<string, unknown>[];
  connections: Record<string, unknown>[];
}
let store: Store;

interface Predicate {
  kind: string;
  column?: unknown;
  value?: unknown;
  args?: Predicate[];
}

const SPACE = '00000000-0000-0000-0000-0000000000aa';

function matchesPredicate(row: Record<string, unknown>, pred: Predicate | undefined): boolean {
  if (!pred) return true;
  if (pred.kind === 'and') return (pred.args ?? []).every((p) => matchesPredicate(row, p));
  if (pred.kind === 'eq') {
    if (pred.column === 'spaceId') return pred.value === SPACE;
    return row[pred.column as string] === pred.value;
  }
  return true;
}

function rowsFor(table: unknown, predicate: Predicate): unknown[] {
  const source =
    table === markers.repoBindings
      ? store.designations
      : table === markers.apiBindings
        ? store.connections
        : [];
  return source.filter((row) => matchesPredicate(row, predicate));
}

function makeFakeTx() {
  return {
    select: (_shape?: unknown) => ({
      from: (table: unknown) => ({
        where: (predicate: Predicate) => Promise.resolve(rowsFor(table, predicate)),
      }),
    }),
  };
}

vi.mock('@aflow/database', () => ({
  createTenantContext: (tenantId: string) => ({ tenantId }),
  withTenantSchema: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeFakeTx()),
  repoBindings: markers.repoBindings,
  apiBindings: markers.apiBindings,
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ kind: 'and', args }),
  eq: (column: unknown, value: unknown) => ({ kind: 'eq', column, value }),
}));

const FAKE_DB = {} as PostgresJsDatabase;
const TENANT = '00000000-0000-0000-0000-000000000001';

function designation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coordinate: 'github.com/acme/repo',
    spaceId: SPACE,
    connectionBindingId: 'github-default',
    status: 'ready',
    ...over,
  };
}

function connection(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bindingId: 'github-default',
    spaceId: SPACE,
    apiId: 'github',
    enabled: 1,
    ...over,
  };
}

describe('resolveConnectionForRepoCoordinate (Plan 222 P3c)', () => {
  beforeEach(() => {
    store = { designations: [], connections: [] };
  });

  it('returns the connection bindingId for an enabled github connection', async () => {
    store.designations = [designation()];
    store.connections = [connection()];

    await expect(
      resolveConnectionForRepoCoordinate(FAKE_DB, TENANT, SPACE, 'acme/repo'),
    ).resolves.toBe('github-default');
  });

  it('CONNECTION_MISSING when the coordinate has no designation', async () => {
    store.connections = [connection()];

    const err = await resolveConnectionForRepoCoordinate(FAKE_DB, TENANT, SPACE, 'acme/repo').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoConnectionResolveError);
    expect((err as RepoConnectionResolveError).code).toBe('CONNECTION_MISSING');
  });

  it('CONNECTION_MISSING when the designation references an absent connection', async () => {
    store.designations = [designation({ connectionBindingId: 'gone' })];
    store.connections = [connection()];

    const err = await resolveConnectionForRepoCoordinate(FAKE_DB, TENANT, SPACE, 'acme/repo').catch(
      (e: unknown) => e,
    );
    expect((err as RepoConnectionResolveError).code).toBe('CONNECTION_MISSING');
  });

  it('CONNECTION_INVALID when the connection is not github', async () => {
    store.designations = [designation()];
    store.connections = [connection({ apiId: 'gitlab' })];

    const err = await resolveConnectionForRepoCoordinate(FAKE_DB, TENANT, SPACE, 'acme/repo').catch(
      (e: unknown) => e,
    );
    expect((err as RepoConnectionResolveError).code).toBe('CONNECTION_INVALID');
  });

  it('CONNECTION_INVALID when the connection is disabled', async () => {
    store.designations = [designation()];
    store.connections = [connection({ enabled: 0 })];

    const err = await resolveConnectionForRepoCoordinate(FAKE_DB, TENANT, SPACE, 'acme/repo').catch(
      (e: unknown) => e,
    );
    expect((err as RepoConnectionResolveError).code).toBe('CONNECTION_INVALID');
  });

  it('CONNECTION_INVALID when the designation is not ready (matches the executor git resolver)', async () => {
    store.designations = [designation({ status: 'provisioning' })];
    store.connections = [connection()];

    const err = await resolveConnectionForRepoCoordinate(FAKE_DB, TENANT, SPACE, 'acme/repo').catch(
      (e: unknown) => e,
    );
    expect((err as RepoConnectionResolveError).code).toBe('CONNECTION_INVALID');
    expect((err as Error).message).toMatch(/not ready/i);
  });

  it('CONNECTION_MISSING for an unparseable coordinate (no connection resolvable)', async () => {
    const err = await resolveConnectionForRepoCoordinate(
      FAKE_DB,
      TENANT,
      SPACE,
      'not a coordinate!!',
    ).catch((e: unknown) => e);
    expect((err as RepoConnectionResolveError).code).toBe('CONNECTION_MISSING');
  });
});

describe('findUnpinnedGithubApiTasks (Plan 222 P3d drift detector)', () => {
  const githubTask = (extra: Record<string, unknown>): WorkflowTask =>
    ({
      taskId: 'merge',
      type: 'operation',
      operation: 'api.http.call',
      ...extra,
    }) as unknown as WorkflowTask;

  it('flags a github api task with no bindingId $bind', () => {
    const task = githubTask({ inputTemplate: { apiId: 'github', endpointId: 'm', params: {} } });
    expect(findUnpinnedGithubApiTasks([task])).toEqual(['merge']);
  });

  it('flags a github api task whose template $binds but has no connection_binding inputBinding', () => {
    const task = githubTask({
      inputTemplate: { apiId: 'github', bindingId: { $bind: 'gh' }, params: {} },
    });
    expect(findUnpinnedGithubApiTasks([task])).toEqual(['merge']);
  });

  it('passes a fully converted github task (connection_binding + $bind)', () => {
    const task = githubTask({
      inputBindings: { gh: { kind: 'connection_binding' } },
      inputTemplate: { apiId: 'github', bindingId: { $bind: 'gh' }, params: {} },
    });
    expect(findUnpinnedGithubApiTasks([task])).toEqual([]);
  });

  it('flags a github task whose bindingId $binds a NON-connection input (stray connection_binding elsewhere)', () => {
    // bindingId $binds `owner` (a task_output), NOT the connection_binding input —
    // the api executor would scope-resolve the bindingId at dispatch. A stray,
    // unrelated connection_binding input must not mask that.
    const task = githubTask({
      inputBindings: {
        owner: { kind: 'task_output' },
        stray: { kind: 'connection_binding' },
      },
      inputTemplate: { apiId: 'github', bindingId: { $bind: 'owner' }, params: {} },
    });
    expect(findUnpinnedGithubApiTasks([task])).toEqual(['merge']);
  });

  it('ignores non-github api tasks and non-api.http.call tasks', () => {
    const kaggle = githubTask({ inputTemplate: { apiId: 'kaggle', params: {} } });
    const agent = {
      taskId: 'rehydrate',
      type: 'agent',
    } as unknown as WorkflowTask;
    expect(findUnpinnedGithubApiTasks([kaggle, agent])).toEqual([]);
  });
});

describe('resolveConnectionGrantsToBinding (connection-deferred agent grant)', () => {
  const grant = (over: Partial<IntegrationCapabilityGrant>): IntegrationCapabilityGrant =>
    ({
      capabilityId: 'github',
      binding: { kind: 'connection' },
      sourceKind: 'api',
      integrationId: 'github',
      toolNames: [{ toolName: 'getPullRequest' }],
      allTools: false,
      ...over,
    }) as IntegrationCapabilityGrant;

  it('resolves a connection-deferred api grant to the pinned binding (capabilityId untouched)', () => {
    const out = resolveConnectionGrantsToBinding([grant({})], 'conn-xyz');
    expect(out[0]!.binding).toEqual({ kind: 'binding', bindingId: 'conn-xyz' });
    expect(out[0]!.capabilityId).toBe('github');
    expect(out[0]!.toolNames).toEqual([{ toolName: 'getPullRequest' }]);
  });

  it('resolves any apiId connection grant — not just github (apiId-agnostic)', () => {
    const out = resolveConnectionGrantsToBinding(
      [grant({ integrationId: 'gitlab', capabilityId: 'gitlab' })],
      'conn-xyz',
    );
    expect(out[0]!.binding).toEqual({ kind: 'binding', bindingId: 'conn-xyz' });
  });

  it('leaves a concrete {kind:binding} grant untouched', () => {
    const fixed = grant({ binding: { kind: 'binding', bindingId: 'kaggle-1' } });
    const out = resolveConnectionGrantsToBinding([fixed], 'conn-xyz');
    expect(out[0]!.binding).toEqual({ kind: 'binding', bindingId: 'kaggle-1' });
  });

  it('returns a NEW array — never mutates the shared grant objects', () => {
    const input = [grant({})];
    const out = resolveConnectionGrantsToBinding(input, 'conn-xyz');
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
    expect(input[0]!.binding).toEqual({ kind: 'connection' });
  });
});
