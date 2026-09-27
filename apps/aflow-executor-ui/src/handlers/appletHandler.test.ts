import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type {
  AppletDefinition,
  AppletInstance,
  AppletJournalEntry,
  AppletRoleBinding,
  AppletStateVersion,
  PayloadRef,
  TenantId,
  UiAppletActOutput,
  UiAppletGetOutput,
  UiAppletInstantiateOutput,
  UiAppletListOutput,
} from '@aflow/schemas';
import { AppletDefinitionSchema } from '@aflow/schemas';
import type {
  AppletArtifactResolution,
  AppletInstanceListItem,
  AppletPersistence,
  AppletPersistenceTx,
} from '@aflow/applet-runtime';
import { AppletHandler } from './appletHandler.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = randomUUID();
const OTHER_SPACE = randomUUID();
const SESSION = randomUUID();
const ARTIFACT_ID = randomUUID();
const VERSION_ID = randomUUID();
const DEFINITION_HASH = `sha256:${randomUUID()}`;

const definition: AppletDefinition = AppletDefinitionSchema.parse({
  appletKey: 'work-board',
  version: 1,
  name: 'Work Board',
  description: 'A shared work item',
  semanticDescription: 'A board people and the agent operate together',
  stateSchema: {
    type: 'object',
    properties: {
      budget: { type: 'number' },
      secret: { type: 'string' },
      title: { type: 'string' },
      cells: { type: 'object', additionalProperties: { type: 'string' } },
    },
    additionalProperties: false,
  },
  initialState: { budget: 0, secret: 'hidden', title: 'Q3 launch', cells: { a1: 'x' } },
  agentProjection: ['/budget', '/title'],
  attentionProjection: { title: '/title' },
  agentGrid: {
    mapPath: '/cells',
    rowLabels: ['1'],
    colLabels: ['a', 'b'],
    legend: 'x marks the spot',
  },
  situationProjection: ['/title', '/budget'],
  roles: [{ id: 'reviewer', description: 'Reviews the board' }],
  actions: [
    {
      name: 'set_budget',
      description: 'Set the budget',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }] },
    },
    {
      name: 'edit_freely',
      description: 'Edit freely',
      inputSchema: { type: 'object' },
      patch: 'actor_supplied',
    },
    {
      name: 'human_only_nudge',
      description: 'A view-only affordance',
      inputSchema: { type: 'object' },
      patch: { template: [{ op: 'replace', path: '/state/title', valueFrom: '/input/title' }] },
      audience: 'human',
    },
  ],
});

interface StoredInstance {
  instance: AppletInstance;
  state: Record<string, unknown>;
  stateVersion: number;
}

class FakeStore {
  instances = new Map<string, StoredInstance>();
  journal = new Map<string, AppletJournalEntry[]>();
  roleBindings = new Map<string, AppletRoleBinding[]>();
  // Monotonic clock: real writes never share a wall-clock ms the way a hot
  // test loop does, and updatedAt ordering is what list pagination sorts on.
  private clock = Date.now();
  private nextTs(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }
  artifactVersions = new Map<
    string,
    {
      artifactId: string;
      spaceId: string;
      isCurrent: boolean;
      definition: AppletDefinition | null;
      definitionHash: string | null;
    }
  >();

  persistence(): AppletPersistence {
    return { transact: (fn) => fn(this.txPort()) };
  }

  private entries(instanceId: string): AppletJournalEntry[] {
    const existing = this.journal.get(instanceId);
    if (existing) return existing;
    const created: AppletJournalEntry[] = [];
    this.journal.set(instanceId, created);
    return created;
  }

  private txPort(): AppletPersistenceTx {
    return {
      loadInstanceForUpdate: async (instanceId) => {
        const stored = this.instances.get(instanceId);
        if (!stored) return null;
        return {
          instance: structuredClone(stored.instance),
          definition,
          state: structuredClone(stored.state),
          stateVersion: stored.stateVersion as AppletStateVersion,
        };
      },
      getJournalEntry: async (instanceId, actionId) =>
        this.entries(instanceId).find((entry) => entry.receipt.actionId === actionId) ?? null,
      nextSeq: async (instanceId) => this.entries(instanceId).length + 1,
      writeSnapshot: async (instance, state) => {
        const stored = this.instances.get(instance.instanceId);
        if (!stored) throw new Error('no instance');
        stored.state = structuredClone(state);
        stored.stateVersion += 1;
        return stored.stateVersion as AppletStateVersion;
      },
      appendJournalEntry: async (entry) => {
        this.entries(entry.instanceId).push(structuredClone(entry));
      },
      touchInstance: async (instanceId, changes) => {
        const stored = this.instances.get(instanceId);
        if (!stored) return;
        stored.instance = {
          ...stored.instance,
          updatedAt: this.nextTs(),
          ...(changes?.status !== undefined ? { status: changes.status } : {}),
        };
      },
      listRoleBindings: async (instanceId) => this.roleBindings.get(instanceId) ?? [],
      resolveAppletArtifact: async (ref): Promise<AppletArtifactResolution> => {
        let versionId: string | undefined;
        if (ref.versionId !== undefined) {
          versionId = ref.versionId;
        } else if (ref.artifactId !== undefined) {
          for (const [id, version] of this.artifactVersions) {
            if (version.artifactId === ref.artifactId && version.isCurrent) versionId = id;
          }
        }
        const version = versionId !== undefined ? this.artifactVersions.get(versionId) : undefined;
        if (!version || version.spaceId !== ref.spaceId || versionId === undefined) {
          return { outcome: 'not_found' };
        }
        if (version.definition === null || version.definitionHash === null) {
          return { outcome: 'not_an_applet', artifactVersionId: versionId };
        }
        return {
          outcome: 'resolved',
          artifactId: version.artifactId,
          artifactVersionId: versionId,
          definition: version.definition,
          definitionHash: version.definitionHash,
        };
      },
      createInstance: async (seed) => {
        if (this.instances.has(seed.instance.instanceId)) throw new Error('duplicate instance');
        this.instances.set(seed.instance.instanceId, {
          instance: { ...structuredClone(seed.instance), updatedAt: this.nextTs() },
          state: structuredClone(seed.initialState),
          stateVersion: 1,
        });
        this.roleBindings.set(
          seed.instance.instanceId,
          seed.roleBindings.map((binding) => ({
            instanceId: seed.instance.instanceId,
            userId: binding.userId,
            roleId: binding.roleId,
            createdAt: new Date().toISOString(),
          })),
        );
        return 1 as AppletStateVersion;
      },
      listRecentReceipts: async (instanceId, limit) =>
        this.entries(instanceId)
          .map((entry) => entry.receipt)
          .slice(-limit),
      listInstances: async (query) => {
        const matching = [...this.instances.values()]
          .filter(
            (stored) =>
              stored.instance.spaceId === query.spaceId &&
              stored.instance.status === query.status &&
              (query.appletKey === undefined || stored.instance.appletKey === query.appletKey),
          )
          .sort((a, b) => b.instance.updatedAt.localeCompare(a.instance.updatedAt));
        const page = matching.slice(query.offset, query.offset + query.limit);
        const items: AppletInstanceListItem[] = page.map((stored) => {
          const receipts = this.entries(stored.instance.instanceId);
          const lastEntry = receipts[receipts.length - 1];
          return {
            instance: structuredClone(stored.instance),
            definition,
            state: structuredClone(stored.state),
            stateVersion: stored.stateVersion as AppletStateVersion,
            ...(lastEntry !== undefined ? { lastReceipt: structuredClone(lastEntry.receipt) } : {}),
          };
        });
        return { items, total: matching.length };
      },
    };
  }
}

function makeStore(): FakeStore {
  const store = new FakeStore();
  store.artifactVersions.set(VERSION_ID, {
    artifactId: ARTIFACT_ID,
    spaceId: SPACE,
    isCurrent: true,
    definition,
    definitionHash: DEFINITION_HASH,
  });
  return store;
}

interface CtxOptions {
  spaceId?: string | undefined;
  sessionId?: string;
}

function makeCtx(
  operationId: string,
  input: unknown,
  options?: CtxOptions,
): { ctx: ExecutorContext; readOutput: <T>() => T } {
  const writes: Array<{ kind: string; data: unknown }> = [];
  const ctx = {
    job: {
      inputRef: 'inline:input' as PayloadRef,
      ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    },
    tenantId: TENANT,
    spaceId: options && 'spaceId' in options ? options.spaceId : SPACE,
    runId: randomUUID(),
    stepExecutionId: randomUUID(),
    attempt: 1,
    operationId,
    readPayload: async () => input,
    writePayload: async (kind: string, data: unknown) => {
      writes.push({ kind, data });
      return `inline:${kind}` as PayloadRef;
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ExecutorContext;
  return {
    ctx,
    readOutput: <T>() => {
      const output = writes.find((write) => write.kind === 'output');
      if (!output) throw new Error('no output written');
      return output.data as T;
    },
  };
}

function makeHandler(store: FakeStore): AppletHandler {
  return new AppletHandler(() => store.persistence());
}

async function instantiate(
  store: FakeStore,
  options?: { roleBindings?: Array<{ userId: string; roleId: string }> },
): Promise<UiAppletInstantiateOutput> {
  const handler = makeHandler(store);
  const { ctx, readOutput } = makeCtx(
    'ui.applet.instantiate',
    {
      artifactId: ARTIFACT_ID,
      ...(options?.roleBindings ? { roleBindings: options.roleBindings } : {}),
    },
    { sessionId: SESSION },
  );
  const result = await handler.execute(ctx);
  expect(result.status).toBe('SUCCEEDED');
  return readOutput<UiAppletInstantiateOutput>();
}

describe('ui.applet.instantiate', () => {
  it('births initialState, pins the definition, and binds the originating session', async () => {
    const store = makeStore();
    const userId = randomUUID();
    const output = await instantiate(store, {
      roleBindings: [{ userId, roleId: 'reviewer' }],
    });

    expect(output.state).toEqual(definition.initialState);
    expect(output.stateVersion).toBe(1);
    expect(output.presentation).toEqual({
      mode: 'rendered_inline',
      substrate: 'applet',
      instanceId: output.instance.instanceId,
    });
    expect(output.instance.appletKey).toBe('work-board');
    expect(output.instance.definitionHash).toBe(DEFINITION_HASH);
    expect(output.instance.artifactVersionId).toBe(VERSION_ID);
    expect(output.instance.boundSessionId).toBe(SESSION);
    expect(output.instance.status).toBe('active');
    // The raw state doc's path never rides an op output — it would steer the
    // agent to read the doc through the memory tools instead of ui.applet.get.
    expect(output.instance).not.toHaveProperty('statePath');

    const stored = store.instances.get(output.instance.instanceId);
    expect(stored?.instance.statePath).toBe(`/applets/${output.instance.instanceId}.json`);
    expect(stored?.state).toEqual(definition.initialState);
    expect(store.roleBindings.get(output.instance.instanceId)).toEqual([
      expect.objectContaining({ userId, roleId: 'reviewer' }),
    ]);
  });

  it('leaves boundSessionId null for a job without a session', async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const { ctx, readOutput } = makeCtx('ui.applet.instantiate', { versionId: VERSION_ID });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    expect(readOutput<UiAppletInstantiateOutput>().instance.boundSessionId).toBeNull();
  });

  it('refuses a non-applet artifact version as a validation failure', async () => {
    const store = makeStore();
    store.artifactVersions.set(VERSION_ID, {
      artifactId: ARTIFACT_ID,
      spaceId: SPACE,
      isCurrent: true,
      definition: null,
      definitionHash: null,
    });
    const handler = makeHandler(store);
    const { ctx } = makeCtx('ui.applet.instantiate', { artifactId: ARTIFACT_ID });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('validation');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain('no applet definition');
  });

  it('reports an unknown artifact as not_found', async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const { ctx } = makeCtx('ui.applet.instantiate', { artifactId: randomUUID() });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('not_found');
  });

  it('refuses another space’s artifact as not_found', async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const { ctx } = makeCtx(
      'ui.applet.instantiate',
      { versionId: VERSION_ID },
      { spaceId: OTHER_SPACE },
    );
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('not_found');
  });

  it('publishes the draft first, then instantiates against the published version', async () => {
    const store = makeStore();
    const draftId = randomUUID();
    const publishDraft = vi
      .fn()
      .mockResolvedValue({ ok: true, artifactVersionId: VERSION_ID } as const);
    const handler = new AppletHandler(() => store.persistence(), undefined, publishDraft);
    const { ctx, readOutput } = makeCtx('ui.applet.instantiate', { draftId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    expect(publishDraft).toHaveBeenCalledWith(ctx, { spaceId: SPACE, draftId });
    expect(readOutput<UiAppletInstantiateOutput>().instance.artifactVersionId).toBe(VERSION_ID);
  });

  it('propagates a refused publish (definition-less draft) verbatim', async () => {
    const store = makeStore();
    const refusal = {
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Draft carries no applet definition — generate with applet: true',
        classification: 'validation',
        retryable: false,
        timestamp: new Date().toISOString(),
      },
    } as const;
    const publishDraft = vi.fn().mockResolvedValue(refusal);
    const handler = new AppletHandler(() => store.persistence(), undefined, publishDraft);
    const { ctx } = makeCtx('ui.applet.instantiate', { draftId: randomUUID() });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('validation');
    expect(result.error.message).toContain('no applet definition');
  });

  it('refuses drafts when no draft publisher is wired', async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const { ctx } = makeCtx('ui.applet.instantiate', { draftId: randomUUID() });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('internal');
    expect(result.error.retryable).toBe(false);
  });

  it('refuses an initialState that violates the stateSchema', async () => {
    const store = makeStore();
    const badDefinition = {
      ...definition,
      initialState: { budget: 'not-a-number' },
    } as AppletDefinition;
    store.artifactVersions.set(VERSION_ID, {
      artifactId: ARTIFACT_ID,
      spaceId: SPACE,
      isCurrent: true,
      definition: badDefinition,
      definitionHash: `sha256:${randomUUID()}`,
    });
    const handler = makeHandler(store);
    const { ctx } = makeCtx('ui.applet.instantiate', { artifactId: ARTIFACT_ID });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('validation');
    expect(result.error.message).toContain('initialState');
  });

  it('fails loud when the execution context carries no spaceId', async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const { ctx } = makeCtx(
      'ui.applet.instantiate',
      { artifactId: ARTIFACT_ID },
      { spaceId: undefined },
    );
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.message).toContain('spaceId');
  });
});

describe('ui.applet.get', () => {
  it('returns projected state, recent receipts, version, and the agent action surface', async () => {
    const store = makeStore();
    const { instance } = await instantiate(store);
    const handler = makeHandler(store);

    const actCtx = makeCtx('ui.applet.act', {
      instanceId: instance.instanceId,
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 40000 },
    });
    expect((await handler.execute(actCtx.ctx)).status).toBe('SUCCEEDED');

    const { ctx, readOutput } = makeCtx('ui.applet.get', { instanceId: instance.instanceId });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    const output = readOutput<UiAppletGetOutput>();

    expect(output.state).toEqual({ budget: 40000, title: 'Q3 launch' });
    expect(output.state).not.toHaveProperty('secret');
    expect(output.stateVersion).toBe(2);
    expect(output.recentReceipts).toHaveLength(1);
    expect(output.recentReceipts[0]?.name).toBe('set_budget');
    expect(output.availableActions).toEqual(['set_budget', 'edit_freely', 'raw_patch']);
    // The declared grid renders from FULL current state at read time.
    expect(output.gridView).toBe('  a b\n1 x .\nx marks the spot');
    // The declared situation pointers render as labeled lines in the read —
    // the cache-safe carrier of per-action facts (tail, never prompt prefix).
    expect(output.situation).toBe('title: Q3 launch\nbudget: 40000');
    expect(output.presentation).toEqual({
      mode: 'rendered_inline',
      substrate: 'applet',
      instanceId: instance.instanceId,
    });
  });

  it('reads a cross-space instance as not_found', async () => {
    const store = makeStore();
    const { instance } = await instantiate(store);
    const handler = makeHandler(store);
    const { ctx } = makeCtx(
      'ui.applet.get',
      { instanceId: instance.instanceId },
      { spaceId: OTHER_SPACE },
    );
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('not_found');
  });
});

describe('ui.applet.act', () => {
  it('applies a template action with a server-stamped agent actor', async () => {
    const store = makeStore();
    const { instance } = await instantiate(store);
    const handler = makeHandler(store);
    const { ctx, readOutput } = makeCtx('ui.applet.act', {
      instanceId: instance.instanceId,
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 12000 },
    });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('SUCCEEDED');
    const output = readOutput<UiAppletActOutput>();
    expect(output.stateVersion).toBe(2);
    // An agent act re-mounts the board at the tail so the user sees the move land.
    expect(output.presentation).toEqual({
      mode: 'rendered_inline',
      substrate: 'applet',
      instanceId: instance.instanceId,
    });
    // The post-apply grid rides the act output — the agent sees what its move produced.
    expect(output.gridView).toBe('  a b\n1 x .\nx marks the spot');
    expect(output.receipt.actor).toEqual({ kind: 'agent', agentRole: 'agent' });
    // The applied patch never rides agent-facing receipts — derivable, and the
    // heaviest field (twenty of them once blew the turn's summary budget).
    expect(output.receipt).not.toHaveProperty('patch');
    expect(store.instances.get(instance.instanceId)?.state).toEqual({
      budget: 12000,
      secret: 'hidden',
      title: 'Q3 launch',
      cells: { a1: 'x' },
    });
  });

  it('maps a stale actor-supplied baseVersion to a retryable conflict carrying the current version', async () => {
    const store = makeStore();
    const { instance } = await instantiate(store);
    const handler = makeHandler(store);

    const first = makeCtx('ui.applet.act', {
      instanceId: instance.instanceId,
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 1 },
    });
    expect((await handler.execute(first.ctx)).status).toBe('SUCCEEDED');

    const { ctx } = makeCtx('ui.applet.act', {
      instanceId: instance.instanceId,
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'edit_freely',
      input: {},
      proposedPatch: [{ op: 'replace', path: '/state/title', value: 'stale' }],
    });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('conflict');
    expect(result.error.retryable).toBe(true);
    expect(result.error.details).toEqual({ currentVersion: 2 });
  });

  it('maps a rejection to a non-retryable validation error carrying reason and availableActions', async () => {
    const store = makeStore();
    const { instance } = await instantiate(store);
    const handler = makeHandler(store);
    const { ctx } = makeCtx('ui.applet.act', {
      instanceId: instance.instanceId,
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'no_such_action',
      input: {},
    });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('validation');
    expect(result.error.retryable).toBe(false);
    expect(result.error.details?.['reason']).toBe('unknown_action');
    expect(result.error.details?.['availableActions']).toEqual([
      'set_budget',
      'edit_freely',
      'human_only_nudge',
      'raw_patch',
    ]);
  });

  it('acts on a cross-space instance as not_found', async () => {
    const store = makeStore();
    const { instance } = await instantiate(store);
    const handler = makeHandler(store);
    const { ctx } = makeCtx(
      'ui.applet.act',
      {
        instanceId: instance.instanceId,
        actionId: randomUUID(),
        baseVersion: 1,
        name: 'set_budget',
        input: { amount: 5 },
      },
      { spaceId: OTHER_SPACE },
    );
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('not_found');
  });
});

describe('ui.applet.list', () => {
  it('lists active instances with version, last receipt, attention, and pages by cursor', async () => {
    const store = makeStore();
    const first = await instantiate(store);
    const second = await instantiate(store);
    const handler = makeHandler(store);

    const actCtx = makeCtx('ui.applet.act', {
      instanceId: second.instance.instanceId,
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 7 },
    });
    expect((await handler.execute(actCtx.ctx)).status).toBe('SUCCEEDED');

    const page1 = makeCtx('ui.applet.list', { limit: 1 });
    const result1 = await handler.execute(page1.ctx);
    expect(result1.status).toBe('SUCCEEDED');
    const output1 = page1.readOutput<UiAppletListOutput>();
    expect(output1.total).toBe(2);
    expect(output1.instances).toHaveLength(1);
    expect(output1.nextCursor).toBe('1');
    expect(output1.instances[0]?.instanceId).toBe(second.instance.instanceId);
    expect(output1.instances[0]?.stateVersion).toBe(2);
    expect(output1.instances[0]?.lastReceipt?.name).toBe('set_budget');
    expect(output1.instances[0]?.attention).toEqual({ title: 'Q3 launch' });

    const page2 = makeCtx('ui.applet.list', { limit: 1, cursor: output1.nextCursor });
    const result2 = await handler.execute(page2.ctx);
    expect(result2.status).toBe('SUCCEEDED');
    const output2 = page2.readOutput<UiAppletListOutput>();
    expect(output2.instances[0]?.instanceId).toBe(first.instance.instanceId);
    expect(output2.instances[0]?.lastReceipt).toBeUndefined();
    expect(output2.nextCursor).toBeUndefined();
  });

  it('rejects a malformed cursor', async () => {
    const store = makeStore();
    const handler = makeHandler(store);
    const { ctx } = makeCtx('ui.applet.list', { cursor: 'not-a-number' });
    const result = await handler.execute(ctx);
    expect(result.status).toBe('FAILED');
    if (result.status !== 'FAILED') return;
    expect(result.error.classification).toBe('validation');
  });
});
