import { describe, it, expect } from 'vitest';
import {
  isCodeLaneEnabled,
  codeLaneBreakerRefusal,
  CodeLaneDisabledError,
  CODE_LANE_ENABLED_ENV,
} from './codeLaneBreaker.js';
import { toAgentToolError } from './errors.js';

describe('isCodeLaneEnabled', () => {
  it('is off when nothing set it', () => {
    expect(isCodeLaneEnabled({})).toBe(false);
  });

  it('is off for an explicit no', () => {
    for (const raw of ['false', 'FALSE', '0', 'off', 'no', '']) {
      expect(isCodeLaneEnabled({ [CODE_LANE_ENABLED_ENV]: raw })).toBe(false);
    }
  });

  it('is off for anything malformed', () => {
    // A typo must not be what turns on a credential-bearing agent with egress.
    for (const raw of ['ture', 'enabled', 'y', '2', 'true false', 'null', 'undefined']) {
      expect(isCodeLaneEnabled({ [CODE_LANE_ENABLED_ENV]: raw })).toBe(false);
    }
  });

  it('is on only for an explicit yes', () => {
    for (const raw of ['true', 'TRUE', ' True ', '1', 'on', 'yes']) {
      expect(isCodeLaneEnabled({ [CODE_LANE_ENABLED_ENV]: raw })).toBe(true);
    }
  });
});

describe('codeLaneBreakerRefusal', () => {
  it('refuses code work when the breaker is unset', () => {
    expect(codeLaneBreakerRefusal('code', undefined, {})).toBeInstanceOf(CodeLaneDisabledError);
  });

  it('refuses code work when the breaker is explicitly false', () => {
    expect(
      codeLaneBreakerRefusal('code', undefined, { [CODE_LANE_ENABLED_ENV]: 'false' }),
    ).toBeInstanceOf(CodeLaneDisabledError);
  });

  it('governs only the coding lane', () => {
    for (const stepType of ['ai', 'api', 'compute', 'memory', 'user', 'ui', 'mcp']) {
      expect(codeLaneBreakerRefusal(stepType, undefined, {})).toBeUndefined();
    }
  });

  it('lets code work through once an operator enabled it', () => {
    expect(
      codeLaneBreakerRefusal('code', undefined, { [CODE_LANE_ENABLED_ENV]: 'true' }),
    ).toBeUndefined();
  });

  it('names the operation it refused', () => {
    const refusal = codeLaneBreakerRefusal('code', 'operation code.agent.run', {});
    expect(refusal?.message).toContain('code.agent.run');
    expect(refusal?.message).toContain(CODE_LANE_ENABLED_ENV);
  });
});

describe('CodeLaneDisabledError classification', () => {
  it('is a non-retryable permission refusal, not an outage', () => {
    const error = new CodeLaneDisabledError().toAflowError();
    expect(error.classification).toBe('permission');
    expect(error.retryable).toBe(false);
  });

  it('reaches an agent as permission + retry:false', () => {
    // The classification is load-bearing: `toAgentToolError` is what turns it
    // into an answer the agent responds to with signal_blocked rather than a
    // failure it retries.
    const agentError = toAgentToolError(new CodeLaneDisabledError().toAflowError());
    expect(agentError.error).toBe('permission');
    expect(agentError.retry).toBe(false);
  });
});
