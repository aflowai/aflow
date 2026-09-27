import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  GuardrailTrigger,
  CompiledGuardrailSet,
  CompiledRail,
  GuardrailCheckRecord,
  GuardrailRunSummaryEvent,
  SessionAgentTarget,
} from '@aflow/schemas';
import { agentTargetKey } from '@aflow/schemas';
import { appendSessionEvent } from '@aflow/redis';
import { appendGuardrailCheck } from '@aflow/redis';
import { getLayer1Executor, type RailExecContext, type RailExecResult } from './railExecutors.js';
import { createPolicyCompiler, type PolicyCompiler } from './policyCompiler.js';

// ── Public interfaces ────────────────────────────────────────────────────────

export interface GuardrailContext {
  tenantId: string;
  runId: string;
  target: SessionAgentTarget;
  spaceId?: string;
  stepExecutionId?: string;
  stepId?: string;
  operationId?: string;
  turnNumber?: number;
  totalToolCalls?: number;
  totalTokens?: number;
}

export interface ViolationDetail {
  railId: string;
  policyId: string;
  type: string;
  message?: string;
  detail?: unknown;
}

export interface CheckResult {
  passed: boolean;
  violations: ViolationDetail[];
  action: 'allow' | 'block' | 'retry' | 'redact' | 'escalate';
  redactedPayload?: unknown;
  durationMs: number;
  checksRun: number;
}

export interface GuardrailGate {
  check(
    trigger: GuardrailTrigger,
    payload: unknown,
    context: GuardrailContext,
  ): Promise<CheckResult>;
  getRunSummary(tenantId: string, runId: string): GuardrailRunSummaryEvent;
  emitRunSummary(tenantId: string, runId: string): Promise<void>;
  invalidateCache(tenantId: string, target?: SessionAgentTarget): Promise<void>;
  /** Clean up in-memory accumulator for a run (call on fail/cancel to prevent leak). */
  cleanupRun(tenantId: string, runId: string): void;
}

// ── Error for blocked operations ─────────────────────────────────────────────

export class GuardrailBlockedError extends Error {
  public readonly violations: ViolationDetail[];

  constructor(violations: ViolationDetail[]) {
    const msg = violations.map((v) => v.message ?? `${v.type}: ${v.railId}`).join('; ');
    super(`Guardrail blocked: ${msg}`);
    this.name = 'GuardrailBlockedError';
    this.violations = violations;
  }
}

// ── Run summary accumulator ──────────────────────────────────────────────────

interface RunAccumulator {
  checksTotal: number;
  checksPassed: number;
  checksViolated: number;
  checksErrored: number;
  totalDurationMs: number;
  violations: Array<{ railId: string; trigger: string; action: string }>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export interface GuardrailGateDeps {
  redis: Redis;
  db: PostgresJsDatabase;
}

export function createGuardrailGate(deps: GuardrailGateDeps): GuardrailGate {
  const { redis, db } = deps;
  const compiler: PolicyCompiler = createPolicyCompiler({ redis, db });
  const runAccumulators = new Map<string, RunAccumulator>();

  function getAccumulator(tenantId: string, runId: string): RunAccumulator {
    const key = `${tenantId}:${runId}`;
    let acc = runAccumulators.get(key);
    if (!acc) {
      acc = {
        checksTotal: 0,
        checksPassed: 0,
        checksViolated: 0,
        checksErrored: 0,
        totalDurationMs: 0,
        violations: [],
      };
      runAccumulators.set(key, acc);
    }
    return acc;
  }

  async function check(
    trigger: GuardrailTrigger,
    payload: unknown,
    context: GuardrailContext,
  ): Promise<CheckResult> {
    const startMs = performance.now();

    let compiled: CompiledGuardrailSet;
    try {
      compiled = await compiler.getCompiledSet({
        tenantId: context.tenantId,
        targetKey: agentTargetKey(context.target),
        ...(context.spaceId ? { spaceId: context.spaceId } : {}),
      });
    } catch {
      // If compilation fails, pass through (fail_open for infrastructure errors)
      return {
        passed: true,
        violations: [],
        action: 'allow',
        durationMs: performance.now() - startMs,
        checksRun: 0,
      };
    }

    const rails = compiled.byTrigger[trigger];
    if (!rails || rails.length === 0) {
      return {
        passed: true,
        violations: [],
        action: 'allow',
        durationMs: performance.now() - startMs,
        checksRun: 0,
      };
    }

    // Filter to Layer 1 (rule-based) rails only in Phase 1
    const layer1Rails = rails.filter((r) => r.layer === 'rule');

    const acc = getAccumulator(context.tenantId, context.runId);
    const violations: ViolationDetail[] = [];
    let resultAction: CheckResult['action'] = 'allow';
    let redactedPayload: unknown;
    let checksRun = 0;

    const railContext: RailExecContext = {
      tenantId: context.tenantId,
      runId: context.runId,
      targetKey: agentTargetKey(context.target),
      ...(context.stepExecutionId ? { stepExecutionId: context.stepExecutionId } : {}),
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(context.operationId ? { operationId: context.operationId } : {}),
      ...(context.turnNumber != null ? { turnNumber: context.turnNumber } : {}),
      ...(context.totalToolCalls != null ? { totalToolCalls: context.totalToolCalls } : {}),
      ...(context.totalTokens != null ? { totalTokens: context.totalTokens } : {}),
    };

    for (const rail of layer1Rails) {
      const executor = getLayer1Executor(rail.type);
      if (!executor) continue;

      checksRun++;
      acc.checksTotal++;
      const railStartMs = performance.now();

      let result: RailExecResult;
      try {
        result = await executor(rail, payload, railContext, redis);
      } catch {
        acc.checksErrored++;
        // Honor failBehavior
        if (rail.failBehavior === 'fail_open') {
          result = { passed: true };
        } else {
          result = {
            passed: false,
            violationType: 'rail_error',
            violationMessage: 'Rail execution failed',
          };
        }
      }

      const railDurationMs = performance.now() - railStartMs;

      // Build check record for guardrail log
      const checkRecord: GuardrailCheckRecord = {
        type: 'GuardrailCheck',
        timestamp: Date.now(),
        railId: rail.railId,
        policyId: rail.policyId,
        trigger,
        stepExecutionId: context.stepExecutionId,
        layer: rail.layer,
        mode: rail.mode,
        result: result.passed ? 'pass' : 'violation',
        action: result.passed ? 'allowed' : mapViolationAction(rail.onViolation),
        violationType: result.violationType,
        violationMessage: result.violationMessage,
        violationDetail: result.detail,
        durationMs: railDurationMs,
      };

      // Write to guardrail log stream (fire-and-forget)
      appendGuardrailCheck(
        redis,
        context.tenantId,
        context.runId,
        checkRecord as unknown as Record<string, unknown>,
      ).catch(() => {});

      if (result.passed) {
        acc.checksPassed++;
      } else {
        acc.checksViolated++;
        const violationMessage = result.violationMessage ?? rail.violationMessage;
        const violation: ViolationDetail = {
          railId: rail.railId,
          policyId: rail.policyId,
          type: result.violationType ?? rail.type,
          ...(violationMessage != null ? { message: violationMessage } : {}),
          ...(result.detail != null ? { detail: result.detail } : {}),
        };
        violations.push(violation);
        acc.violations.push({
          railId: rail.railId,
          trigger,
          action: rail.onViolation,
        });

        // Emit violation event to run_events
        emitViolationEvent(trigger, context, rail, railDurationMs).catch(() => {});

        // Determine action (strongest wins)
        const actionPriority = mapActionToPriority(rail.onViolation);
        const currentPriority = mapActionToPriority(
          resultAction === 'allow' ? 'warn' : violationActionFromCheckAction(resultAction),
        );
        if (actionPriority > currentPriority) {
          resultAction = mapOnViolationToCheckAction(rail.onViolation);
        }

        if (result.redactedPayload !== undefined) {
          redactedPayload = result.redactedPayload;
        }

        // For blocking actions, stop checking further rails
        if (
          rail.onViolation === 'block' ||
          rail.onViolation === 'block_with_retry' ||
          rail.onViolation === 'escalate'
        ) {
          break;
        }
      }
    }

    const durationMs = performance.now() - startMs;
    acc.totalDurationMs += durationMs;

    return {
      passed: violations.length === 0,
      violations,
      action: resultAction,
      redactedPayload,
      durationMs,
      checksRun,
    };
  }

  async function emitViolationEvent(
    trigger: GuardrailTrigger,
    context: GuardrailContext,
    rail: CompiledRail,
    durationMs: number,
  ): Promise<void> {
    const event = {
      eventId: crypto.randomUUID(),
      eventType: 'GuardrailViolation' as const,
      timestamp: Date.now(),
      sessionId: context.runId,
      stepExecutionId: context.stepExecutionId,
      metadata: {
        railId: rail.railId,
        policyId: rail.policyId,
        trigger,
        action: mapViolationAction(rail.onViolation),
        violationMessage: rail.violationMessage,
        durationMs,
      } satisfies Record<string, unknown>,
    };

    await appendSessionEvent(redis, context.tenantId, context.runId, event).catch(() => {});
  }

  function getRunSummary(tenantId: string, runId: string): GuardrailRunSummaryEvent {
    const acc = getAccumulator(tenantId, runId);
    return {
      checksTotal: acc.checksTotal,
      checksPassed: acc.checksPassed,
      checksViolated: acc.checksViolated,
      checksErrored: acc.checksErrored,
      totalDurationMs: acc.totalDurationMs,
      violations: acc.violations,
    };
  }

  async function emitRunSummary(tenantId: string, runId: string): Promise<void> {
    const summary = getRunSummary(tenantId, runId);
    if (summary.checksTotal === 0) return; // No guardrails were active

    const event = {
      eventId: crypto.randomUUID(),
      eventType: 'GuardrailRunSummary' as const,
      timestamp: Date.now(),
      sessionId: runId,
      metadata: summary as unknown as Record<string, unknown>,
    };

    await appendSessionEvent(redis, tenantId, runId, event).catch(() => {});

    // Clean up accumulator
    runAccumulators.delete(`${tenantId}:${runId}`);
  }

  async function invalidateCache(tenantId: string, target?: SessionAgentTarget): Promise<void> {
    await compiler.invalidate(tenantId, target ? agentTargetKey(target) : undefined);
  }

  function cleanupRun(tenantId: string, runId: string): void {
    runAccumulators.delete(`${tenantId}:${runId}`);
  }

  return { check, getRunSummary, emitRunSummary, invalidateCache, cleanupRun };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapViolationAction(
  onViolation: string,
): 'blocked' | 'retried' | 'redacted' | 'warned' | 'escalated' {
  switch (onViolation) {
    case 'block':
      return 'blocked';
    case 'block_with_retry':
      return 'retried';
    case 'redact':
      return 'redacted';
    case 'escalate':
      return 'escalated';
    case 'warn':
    default:
      return 'warned';
  }
}

function mapOnViolationToCheckAction(onViolation: string): CheckResult['action'] {
  switch (onViolation) {
    case 'block':
      return 'block';
    case 'block_with_retry':
      return 'retry';
    case 'redact':
      return 'redact';
    case 'escalate':
      return 'escalate';
    case 'warn':
    default:
      return 'allow';
  }
}

function violationActionFromCheckAction(action: CheckResult['action']): string {
  switch (action) {
    case 'block':
      return 'block';
    case 'retry':
      return 'block_with_retry';
    case 'redact':
      return 'redact';
    case 'escalate':
      return 'escalate';
    case 'allow':
    default:
      return 'warn';
  }
}

function mapActionToPriority(onViolation: string): number {
  switch (onViolation) {
    case 'warn':
      return 0;
    case 'redact':
      return 1;
    case 'block_with_retry':
      return 2;
    case 'block':
      return 3;
    case 'escalate':
      return 4;
    default:
      return -1;
  }
}
