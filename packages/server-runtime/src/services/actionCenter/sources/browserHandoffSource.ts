/**
 * Browser hand-offs waiting on the operator (Plan 320 D8, §3.6 step 4).
 *
 * A run's page is shown in a browser window on the operator's machine while the
 * step that asked waits there. The host executor reaches only Redis, so the
 * item is read from the record it keeps for as long as some run waits — one per
 * profile and site, through the space's index, never the keyspace — and is gone
 * when the last wait ends, however it ends.
 *
 * **Done** is the item's one answer. It reaches each waiting step on its own
 * channel and ends the wait as `completed`; the executor then takes the record
 * down. This is the only publisher of that channel: no operation names it, so
 * no agent can end a hand-off for the operator.
 */
import { createHash } from 'node:crypto';

import {
  type BrowserHandoffRecord,
  leaveBrowserHandoff,
  readSpaceBrowserHandoffs,
} from '@aflow/redis';
import {
  BROWSER_PAGE_HANDOFF_OPERATION_ID,
  type BrowserHandoffOrigin,
  type BrowserHandoffReason,
  StreamKeys,
} from '@aflow/schemas';

import {
  ActionCenterResolveError,
  type ActionCenterResolveOutcome,
  type ActionCenterScope,
  type ActionCenterSource,
  type ActionCenterSourceDeps,
  type ActionCenterSourceItem,
} from '../types.js';

const ITEM_ID_PREFIX = 'browser_handoff:';
const MAX_WAITING_SHOWN = 50;
const SUMMARY_MAX = 2_000;

const TITLE: Record<BrowserHandoffReason, (site: string) => string> = {
  sign_in: (site) => `Sign in to ${site}`,
  challenge: (site) => `Pass the check on ${site}`,
  confirm: (site) => `Confirm a step on ${site}`,
};

/** Short and stable: the record's key can be longer than an item id may be. */
export function browserHandoffItemId(recordKey: string): string {
  return `${ITEM_ID_PREFIX}${createHash('sha256').update(recordKey).digest('hex').slice(0, 32)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toItem(record: BrowserHandoffRecord, scope: ActionCenterScope): ActionCenterSourceItem {
  const waiting = record.waiting.slice(0, MAX_WAITING_SHOWN);
  const origin: BrowserHandoffOrigin = {
    type: 'browser_handoff',
    spaceId: scope.spaceId,
    hostname: record.hostname,
    profileId: record.profileId,
    site: record.site,
    reason: record.reason,
    message: truncate(record.message, 8_000),
    startedAt: record.startedAt,
    waiting: waiting.map((waiter) => ({
      runId: waiter.runId,
      stepExecutionId: waiter.stepExecutionId,
      ...(waiter.sessionId !== undefined ? { sessionId: waiter.sessionId } : {}),
    })),
  };
  const lastDeadline = waiting.reduce(
    (latest, waiter) => (waiter.deadlineAt > latest ? waiter.deadlineAt : latest),
    record.startedAt,
  );
  return {
    id: browserHandoffItemId(record.key),
    spaceId: scope.spaceId,
    kind: 'browser_handoff',
    origin,
    title: TITLE[record.reason](record.site),
    summary: truncate(record.message, SUMMARY_MAX),
    uiHints: { approveLabel: 'Done' },
    requestedAt: record.startedAt,
    expiresAt: lastDeadline,
    requestedBy: {
      kind: 'agent',
      label: `Browser on ${record.hostname}`,
      ...(waiting[0]?.sessionId !== undefined ? { sessionId: waiting[0].sessionId } : {}),
    },
    priority: 'normal',
    relatesTo: [],
    resolverAuthority: { kind: 'space' },
    status: 'open',
  };
}

export function createBrowserHandoffSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  const read = async (scope: ActionCenterScope): Promise<BrowserHandoffRecord[]> =>
    await readSpaceBrowserHandoffs(deps.redis, scope.tenantId, scope.spaceId);

  return {
    name: 'browserHandoff',
    rowScope: 'space',
    handlesOriginTypes: ['browser_handoff'],

    async listOpen(scope) {
      return (await read(scope)).map((record) => toItem(record, scope));
    },

    async getById(ctx, itemId) {
      if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
      const record = (await read(ctx)).find((open) => browserHandoffItemId(open.key) === itemId);
      return record === undefined ? null : toItem(record, ctx);
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      if (resolution.kind !== 'approve') {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          `A browser hand-off is answered with Done only; got '${resolution.kind}'.`,
        );
      }
      const record = (await read(ctx)).find((open) => browserHandoffItemId(open.key) === item.id);
      if (record === undefined) {
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          'This hand-off has already ended.',
          'stale_target',
        );
      }
      const message = JSON.stringify({ resolvedBy: ctx.actorUserId });
      for (const waiter of record.waiting) {
        const heard = await deps.redis.publish(
          StreamKeys.browserHandoffDoneChannel(waiter.stepExecutionId),
          message,
        );
        // Nobody listening means the executor that held this wait is gone, and
        // with it the wait; without this its line would stand until it expired.
        if (heard === 0) {
          await leaveBrowserHandoff(deps.redis, {
            key: record.key,
            hostname: record.hostname,
            tenantId: waiter.tenantId,
            spaceId: waiter.spaceId,
            stepExecutionId: waiter.stepExecutionId,
          });
        }
      }
      return {
        resolvedAt: new Date().toISOString(),
        dispatchedOperationId: BROWSER_PAGE_HANDOFF_OPERATION_ID,
      };
    },
  };
}
