import { describe, expect, it } from 'vitest';
import type { WorkflowTask } from '@aflow/schemas';
import { materializeAndValidateSkillConfig } from '../skillValidity/skillValidity.js';

function decide(template: Record<string, unknown>): WorkflowTask {
  return {
    taskId: 'triage',
    name: 'Triage',
    goal: 'Run ai.decision.decide.',
    type: 'operation',
    operation: 'ai.decision.decide',
    inputTemplate: { state: 'A ticket', ...template },
  };
}

const QUESTIONS = {
  team: { type: 'choice', options: { billing: null, technical: null }, minConfidence: 0.8 },
};

function codes(task: WorkflowTask) {
  const { validity } = materializeAndValidateSkillConfig({ tasks: [task] });
  return {
    errors: validity.diagnostics.map((d) => d.code),
    advisories: validity.advisories.map((d) => d.code),
  };
}

describe('a decision step is checked against the model it names', () => {
  it('refuses images sent to a model that reads none', () => {
    const result = codes(
      decide({
        model: 'jev',
        questions: QUESTIONS,
        images: [{ path: '/media/x.png', version: 1, contentHash: 'h' }],
      }),
    );
    expect(result.errors).toContain('decision_model_reads_no_images');
  });

  it('advises when a threshold rests on self-reported confidence', () => {
    expect(codes(decide({ model: 'luna-decisions', questions: QUESTIONS })).advisories).toContain(
      'decision_confidence_self_reported',
    );
  });

  it('says nothing for a calibrated model, or one the space chooses', () => {
    for (const template of [{ model: 'jev', questions: QUESTIONS }, { questions: QUESTIONS }]) {
      const result = codes(decide(template));
      expect(result.advisories).not.toContain('decision_confidence_self_reported');
      expect(result.errors).not.toContain('decision_model_reads_no_images');
    }
  });
});
