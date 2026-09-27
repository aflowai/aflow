import { describe, expect, it } from 'vitest';
import { buildTimeoutTeaching } from '../timeoutTeaching.js';

const WORKSPACE_CLAUSE = 'writes to /workspace/ before the kill were flushed to Memory';

describe('buildTimeoutTeaching', () => {
  it('explicit limits.timeoutSeconds: names the knob, the space max, and the fix', () => {
    const msg = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: 3600,
      source: { kind: 'explicit', requestedSeconds: 600 },
      workspaceEnabled: false,
    });
    expect(msg).toContain('limits.timeoutSeconds');
    expect(msg).toContain('600');
    expect(msg).toContain('3600');
    expect(msg).toContain('limits: { timeoutSeconds: <n> }');
    expect(msg).not.toContain(WORKSPACE_CLAUSE);
  });

  it("runtimePreset: names the preset as the limit's origin, the space max, and the fix", () => {
    const msg = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: 3600,
      source: { kind: 'preset', presetName: 'ml-training', presetSeconds: 1800 },
      workspaceEnabled: false,
    });
    expect(msg).toContain("runtimePreset 'ml-training'");
    expect(msg).toContain('1800');
    expect(msg).toContain('3600');
    expect(msg).toContain('limits: { timeoutSeconds: <n> }');
    expect(msg).not.toContain(WORKSPACE_CLAUSE);
  });

  it('default: names the default as the origin, the space max, and the fix', () => {
    const msg = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: 3600,
      source: { kind: 'default', defaultSeconds: 180 },
      workspaceEnabled: false,
    });
    expect(msg).toContain('the default');
    expect(msg).toContain('180');
    expect(msg).toContain('3600');
    expect(msg).toContain('limits: { timeoutSeconds: <n> }');
    expect(msg).not.toContain(WORKSPACE_CLAUSE);
  });

  it('request at/above the policy ceiling: points at the space admin, not the knob', () => {
    const msg = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: 900,
      source: { kind: 'explicit', requestedSeconds: 3600 },
      workspaceEnabled: false,
    });
    expect(msg).toContain('maxExecutionSeconds');
    expect(msg).toContain('900');
    expect(msg).toContain('3600');
    expect(msg).toContain('space admin');
    expect(msg).not.toContain('limits: { timeoutSeconds: <n> }');
    expect(msg).not.toContain(WORKSPACE_CLAUSE);
  });

  it('workspace-enabled run: appends the flush-survives-the-kill clause after the knob teaching', () => {
    const msg = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: 3600,
      source: { kind: 'preset', presetName: 'ml-training', presetSeconds: 1800 },
      workspaceEnabled: true,
    });
    expect(msg).toContain('limits: { timeoutSeconds: <n> }');
    expect(msg).toContain(WORKSPACE_CLAUSE);
    expect(msg).toContain('workspaceFlush');
    expect(msg).toContain('resume from it instead of restarting');
  });

  it('workspace-enabled run at the policy ceiling: appends the clause after the admin pointer', () => {
    const msg = buildTimeoutTeaching({
      policyMaxTimeoutSeconds: 900,
      source: { kind: 'explicit', requestedSeconds: 3600 },
      workspaceEnabled: true,
    });
    expect(msg).toContain('space admin');
    expect(msg).toContain(WORKSPACE_CLAUSE);
    expect(msg).toContain('workspaceFlush');
  });
});
