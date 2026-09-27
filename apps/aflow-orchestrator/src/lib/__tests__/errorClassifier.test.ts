import { describe, it, expect } from 'vitest';
import { classifyOrchestratorError } from '../errorClassifier.js';

describe('classifyOrchestratorError', () => {
  // ── Flow not found ───────────────────────────────────────────────────────

  it('classifies "flow not found" errors', () => {
    const { classified, internalMessage } = classifyOrchestratorError(
      new Error('Flow my-flow not found in tenant abc'),
      { flowId: 'my-flow' },
    );
    expect(classified.code).toBe('FLOW_NOT_FOUND');
    expect(classified.classification).toBe('not_found');
    expect(classified.retryable).toBe(false);
    expect(classified.message).toContain('my-flow');
    expect(classified.message).not.toContain('tenant');
    expect(internalMessage).toContain('tenant abc');
  });

  // ── Guardrail blocked ────────────────────────────────────────────────────

  it('classifies guardrail blocked errors', () => {
    const err = new Error('Content blocked by guardrail policy xyz');
    Object.defineProperty(err, 'constructor', {
      value: class GuardrailBlockedError extends Error {},
    });
    const { classified } = classifyOrchestratorError(err);
    expect(classified.code).toBe('GUARDRAIL_BLOCKED');
    expect(classified.classification).toBe('content_policy');
    expect(classified.retryable).toBe(false);
  });

  it('classifies GuardrailBlockedError by constructor name', () => {
    class GuardrailBlockedError extends Error {
      constructor(msg: string) {
        super(msg);
        this.name = 'GuardrailBlockedError';
      }
    }
    const { classified } = classifyOrchestratorError(new GuardrailBlockedError('blocked'));
    expect(classified.code).toBe('GUARDRAIL_BLOCKED');
  });

  // ── Validation / Zod errors ──────────────────────────────────────────────

  it('classifies Zod validation errors', () => {
    const { classified, internalMessage } = classifyOrchestratorError(
      new Error(
        "Invalid enum value. Expected 'chat' | 'api' | 'eval' | 'mcp' | 'schedule', received 'voice'",
      ),
    );
    expect(classified.code).toBe('VALIDATION_FAILED');
    expect(classified.classification).toBe('validation');
    expect(classified.retryable).toBe(false);
    // User message should NOT contain the raw enum details
    expect(classified.message).not.toContain('Expected');
    expect(classified.message).not.toContain("'voice'");
    // Internal message should preserve the full details for debugging
    expect(internalMessage).toContain('Expected');
  });

  // ── Flow input validation ────────────────────────────────────────────────

  it('classifies flow input validation errors', () => {
    const { classified } = classifyOrchestratorError(
      new Error('Flow input validation failed: missing required field "query"'),
    );
    expect(classified.code).toBe('FLOW_INPUT_VALIDATION_FAILED');
    expect(classified.classification).toBe('validation');
  });

  // ── No executor available ────────────────────────────────────────────────

  it('classifies "no executor" errors as transient + retryable', () => {
    const { classified } = classifyOrchestratorError(
      new Error('No executor available for step type ai'),
    );
    expect(classified.code).toBe('NO_EXECUTOR_AVAILABLE');
    expect(classified.classification).toBe('transient');
    expect(classified.retryable).toBe(true);
  });

  // ── Corrupt run state ────────────────────────────────────────────────────

  it('classifies corrupt state errors', () => {
    const { classified } = classifyOrchestratorError(
      new Error('Run abc is stalled (state corrupt); clear quarantine to retry'),
    );
    expect(classified.code).toBe('RUN_STATE_CORRUPT');
    expect(classified.classification).toBe('internal');
    expect(classified.retryable).toBe(false);
  });

  // ── Permission errors ────────────────────────────────────────────────────

  it('classifies permission errors', () => {
    const { classified } = classifyOrchestratorError(
      new Error('Permission denied: cannot access flow'),
    );
    expect(classified.code).toBe('PERMISSION_DENIED');
    expect(classified.classification).toBe('permission');
  });

  // ── Database errors (must NOT leak SQL) ──────────────────────────────────

  it('classifies database errors and scrubs SQL from user message', () => {
    const { classified, internalMessage } = classifyOrchestratorError(
      new Error(
        'Failed query: INSERT INTO sessions (id, tenant_id) VALUES ($1, $2) params: ["run123", "tenant456"]',
      ),
    );
    expect(classified.code).toBe('DATABASE_ERROR');
    expect(classified.classification).toBe('internal');
    expect(classified.retryable).toBe(true);
    // User message must NOT contain SQL
    expect(classified.message).not.toContain('INSERT');
    expect(classified.message).not.toContain('params');
    expect(classified.message).not.toContain('run123');
    // Internal message preserves the full SQL for debugging
    expect(internalMessage).toContain('INSERT INTO');
  });

  it('classifies duplicate key violations', () => {
    const { classified } = classifyOrchestratorError(
      new Error('duplicate key value violates unique constraint "sessions_pkey"'),
    );
    expect(classified.code).toBe('DATABASE_ERROR');
    expect(classified.message).not.toContain('sessions_pkey');
  });

  // ── Connection errors ────────────────────────────────────────────────────

  it('classifies connection errors as transient + retryable', () => {
    const { classified } = classifyOrchestratorError(
      new Error('connect ECONNREFUSED 10.0.0.1:6379'),
    );
    expect(classified.code).toBe('CONNECTION_ERROR');
    expect(classified.classification).toBe('transient');
    expect(classified.retryable).toBe(true);
    expect(classified.message).not.toContain('10.0.0.1');
  });

  // ── Timeout errors ───────────────────────────────────────────────────────

  it('classifies timeout errors as retryable', () => {
    const { classified } = classifyOrchestratorError(
      new Error('Operation timed out after 30000ms'),
    );
    expect(classified.code).toBe('EXECUTION_TIMEOUT');
    expect(classified.classification).toBe('timeout');
    expect(classified.retryable).toBe(true);
  });

  it('classifies pinned_tool_cap_exceeded as a configuration error with operator-actionable guidance', () => {
    const err = new Error(
      'Pinned tool count (74) exceeds MAX_TOTAL_TOOLS=50 [MCP=66, API=0, coreOps=4, coreAgents=2, graph=2]. ' +
        'Reduce coreOperations / coreAgents / coreApis endpoints / coreMcpServers tools, ' +
        'or tighten binding.toolAccessPolicy.allow. (pinned_tool_cap_exceeded)',
    );
    const { classified, internalMessage } = classifyOrchestratorError(err);
    expect(classified.code).toBe('TOOL_BUDGET_EXCEEDED');
    expect(classified.classification).toBe('configuration');
    expect(classified.retryable).toBe(false);
    // Operator-facing message points them at the ACL editor explicitly.
    expect(classified.message).toMatch(/Tool permissions/i);
    expect(classified.message).toMatch(/Integrations/i);
    // Per-source breakdown stays in the internal message for debugging.
    expect(internalMessage).toContain('MCP=66');
  });

  // ── Unknown / fallback ───────────────────────────────────────────────────

  it('classifies unknown errors as internal', () => {
    const { classified, internalMessage } = classifyOrchestratorError(
      new Error('Something completely unexpected happened'),
    );
    expect(classified.code).toBe('INTERNAL_ERROR');
    expect(classified.classification).toBe('internal');
    expect(classified.retryable).toBe(false);
    expect(internalMessage).toContain('Something completely unexpected');
  });

  it('handles non-Error values', () => {
    const { classified } = classifyOrchestratorError('just a string');
    expect(classified.code).toBe('INTERNAL_ERROR');
    expect(classified.classification).toBe('internal');
  });

  // ── All classified messages have required fields ─────────────────────────

  it('always produces a valid AflowError shape', () => {
    const errors = [
      new Error('Flow x not found'),
      new Error('Invalid enum value'),
      new Error('No executor available'),
      new Error('Failed query: SELECT 1'),
      new Error('connect ECONNREFUSED'),
      new Error('Unknown kaboom'),
    ];

    for (const err of errors) {
      const { classified } = classifyOrchestratorError(err);
      expect(classified.code).toBeTruthy();
      expect(classified.message).toBeTruthy();
      expect(classified.classification).toBeTruthy();
      expect(typeof classified.retryable).toBe('boolean');
      expect(classified.timestamp).toBeTruthy();
    }
  });
});
