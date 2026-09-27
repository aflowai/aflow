import type { AgentToolSpec } from '@aflow/schemas';

/**
 * Submitting takes no result: it sends what `draft_patch` has built.
 *
 * The task's output schema reaches the model through the system prompt's
 * Output Contract section, not through either tool here — a tool description
 * carrying a whole JSON Schema cost 5.4k of a 7.3k tool budget on a real run.
 * These descriptions name the target's top-level fields and leave the shape to
 * the contract.
 */
export function applySubmitOutputToolSchema(
  availableTools: AgentToolSpec[],
  finalOutputSchema: Record<string, unknown> | undefined,
): void {
  const submitTool = availableTools.find((t) => t.toolId === 'submit_output');
  if (!submitTool) return;

  submitTool.inputSchema = {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        maxLength: 16000,
        description: 'Optional note on what was accomplished. Not part of the task output.',
      },
    },
  };

  // The target shape is NOT pasted into the draft tool's description. Inlining
  // it cost 5.4k of a 7.3k tool budget on a real run — the contract is already
  // in the task's own instructions, and a tool description that large crowds
  // out the tools beside it.
  const draftTool = availableTools.find((t) => t.toolId === 'draft_patch');
  if (draftTool && finalOutputSchema) {
    const top = (finalOutputSchema as { properties?: Record<string, unknown> }).properties;
    const fields = top ? Object.keys(top).join(', ') : '';
    draftTool.inputSchema['description'] = fields
      ? `Build the task result here, then call submit_output (which takes no result). The finished draft has these top-level fields: ${fields}. Submitting reports anything still unmet.`
      : `Build the task result here, then call submit_output (which takes no result).`;
  }
}
