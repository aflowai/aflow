import type { AiMessageV1, PinnedState, SummaryTemplate } from '@aflow/schemas';
import { DEFAULT_SUMMARY_SECTIONS } from '@aflow/schemas';

// ============================================================================
// Template rendering
// ============================================================================

/**
 * Render section headings + per-section instructions for the summarizer.
 */
function renderSectionInstructions(template: SummaryTemplate): string {
  const sections = template.sections.length > 0 ? template.sections : DEFAULT_SUMMARY_SECTIONS;
  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`### ${section.heading}`);
    lines.push(`Instructions: ${section.prompt}`);
    if (!section.required) {
      lines.push('(This section is optional — omit if nothing applies.)');
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Render pinned state as a "do not duplicate" block for the summarizer.
 */
function renderPinnedStateForSummarizer(pinned: PinnedState): string {
  const parts: string[] = [];
  if (pinned.objective) {
    parts.push(`- Objective: ${pinned.objective}`);
  }
  if (pinned.activeSubGoal) {
    parts.push(`- Active sub-goal: ${pinned.activeSubGoal}`);
  }
  if (pinned.activeRefs && pinned.activeRefs.length > 0) {
    for (const ref of pinned.activeRefs) {
      parts.push(
        `- Active ref: ${ref.ref} — ${ref.description} (from turn ${String(ref.fromTurn)})`,
      );
    }
  }
  if (pinned.writtenVariables && pinned.writtenVariables.length > 0) {
    for (const v of pinned.writtenVariables) {
      parts.push(`- Variable: ${v.variableKey}${v.summary ? ` — ${v.summary}` : ''}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : '(none)';
}

// ============================================================================
// Message serialization for summarizer input
// ============================================================================

/**
 * Serialize messages into a readable transcript for the summarizer.
 * Preserves $ref paths, error details, and key metadata.
 */
function serializeMessagesForSummarizer(messages: AiMessageV1[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const roleLabel = msg.role.toUpperCase();
    const prefix = msg.name ? `[${roleLabel}: ${msg.name}]` : `[${roleLabel}]`;

    const contentParts: string[] = [];
    for (const part of msg.parts) {
      if (part.kind === 'text') {
        contentParts.push(part.text);
      } else if (part.kind === 'json') {
        contentParts.push(JSON.stringify(part.json, null, 2));
      } else if (part.kind === 'ref') {
        contentParts.push(`[ref: ${part.ref}${part.summary ? ` — ${part.summary}` : ''}]`);
      }
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const tcSummaries = msg.toolCalls.map(
        (tc) =>
          `  → ${tc.name}(${typeof tc.argumentsJson === 'string' ? tc.argumentsJson : JSON.stringify(tc.argumentsJson)})`,
      );
      contentParts.push(tcSummaries.join('\n'));
    }

    lines.push(`${prefix}\n${contentParts.join('\n')}`);
  }
  return lines.join('\n\n');
}

// ============================================================================
// Prompt builders
// ============================================================================

/**
 * Build the summarization prompt for fresh compaction (first time).
 */
export function buildSummarizationPrompt(
  messages: AiMessageV1[],
  pinnedState: PinnedState,
  template: SummaryTemplate,
  compressedTurnRange: [number, number],
): string {
  const transcript = serializeMessagesForSummarizer(messages);
  const sectionInstructions = renderSectionInstructions(template);
  const pinnedBlock = renderPinnedStateForSummarizer(pinnedState);

  return `You are a conversation summarizer for an AI agent workflow system.

## Task
Summarize the following conversation transcript (turns ${String(compressedTurnRange[0])}–${String(compressedTurnRange[1])}) into structured sections. This summary will replace the original messages in the agent's context window, so it must preserve all information the agent needs to continue working effectively.

## Critical rules
1. **Preserve specific values**: Include exact numbers, metrics, file paths, error messages, and parameter values. Never generalize "the model achieved good results" — say "XGBoost RMSLE: 0.11255".
2. **Preserve all $ref paths**: Any reference like {"$ref": "output.abc123/content"} MUST appear verbatim in the summary. These are live data references the agent needs.
3. **Preserve error details**: Include exact error messages and what caused them. The agent must not repeat past mistakes.
4. **Be concise but complete**: Target ~${String(template.maxTokens)} tokens. Every sentence should carry information.
5. **Do NOT duplicate pinned state**: The following facts are already captured separately and should NOT be repeated in the summary:

${pinnedBlock}

## Output format
Write markdown with the following sections:

${sectionInstructions}
${template.emphasisInstructions ? `## Additional emphasis\n${template.emphasisInstructions}\n` : ''}
## Conversation transcript to summarize

${transcript}`;
}

/**
 * Build the merge prompt for incremental compaction (2nd+ time).
 * Updates existing sections rather than re-summarizing from scratch.
 */
export function buildMergePrompt(
  newMessages: AiMessageV1[],
  pinnedState: PinnedState,
  previousSummary: string,
  template: SummaryTemplate,
  newTurnRange: [number, number],
): string {
  const transcript = serializeMessagesForSummarizer(newMessages);
  const sectionInstructions = renderSectionInstructions(template);
  const pinnedBlock = renderPinnedStateForSummarizer(pinnedState);

  return `You are a conversation summarizer for an AI agent workflow system.

## Task
Update an existing conversation summary with new turns (${String(newTurnRange[0])}–${String(newTurnRange[1])}). Do NOT re-summarize the existing summary from scratch — merge the new information into the existing sections.

## Critical rules
1. **Merge, don't re-summarize**: Add new accomplishments to "What Was Accomplished", update "Current Focus" to reflect the latest state, append new mistakes to "Mistakes & Lessons Learned", etc.
2. **Preserve specific values**: Include exact numbers, metrics, $ref paths, error messages, parameter values.
3. **Preserve all $ref paths**: Any {"$ref": "..."} must appear verbatim.
4. **Be concise**: The merged summary should not grow unboundedly. If an accomplishment is superseded by a better result, update the entry rather than appending.
5. **Do NOT duplicate pinned state**:

${pinnedBlock}

## Section structure

${sectionInstructions}
${template.emphasisInstructions ? `## Additional emphasis\n${template.emphasisInstructions}\n` : ''}
## Existing summary (to be updated)

${previousSummary}

## New turns to merge (${String(newTurnRange[0])}–${String(newTurnRange[1])})

${transcript}`;
}
