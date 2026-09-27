/**
 * Session invitations as Action Center items — derived at list time from the
 * invitee's `session_participants` rows, no separate storage. `generation` is
 * the CAS token, so a re-invitation after a decline is a new item. Visible to
 * and resolvable by the invitee only: `approve` joins, `reject` declines,
 * with the words carried by uiHints.
 */
import {
  createTenantContext,
  getSessionParticipant,
  listPendingInvitesForUser,
  setParticipantStatus,
  upsertJoinedParticipant,
  withTenantSchema,
  type PendingInviteRow,
} from '@aflow/database';
import type { SessionId } from '@aflow/schemas';
import { resolveUserLabels, rosterUserLabel } from '@aflow/cybernetic-runtime';
import {
  ActionCenterResolveError,
  type ActionCenterContext,
  type ActionCenterResolveOutcome,
  type ActionCenterSource,
  type ActionCenterSourceDeps,
  type ActionCenterSourceItem,
} from '../types.js';
import { postRoomMessageDirect } from '../../sessionRoomPost.js';

const ITEM_ID_PREFIX = 'session-invite:';

function itemIdFor(sessionId: string, userId: string): string {
  return `${ITEM_ID_PREFIX}${sessionId}:${userId}`;
}

function parseItemId(itemId: string): { sessionId: string; userId: string } | null {
  if (!itemId.startsWith(ITEM_ID_PREFIX)) return null;
  const rest = itemId.slice(ITEM_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { sessionId: rest.slice(0, sep), userId: rest.slice(sep + 1) };
}

export function createSessionInvitationSource(deps: ActionCenterSourceDeps): ActionCenterSource {
  async function buildItem(
    ctx: ActionCenterContext,
    invite: PendingInviteRow,
    inviterLabel: string | undefined,
  ): Promise<ActionCenterSourceItem> {
    const invitedBy = invite.member.invitedBy;
    return {
      id: itemIdFor(invite.member.sessionId, invite.member.userId),
      spaceId: ctx.spaceId,
      kind: 'session_invitation',
      origin: {
        type: 'session_invitation',
        sessionId: invite.member.sessionId,
        inviteeUserId: invite.member.userId,
        generation: invite.member.generation,
      },
      title: 'Session invitation',
      summary: `${inviterLabel ?? 'A teammate'} invited you to join a session. Joining adds you to its roster — you can play or talk without composing a first message.`,
      uiHints: { approveLabel: 'Join', rejectLabel: 'Decline' },
      requestedAt: invite.member.invitedAt ?? invite.member.updatedAt,
      requestedBy: {
        kind: 'system',
        label: inviterLabel ?? 'Session invitation',
        sessionId: invite.member.sessionId,
        ...(invitedBy ? { userId: invitedBy } : {}),
      },
      priority: 'normal',
      relatesTo: [],
      resolverAuthority: { kind: 'named_user', userId: invite.member.userId },
      status: 'open',
    };
  }

  async function loadInvite(
    ctx: ActionCenterContext,
    sessionId: string,
    userId: string,
  ): Promise<PendingInviteRow | null> {
    const tenantCtx = createTenantContext(ctx.tenantId);
    const invites = await withTenantSchema(deps.db, tenantCtx, (tx) =>
      listPendingInvitesForUser(tx, userId),
    );
    const match = invites.find((invite) => invite.member.sessionId === sessionId);
    return match ?? null;
  }

  return {
    name: 'sessionInvitation',
    rowScope: 'actor',
    handlesOriginTypes: ['session_invitation'],

    async listOpen(ctx: ActionCenterContext): Promise<ActionCenterSourceItem[]> {
      const tenantCtx = createTenantContext(ctx.tenantId);
      const invites = await withTenantSchema(deps.db, tenantCtx, (tx) =>
        listPendingInvitesForUser(tx, ctx.actorUserId),
      );
      const inSpace = invites.filter((invite) => invite.spaceId === ctx.spaceId);
      if (inSpace.length === 0) return [];
      const labels = await resolveUserLabels(
        deps.db,
        inSpace.map((invite) => invite.member.invitedBy).filter((id): id is string => id !== null),
      );
      const items: ActionCenterSourceItem[] = [];
      for (const invite of inSpace) {
        items.push(
          await buildItem(
            ctx,
            invite,
            invite.member.invitedBy
              ? rosterUserLabel(labels.get(invite.member.invitedBy), invite.member.invitedBy)
              : undefined,
          ),
        );
      }
      return items;
    },

    async getById(ctx, itemId): Promise<ActionCenterSourceItem | null> {
      const parsed = parseItemId(itemId);
      if (!parsed) return null;
      // Invitee-only: someone else's invitation does not exist for this reader.
      if (parsed.userId !== ctx.actorUserId) return null;
      const invite = await loadInvite(ctx, parsed.sessionId, parsed.userId);
      if (invite?.spaceId !== ctx.spaceId) return null;
      const labels = invite.member.invitedBy
        ? await resolveUserLabels(deps.db, [invite.member.invitedBy])
        : new Map<string, string>();
      return buildItem(
        ctx,
        invite,
        invite.member.invitedBy
          ? rosterUserLabel(labels.get(invite.member.invitedBy), invite.member.invitedBy)
          : undefined,
      );
    },

    async resolve(ctx, item, resolution): Promise<ActionCenterResolveOutcome> {
      const origin = item.origin;
      if (origin.type !== 'session_invitation') {
        throw new ActionCenterResolveError('INVALID_RESOLUTION', 'Origin is not an invitation');
      }
      if (ctx.actorUserId !== origin.inviteeUserId) {
        throw new ActionCenterResolveError(
          'FORBIDDEN',
          'Only the invited person can answer an invitation',
        );
      }
      if (resolution.kind !== 'approve' && resolution.kind !== 'reject') {
        throw new ActionCenterResolveError(
          'INVALID_RESOLUTION',
          "An invitation takes 'approve' (join) or 'reject' (decline)",
        );
      }
      const tenantCtx = createTenantContext(ctx.tenantId);
      const current = await withTenantSchema(deps.db, tenantCtx, (tx) =>
        getSessionParticipant(tx, origin.sessionId, origin.inviteeUserId),
      );
      if (current?.status !== 'invited') {
        throw new ActionCenterResolveError('NOT_FOUND', 'This invitation is no longer pending');
      }
      if (current.generation !== origin.generation) {
        throw new ActionCenterResolveError(
          'STALE_ACTION_CENTER_ITEM',
          'This invitation was superseded — reload and answer the current one',
        );
      }

      if (resolution.kind === 'approve') {
        await withTenantSchema(deps.db, tenantCtx, (tx) =>
          upsertJoinedParticipant(tx, origin.sessionId, origin.inviteeUserId),
        );
        // The join is room news — humans see it in the transcript, the agent
        // reads it at its next boundary. Best-effort like every roster write.
        try {
          const labels = await resolveUserLabels(deps.db, [origin.inviteeUserId]);
          const joinedLabel = rosterUserLabel(
            labels.get(origin.inviteeUserId),
            origin.inviteeUserId,
          );
          await postRoomMessageDirect(deps.redis, deps.db, {
            tenantId: ctx.tenantId,
            sessionId: origin.sessionId as SessionId,
            actorUserId: origin.inviteeUserId,
            ...(joinedLabel !== undefined ? { actorDisplayName: joinedLabel } : {}),
            body: 'joined the session',
          });
        } catch {
          /* the roster row is the fact; the room line is a courtesy */
        }
        return {
          resolvedAt: new Date().toISOString(),
          dispatchedOperationId: 'session.participants.join',
        };
      }

      const declined = await withTenantSchema(deps.db, tenantCtx, (tx) =>
        setParticipantStatus(tx, {
          sessionId: origin.sessionId,
          userId: origin.inviteeUserId,
          from: ['invited'],
          to: 'declined',
        }),
      );
      if (!declined) {
        throw new ActionCenterResolveError('NOT_FOUND', 'This invitation is no longer pending');
      }
      return {
        resolvedAt: new Date().toISOString(),
        dispatchedOperationId: 'session.participants.decline',
      };
    },
  };
}
