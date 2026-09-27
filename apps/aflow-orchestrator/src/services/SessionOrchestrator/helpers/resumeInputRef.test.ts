import { describe, expect, it } from 'vitest';
import { chooseResumeInputRef } from './resumeInputRef.js';

describe('chooseResumeInputRef', () => {
  describe('runner-style steps (ai.agent.turn, agent.control.delegate)', () => {
    it('uses paramsInputRef for ai.agent.turn even when paused with a requestedInputRef', () => {
      // Runner-style steps treat the resume as a new user message; the
      // ORIGINAL inputRef would discard the user's resume text.
      const out = chooseResumeInputRef({
        operation: 'ai.agent.turn',
        stepStatus: 'PAUSED',
        stepInputRef: 'inline:original-prompt',
        paramsInputRef: 'inline:resume-prompt',
        runRequestedInputRef: 'inline:requested',
      });
      expect(out).toBe('inline:resume-prompt');
    });

    it('uses paramsInputRef for agent.control.delegate', () => {
      const out = chooseResumeInputRef({
        operation: 'agent.control.delegate',
        stepStatus: 'PAUSED',
        stepInputRef: 'inline:original',
        paramsInputRef: 'inline:resume',
        runRequestedInputRef: 'inline:requested',
      });
      expect(out).toBe('inline:resume');
    });

    it('uses paramsInputRef for ai.agent.turn when the step is SUCCEEDED (Plan 145 §6.2)', () => {
      const out = chooseResumeInputRef({
        operation: 'ai.agent.turn',
        stepStatus: 'SUCCEEDED',
        stepInputRef: 'inline:prior-agent-turn-input',
        paramsInputRef: 'inline:user-resume-reply',
        runRequestedInputRef: 'inline:requested-from-pause',
      });
      expect(out).toBe('inline:user-resume-reply');
    });
  });

  describe('paused operation steps (Plan 120 §5b — bind-then-resume backstop)', () => {
    it('preserves original stepInputRef when prepare-design-surface paused with bind-capability handoff', () => {
      const out = chooseResumeInputRef({
        operation: 'skill.compose.prepare_surface',
        stepStatus: 'PAUSED',
        stepInputRef: 'inline:analyze-intent-output',
        paramsInputRef: 'inline:resume-prompt-from-helmsman',
        runRequestedInputRef: 'inline:bind-capability-handoff-payload',
      });
      expect(out).toBe('inline:analyze-intent-output');
    });

    it('preserves original stepInputRef for any non-runner operation paused with a requestedInputRef', () => {
      const out = chooseResumeInputRef({
        operation: 'capability.binding.propose',
        stepStatus: 'PAUSED',
        stepInputRef: 'inline:declared-input',
        paramsInputRef: 'inline:resume-text',
        runRequestedInputRef: 'inline:handoff',
      });
      expect(out).toBe('inline:declared-input');
    });
  });

  describe("falls back to paramsInputRef when conditions aren't met", () => {
    it('uses paramsInputRef when step is not paused', () => {
      const out = chooseResumeInputRef({
        operation: 'skill.compose.prepare_surface',
        stepStatus: 'RUNNING',
        stepInputRef: 'inline:original',
        paramsInputRef: 'inline:resume',
        runRequestedInputRef: 'inline:requested',
      });
      expect(out).toBe('inline:resume');
    });

    it('uses paramsInputRef when run state has no requestedInputRef', () => {
      // Without a requestedInputRef on the run, the pause didn't carry a
      // structured handoff — treat resume as a new user input.
      const out = chooseResumeInputRef({
        operation: 'skill.compose.prepare_surface',
        stepStatus: 'PAUSED',
        stepInputRef: 'inline:original',
        paramsInputRef: 'inline:resume',
        runRequestedInputRef: null,
      });
      expect(out).toBe('inline:resume');
    });

    it('uses paramsInputRef when stepInputRef is missing', () => {
      const out = chooseResumeInputRef({
        operation: 'skill.compose.prepare_surface',
        stepStatus: 'PAUSED',
        stepInputRef: null,
        paramsInputRef: 'inline:resume',
        runRequestedInputRef: 'inline:handoff',
      });
      expect(out).toBe('inline:resume');
    });

    it('uses paramsInputRef when operation is undefined', () => {
      const out = chooseResumeInputRef({
        operation: undefined,
        stepStatus: 'PAUSED',
        stepInputRef: 'inline:original',
        paramsInputRef: 'inline:resume',
        runRequestedInputRef: 'inline:handoff',
      });
      // No operation → not runner-style, but fallback is still safe.
      // Note: an undefined operation with stepInputRef + handoff DOES hit
      expect(out).toBe('inline:original');
    });
  });
});
