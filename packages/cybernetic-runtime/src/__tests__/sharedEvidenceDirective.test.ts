import { describe, expect, it } from 'vitest';
import type { EntityDirectives } from '@aflow/schemas';
import { CYBERNETIC_AGENTS, SHARED_EVIDENCE_DIRECTIVE } from '@aflow/platform-artifacts';
import { assembleHelmsmanPrompt } from '../helmsmanPrompt.js';

// A sentinel phrase from the shared directive — if the directive text is
// edited, keep a stable clause here so the presence check keeps meaning.
const SENTINEL = 'Ground every conclusion in evidence';

function systemPromptForFlow(flowId: string): string {
  const flow = CYBERNETIC_AGENTS.find((f) => f.flowId === flowId);
  if (!flow) throw new Error(`flow ${flowId} not found`);
  for (const step of flow.steps) {
    const config = step.config as { systemPrompt?: unknown } | undefined;
    if (typeof config?.systemPrompt === 'string' && config.systemPrompt.includes(SENTINEL)) {
      return config.systemPrompt;
    }
  }
  // Return the first agent-step prompt so a missing directive fails loudly.
  const firstAgent = flow.steps.find(
    (s) => typeof (s.config as { systemPrompt?: unknown } | undefined)?.systemPrompt === 'string',
  );
  return String((firstAgent?.config as { systemPrompt?: unknown } | undefined)?.systemPrompt ?? '');
}

const directives: EntityDirectives = {
  responsibility: 'General-purpose workspace for testing.',
  priorities: [],
  style: '',
} as unknown as EntityDirectives;

describe('shared evidence-grounding directive (Plan 237 #1)', () => {
  it('the directive constant carries the evidence-grounding ontology', () => {
    expect(SHARED_EVIDENCE_DIRECTIVE).toContain(SENTINEL);
    expect(SHARED_EVIDENCE_DIRECTIVE.toLowerCase()).toContain('confirm');
    expect(SHARED_EVIDENCE_DIRECTIVE.toLowerCase()).toContain('withhold');
  });

  it('appears in the Runner assembled system prompt', () => {
    expect(systemPromptForFlow('cybernetic-runner')).toContain(SENTINEL);
  });

  it('appears in the Coach assembled system prompt', () => {
    expect(systemPromptForFlow('cybernetic-coach')).toContain(SENTINEL);
  });

  it('appears in the Helmsman assembled (live) system prompt', () => {
    const prompt = assembleHelmsmanPrompt({
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
    });
    expect(prompt).toContain(SENTINEL);
  });

  it('is one directive shared by all three roles (identical text)', () => {
    const runner = systemPromptForFlow('cybernetic-runner');
    const coach = systemPromptForFlow('cybernetic-coach');
    const helmsman = assembleHelmsmanPrompt({
      spaceName: 'Test space',
      directives,
      selfModel: undefined,
    });
    for (const prompt of [runner, coach, helmsman]) {
      expect(prompt).toContain(SHARED_EVIDENCE_DIRECTIVE);
    }
  });
});
