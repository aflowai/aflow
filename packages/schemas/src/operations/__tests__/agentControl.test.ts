import { describe, expect, it } from 'vitest';
import { AgentDelegateInputSchema, AgentResumeInputSchema } from '../../operations/agentControl.js';

describe('Agent control wait coercion', () => {
  it('coerces delegate wait="true" and wait="false" strings', () => {
    const delegateTrue = AgentDelegateInputSchema.parse({
      target: { kind: 'platform-role', systemRole: 'cybernetic-coach' },
      wait: 'true',
    });
    const delegateFalse = AgentDelegateInputSchema.parse({
      target: { kind: 'platform-role', systemRole: 'cybernetic-coach' },
      wait: 'false',
    });

    expect(delegateTrue.wait).toBe(true);
    expect(delegateFalse.wait).toBe(false);
  });

  it('coerces resume wait="true" and keeps until_pause literal', () => {
    const resumed = AgentResumeInputSchema.parse({
      childSessionId: '00000000-0000-0000-0000-000000000001',
      message: 'continue',
      wait: 'true',
    });
    const paused = AgentResumeInputSchema.parse({
      childSessionId: '00000000-0000-0000-0000-000000000001',
      message: 'continue',
      wait: 'until_pause',
    });

    expect(resumed.wait).toBe(true);
    expect(paused.wait).toBe('until_pause');
  });
});
