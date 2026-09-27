/**
 * A space policy is an operator's decision about a runtime that exists. Where
 * none does, storing the decision leaves a workspace permitting sandboxed code
 * and no way to run it — the same dead end the policy gate prevents, one layer
 * along, and measurably so: on an appliance with the policy switched on, a
 * request for sandboxed code promoted the tool, never called it, and answered
 * from the model's own knowledge instead.
 *
 * The appliance ships without the sandbox because it needs the host Docker
 * daemon, so `computeRuntime` is what the profile adding it declares.
 */
import { describe, expect, it } from 'vitest';
import { resolveEditionDescriptor } from '@aflow/schemas';

const LOCAL = {
  PHOENIX_EDITION: 'community-local',
  PHOENIX_INSTANCE_SECRET: 'x'.repeat(40),
} as NodeJS.ProcessEnv;

describe('computeRuntime', () => {
  it('is absent on an appliance that has not opted in', () => {
    expect(resolveEditionDescriptor(LOCAL).computeRuntime).toBe('absent');
  });

  it('is present once the compute profile declares it', () => {
    expect(
      resolveEditionDescriptor({ ...LOCAL, PHOENIX_COMPUTE_RUNTIME: 'present' }).computeRuntime,
    ).toBe('present');
  });

  /** Anything other than the opt-in reads as no runtime, never as a maybe. */
  it('treats an unrecognised value as absent', () => {
    for (const value of ['', 'yes', 'true', 'PRESENT']) {
      expect(
        resolveEditionDescriptor({ ...LOCAL, PHOENIX_COMPUTE_RUNTIME: value }).computeRuntime,
      ).toBe('absent');
    }
  });

  /**
   * The hosted deployment runs the sandbox on its own host, reached through the
   * job stream rather than by sitting beside the orchestrator.
   */
  it('is present for the hosted edition', () => {
    expect(resolveEditionDescriptor({ PHOENIX_EDITION: 'enterprise' }).computeRuntime).toBe(
      'present',
    );
  });

  /**
   * Stopping the compute host is a documented cost lever there, and an instance
   * reporting a runtime it has shut down permits a policy nothing will serve.
   */
  it('lets the hosted edition declare its compute host stopped', () => {
    expect(
      resolveEditionDescriptor({ PHOENIX_EDITION: 'enterprise', PHOENIX_COMPUTE_RUNTIME: 'absent' })
        .computeRuntime,
    ).toBe('absent');
  });
});
