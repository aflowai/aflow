import { describe, expect, it } from 'vitest';
import { CYBERNETIC_AGENTS } from '@aflow/platform-artifacts';
import { isInlineOperation } from '../inlineOperations.js';
import { applySubmitOutputToolSchema } from '../submitOutputToolSchema.js';
import { AgentStepConfigSchema, type AgentToolSpec } from '@aflow/schemas';

const runner = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-runner');
const steps = (runner?.steps ?? []) as Array<{
  stepId: string;
  operation?: string;
  onSuccess?: { next?: { stepId: string }[] };
  onFailure?: { next?: { stepId: string }[] };
}>;
const DRAFT_STEPS = ['draft_patch', 'draft_get'];

describe('the draft tools sit where submit_output sits', () => {
  it('is reachable from the same edges, so it exists wherever submitting does', () => {
    const execute = steps.find((s) => s.stepId === 'execute');
    const targets = (execute?.onSuccess?.next ?? []).map((n) => n.stepId);
    expect(targets).toContain('submit_output');
    for (const id of DRAFT_STEPS) expect(targets).toContain(id);
  });

  it('routes failure back to the agent turn', () => {
    // A graph tool whose failure edge targets a non-agent step gets no feedback
    // and increments no counter — the silent-forever loop.
    for (const id of DRAFT_STEPS) {
      const step = steps.find((s) => s.stepId === id);
      expect(step?.onFailure?.next?.[0]?.stepId, `${id} onFailure`).toBe('execute');
      expect(step?.onSuccess?.next?.[0]?.stepId, `${id} onSuccess`).toBe('execute');
    }
  });

  it('is routed inline, not dispatched to an executor', () => {
    // A graph step whose operation no inline classifier claims is sent to an
    // executor for its stepType, and fails with "no executor available".
    for (const id of DRAFT_STEPS) {
      const op = steps.find((s) => s.stepId === id)?.operation;
      expect(op, `${id} operation`).toBeDefined();
      expect(isInlineOperation(op!), `${op} inline`).toBe(true);
    }
  });
});

describe('the submit tool takes no result', () => {
  it('offers only a summary, so the draft is the sole way to produce an output', () => {
    const tools = [{ toolId: 'submit_output', inputSchema: {} }] as unknown as AgentToolSpec[];
    applySubmitOutputToolSchema(tools, undefined);
    const schema = tools[0]!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    // A literal `result` is the door back to emitting everything in one
    // message, which is the behaviour the draft exists to remove.
    expect(Object.keys(schema.properties)).toEqual(['summary']);
    expect(schema.required).toBeUndefined();
  });

  it('names the contract fields on the draft tool without inlining the schema', () => {
    const tools = [
      { toolId: 'submit_output', inputSchema: {} },
      { toolId: 'draft_patch', inputSchema: {} },
    ] as unknown as AgentToolSpec[];
    const contract = {
      type: 'object',
      properties: { cases: { type: 'array' }, rationale: { type: 'string' } },
    };
    applySubmitOutputToolSchema(tools, contract);
    const description = (tools[1]!.inputSchema as Record<string, unknown>)['description'] as string;

    expect(description).toContain('cases, rationale');
    // Inlining the whole schema here cost 5.4k of a 7.3k tool budget live.
    expect(description).not.toContain('"type"');
    expect(description.length).toBeLessThan(400);
  });
});

describe('every agent carries its reasoning across the tool loop', () => {
  // The Runner sets nothing: this is the platform default, so an agent that
  // reasons its way to a tool call can still see that reasoning when the
  // result comes back. It was 'off', and a Runner that had planned twelve
  // cases inside its reasoning re-sent its opening move 130 times.
  it('defaults to auto rather than off', () => {
    const parsed = AgentStepConfigSchema.parse({});
    expect(parsed.reasoningContinuity).toBe('auto');
  });

  it('leaves the Runner to the default rather than pinning a mode', () => {
    const execute = steps.find((s) => s.stepId === 'execute') as
      { config?: Record<string, unknown> } | undefined;
    expect(execute?.config?.['reasoningContinuity']).toBeUndefined();
  });
});
