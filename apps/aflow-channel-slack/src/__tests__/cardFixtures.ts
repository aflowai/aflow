/**
 * Fakes for the card tests: an item builder, a Slack that records what the bot
 * posted and edited, and an API that answers as the Action Center routes do.
 */
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  ActionCenterItemSchema,
  type ActionCenterItem,
  type ActionCenterResolution,
} from '@aflow/schemas';

import type { AflowApi, ObservedOrigin, ResolvedItem, RouteRefusal } from '../aflowApi.js';
import type { ChannelMessageSendHandler } from '../sendHandler.js';
import type { PostOptions, SlackBlock, SlackClient } from '../slack.js';
import type { ChannelStore } from '../store.js';

export const TENANT = 'tenant-1';
export const OWNER = 'owner-1';
export const OPERATOR = 'U-OPERATOR';
export const SPACE = '7b0c3c52-3f4e-4a43-9a43-0d5e8d7c1a01';
export const WORKFLOW_RUN = 'c5d5bb0f-77a4-4c1b-a0f6-6a9a7d0f4b22';

export const STEP_ORIGIN = {
  type: 'step',
  runId: 'session-1',
  stepExecutionId: 'step-exec-1',
  sessionId: 'session-1',
  pauseVersion: 0,
  operationId: 'user.interaction.approve',
} as const;

/** A valid item, checked against the schema the API answers with. */
export function makeItem(overrides: Record<string, unknown> = {}): ActionCenterItem {
  return ActionCenterItemSchema.parse({
    id: 'step:step-exec-1',
    spaceId: SPACE,
    kind: 'human_approval',
    origin: STEP_ORIGIN,
    title: 'Ship the release',
    summary: 'The release skill waits on your approval.',
    requestedAt: '2026-11-01T08:00:00.000Z',
    requestedBy: { kind: 'agent', label: 'Agent' },
    allowedActions: ['approve', 'reject', 'submit', 'reassign'],
    status: 'open',
    ...overrides,
  });
}

/** A medium-tier API write approval from a workflow run's paused task, with its preview. */
export function writeApproval(tier: 'low' | 'medium' | 'high' = 'medium'): ActionCenterItem {
  return makeItem({
    id: `wf-write:${WORKFLOW_RUN}:task-push`,
    kind: 'write_approval',
    origin: { type: 'workflow_task', runId: WORKFLOW_RUN, taskId: 'task-push', pauseVersion: 0 },
    title: 'Approve write: Create the release',
    summary: 'A skill wants to call POST api.github.com (github/createRelease).',
    extension: {
      kind: 'write_approval',
      target: 'api',
      apiId: 'github',
      endpointId: 'createRelease',
      endpointName: 'Create a release',
      method: 'POST',
      urlHost: 'api.github.com',
      writeRiskTier: tier,
      bodyPreview: '{"tag_name":"v1.4.0","token":"[redacted]"}',
    },
  });
}

export interface Post {
  channel: string;
  text: string;
  blocks?: readonly SlackBlock[];
  threadTs?: string;
}

export interface RecordingSlack extends SlackClient {
  posts: Post[];
  updates: Array<{ channel: string; ts: string; text: string; blocks: readonly SlackBlock[] }>;
}

export function recordingSlack(): RecordingSlack {
  const slack: RecordingSlack = {
    posts: [],
    updates: [],
    openDirectMessage: (userId) => Promise.resolve(`D-${userId}`),
    postMessage: (channel: string, text: string, options: PostOptions = {}) => {
      slack.posts.push({
        channel,
        text,
        ...(options.blocks === undefined ? {} : { blocks: options.blocks }),
        ...(options.threadTs === undefined ? {} : { threadTs: options.threadTs }),
      });
      return Promise.resolve({ channel, ts: `1700000000.00${String(slack.posts.length)}` });
    },
    updateMessage: (channel, ts, text, blocks) => {
      slack.updates.push({ channel, ts, text, blocks });
      return Promise.resolve();
    },
    openSocketModeUrl: () => Promise.resolve('wss://example.invalid'),
  };
  return slack;
}

export interface FakeApi extends AflowApi {
  items: Map<string, ActionCenterItem>;
  reads: Array<{ spaceId: string; itemId: string; signal?: AbortSignal }>;
  resolves: Array<{ itemId: string; origin: ObservedOrigin; resolution: ActionCenterResolution }>;
  /** Answers the next resolve with this instead of the route's rules. */
  nextAnswer?: RouteRefusal;
}

/**
 * The routes' rules that matter to a card: a read in the space, and a resolve
 * that compares the origin and answers a decided item 409.
 */
export function fakeApi(...items: ActionCenterItem[]): FakeApi {
  const api: FakeApi = {
    items: new Map(items.map((item) => [item.id, item])),
    reads: [],
    resolves: [],
    readItem: (spaceId, itemId, signal) => {
      api.reads.push({ spaceId, itemId, ...(signal === undefined ? {} : { signal }) });
      const item = api.items.get(itemId);
      if (item === undefined || item.spaceId !== spaceId) {
        return Promise.resolve({
          ok: false,
          status: 404,
          error: 'NOT_FOUND',
          message: `Action Center item ${itemId} not found.`,
          retryable: false,
          outcomeUnknown: false,
        });
      }
      return Promise.resolve({ ok: true, item, origin: item.origin as ObservedOrigin });
    },
    resolveItem: (spaceId, itemId, origin, resolution) => {
      api.resolves.push({ itemId, origin, resolution });
      const answer = api.nextAnswer;
      if (answer !== undefined) {
        delete api.nextAnswer;
        return Promise.resolve(answer);
      }
      const item = api.items.get(itemId);
      if (item === undefined || item.spaceId !== spaceId) {
        return Promise.resolve({
          ok: false,
          status: 404,
          error: 'NOT_FOUND',
          message: `Action Center item ${itemId} not found.`,
          retryable: false,
          outcomeUnknown: false,
        });
      }
      if (item.status !== 'open' || JSON.stringify(item.origin) !== JSON.stringify(origin)) {
        return Promise.resolve({
          ok: false,
          status: 409,
          error: 'STALE_ACTION_CENTER_ITEM',
          message: `Origin CAS mismatch for ${itemId} — reload before resolving.`,
          retryable: false,
          outcomeUnknown: false,
          latestItem: item,
        });
      }
      const resolved: ActionCenterItem = {
        ...item,
        status: 'resolved',
        resolution,
        resolvedBy: OWNER,
        origin: { ...item.origin, pauseVersion: 1 } as ActionCenterItem['origin'],
      };
      api.items.set(itemId, resolved);
      const answered: ResolvedItem = { ok: true, item: resolved };
      return Promise.resolve(answered);
    },
    // A card test holds no conversation; `conversationFixtures.ts` serves those routes.
    homeSpace: () => Promise.reject(new Error('no conversation in a card test')),
    startConversation: () => Promise.reject(new Error('no conversation in a card test')),
    resumeConversation: () => Promise.reject(new Error('no conversation in a card test')),
    latestEvents: () => Promise.reject(new Error('no conversation in a card test')),
  };
  return api;
}

export function linkOperator(store: ChannelStore): void {
  store.linkWithCode('a'.repeat(64), {
    slackUserId: OPERATOR,
    aflowUserId: OWNER,
    tenantId: TENANT,
    linkedAt: '2026-11-01T08:00:00.000Z',
  });
}

/** One `channel.message.send` step in the operator's run, in the space. */
export async function sendStep(
  handler: ChannelMessageSendHandler,
  input: unknown,
  scope: { executionId?: string; spaceId?: string | null; signal?: AbortSignal } = {},
): Promise<{ result: StepResult; written: unknown }> {
  let written: unknown;
  const ctx = {
    tenantId: TENANT,
    ...(scope.spaceId === null ? {} : { spaceId: scope.spaceId ?? SPACE }),
    runId: 'run-1',
    stepExecutionId: 'step-attempt',
    logicalExecutionId: scope.executionId ?? 'exec-1',
    attempt: 1,
    signal: scope.signal ?? new AbortController().signal,
    job: {
      operationId: 'channel.message.send',
      inputRef: 'inline:input',
      credentialOwnerId: OWNER,
    },
    readPayload: () => Promise.resolve(input),
    writePayload: (_kind: string, data: unknown) => {
      written = data;
      return Promise.resolve('inline:output');
    },
  } as unknown as ExecutorContext;
  return { result: await handler.execute(ctx), written };
}

export function errorOf(result: StepResult): { code: string; retryable: boolean; message: string } {
  if (result.status !== 'FAILED') throw new Error(`expected a failure, got ${result.status}`);
  return result.error;
}

/** Every button on a message's blocks. */
export function buttonsOf(blocks: readonly SlackBlock[] | undefined): string[] {
  return (blocks ?? [])
    .filter((block) => block['type'] === 'actions')
    .flatMap((block) => block['elements'] as Array<{ action_id: string }>)
    .map((element) => element.action_id);
}

/** All the text a message's blocks show, joined. */
export function textOf(blocks: readonly SlackBlock[] | undefined): string {
  return JSON.stringify(blocks ?? []);
}
