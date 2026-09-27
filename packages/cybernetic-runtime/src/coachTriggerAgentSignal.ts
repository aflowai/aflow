import type { RunnerReflection } from '@aflow/schemas';

export interface AgentSignalCoachActivation {
  activate: true;
  source: 'agent_signal';
  reason: string;
}

export function checkAgentSignalCoachActivation(input: {
  reflections: readonly RunnerReflection[];
}): AgentSignalCoachActivation | null {
  for (const reflection of input.reflections) {
    const condition = reflection.condition;
    if (!condition) continue;

    if (condition.disposition === 'struggling') {
      return {
        activate: true,
        source: 'agent_signal',
        reason:
          `agent condition on task "${reflection.taskId}": disposition=${condition.disposition} ` +
          `(complexity=${condition.complexity}, progress=${condition.progress})`,
      };
    }
  }
  return null;
}
