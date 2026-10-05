import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppletDefinitionSchema,
  type AppletActionReceipt,
  type AppletDefinition,
  type AppletInstanceStatus,
} from '@aflow/schemas';
import type { AppletInstanceListItem } from '@aflow/applet-runtime';
import {
  deriveActiveAppletSummaries,
  renderAttentionContext,
  type ActiveAppletSummary,
  type HelmsmanAttentionContext,
} from '../attentionBuilder.js';

const SPACE = randomUUID();
const KARIM_ID = randomUUID();
/** A conversation that has taken up no part of the plan. */
const COLD = { sessionId: randomUUID(), planRootIds: [] };

function makeDefinition(opts: { appletKey?: string; withProjection?: boolean }): AppletDefinition {
  return AppletDefinitionSchema.parse({
    appletKey: opts.appletKey ?? 'chess',
    version: 1,
    name: 'Chess',
    description: 'A two-player game',
    semanticDescription: 'A two-player chess game people and the agent play together',
    stateSchema: { type: 'object' },
    initialState: {},
    actions: [
      {
        name: 'move',
        description: 'Make a move',
        inputSchema: { type: 'object' },
        patch: 'actor_supplied',
      },
    ],
    ...(opts.withProjection === true
      ? { attentionProjection: { title: '/title', status: '/phase', waitingOn: '/turn' } }
      : {}),
  });
}

function makeReceipt(over: Partial<AppletActionReceipt> = {}): AppletActionReceipt {
  return {
    actionId: randomUUID(),
    seq: 1,
    actor: { kind: 'user', userId: KARIM_ID },
    name: 'move',
    input: {},
    beforeVersion: 1,
    afterVersion: 2,
    patch: [],
    effects: { notable: false, waking: false, ending: false },
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
    ...over,
  };
}

function makeItem(opts: {
  appletKey?: string;
  status?: AppletInstanceStatus;
  withProjection?: boolean;
  state?: Record<string, unknown>;
  lastReceipt?: AppletActionReceipt;
}): AppletInstanceListItem {
  const instanceId = randomUUID();
  const now = new Date().toISOString();
  return {
    instance: {
      instanceId,
      spaceId: SPACE,
      appletKey: opts.appletKey ?? 'chess',
      definitionHash: 'sha256:test',
      artifactVersionId: randomUUID(),
      statePath: `/applets/${instanceId}.json`,
      status: opts.status ?? 'active',
      boundSessionId: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    },
    definition: makeDefinition({
      ...(opts.appletKey !== undefined ? { appletKey: opts.appletKey } : {}),
      ...(opts.withProjection !== undefined ? { withProjection: opts.withProjection } : {}),
    }),
    state: opts.state ?? {},
    stateVersion: 7,
    ...(opts.lastReceipt !== undefined ? { lastReceipt: opts.lastReceipt } : {}),
  };
}

function contextWith(applets: ActiveAppletSummary[], total: number): HelmsmanAttentionContext {
  return {
    activeWorkflowRuns: [],
    ...(applets.length > 0 ? { activeApplets: applets, activeAppletsTotal: total } : {}),
    pendingProposals: 0,
    pendingPlatformIssues: 0,
    pendingAnomalies: 0,
    pendingPatternFlags: 0,
  };
}

describe('deriveActiveAppletSummaries', () => {
  it('caps at 8 and the renderer emits the overflow pointer at ui.applet.list', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ appletKey: `board-${String(i)}` }),
    );
    const summaries = deriveActiveAppletSummaries(items, new Map());
    expect(summaries).toHaveLength(8);

    const text = renderAttentionContext(contextWith(summaries, 10), COLD);
    expect(text).toContain('Active applets:');
    expect(text).toContain('... and 2 more — use `ui.applet.list`');
  });

  it('never surfaces ended or archived instances', () => {
    const ended = makeItem({ appletKey: 'finished-game', status: 'ended' });
    const archived = makeItem({ appletKey: 'old-game', status: 'archived' });
    const active = makeItem({ appletKey: 'live-game' });
    const summaries = deriveActiveAppletSummaries([ended, active, archived], new Map());

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.appletKey).toBe('live-game');

    const text = renderAttentionContext(contextWith(summaries, 1), COLD);
    expect(text).not.toContain(ended.instance.instanceId);
    expect(text).not.toContain(archived.instance.instanceId);
    expect(text).toContain(active.instance.instanceId);
  });

  it('renders slow-moving identity only — per-action facts must never ride the cached prefix', () => {
    const item = makeItem({
      withProjection: true,
      state: { title: 'Karim vs Sara', turn: 'Sara', phase: 'midgame' },
      lastReceipt: makeReceipt(),
    });
    const summaries = deriveActiveAppletSummaries([item], new Map([[KARIM_ID, 'Karim']]));
    expect(summaries[0]!.attention).toEqual({
      title: 'Karim vs Sara',
      status: 'midgame',
      waitingOn: 'Sara',
    });

    const text = renderAttentionContext(contextWith(summaries, 1), COLD);
    expect(text).toContain('- chess "Karim vs Sara" (active, midgame)');
    expect(text).toContain(`[instanceId: ${item.instance.instanceId}]`);
    // waitingOn, version, and time-ago change every action (time-ago every
    // TURN) — the line renders into the cached prompt prefix, so they ride
    // ui.applet.get results instead.
    expect(text).not.toContain('waiting:');
    expect(text).not.toContain('ago');
    expect(text).not.toContain('v7');
  });

  it('renders the generic line — name and lifecycle status — when no projection is declared', () => {
    const item = makeItem({
      appletKey: 'work-board',
      state: { title: 'ignored without a projection' },
      lastReceipt: makeReceipt({
        name: 'set_budget',
        actor: { kind: 'agent', agentRole: 'helmsman' },
      }),
    });
    const summaries = deriveActiveAppletSummaries([item], new Map());
    expect(summaries[0]!.attention).toBeUndefined();

    const text = renderAttentionContext(contextWith(summaries, 1), COLD);
    expect(text).toContain('- work-board (active) — read with `ui.applet.get`');
    expect(text).not.toContain('ignored without a projection');
  });

  it('falls back to the raw user id when no label resolves, and to "no actions yet" without receipts', () => {
    const unlabeled = makeItem({ lastReceipt: makeReceipt() });
    const untouched = makeItem({ appletKey: 'fresh-board' });
    const summaries = deriveActiveAppletSummaries([unlabeled, untouched], new Map());

    expect(summaries[0]!.lastAction!.actorDisplay).toBe(KARIM_ID);
    expect(summaries[1]!.lastAction).toBeUndefined();

    const text = renderAttentionContext(contextWith(summaries, 2), COLD);
    expect(text).toContain('- fresh-board (active) — read with `ui.applet.get`');
  });
});
