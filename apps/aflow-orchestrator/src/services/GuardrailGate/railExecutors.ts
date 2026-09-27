import type { Redis } from 'ioredis';
import type { CompiledRail } from '@aflow/schemas';

export interface RailExecContext {
  tenantId: string;
  runId: string;
  targetKey: string;
  stepExecutionId?: string;
  stepId?: string;
  operationId?: string;
  turnNumber?: number;
  totalToolCalls?: number;
  totalTokens?: number;
}

export interface RailExecResult {
  passed: boolean;
  violationType?: string;
  violationMessage?: string;
  detail?: unknown;
  redactedPayload?: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function payloadToString(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload == null) return '';
  return JSON.stringify(payload);
}

// ── PII Regex Patterns ───────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/ },
  {
    name: 'credit_card',
    regex: /\b(?:\d{4}[- ]?){3}\d{4}\b/,
  },
  { name: 'phone', regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/ },
];

// ── Simple Expression Evaluator (for argument_constraint) ────────────────────

/**
 * Evaluate a simple constraint expression against a data object.
 * Supports: <, >, <=, >=, ===, !==, ==, !=
 * Format: "path op value" e.g. "amount < 1000" or "status === approved"
 */
function evaluateConstraint(expression: string, data: unknown): boolean {
  const match = /^\s*([a-zA-Z0-9_.[\]]+)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)\s*$/.exec(expression);
  if (!match) return true; // Cannot parse — pass

  const [, path, op, rawValue] = match;
  if (!path || !op || !rawValue) return true;

  // Resolve path from data
  const resolved = resolvePath(data, path);

  // Parse the comparison value
  let compareValue: unknown;
  const trimmed = rawValue.trim();
  if (trimmed === 'true') compareValue = true;
  else if (trimmed === 'false') compareValue = false;
  else if (trimmed === 'null') compareValue = null;
  else if (/^-?\d+(\.\d+)?$/.test(trimmed)) compareValue = Number(trimmed);
  else if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    compareValue = trimmed.slice(1, -1);
  } else {
    compareValue = trimmed;
  }

  switch (op) {
    case '<':
      return Number(resolved) < Number(compareValue);
    case '>':
      return Number(resolved) > Number(compareValue);
    case '<=':
      return Number(resolved) <= Number(compareValue);
    case '>=':
      return Number(resolved) >= Number(compareValue);
    case '===':
      return resolved === compareValue;
    case '!==':
      return resolved !== compareValue;
    case '==':
      return resolved == compareValue;
    case '!=':
      return resolved != compareValue;
    default:
      return true;
  }
}

function resolvePath(data: unknown, path: string): unknown {
  if (data == null || typeof data !== 'object') return undefined;
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Rail Executor Registry ───────────────────────────────────────────────────

export type RailExecutor = (
  rail: CompiledRail,
  payload: unknown,
  context: RailExecContext,
  redis?: Redis,
) => RailExecResult | Promise<RailExecResult>;

function execBlocklist(rail: CompiledRail, payload: unknown): RailExecResult {
  const terms = rail.config['terms'] as string[] | undefined;
  if (!terms || terms.length === 0) return { passed: true };

  const text = payloadToString(payload).toLowerCase();
  const blocked = new Set(terms.map((t) => t.toLowerCase()));

  for (const term of blocked) {
    if (text.includes(term)) {
      return {
        passed: false,
        violationType: 'blocklist_match',
        violationMessage: rail.violationMessage ?? `Blocked term detected: "${term}"`,
        detail: { matchedTerm: term },
      };
    }
  }
  return { passed: true };
}

function execAllowlist(rail: CompiledRail, payload: unknown): RailExecResult {
  const terms = rail.config['terms'] as string[] | undefined;
  if (!terms || terms.length === 0) return { passed: true };

  const text = payloadToString(payload).toLowerCase();
  const allowed = new Set(terms.map((t) => t.toLowerCase()));

  for (const term of allowed) {
    if (text.includes(term)) {
      return { passed: true };
    }
  }
  return {
    passed: false,
    violationType: 'allowlist_miss',
    violationMessage: rail.violationMessage ?? 'Content does not match any allowed terms',
  };
}

function execRegexFilter(rail: CompiledRail, payload: unknown): RailExecResult {
  const patterns = rail.config['patterns'] as string[] | undefined;
  if (!patterns || patterns.length === 0) return { passed: true };

  const text = payloadToString(payload);
  const flags = (rail.config['flags'] as string) ?? 'i';

  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern, flags);
      if (re.test(text)) {
        return {
          passed: false,
          violationType: 'regex_match',
          violationMessage: rail.violationMessage ?? `Content matches blocked pattern: ${pattern}`,
          detail: { matchedPattern: pattern },
        };
      }
    } catch {
      // Invalid regex — skip
    }
  }
  return { passed: true };
}

function execPiiDetectRegex(rail: CompiledRail, payload: unknown): RailExecResult {
  const text = payloadToString(payload);
  const enabledPatterns = (rail.config['patterns'] as string[] | undefined) ?? [
    'ssn',
    'email',
    'credit_card',
    'phone',
  ];

  for (const pii of PII_PATTERNS) {
    if (!enabledPatterns.includes(pii.name)) continue;
    if (pii.regex.test(text)) {
      return {
        passed: false,
        violationType: 'pii_detected',
        violationMessage: rail.violationMessage ?? `PII detected: ${pii.name}`,
        detail: { piiType: pii.name },
      };
    }
  }
  return { passed: true };
}

function execLengthLimit(rail: CompiledRail, payload: unknown): RailExecResult {
  const maxLength = rail.config['maxLength'] as number | undefined;
  if (maxLength == null) return { passed: true };

  const text = payloadToString(payload);
  if (text.length > maxLength) {
    return {
      passed: false,
      violationType: 'length_exceeded',
      violationMessage:
        rail.violationMessage ?? `Content length ${text.length} exceeds limit ${maxLength}`,
      detail: { length: text.length, maxLength },
    };
  }
  return { passed: true };
}

function execBudgetLimit(
  rail: CompiledRail,
  _payload: unknown,
  context: RailExecContext,
): RailExecResult {
  const maxTokens = rail.config['maxTokens'] as number | undefined;
  const maxTurns = rail.config['maxTurns'] as number | undefined;
  const maxToolCalls = rail.config['maxToolCalls'] as number | undefined;

  if (maxTokens != null && context.totalTokens != null && context.totalTokens > maxTokens) {
    return {
      passed: false,
      violationType: 'budget_exceeded',
      violationMessage:
        rail.violationMessage ?? `Token budget exceeded: ${context.totalTokens}/${maxTokens}`,
      detail: { metric: 'tokens', current: context.totalTokens, limit: maxTokens },
    };
  }
  if (maxTurns != null && context.turnNumber != null && context.turnNumber > maxTurns) {
    return {
      passed: false,
      violationType: 'budget_exceeded',
      violationMessage:
        rail.violationMessage ?? `Turn limit exceeded: ${context.turnNumber}/${maxTurns}`,
      detail: { metric: 'turns', current: context.turnNumber, limit: maxTurns },
    };
  }
  if (
    maxToolCalls != null &&
    context.totalToolCalls != null &&
    context.totalToolCalls > maxToolCalls
  ) {
    return {
      passed: false,
      violationType: 'budget_exceeded',
      violationMessage:
        rail.violationMessage ??
        `Tool call limit exceeded: ${context.totalToolCalls}/${maxToolCalls}`,
      detail: { metric: 'toolCalls', current: context.totalToolCalls, limit: maxToolCalls },
    };
  }
  return { passed: true };
}

function execToolAllowlist(
  rail: CompiledRail,
  _payload: unknown,
  context: RailExecContext,
): RailExecResult {
  const allowed = rail.config['allowed'] as string[] | undefined;
  if (!allowed || allowed.length === 0) return { passed: true };

  const toolId = context.operationId ?? context.stepId;
  if (!toolId) return { passed: true };

  const allowedSet = new Set(allowed);
  if (!allowedSet.has(toolId)) {
    return {
      passed: false,
      violationType: 'tool_not_allowed',
      violationMessage: rail.violationMessage ?? `Tool "${toolId}" is not in the allowlist`,
      detail: { toolId, allowed },
    };
  }
  return { passed: true };
}

function execToolDenylist(
  rail: CompiledRail,
  _payload: unknown,
  context: RailExecContext,
): RailExecResult {
  const denied = rail.config['denied'] as string[] | undefined;
  if (!denied || denied.length === 0) return { passed: true };

  const toolId = context.operationId ?? context.stepId;
  if (!toolId) return { passed: true };

  const deniedSet = new Set(denied);
  if (deniedSet.has(toolId)) {
    return {
      passed: false,
      violationType: 'tool_denied',
      violationMessage: rail.violationMessage ?? `Tool "${toolId}" is denied`,
      detail: { toolId, denied },
    };
  }
  return { passed: true };
}

function execArgumentConstraint(rail: CompiledRail, payload: unknown): RailExecResult {
  const constraints = rail.config['constraints'] as string[] | undefined;
  if (!constraints || constraints.length === 0) return { passed: true };

  for (const constraint of constraints) {
    if (!evaluateConstraint(constraint, payload)) {
      return {
        passed: false,
        violationType: 'argument_constraint_violated',
        violationMessage: rail.violationMessage ?? `Argument constraint violated: ${constraint}`,
        detail: { constraint },
      };
    }
  }
  return { passed: true };
}

async function execRateLimit(
  rail: CompiledRail,
  _payload: unknown,
  context: RailExecContext,
  redis?: Redis,
): Promise<RailExecResult> {
  if (!redis) {
    // No Redis — honor failBehavior
    if (rail.failBehavior === 'fail_open') return { passed: true };
    return {
      passed: false,
      violationType: 'rate_limit_error',
      violationMessage: 'Rate limit check failed: Redis unavailable',
    };
  }

  const max = rail.config['max'] as number | undefined;
  const windowSeconds = rail.config['windowSeconds'] as number | undefined;
  const key = (rail.config['key'] as string) ?? 'default';
  if (max == null || windowSeconds == null) return { passed: true };

  const redisKey = `aflow:ratelimit:${context.tenantId}:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;

  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }
    if (count > max) {
      return {
        passed: false,
        violationType: 'rate_limit_exceeded',
        violationMessage:
          rail.violationMessage ?? `Rate limit exceeded: ${count}/${max} per ${windowSeconds}s`,
        detail: { count, max, windowSeconds },
      };
    }
    return { passed: true };
  } catch {
    if (rail.failBehavior === 'fail_open') return { passed: true };
    return {
      passed: false,
      violationType: 'rate_limit_error',
      violationMessage: 'Rate limit check failed',
    };
  }
}

// ── Rail Type → Executor Map ─────────────────────────────────────────────────

const LAYER1_EXECUTORS: Record<string, RailExecutor> = {
  blocklist: execBlocklist,
  allowlist: execAllowlist,
  regex_filter: execRegexFilter,
  pii_detect_regex: execPiiDetectRegex,
  length_limit: execLengthLimit,
  budget_limit: execBudgetLimit,
  tool_allowlist: execToolAllowlist,
  tool_denylist: execToolDenylist,
  argument_constraint: execArgumentConstraint,
  rate_limit: execRateLimit,
};

/**
 * Get the Layer 1 rail executor for a given rail type.
 * Returns undefined for Layer 2/3 types (not executed in Phase 1).
 */
export function getLayer1Executor(railType: string): RailExecutor | undefined {
  return LAYER1_EXECUTORS[railType];
}

// Export individual executors for testing
export {
  execBlocklist,
  execAllowlist,
  execRegexFilter,
  execPiiDetectRegex,
  execLengthLimit,
  execBudgetLimit,
  execToolAllowlist,
  execToolDenylist,
  execArgumentConstraint,
  execRateLimit,
};
