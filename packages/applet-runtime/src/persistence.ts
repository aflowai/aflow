/**
 * The gateway's storage dependency. One transaction spans the instance row
 * lock, the snapshot write and the journal append — the row lock is what
 * serializes concurrent writers, so every method here operates on the same
 * transaction handle the lock was taken on.
 */
import type {
  AppletActionReceipt,
  AppletDefinition,
  AppletEffectDeliveryOutcome,
  AppletInstance,
  AppletInstanceStatus,
  AppletJournalEntry,
  AppletRelayedEffectKind,
  AppletRoleBinding,
  AppletStateVersion,
} from '@aflow/schemas';

/** Everything the gateway needs about an instance, loaded under the row lock. */
export interface AppletInstanceRecord {
  instance: AppletInstance;
  /** The pinned definition, colocated with the artifact version. */
  definition: AppletDefinition;
  /** The current state body (unwrapped — the stored doc is a `{ state }` wrapper). */
  state: Record<string, unknown>;
  stateVersion: AppletStateVersion;
}

/** An applet-bearing artifact version resolved for instantiation. */
export type AppletArtifactResolution =
  | {
      outcome: 'resolved';
      artifactId: string;
      artifactVersionId: string;
      definition: AppletDefinition;
      /** Platform-computed hash pinned on the version row alongside the definition. */
      definitionHash: string;
    }
  | { outcome: 'not_found' }
  | { outcome: 'not_an_applet'; artifactVersionId: string }
  | { outcome: 'definition_invalid'; artifactVersionId: string; message: string };

export interface AppletRoleBindingSeed {
  userId: string;
  roleId: string;
}

/** Everything instantiation persists in one transaction — ids minted by the caller. */
export interface AppletInstanceSeed {
  instance: AppletInstance;
  initialState: Record<string, unknown>;
  roleBindings: AppletRoleBindingSeed[];
}

export interface AppletInstanceQuery {
  spaceId: string;
  status: AppletInstanceStatus;
  appletKey?: string;
  limit: number;
  offset: number;
}

export interface AppletInstanceListItem extends AppletInstanceRecord {
  lastReceipt?: AppletActionReceipt;
}

export interface AppletInstanceListResult {
  items: AppletInstanceListItem[];
  total: number;
}

/** One owed effect on one journal row, marked delivered by the post-commit relay. */
export interface AppletEffectDeliveryMark {
  instanceId: string;
  actionId: string;
  effect: AppletRelayedEffectKind;
  outcome: AppletEffectDeliveryOutcome;
  deliveredAt: string;
  /** Record a failed attempt: bump attempts, keep the effect pending; outcome ignored. */
  attemptOnly?: boolean;
}

/** Transaction-scoped operations — valid only inside the `transact` callback. */
export interface AppletPersistenceTx {
  /**
   * Load instance + definition + state, taking `SELECT ... FOR UPDATE` on the
   * instance row. Returns null when no such instance exists.
   */
  loadInstanceForUpdate(instanceId: string): Promise<AppletInstanceRecord | null>;
  /** Journal lookup by the idempotency key `(instanceId, actionId)`. */
  getJournalEntry(instanceId: string, actionId: string): Promise<AppletJournalEntry | null>;
  /** Next instance-scoped journal sequence — gap-free under the row lock. */
  nextSeq(instanceId: string): Promise<number>;
  /** Overwrite the state snapshot; returns the version the store assigned. */
  writeSnapshot(
    instance: AppletInstance,
    state: Record<string, unknown>,
  ): Promise<AppletStateVersion>;
  appendJournalEntry(entry: AppletJournalEntry): Promise<void>;
  /** Bump `updatedAt`; optionally flip lifecycle status (the `ends` flag). */
  touchInstance(instanceId: string, changes?: { status?: AppletInstanceStatus }): Promise<void>;
  /**
   * Move the instance's pin to another version of the same artifact, recording
   * where it came from. Only the upgrade gate calls this — after validating
   * the current state against the target definition's stateSchema.
   */
  repinInstance(
    instanceId: string,
    pin: {
      definitionHash: string;
      artifactVersionId: string;
      upgradedFromVersionId: string;
      upgradedAt: string;
    },
  ): Promise<void>;
  listRoleBindings(instanceId: string): Promise<AppletRoleBinding[]>;
  /**
   * Resolve the applet definition pinned on an artifact version — by exact
   * version, or by an artifact's current published version. Space-scoped:
   * another space's artifact resolves as not_found.
   */
  resolveAppletArtifact(ref: {
    spaceId: string;
    artifactId?: string;
    versionId?: string;
  }): Promise<AppletArtifactResolution>;
  /**
   * Birth an instance: instance row, role bindings, and the initial `{ state }`
   * doc (writeMode 'create') in this transaction. Returns the birthed version.
   */
  createInstance(seed: AppletInstanceSeed): Promise<AppletStateVersion>;
  /** The journal tail — up to `limit` most recent receipts, any order. */
  listRecentReceipts(instanceId: string, limit: number): Promise<AppletActionReceipt[]>;
  /** Space-scoped listing, most recently touched first. */
  listInstances(query: AppletInstanceQuery): Promise<AppletInstanceListResult>;
  /** Plain instance read, no lock — for post-commit consumers of the outbox. */
  getInstance(instanceId: string): Promise<AppletInstance | null>;
  /**
   * Journal rows still owing effect deliveries, ascending seq — the outbox
   * backlog the relay drains before (and including) a fresh action's effects.
   */
  listPendingEffects(instanceId: string): Promise<AppletJournalEntry[]>;
  /**
   * Flip one owed effect to delivered. Runs outside the action transaction by
   * design: a crash between commit and mark re-drives the effect later, and
   * every destination is idempotent on actionId.
   */
  markEffectDelivered(mark: AppletEffectDeliveryMark): Promise<void>;
}

export interface AppletPersistence {
  /**
   * Run `fn` inside one database transaction. A throw rolls back everything —
   * snapshot, journal and instance row commit or vanish together.
   */
  transact<T>(fn: (tx: AppletPersistenceTx) => Promise<T>): Promise<T>;
}
