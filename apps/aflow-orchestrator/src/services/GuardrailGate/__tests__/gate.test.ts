import { describe, it, expect, vi } from 'vitest';
import type { CompiledRail } from '@aflow/schemas';
import {
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
  type RailExecContext,
} from '../railExecutors.js';

function makeRail(overrides: Partial<CompiledRail> = {}): CompiledRail {
  return {
    railId: 'test-rail',
    policyId: 'test-policy',
    layer: 'rule',
    mode: 'blocking',
    type: 'blocklist',
    config: {},
    onViolation: 'block',
    priority: 100,
    failBehavior: 'fail_closed',
    ...overrides,
  };
}

function makeContext(overrides: Partial<RailExecContext> = {}): RailExecContext {
  return {
    tenantId: 'test-tenant',
    runId: 'test-run',
    flowId: 'test-flow',
    ...overrides,
  };
}

describe('blocklist rail', () => {
  it('blocks when term is present (case-insensitive)', () => {
    const rail = makeRail({
      type: 'blocklist',
      config: { terms: ['forbidden', 'secret'] },
    });
    const result = execBlocklist(rail, 'This contains a FORBIDDEN word', makeContext());
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('blocklist_match');
    expect(result.detail).toEqual({ matchedTerm: 'forbidden' });
  });

  it('passes when no blocked terms are present', () => {
    const rail = makeRail({
      type: 'blocklist',
      config: { terms: ['forbidden', 'secret'] },
    });
    const result = execBlocklist(rail, 'This is a normal message', makeContext());
    expect(result.passed).toBe(true);
  });

  it('passes when terms list is empty', () => {
    const rail = makeRail({ type: 'blocklist', config: { terms: [] } });
    const result = execBlocklist(rail, 'anything', makeContext());
    expect(result.passed).toBe(true);
  });

  it('handles object payloads', () => {
    const rail = makeRail({
      type: 'blocklist',
      config: { terms: ['password'] },
    });
    const result = execBlocklist(rail, { key: 'password: abc123' }, makeContext());
    expect(result.passed).toBe(false);
  });
});

describe('allowlist rail', () => {
  it('passes when an allowed term is present', () => {
    const rail = makeRail({
      type: 'allowlist',
      config: { terms: ['approved', 'safe'] },
    });
    const result = execAllowlist(rail, 'This is an APPROVED message', makeContext());
    expect(result.passed).toBe(true);
  });

  it('blocks when no allowed terms are present', () => {
    const rail = makeRail({
      type: 'allowlist',
      config: { terms: ['approved'] },
    });
    const result = execAllowlist(rail, 'This is a random message', makeContext());
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('allowlist_miss');
  });
});

describe('regex_filter rail', () => {
  it('blocks on regex match', () => {
    const rail = makeRail({
      type: 'regex_filter',
      config: { patterns: ['\\b\\d{4}-\\d{4}\\b'] },
    });
    const result = execRegexFilter(rail, 'My code is 1234-5678', makeContext());
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('regex_match');
  });

  it('passes when no regex matches', () => {
    const rail = makeRail({
      type: 'regex_filter',
      config: { patterns: ['\\bXXX\\b'] },
    });
    const result = execRegexFilter(rail, 'Normal text', makeContext());
    expect(result.passed).toBe(true);
  });
});

describe('pii_detect_regex rail', () => {
  it('detects SSN pattern', () => {
    const rail = makeRail({ type: 'pii_detect_regex', config: {} });
    const result = execPiiDetectRegex(rail, 'My SSN is 123-45-6789', makeContext());
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ piiType: 'ssn' });
  });

  it('detects email pattern', () => {
    const rail = makeRail({ type: 'pii_detect_regex', config: {} });
    const result = execPiiDetectRegex(rail, 'Contact me at user@example.com', makeContext());
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ piiType: 'email' });
  });

  it('detects credit card pattern', () => {
    const rail = makeRail({ type: 'pii_detect_regex', config: {} });
    const result = execPiiDetectRegex(rail, 'Card: 4111-1111-1111-1111', makeContext());
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ piiType: 'credit_card' });
  });

  it('passes clean text', () => {
    const rail = makeRail({ type: 'pii_detect_regex', config: {} });
    const result = execPiiDetectRegex(rail, 'Just a normal sentence', makeContext());
    expect(result.passed).toBe(true);
  });

  it('only checks enabled patterns', () => {
    const rail = makeRail({
      type: 'pii_detect_regex',
      config: { patterns: ['ssn'] },
    });
    const result = execPiiDetectRegex(rail, 'Contact me at user@example.com', makeContext());
    expect(result.passed).toBe(true); // email not in enabled patterns
  });
});

describe('length_limit rail', () => {
  it('blocks when payload exceeds limit', () => {
    const rail = makeRail({
      type: 'length_limit',
      config: { maxLength: 10 },
    });
    const result = execLengthLimit(rail, 'This is a very long string', makeContext());
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('length_exceeded');
  });

  it('passes when payload is within limit', () => {
    const rail = makeRail({
      type: 'length_limit',
      config: { maxLength: 100 },
    });
    const result = execLengthLimit(rail, 'Short', makeContext());
    expect(result.passed).toBe(true);
  });
});

describe('budget_limit rail', () => {
  it('blocks when tokens exceed limit', () => {
    const rail = makeRail({
      type: 'budget_limit',
      config: { maxTokens: 1000 },
    });
    const result = execBudgetLimit(rail, null, makeContext({ totalTokens: 1500 }));
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ metric: 'tokens', current: 1500, limit: 1000 });
  });

  it('blocks when turns exceed limit', () => {
    const rail = makeRail({
      type: 'budget_limit',
      config: { maxTurns: 5 },
    });
    const result = execBudgetLimit(rail, null, makeContext({ turnNumber: 6 }));
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ metric: 'turns', current: 6, limit: 5 });
  });

  it('blocks when tool calls exceed limit', () => {
    const rail = makeRail({
      type: 'budget_limit',
      config: { maxToolCalls: 10 },
    });
    const result = execBudgetLimit(rail, null, makeContext({ totalToolCalls: 15 }));
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ metric: 'toolCalls', current: 15, limit: 10 });
  });

  it('passes when within all limits', () => {
    const rail = makeRail({
      type: 'budget_limit',
      config: { maxTokens: 1000, maxTurns: 10, maxToolCalls: 20 },
    });
    const result = execBudgetLimit(
      rail,
      null,
      makeContext({ totalTokens: 500, turnNumber: 3, totalToolCalls: 5 }),
    );
    expect(result.passed).toBe(true);
  });
});

describe('tool_allowlist rail', () => {
  it('blocks disallowed tools', () => {
    const rail = makeRail({
      type: 'tool_allowlist',
      config: { allowed: ['memory.store.get', 'ai.text.generate'] },
    });
    const result = execToolAllowlist(rail, null, makeContext({ operationId: 'api.http.call' }));
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('tool_not_allowed');
  });

  it('passes allowed tools', () => {
    const rail = makeRail({
      type: 'tool_allowlist',
      config: { allowed: ['memory.store.get', 'ai.text.generate'] },
    });
    const result = execToolAllowlist(rail, null, makeContext({ operationId: 'ai.text.generate' }));
    expect(result.passed).toBe(true);
  });
});

describe('tool_denylist rail', () => {
  it('blocks denied tools', () => {
    const rail = makeRail({
      type: 'tool_denylist',
      config: { denied: ['api.http.call'] },
    });
    const result = execToolDenylist(rail, null, makeContext({ operationId: 'api.http.call' }));
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('tool_denied');
  });

  it('passes non-denied tools', () => {
    const rail = makeRail({
      type: 'tool_denylist',
      config: { denied: ['api.http.call'] },
    });
    const result = execToolDenylist(rail, null, makeContext({ operationId: 'ai.text.generate' }));
    expect(result.passed).toBe(true);
  });
});

describe('argument_constraint rail', () => {
  it('passes when constraint is satisfied', () => {
    const rail = makeRail({
      type: 'argument_constraint',
      config: { constraints: ['amount < 1000'] },
    });
    const result = execArgumentConstraint(rail, { amount: 500 }, makeContext());
    expect(result.passed).toBe(true);
  });

  it('blocks when constraint is violated', () => {
    const rail = makeRail({
      type: 'argument_constraint',
      config: { constraints: ['amount < 1000'] },
    });
    const result = execArgumentConstraint(rail, { amount: 1500 }, makeContext());
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('argument_constraint_violated');
  });

  it('supports equality checks', () => {
    const rail = makeRail({
      type: 'argument_constraint',
      config: { constraints: ['status === approved'] },
    });
    const pass = execArgumentConstraint(rail, { status: 'approved' }, makeContext());
    expect(pass.passed).toBe(true);

    const fail = execArgumentConstraint(rail, { status: 'pending' }, makeContext());
    expect(fail.passed).toBe(false);
  });
});

describe('pii_detect_regex — phone number', () => {
  it('detects US phone number', () => {
    const rail = makeRail({ type: 'pii_detect_regex', config: {} });
    const result = execPiiDetectRegex(rail, 'Call me at (555) 123-4567', makeContext());
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ piiType: 'phone' });
  });

  it('detects phone with country code', () => {
    const rail = makeRail({ type: 'pii_detect_regex', config: {} });
    const result = execPiiDetectRegex(rail, 'Call +1-555-123-4567', makeContext());
    expect(result.passed).toBe(false);
    expect(result.detail).toEqual({ piiType: 'phone' });
  });
});

describe('rate_limit rail', () => {
  function makeMockRedis(): Record<string, unknown> & {
    incr: ReturnType<typeof vi.fn>;
    expire: ReturnType<typeof vi.fn>;
  } {
    return {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    };
  }

  it('passes when under rate limit', async () => {
    const redis = makeMockRedis();
    const rail = makeRail({
      type: 'rate_limit',
      config: { max: 10, windowSeconds: 60, key: 'test' },
    });
    const result = await execRateLimit(rail, null, makeContext(), redis as never);
    expect(result.passed).toBe(true);
    expect(redis.incr).toHaveBeenCalled();
  });

  it('blocks when rate limit exceeded', async () => {
    const redis = makeMockRedis();
    redis.incr.mockResolvedValue(11);
    const rail = makeRail({
      type: 'rate_limit',
      config: { max: 10, windowSeconds: 60, key: 'test' },
    });
    const result = await execRateLimit(rail, null, makeContext(), redis as never);
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('rate_limit_exceeded');
  });

  it('honors fail_open when Redis unavailable', async () => {
    const rail = makeRail({
      type: 'rate_limit',
      config: { max: 10, windowSeconds: 60 },
      failBehavior: 'fail_open',
    });
    const result = await execRateLimit(rail, null, makeContext(), undefined);
    expect(result.passed).toBe(true);
  });

  it('honors fail_closed when Redis unavailable', async () => {
    const rail = makeRail({
      type: 'rate_limit',
      config: { max: 10, windowSeconds: 60 },
      failBehavior: 'fail_closed',
    });
    const result = await execRateLimit(rail, null, makeContext(), undefined);
    expect(result.passed).toBe(false);
    expect(result.violationType).toBe('rate_limit_error');
  });
});

describe('multiple rails', () => {
  it('no rails returns passed immediately', () => {
    // This is handled by GuardrailGate.check(), not individual executors
    // but we verify each executor handles empty config gracefully
    const rail = makeRail({ type: 'blocklist', config: {} });
    expect(execBlocklist(rail, 'test', makeContext()).passed).toBe(true);
  });
});
