import { BACKGROUND_TASK_MODES, type BackgroundTaskMode } from '@aflow/lib';
import { z } from 'zod';

/**
 * Services that may own background work. A task that cannot name its owning
 * service has no on-call story, so the enum is closed.
 */
export const BackgroundTaskServiceSchema = z.enum([
  'server',
  'orchestrator',
  'executor-ai',
  'executor-api',
  'executor-code',
  'executor-compute',
  'executor-host',
  'executor-mcp',
  'executor-memory',
  'executor-mock',
  'executor-ui',
  'executor-user',
  'mcp-server',
  'voice',
  'shared-runtime',
]);
export type BackgroundTaskService = z.infer<typeof BackgroundTaskServiceSchema>;

/**
 * `correctness` — the sole owner of a durable invariant; silent disablement loses work.
 * `operational` — improves visibility or recovery speed but loses no work when off.
 * `feature` — exists only because an optional feature is enabled.
 */
export const BackgroundTaskCriticalitySchema = z.enum(['correctness', 'operational', 'feature']);
export type BackgroundTaskCriticality = z.infer<typeof BackgroundTaskCriticalitySchema>;

/**
 * How the task learns that work exists. `candidate` is the level-triggered
 * default; `audit` is the bounded drift repair that must never serve live
 * latency.
 */
export const BackgroundTaskTriggerSchema = z.enum([
  'blocking',
  'event',
  'candidate',
  'audit',
  'heartbeat',
  'active-resource',
]);
export type BackgroundTaskTrigger = z.infer<typeof BackgroundTaskTriggerSchema>;

export const BackgroundTaskScopeSchema = z.enum([
  'per_instance',
  'singleton',
  'shard_owner',
  'active_subscription',
]);
export type BackgroundTaskScope = z.infer<typeof BackgroundTaskScopeSchema>;

export const BackgroundTaskSubstrateSchema = z.enum([
  'redis-stream',
  'redis-zset',
  'redis-lease',
  'redis-pubsub',
  'postgres-due',
  'local',
]);
export type BackgroundTaskSubstrate = z.infer<typeof BackgroundTaskSubstrateSchema>;

/**
 * `never` — a correctness task with no safe off state; needs break-glass plus an alert.
 * `breakglass` — may be disabled by an explicit operator flag that logs at error level.
 * `safe` — disabling degrades a feature only.
 */
export const BackgroundTaskDisablePolicySchema = z.enum(['never', 'breakglass', 'safe']);
export type BackgroundTaskDisablePolicy = z.infer<typeof BackgroundTaskDisablePolicySchema>;

/**
 * Budget for what a task's *producer* may add to a state transition. The
 * migration from scanning to candidate indexes is only safe if arming a marker
 * extends an existing transaction/Lua/pipeline instead of adding a round trip.
 */
export const BackgroundTaskHotPathProducerBudgetSchema = z.object({
  maxAdditionalNetworkRoundTrips: z.number().int().nonnegative(),
  description: z.string().min(1),
});
export type BackgroundTaskHotPathProducerBudget = z.infer<
  typeof BackgroundTaskHotPathProducerBudgetSchema
>;

/**
 * Discovery mechanisms banned as recurring schedulers. A registered task or a
 * named exception declares which ones its source actually uses, so attribution
 * is per (file, mechanism) — listing a file for its `setInterval` must not turn
 * that file into a blanket exemption for a keyspace scan added later.
 */
export const BackgroundDiscoveryRuleSchema = z.enum([
  'setInterval',
  /** A `setTimeout` that re-arms itself from inside the function it schedules. */
  'recursive-timer',
  /** A blocking `XREAD`/`XREADGROUP` loop. */
  'blocking-consumer',
  'redis-keys',
  'keyspace-scan',
  'full-set-read',
  'tenant-enumeration',
]);
export type BackgroundDiscoveryRule = z.infer<typeof BackgroundDiscoveryRuleSchema>;

/**
 * Occurrences are counted, not just named. Declaring only the mechanism would
 * let a second unrelated loop join a file that already has one and still pass.
 */
export const BackgroundDiscoveryClaimSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { rule: value, count: 1 } : value),
  z.object({
    rule: BackgroundDiscoveryRuleSchema,
    count: z.number().int().positive().default(1),
  }),
);
export type BackgroundDiscoveryClaim = z.infer<typeof BackgroundDiscoveryClaimSchema>;

/** A bare path is shorthand for a file that uses none of the banned mechanisms. */
export const BackgroundTaskSiteSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { path: value } : value),
  z.object({
    path: z.string().min(1),
    discovery: z.array(BackgroundDiscoveryClaimSchema).default([]),
  }),
);
export type BackgroundTaskSite = z.infer<typeof BackgroundTaskSiteSchema>;

export const BackgroundTaskDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  service: BackgroundTaskServiceSchema,
  ownerDomain: z.string().min(1),
  purpose: z.string().min(1),
  invariant: z.string().min(1),
  criticality: BackgroundTaskCriticalitySchema,
  trigger: BackgroundTaskTriggerSchema,
  scope: BackgroundTaskScopeSchema,
  substrate: BackgroundTaskSubstrateSchema,
  baseCadenceMs: z.number().int().positive().optional(),
  /**
   * A periodic datastore read that exists only because the task's event or
   * candidate path is incomplete. Recording it separately from `baseCadenceMs`
   * keeps "this is the cadence the work needs" distinct from "this is a poll we
   * still owe a deletion", and lets the final hardening gate assert the second
   * set is empty.
   */
  residualPollMs: z.number().int().positive().optional(),
  maxBatch: z.number().int().positive(),
  maxCycleMs: z.number().int().positive(),
  /**
   * Datastore operations this task issues per minute with zero due work. The
   * plan's central claim is that this number must not grow with shard, tenant,
   * key, or subscriber cardinality — so it is recorded per task and asserted.
   */
  idleOperationBudgetPerMinute: z.number().nonnegative(),
  hotPathProducerBudget: BackgroundTaskHotPathProducerBudgetSchema,
  /**
   * Environment variable whose falsy value takes the task out of service
   * because the feature it maintains is not running here. Read at resolve time
   * as an explicit opt-out — an unset gate is the feature being on, since a
   * gate that defaulted closed would silence a live invariant on every
   * deployment that had never heard of it.
   */
  featureGate: z.string().min(1).optional(),
  disablePolicy: BackgroundTaskDisablePolicySchema,
  recovery: z.string().min(1),
  /**
   * Repo-relative source files that implement the task. The CI drift guard
   * attributes every scanned interval/keyspace-discovery hit to a registered
   * task through this list, so an unregistered loop cannot be introduced
   * without either registering it or naming an explicit exception.
   */
  sites: z.array(BackgroundTaskSiteSchema).min(1),
  /**
   * Operator-facing note about how the task behaves today — a cost that is
   * proportional to something it should not be, a duplicated responsibility, a
   * known limitation. Roadmap belongs in the plan, not in the catalog.
   */
  note: z.string().min(1).optional(),
});

export type BackgroundTaskDefinition = z.infer<typeof BackgroundTaskDefinitionSchema>;
/** Authoring shape: `sites` accepts a bare path string. */
export type BackgroundTaskDefinitionInput = z.input<typeof BackgroundTaskDefinitionSchema>;

/**
 * `observe` runs the task's discovery and comparison but suppresses its side
 * effects — the rollout control for candidate migrations.
 *
 * Built from the runner's own tuple so an operator can never name a mode the
 * runner has not implemented.
 */
export const BackgroundTaskModeSchema = z.enum(BACKGROUND_TASK_MODES);
export type { BackgroundTaskMode };

export const BackgroundTaskOverrideSchema = z.object({
  mode: BackgroundTaskModeSchema,
  reason: z.string().min(1).optional(),
});
export type BackgroundTaskOverride = z.infer<typeof BackgroundTaskOverrideSchema>;

export const BackgroundTaskOverrideMapSchema = z.record(z.string(), BackgroundTaskOverrideSchema);
export type BackgroundTaskOverrideMap = z.infer<typeof BackgroundTaskOverrideMapSchema>;

/**
 * A named, bounded exception to the keyspace-discovery ban: migrations,
 * operator-triggered repair, and corrupt-state salvage. Every exception has an
 * owner and an explicit bound so the allowlist cannot quietly become the
 * architecture.
 */
export const BackgroundScanExceptionSchema = z.object({
  site: z.string().min(1),
  discovery: z.array(BackgroundDiscoveryClaimSchema).min(1),
  owner: z.string().min(1),
  reason: z.string().min(1),
  bound: z.string().min(1),
});
export type BackgroundScanException = z.infer<typeof BackgroundScanExceptionSchema>;
/** Authoring shape: `discovery` accepts a bare rule name for a single occurrence. */
export type BackgroundScanExceptionInput = z.input<typeof BackgroundScanExceptionSchema>;
