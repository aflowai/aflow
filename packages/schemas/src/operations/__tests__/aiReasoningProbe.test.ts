import { describe, expect, it } from 'vitest';
import { bundleForOperation } from '../../catalog/capabilityBundles.js';
import { buildOperationId } from '../../catalog/operationId.js';
import { getOperation } from '../../catalog/registry.js';
import { AiModelProbeReasoningInputSchema } from '../aiReasoningProbe.js';

const OPERATION_ID = buildOperationId('ai', 'model', 'probe_reasoning');

function refusal(input: unknown): string {
  const parsed = AiModelProbeReasoningInputSchema.safeParse(input);
  expect(parsed.success).toBe(false);
  return parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('\n');
}

describe('ai.model.probe_reasoning input', () => {
  it('takes a model id and nothing else', () => {
    expect(AiModelProbeReasoningInputSchema.parse({ model: ' gemini-3.8-flash ' })).toEqual({
      model: 'gemini-3.8-flash',
    });
  });

  it('refuses a key passed as input, saying the stored credential is used', () => {
    const message = refusal({ model: 'gemini-3.8-flash', apiKey: 'sk-live' });
    expect(message).toMatch(/takes only `model`/);
    expect(message).toMatch(/credential this space already stores/);
  });

  it('refuses a missing or blank model, naming how one is spelled', () => {
    expect(refusal({})).toMatch(/Required/);
    expect(refusal({ model: '   ' })).toMatch(/"gpt-6\.1-sol"/);
  });
});

describe('ai.model.probe_reasoning registration', () => {
  const op = getOperation(OPERATION_ID);

  it('is registered on the AI executor in its own capability group', () => {
    expect(op).toBeDefined();
    expect(op?.stepType).toBe('ai');
    expect(op?.capabilityGroupId).toBe('ai.model');
    expect(op?.agentTool).toBe(true);
    expect(op?.mutates).toBe(false);
  });

  it('says it spends real tokens, when to use it, and its pitfalls', () => {
    expect(op?.semanticDescription).toMatch(/SPENDS REAL TOKENS/);
    expect(op?.usage.whenToUse.length).toBeGreaterThan(0);
    expect(op?.usage.pitfalls?.join(' ')).toMatch(/real tokens/);
    expect(op?.usage.pitfalls?.join(' ')).toMatch(/no key can be passed/);
    expect(AiModelProbeReasoningInputSchema.safeParse(op?.usage.minimalExampleInput).success).toBe(
      true,
    );
  });

  it('belongs to an operator-visible capability bundle', () => {
    expect(bundleForOperation(OPERATION_ID)?.id).toBe('model_measurement');
  });
});
