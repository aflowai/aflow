import { describe, it, expect } from 'vitest';
import type { GuardrailPolicy } from '@aflow/schemas';
import { compilePolicies, type CompileContext } from '../policyCompiler.js';

function makePolicy(overrides: Partial<GuardrailPolicy> = {}): GuardrailPolicy {
  return {
    policyId: 'test-policy',
    name: 'Test Policy',
    version: '1',
    scope: { platform: false },
    rails: [
      {
        railId: 'test-rail',
        name: 'Test Rail',
        layer: 'rule',
        trigger: 'on_agent_turn_output',
        mode: 'blocking',
        type: 'blocklist',
        config: { terms: ['test'] },
        onViolation: 'block',
        priority: 100,
        enabled: true,
      },
    ],
    settings: {
      defaultFailBehavior: 'fail_closed',
      maxLatencyMs: 5000,
      logMode: 'violations_only',
      logSampleRate: 0.1,
    },
    ...overrides,
  };
}

const defaultContext: CompileContext = {
  tenantId: 'test-tenant',
  targetKey: 'test-flow',
};

describe('compilePolicies', () => {
  it('compiles a single policy correctly', () => {
    const policy = makePolicy({
      scope: { platform: true },
    });
    const result = compilePolicies([policy], defaultContext);

    expect(result.policyIds).toEqual(['test-policy']);
    expect(result.byTrigger.on_agent_turn_output).toHaveLength(1);
    expect(result.byTrigger.on_agent_turn_output[0]!.railId).toBe('test-rail');
    expect(result.byTrigger.on_agent_turn_output[0]!.policyId).toBe('test-policy');
  });

  it('narrower scope wins on railId collision', () => {
    const platformPolicy = makePolicy({
      policyId: 'platform-policy',
      scope: { platform: true },
      rails: [
        {
          railId: 'shared-rail',
          name: 'Platform Rail',
          layer: 'rule',
          trigger: 'on_run_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['platform'] },
          onViolation: 'warn',
          priority: 100,
          enabled: true,
        },
      ],
    });

    const flowPolicy = makePolicy({
      policyId: 'flow-policy',
      scope: { platform: false, flowIds: ['test-flow'] },
      rails: [
        {
          railId: 'shared-rail', // Same railId — flow scope should win
          name: 'Flow Rail',
          layer: 'rule',
          trigger: 'on_run_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['flow-specific'] },
          onViolation: 'block',
          priority: 50,
          enabled: true,
        },
      ],
    });

    const result = compilePolicies([platformPolicy, flowPolicy], defaultContext);

    // Flow scope wins — the rail should have flow-specific config and 'block' action
    expect(result.byTrigger.on_run_input).toHaveLength(1);
    expect(result.byTrigger.on_run_input[0]!.policyId).toBe('flow-policy');
    expect(result.byTrigger.on_run_input[0]!.onViolation).toBe('block');
  });

  it('platform safety floor cannot be overridden', () => {
    const platformPolicy = makePolicy({
      policyId: 'platform-safety',
      scope: { platform: true },
      rails: [
        {
          railId: 'safety-rail',
          name: 'Safety Rail',
          layer: 'rule',
          trigger: 'on_agent_turn_output',
          mode: 'blocking',
          type: 'tool_denylist',
          config: { denied: ['dangerous.op'] },
          onViolation: 'block', // Platform block = safety floor
          priority: 0,
          enabled: true,
        },
      ],
    });

    const flowPolicy = makePolicy({
      policyId: 'flow-override',
      scope: { platform: false, flowIds: ['test-flow'] },
      rails: [
        {
          railId: 'safety-rail', // Same railId — tries to override
          name: 'Flow Override',
          layer: 'rule',
          trigger: 'on_agent_turn_output',
          mode: 'blocking',
          type: 'tool_denylist',
          config: { denied: [] }, // Tries to allow everything
          onViolation: 'warn', // Tries to downgrade to warn
          priority: 100,
          enabled: true,
        },
      ],
    });

    const result = compilePolicies([platformPolicy, flowPolicy], defaultContext);

    // Platform safety floor wins — onViolation stays 'block'
    expect(result.byTrigger.on_agent_turn_output).toHaveLength(1);
    expect(result.byTrigger.on_agent_turn_output[0]!.policyId).toBe('platform-safety');
    expect(result.byTrigger.on_agent_turn_output[0]!.onViolation).toBe('block');
  });

  it('sorts rails by priority within trigger group', () => {
    const policy = makePolicy({
      scope: { platform: true },
      rails: [
        {
          railId: 'high-prio',
          name: 'High Priority',
          layer: 'rule',
          trigger: 'on_tool_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['x'] },
          onViolation: 'block',
          priority: 10,
          enabled: true,
        },
        {
          railId: 'low-prio',
          name: 'Low Priority',
          layer: 'rule',
          trigger: 'on_tool_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['y'] },
          onViolation: 'block',
          priority: 200,
          enabled: true,
        },
        {
          railId: 'mid-prio',
          name: 'Mid Priority',
          layer: 'rule',
          trigger: 'on_tool_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['z'] },
          onViolation: 'block',
          priority: 100,
          enabled: true,
        },
      ],
    });

    const result = compilePolicies([policy], defaultContext);

    expect(result.byTrigger.on_tool_input.map((r) => r.railId)).toEqual([
      'high-prio',
      'mid-prio',
      'low-prio',
    ]);
  });

  it('disabled rails are excluded', () => {
    const policy = makePolicy({
      scope: { platform: true },
      rails: [
        {
          railId: 'enabled-rail',
          name: 'Enabled',
          layer: 'rule',
          trigger: 'on_run_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['test'] },
          onViolation: 'block',
          priority: 100,
          enabled: true,
        },
        {
          railId: 'disabled-rail',
          name: 'Disabled',
          layer: 'rule',
          trigger: 'on_run_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['test2'] },
          onViolation: 'block',
          priority: 100,
          enabled: false,
        },
      ],
    });

    const result = compilePolicies([policy], defaultContext);
    expect(result.byTrigger.on_run_input).toHaveLength(1);
    expect(result.byTrigger.on_run_input[0]!.railId).toBe('enabled-rail');
  });

  it('non-matching scope policies are filtered out', () => {
    const policy = makePolicy({
      scope: { platform: false, flowIds: ['other-flow'] },
    });

    const result = compilePolicies([policy], defaultContext);
    expect(result.policyIds).toEqual([]);
    expect(result.byTrigger.on_agent_turn_output).toHaveLength(0);
  });

  it('resolves failBehavior: per-rail > policy default > layer default', () => {
    const policy = makePolicy({
      scope: { platform: true },
      settings: {
        defaultFailBehavior: 'fail_open',
        maxLatencyMs: 5000,
        logMode: 'violations_only',
        logSampleRate: 0.1,
      },
      rails: [
        {
          railId: 'rail-with-explicit-fail',
          name: 'Explicit Fail',
          layer: 'rule',
          trigger: 'on_run_input',
          mode: 'blocking',
          type: 'blocklist',
          config: {},
          onViolation: 'block',
          priority: 100,
          enabled: true,
          failBehavior: 'fail_closed', // Explicit per-rail
        },
        {
          railId: 'rail-with-policy-default',
          name: 'Policy Default',
          layer: 'rule',
          trigger: 'on_run_output',
          mode: 'blocking',
          type: 'blocklist',
          config: {},
          onViolation: 'block',
          priority: 100,
          enabled: true,
          // No failBehavior — should use policy default (fail_open)
        },
      ],
    });

    const result = compilePolicies([policy], defaultContext);

    const railExplicit = result.byTrigger.on_run_input[0];
    expect(railExplicit?.failBehavior).toBe('fail_closed');

    const railDefault = result.byTrigger.on_run_output[0];
    expect(railDefault?.failBehavior).toBe('fail_open');
  });

  it('uses winning scope trigger on railId collision (BUG 4 regression)', () => {
    const platformPolicy = makePolicy({
      policyId: 'platform-policy',
      scope: { platform: true },
      rails: [
        {
          railId: 'shared-rail',
          name: 'Platform Rail',
          layer: 'rule',
          trigger: 'on_run_input',
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['platform'] },
          onViolation: 'warn',
          priority: 100,
          enabled: true,
        },
      ],
    });

    const flowPolicy = makePolicy({
      policyId: 'flow-policy',
      scope: { platform: false, flowIds: ['test-flow'] },
      rails: [
        {
          railId: 'shared-rail',
          name: 'Flow Rail',
          layer: 'rule',
          trigger: 'on_tool_input', // Different trigger than platform
          mode: 'blocking',
          type: 'blocklist',
          config: { terms: ['flow-specific'] },
          onViolation: 'block',
          priority: 50,
          enabled: true,
        },
      ],
    });

    const result = compilePolicies([platformPolicy, flowPolicy], defaultContext);

    // Flow scope wins — rail should be in on_tool_input (flow trigger), NOT on_run_input (platform trigger)
    expect(result.byTrigger.on_tool_input).toHaveLength(1);
    expect(result.byTrigger.on_tool_input[0]!.policyId).toBe('flow-policy');
    expect(result.byTrigger.on_run_input).toHaveLength(0);
  });
});
