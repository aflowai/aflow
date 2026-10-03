import type {
  ActionCenterAllowedAction,
  ActionCenterAudience,
  ActionCenterItem,
  ActionCenterItemKind,
  ActionCenterItemOrigin,
  ResolverPolicy,
} from '@aflow/schemas';
import { isResolverAllowed } from '@aflow/schemas';

export type SpaceRole = 'admin' | 'editor' | 'viewer';

/**
 * Actions inherent to each item kind. Filters out actions that aren't
 * even applicable (e.g. you can't `ratify` a `human_input` item).
 */
const KIND_ACTIONS: Record<ActionCenterItemKind, readonly ActionCenterAllowedAction[]> = {
  human_input: ['submit'],
  human_approval: ['approve', 'reject'],
  // Tenant ratifications take ratify / reject. `dismiss` is reserved for
  ratification: ['ratify', 'reject'],
  platform_issue: ['dismiss'],
  // Shown so it is known about. Stopping a trigger is a button on its own page.
  trigger_armed: [],
  coach_activity: [],
  // approve = join, reject = decline.
  session_invitation: ['approve', 'reject'],
  // The operator launches consent out-of-band (deep-link to the consent-start
  // endpoint / provider authorization URL); resume is callback-driven, so no
  // server-side resolution action is exposed beyond the launch affordance.
  needs_oauth_consent: ['connect'],
  // A gated write is approved or denied in place (Plan 253) — deny fails the
  // step, approve writes the grant and re-dispatches it.
  write_approval: ['approve', 'reject'],
  // approve = Done: the operator finished in the window. There is nothing to
  // refuse — a hand-off nobody finishes ends at its own deadline.
  browser_handoff: ['approve'],
};

/**
 * Kinds whose attention can be rerouted to a person. The operator-plane kinds
 * (proposals, platform issues, coach activity) answer to the operator as a
 * role, so there is nobody to route them to — and governance requests
 * (settings origin) answer to tenant admins the same way, which is why the
 * origin participates in the decision, not only the kind.
 */
const REASSIGNABLE_KINDS: ReadonlySet<ActionCenterItemKind> = new Set([
  'human_input',
  'human_approval',
  'write_approval',
  'needs_oauth_consent',
]);

/**
 * Who a request can be answered by, expressed as a property of the request
 * rather than of whoever happens to be reading it.
 *
 * A source states this once; the reader is applied later, at emit time. That
 * is what lets one stored item serve every subscriber in a space instead of
 * one copy per person. Anything a source knows about its own authority that
 * `kind` + `origin.type` + `resolverPolicy` cannot express belongs here.
 */
export type ActionCenterResolverAuthority =
  /** Anyone who can act in the space, narrowed by the item's own resolver policy. */
  | { kind: 'space' }
  /**
   * A tenant-wide grant. The space role is not enough: `candidateResolvers:
   * ['admin']` is compared against the *space* role, so a space admin would
   * otherwise be shown buttons the resolve path refuses.
   */
  | { kind: 'tenant_admin' }
  /** Only the person named on the request, whatever their space role. */
  | { kind: 'named_user'; userId: string }
  /** Answered on another surface. The card is a notification, not a control. */
  | { kind: 'view_only' };

/** Everything about the person reading that can change what they are shown. */
export interface ActionCenterReader {
  actorUserId: string;
  actorSpaceRole: SpaceRole;
  /**
   * True only for an active tenant-membership owner/admin. Space owners and
   * space admins resolve `actorSpaceRole: 'admin'` too, so a tenant-wide
   * authority must gate on this, never on the space role.
   */
  actorIsTenantAdmin: boolean;
}

/**
 * Resolve the actions a given reader may issue on a given item.
 */
export function computeAllowedActions(args: {
  itemKind: ActionCenterItemKind;
  originType?: ActionCenterItemOrigin['type'];
  resolverPolicy?: ResolverPolicy | undefined;
  authority: ActionCenterResolverAuthority;
  reader: ActionCenterReader;
}): ActionCenterAllowedAction[] {
  const { authority, reader } = args;
  if (authority.kind === 'view_only') return [];
  // The named person answers for themselves, so their space role does not
  // enter into it — a viewer who has been invited can still join or decline.
  if (authority.kind === 'named_user') {
    return authority.userId === reader.actorUserId ? [...KIND_ACTIONS[args.itemKind]] : [];
  }
  if (authority.kind === 'tenant_admin' && !reader.actorIsTenantAdmin) return [];

  // Viewers observe; editors steer.
  if (reader.actorSpaceRole === 'viewer') return [];

  const actions: ActionCenterAllowedAction[] = [];
  const allowed = isResolverAllowed(args.resolverPolicy, {
    actorUserId: reader.actorUserId,
    actorSpaceRole: reader.actorSpaceRole,
  });
  if (allowed) actions.push(...KIND_ACTIONS[args.itemKind]);
  // Routing attention is not resolving: anyone who can act in the space may
  // redirect who is being asked, even when the answer is not theirs to give.
  if (REASSIGNABLE_KINDS.has(args.itemKind) && args.originType !== 'settings') {
    actions.push('reassign');
  }
  return actions;
}

/**
 * Who this request is waiting on, answered for the person asking.
 *
 * The same item is `you` to the person named on it and `someone_else` to
 * everyone else in the space — which is what lets one pipeline serve a team
 * without every member being told to act on every request. Read from the
 * resolver policy the request already carries; nothing new is stored, and an
 * untargeted request stays `anyone`.
 */
export function computeAudience(args: {
  resolverPolicy?: ResolverPolicy | undefined;
  assignee?: string | undefined;
  actorUserId: string;
  actorSpaceRole: SpaceRole;
}): ActionCenterAudience {
  // An assignment narrows the audience below the resolver policy: the request
  // is being asked of the assignee, and a named approver who is not the
  // assignee reads it as someone else's until it comes back to them. Their
  // authority to answer is untouched — this only says whose desk it is on.
  if (args.assignee) return args.assignee === args.actorUserId ? 'you' : 'someone_else';
  const candidates = args.resolverPolicy?.candidateResolvers;
  if (!candidates || candidates.length === 0) return 'anyone';
  return candidates.includes(args.actorUserId) || candidates.includes(args.actorSpaceRole)
    ? 'you'
    : 'someone_else';
}

/** What a source produced plus the routing state, before any reader is applied. */
type ProjectableItem = Omit<ActionCenterItem, 'audience' | 'allowedActions'> & {
  resolverAuthority: ActionCenterResolverAuthority;
};

/**
 * The reader-facing item: what a source produced, plus what this person may do
 * with it and whose desk it looks like it is on.
 *
 * The only place a reader is applied to a request. Sources are reader-free by
 * type, so one item can be held once per space and projected per subscriber at
 * emit time; a second projection site would be a second answer to "may I press
 * this", and the client treats `allowedActions` as authorization.
 */
export function projectActionCenterItem(
  reader: ActionCenterReader,
  item: ProjectableItem,
): ActionCenterItem {
  // Destructured out rather than spread over: the authority is how the server
  // decides, not something a client is told.
  const { resolverAuthority, ...rest } = item;
  return {
    ...rest,
    allowedActions: computeAllowedActions({
      itemKind: item.kind,
      originType: item.origin.type,
      ...(item.resolverPolicy ? { resolverPolicy: item.resolverPolicy } : {}),
      authority: resolverAuthority,
      reader,
    }),
    audience: computeAudience({
      ...(item.resolverPolicy ? { resolverPolicy: item.resolverPolicy } : {}),
      ...(item.assignee ? { assignee: item.assignee } : {}),
      actorUserId: reader.actorUserId,
      actorSpaceRole: reader.actorSpaceRole,
    }),
  };
}

/**
 * Convenience: assert that a requested resolution kind is in the allowed
 * set. Throws when not — the caller turns the throw into a 403.
 */
export function assertResolutionAllowed(
  item: Pick<ActionCenterItem, 'kind' | 'resolverPolicy' | 'origin'> & {
    resolverAuthority: ActionCenterResolverAuthority;
  },
  resolutionKind: ActionCenterAllowedAction,
  reader: ActionCenterReader,
): void {
  const allowed = computeAllowedActions({
    itemKind: item.kind,
    originType: item.origin.type,
    ...(item.resolverPolicy ? { resolverPolicy: item.resolverPolicy } : {}),
    authority: item.resolverAuthority,
    reader,
  });
  if (!allowed.includes(resolutionKind)) {
    // A view-only card is refused for everyone, so "you are not authorised"
    // sends the caller looking for a permission that does not exist.
    if (item.resolverAuthority.kind === 'view_only') {
      throw new ActionCenterAuthzError(
        `A ${item.kind} item from this source is answered on its own surface, not through the Action Center.`,
      );
    }
    throw new ActionCenterAuthzError(
      `Actor ${reader.actorUserId} (role: ${reader.actorSpaceRole}) is not authorised to '${resolutionKind}' a ${item.kind} item.`,
    );
  }
}

export class ActionCenterAuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionCenterAuthzError';
  }
}
