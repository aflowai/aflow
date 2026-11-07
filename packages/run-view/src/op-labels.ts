/** The coding-harness operation. Its task row mounts a card that reads the task's refs. */
export const HARNESS_RUN_OPERATION = 'host.harness.run';

export const THINKING_CLASS_OPS: ReadonlySet<string> = new Set([
  'ai.agent.turn',
  'agent.control.run_step',
]);
