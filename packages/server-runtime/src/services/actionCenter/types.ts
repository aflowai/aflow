import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type {
  ActionCenterItem,
  ActionCenterItemOrigin,
  ActionCenterResolution,
  PostInstallTask,
  TenantId,
} from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';
import type { ActionCenterReader, ActionCenterResolverAuthority } from './authz.js';
import type { AuditEventInput } from '../../plugins/audit.js';

/** Structural slice of the audit plugin the sources record through. */
export interface ActionCenterAuditRecorder {
  record(event: AuditEventInput): void;
}

/**
 * Dependencies common to every source adapter. The aggregator wires these
 * once at startup; sources only see the deps they need.
 */
export interface ActionCenterSourceDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
  audit?: ActionCenterAuditRecorder;
}

/**
 * Which tenant + space is being read. Everything a space-scoped source is
 * allowed to know: no reader, so its rows are the same for everyone watching
 * and one read can serve them all.
 */
export interface ActionCenterScope {
  tenantId: TenantId;
  spaceId: string;
}

/**
 * Per-call context: which tenant + space we're acting on, and who is
 * asking. Resolvers need `actorUserId` to authorise and to stamp the
 * audit row.
 */
export interface ActionCenterContext extends ActionCenterScope, ActionCenterReader {
  /** Auth method from the caller's token — audit attribution only. */
  actorAuthMethod?: string;
  /**
   * Whether the request resolving was authenticated as an interactive user
   * (`isInteractiveUser`): a resolve that resumes a run counts as a person
   * setting it going only then. Absent reads as not.
   */
  actorIsInteractiveUser?: boolean;
}

/**
 * Outcome of a successful source-level resolve. Carries the same audit
 * data the aggregator stamps onto `hitl_action_audit`. Errors are
 * thrown — the aggregator converts known failure modes into the
 * structured `ActionCenterResolutionError` field on the item.
 */
export interface ActionCenterResolveOutcome {
  /** ISO 8601 timestamp the source recorded the resolution at. */
  resolvedAt: string;
  /** The op the underlying source dispatched (e.g. `workflow.run.resume`, `proposal.ratify`). */
  dispatchedOperationId: string;
  /**
   * When the resolved item gates a downstream op (gate steps especially),
   * this is the gated op id — used to enrich audit + UI. Falls back to
   * `dispatchedOperationId` when N/A.
   */
  reportedOperationId?: string;
  /** Post-install setup tasks (store_install ratification) — surfaced to the resolving operator. */
  setupChecklist?: PostInstallTask[];
}

/**
 * Structured failures from a source resolve. The aggregator converts
 * these into `ActionCenterResolutionError` on the item and an HTTP
 * status — STALE → 409, NOT_FOUND → 404, FORBIDDEN → 403, others 500.
 */
export class ActionCenterResolveError extends Error {
  constructor(
    public readonly code:
      | 'STALE_ACTION_CENTER_ITEM'
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'INVALID_RESOLUTION'
      | 'RATIFICATION_APPLY_FAILED'
      | 'DISPATCH_FAILED',
    message: string,
    public readonly severity: 'transient' | 'stale_target' | 'permanent' = 'permanent',
    public readonly detail?: string,
    /**
     * For STALE_ACTION_CENTER_ITEM, the freshly-read item so the client
     * can re-render without an extra round-trip.
     */
    public readonly latestItem?: ActionCenterSourceItem,
  ) {
    super(message);
    this.name = 'ActionCenterResolveError';
  }
}

/**
 * A request plus the routing state the decision plane owns, and nothing about
 * whoever is reading it. `audience` and `allowedActions` are not properties of
 * the request — the same paused step is "yours" with buttons to the person
 * named on it and "someone else's" without them to everyone watching — so both
 * are stamped once per reader by `projectActionCenterItem` and no source can
 * bake in an answer for one person that another then inherits.
 */
export type ActionCenterPooledItem = Omit<ActionCenterItem, 'audience' | 'allowedActions'> & {
  resolverAuthority: ActionCenterResolverAuthority;
};

/** What a source produces. `assignee` is injected by the aggregator. */
export type ActionCenterSourceItem = Omit<ActionCenterPooledItem, 'assignee'>;

interface ActionCenterSourceCommon {
  /** Stable identifier for debug/logging (e.g. 'pausedStep', 'coachProposal'). */
  readonly name: string;

  /**
   * The origin discriminator(s) this source handles. The aggregator
   * dispatches get/resolve to the source whose set contains `origin.type`.
   */
  readonly handlesOriginTypes: ReadonlyArray<ActionCenterItemOrigin['type']>;

  /**
   * Load a specific item by id. Returns null when the id doesn't belong
   * to this source's universe (the aggregator probes each source).
   */
  getById(ctx: ActionCenterContext, itemId: string): Promise<ActionCenterSourceItem | null>;

  /**
   * Apply a resolution. Throws `ActionCenterResolveError` on CAS mismatch,
   * dispatch failure, or invalid resolution. The aggregator catches and
   * converts to the appropriate HTTP response.
   *
   * Implementations MUST:
   *   1. Re-load the item state from the source (not from the projection).
   *   2. Verify the CAS token on `origin` matches the source's current state.
   *   3. Authorise the resolution kind against the actor's role.
   *   4. Dispatch to the underlying op (workflow.run.resume / proposal.ratify / …).
   *   5. Return the outcome so the aggregator can write the audit row.
   */
  resolve(
    ctx: ActionCenterContext,
    item: ActionCenterSourceItem,
    resolution: ActionCenterResolution,
  ): Promise<ActionCenterResolveOutcome>;
}

/**
 * Rows belong to the space. `listOpen` is handed a scope and not a reader, so
 * one read can be held once and served to every subscriber watching.
 */
export interface SpaceScopedActionCenterSource extends ActionCenterSourceCommon {
  readonly rowScope: 'space';
  listOpen(scope: ActionCenterScope): Promise<ActionCenterSourceItem[]>;
}

/**
 * The row set itself is the reader's own. Pooling it would mean holding one
 * person's rows and filtering them for everybody else, trading "cannot be
 * returned" for "is checked before being returned" on who has been invited
 * where. These are read per reader instead.
 */
export interface ActorScopedActionCenterSource extends ActionCenterSourceCommon {
  readonly rowScope: 'actor';
  listOpen(ctx: ActionCenterContext): Promise<ActionCenterSourceItem[]>;
}

/**
 * Contract every source implements. Sources are stateless — the
 * aggregator holds them and passes scope or ctx per call.
 */
export type ActionCenterSource = SpaceScopedActionCenterSource | ActorScopedActionCenterSource;
