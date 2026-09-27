import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  type CompiledGuardrailSet,
  type CompiledRail,
  type GuardrailTrigger,
  type GuardrailPolicy,
  type GuardrailRail,
  type GuardrailScope,
  type TenantId,
  StreamKeys,
  z,
} from '@aflow/schemas';
import { createTenantContext, withTenantSchema, guardrailPolicies } from '@aflow/database';

const CACHE_TTL_SECONDS = 300; // 5 minutes

const EMPTY_TRIGGERS: CompiledGuardrailSet['byTrigger'] = {
  on_run_input: [],
  on_agent_turn_input: [],
  on_agent_turn_output: [],
  on_tool_input: [],
  on_tool_output: [],
  on_run_output: [],
  on_user_message: [],
};

const TRIGGER_KEYS = Object.keys(EMPTY_TRIGGERS) as GuardrailTrigger[];

// ── Scope precedence (lower = broader = lower priority) ──────────────────────

function scopePrecedence(scope: GuardrailScope): number {
  if (scope.platform) return 0;
  if (scope.tenantIds && scope.tenantIds.length > 0) return 1;
  if (scope.spaceIds && scope.spaceIds.length > 0) return 2;
  if (scope.flowIds && scope.flowIds.length > 0) return 3;
  if (scope.stepIds && scope.stepIds.length > 0) return 4;
  if (scope.operationIds && scope.operationIds.length > 0) return 5;
  return 0; // Default to platform-level
}

// ── Layer defaults for failBehavior ──────────────────────────────────────────

function layerDefaultFailBehavior(layer: string): 'fail_closed' | 'fail_open' {
  if (layer === 'llm_verify') return 'fail_open';
  return 'fail_closed'; // rule + classifier default to fail_closed
}

// ── Scope matching ───────────────────────────────────────────────────────────

function scopeMatches(
  scope: GuardrailScope,
  tenantId: string,
  spaceId?: string,
  targetKey?: string,
): boolean {
  if (scope.platform) return true;
  if (scope.tenantIds?.includes(tenantId)) return true;
  if (spaceId && scope.spaceIds?.includes(spaceId)) return true;
  if (targetKey && scope.flowIds?.includes(targetKey)) return true;
  return false;
}

// ── Compile policies into a set ──────────────────────────────────────────────

export interface CompileContext {
  tenantId: string;
  targetKey: string;
  spaceId?: string;
}

/**
 * Compile multiple policies into a CompiledGuardrailSet.
 * Handles de-duplication, scope precedence, priority sorting, and safety floor.
 */
export function compilePolicies(
  policies: GuardrailPolicy[],
  context: CompileContext,
): CompiledGuardrailSet {
  // Filter to matching policies
  const matched = policies.filter((p) =>
    scopeMatches(p.scope, context.tenantId, context.spaceId, context.targetKey),
  );

  // Sort by scope precedence (broader first, so narrower overrides on collision)
  matched.sort((a, b) => scopePrecedence(a.scope) - scopePrecedence(b.scope));

  // Flatten and de-duplicate rails by railId
  // Track platform safety floor rails (block/escalate at platform scope)
  const safetyFloorRailIds = new Set<string>();
  const railMap = new Map<
    string,
    { rail: CompiledRail; scopeLevel: number; trigger: GuardrailTrigger }
  >();

  for (const policy of matched) {
    const scopeLevel = scopePrecedence(policy.scope);
    const defaultFail = policy.settings?.defaultFailBehavior ?? 'fail_closed';

    for (const rail of policy.rails) {
      if (!rail.enabled) continue;

      // Track platform safety floor
      if (
        policy.scope.platform &&
        (rail.onViolation === 'block' || rail.onViolation === 'escalate')
      ) {
        safetyFloorRailIds.add(rail.railId);
      }

      const existing = railMap.get(rail.railId);

      // Safety floor: platform-scope block/escalate rails cannot be overridden
      if (existing && safetyFloorRailIds.has(rail.railId) && existing.scopeLevel === 0) {
        continue; // Keep platform rail, skip narrower override
      }

      // Narrower scope wins on railId collision
      if (!existing || scopeLevel > existing.scopeLevel) {
        const failBehavior =
          rail.failBehavior ?? defaultFail ?? layerDefaultFailBehavior(rail.layer);

        railMap.set(rail.railId, {
          scopeLevel,
          trigger: rail.trigger,
          rail: {
            railId: rail.railId,
            policyId: policy.policyId,
            layer: rail.layer,
            mode: rail.mode,
            type: rail.type,
            config: rail.config,
            onViolation: rail.onViolation,
            violationMessage: rail.violationMessage,
            priority: rail.priority ?? 100,
            failBehavior: failBehavior,
          },
        });
      }
    }
  }

  // Group by trigger and sort by priority
  const byTrigger = { ...EMPTY_TRIGGERS };
  for (const key of TRIGGER_KEYS) {
    byTrigger[key] = [];
  }

  for (const { rail, trigger } of railMap.values()) {
    if (trigger && trigger in byTrigger) {
      byTrigger[trigger].push(rail);
    }
  }

  // Sort each trigger group by priority ASC, then railId ASC
  for (const key of TRIGGER_KEYS) {
    byTrigger[key].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.railId.localeCompare(b.railId);
    });
  }

  return {
    byTrigger,
    version: Date.now().toString(),
    compiledAtMs: Date.now(),
    policyIds: matched.map((p) => p.policyId),
  };
}

// ── Policy Compiler with caching ─────────────────────────────────────────────

export interface PolicyCompilerDeps {
  redis: Redis;
  db: PostgresJsDatabase;
}

export interface PolicyCompiler {
  getCompiledSet(context: CompileContext): Promise<CompiledGuardrailSet>;
  invalidate(tenantId: string, targetKey?: string): Promise<void>;
  subscribeInvalidations(subscriberRedis: Redis): Promise<() => Promise<void>>;
}

export function createPolicyCompiler(deps: PolicyCompilerDeps): PolicyCompiler {
  const { redis, db } = deps;

  async function loadPoliciesFromDb(context: CompileContext): Promise<GuardrailPolicy[]> {
    const tenantCtx = createTenantContext(context.tenantId as TenantId);
    const rows = await withTenantSchema(db, tenantCtx, async (tx) => {
      return tx.select().from(guardrailPolicies);
    });

    // Parse rows into GuardrailPolicy objects
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      policyId: row['policyId'] as string,
      name: row['name'] as string,
      description: row['description'] as string | undefined,
      version: (row['version'] as string) ?? '1',
      scope: row['scope'] as GuardrailScope,
      rails: row['rails'] as GuardrailRail[],
      settings: (row['settings'] as GuardrailPolicy['settings']) ?? {
        defaultFailBehavior: 'fail_closed',
        maxLatencyMs: 5000,
        logMode: 'violations_only',
        logSampleRate: 0.1,
      },
      tags: row['tags'] as string[] | undefined,
    }));
  }

  async function getCompiledSet(context: CompileContext): Promise<CompiledGuardrailSet> {
    const cacheKey = StreamKeys.guardrailPolicyCacheKey(context.tenantId, context.targetKey);

    // Check cache
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as CompiledGuardrailSet;
      }
    } catch {
      // Cache miss or parse error — continue to compile
    }

    // Load from DB and compile
    const policies = await loadPoliciesFromDb(context);
    const compiled = compilePolicies(policies, context);

    // Cache with TTL (fire-and-forget)
    redis.set(cacheKey, JSON.stringify(compiled), 'EX', CACHE_TTL_SECONDS).catch(() => {
      // Best-effort caching
    });

    return compiled;
  }

  async function invalidate(tenantId: string, targetKey?: string): Promise<void> {
    if (targetKey) {
      const cacheKey = StreamKeys.guardrailPolicyCacheKey(tenantId, targetKey);
      await redis.del(cacheKey).catch(() => {});
    } else {
      // Invalidate all target caches for this tenant — use scan
      const pattern = StreamKeys.guardrailPolicyCacheKey(tenantId, '*');
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys).catch(() => {});
        }
      } while (cursor !== '0');
    }
  }

  async function subscribeInvalidations(subscriberRedis: Redis): Promise<() => Promise<void>> {
    const pattern = 'aflow:pubsub:guardrails:*';

    subscriberRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
      try {
        const parsed = z
          .object({ kind: z.string(), policyId: z.string().optional() })
          .parse(JSON.parse(message) as unknown);
        // Extract tenantId from channel: aflow:pubsub:guardrails:{tenantId}
        const parts = channel.split(':');
        const tenantId = parts[3];
        if (tenantId && parsed.kind === 'policy_changed') {
          invalidate(tenantId).catch(() => {});
        }
      } catch {
        // Malformed message — ignore
      }
    });

    await subscriberRedis.psubscribe(pattern);

    return async () => {
      await subscriberRedis.punsubscribe(pattern);
    };
  }

  return { getCompiledSet, invalidate, subscribeInvalidations };
}
