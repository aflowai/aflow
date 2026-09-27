import { describe, it, expect } from 'vitest';
import { listStagedChangeOpKinds } from '@aflow/schemas';
import { CYBERNETIC_AGENTS } from '../cyberneticAgents.js';

function getCoachPrompt(): string {
  const coach = CYBERNETIC_AGENTS.find((f) => f.flowId === 'cybernetic-coach');
  if (!coach) throw new Error('cybernetic-coach flow definition missing');
  const steps = (coach as unknown as { steps: Array<{ config?: Record<string, unknown> }> }).steps;
  for (const step of steps) {
    const prompt = step.config?.['systemPrompt'];
    if (typeof prompt === 'string' && prompt.includes('You are the Coach')) {
      return prompt;
    }
  }
  throw new Error('Coach systemPrompt not found in flow steps');
}

describe('Coach prompt drift (Plan 163 §9.3)', () => {
  it('does not author flag_pattern (advisory, not a per-run skill edit)', () => {
    const prompt = getCoachPrompt();
    // flag_pattern is no longer a Coach-authored op — the prompt must not
    // instruct or hint it (capability gaps / cross-run patterns become
    // observations or move to the aggregation surface).
    expect(prompt).not.toMatch(/flag_pattern/);
    expect(prompt).not.toContain('### flag_pattern');
  });

  it('teaches the agent about evidence.warrant (Plan 163 §6.4)', () => {
    const prompt = getCoachPrompt();
    expect(prompt).toMatch(/evidence\.warrant/);
    expect(prompt).toMatch(/expectedEffect/);
  });

  it('teaches the agent that eval changes require operator ratification (Plan 163 §8.3)', () => {
    const prompt = getCoachPrompt();
    expect(prompt).toMatch(/eval\.criterion\.add/);
    expect(prompt).toMatch(/require operator ratification/);
  });

  it('renders the schema-derived "Op field contracts" section', () => {
    const prompt = getCoachPrompt();
    // Section header — proves the renderer ran at module load.
    expect(prompt).toContain('Op field contracts (schema-derived)');
    // Spot-check several op headings rendered by `renderStagedChangeOpHints`.
    expect(prompt).toContain('### update_task_goal');
    expect(prompt).toContain('### platform_issue');
    // Field hints carry required/optional + type — the rendered shape.
    expect(prompt).toMatch(/- taskId \(string, required\)/);
  });

  it('does not teach the deleted evidence-tier gate / "brief is sufficient" model (Plan 201)', () => {
    const prompt = getCoachPrompt();
    // The Coach reads the run by default now — no tier gating, no escalation budget.
    expect(prompt).not.toMatch(/evidenceTier/);
    expect(prompt).not.toMatch(/EVIDENCE_TIER_INSUFFICIENT/);
    expect(prompt).not.toMatch(/escalation rate is monitored/i);
    expect(prompt).not.toMatch(/brief is intended to be sufficient/i);
  });

  it('only references op kinds the schema defines (closed-set drift guard)', () => {
    const prompt = getCoachPrompt();
    const valid = new Set(listStagedChangeOpKinds());

    // Scan for backtick-quoted tokens shaped like our op vocabulary:
    // snake_case (update_task_goal, add_trigger_pattern) or dotted
    // (eval.criterion.add). Tokens not matching this shape are out of
    // scope (state vars, operation ids in other namespaces, etc.).
    const opShape =
      /`((?:update|add|remove|reorder|promote|block|unblock|flag|platform|skill|capability)_[a-z_]+|eval\.criterion\.[a-z]+)`/g;
    const drifted: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = opShape.exec(prompt)) !== null) {
      const tok = m[1];
      if (tok && !valid.has(tok)) drifted.push(tok);
    }
    expect(drifted).toEqual([]);
  });
});
