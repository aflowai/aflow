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

/** One message of the compaction range, with the turn it was sent in. */
export interface TranscriptEntry {
  turnNumber: number;
  sourceKind?: string;
  message: AiMessageV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * A tool result as the summarizer needs it: which tool, how it ended, where
 * the full result can be read again, and what the agent was shown. The
 * envelope's bookkeeping fields stay out — pretty-printed, they outweighed
 * the content and buried it.
 */
function renderToolResult(envelope: Record<string, unknown>): string {
  const header = [
    `RESULT ${textOf(envelope['toolName'], 'tool')}`,
    textOf(envelope['status'], 'unknown'),
  ];
  if (typeof envelope['outputPath'] === 'string') {
    header.push(`re-readable at ${envelope['outputPath']}/data`);
  }
  if (typeof envelope['outputRef'] === 'string') {
    header.push(`$ref ${envelope['outputRef']}`);
  }
  const lines = [`(${header.join(' · ')})`];
  const error = envelope['error'];
  if (isRecord(error)) {
    lines.push(`error: ${textOf(error['message'], textOf(error['error'], 'unknown'))}`);
  }
  const wrote = envelope['wroteVariables'];
  if (Array.isArray(wrote) && wrote.length > 0) {
    const keys = wrote.flatMap((v) => (isRecord(v) ? [textOf(v['variableKey'], '?')] : []));
    lines.push(`wrote: ${keys.map((k) => `state.${k}`).join(', ')}`);
  }
  if (typeof envelope['summary'] === 'string' && envelope['summary'].length > 0) {
    lines.push(envelope['summary']);
  }
  return lines.join('\n');
}

/**
 * An assistant decision without what the transcript already shows: its
 * message is the text part, and its calls are the tool-call lines.
 */
function renderDecision(json: Record<string, unknown>): string | undefined {
  const { message: _message, calls: _calls, args: _args, toolId: _toolId, ...rest } = json;
  const keys = Object.keys(rest);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === 'action')) {
    return typeof rest['action'] === 'string' ? `(decision: ${rest['action']})` : undefined;
  }
  return `(decision: ${JSON.stringify(rest)})`;
}

/**
 * Serialize the range into a turn-labelled transcript for the summarizer.
 * Preserves $ref paths, re-read paths, error details and key metadata, and
 * marks clear-to-ref notes as stubs, so the summary can say what was read,
 * what was decided and what is still pending.
 */
function serializeTranscript(entries: readonly TranscriptEntry[]): string {
  const lines: string[] = [];
  let lastTurn: number | undefined;
  for (const { turnNumber, sourceKind, message: msg } of entries) {
    if (turnNumber !== lastTurn) {
      lines.push(`=== Turn ${String(turnNumber)} ===`);
      lastTurn = turnNumber;
    }
    const roleLabel =
      sourceKind === 'cleared_summary'
        ? 'CLEARED RESULT STUB'
        : msg.role === 'tool'
          ? 'TOOL'
          : msg.role.toUpperCase();
    const prefix = msg.name ? `[${roleLabel}: ${msg.name}]` : `[${roleLabel}]`;

    const contentParts: string[] = [];
    for (const part of msg.parts) {
      if (part.kind === 'text') {
        contentParts.push(part.text);
      } else if (part.kind === 'json') {
        const json = part.json;
        if (isRecord(json) && json['kind'] === 'tool_result') {
          contentParts.push(renderToolResult(json));
        } else if (isRecord(json) && msg.role === 'assistant') {
          const decision = renderDecision(json);
          if (decision !== undefined) contentParts.push(decision);
        } else if (!(isRecord(json) && json['kind'] === 'cleared_observation')) {
          contentParts.push(JSON.stringify(json));
        }
      } else if (part.kind === 'ref') {
        contentParts.push(`[ref: ${part.ref}${part.summary ? ` — ${part.summary}` : ''}]`);
      } else {
        contentParts.push(
          `[image: ${String(part.width)}×${String(part.height)} ${part.contentType}${part.description ? ` — ${part.description}` : ''}]`,
        );
      }
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      const tcSummaries = msg.toolCalls.map(
        (tc) =>
          `  → CALL ${tc.name}(${typeof tc.argumentsJson === 'string' ? tc.argumentsJson : JSON.stringify(tc.argumentsJson)})`,
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
 * Rules both prompts share. They name the three things a resumed agent needs
 * from a summary: what it read, what it decided, what it left pending.
 */
function sharedRules(maxTokens: number): string {
  return `- **Keep what was read**: for every source the agent read, name it (tool and path or query) and state the facts the agent took from it. Copy every re-read path ("re-readable at …") and every {"$ref": "…"} verbatim, so the agent can read the full result again instead of repeating the call.
- **Keep what was decided**: every decision the agent or a person made, with its reason and any value it fixed. A decision a later turn reversed appears once, as reversed.
- **Keep what is left pending**: every open item, unanswered question, promised step and call whose result had not arrived. Say which turn raised each one.
- **Preserve specific values**: exact numbers, identifiers, file paths, error messages and parameter values. Never write "the results were good" — write "XGBoost RMSLE: 0.11255".
- **Preserve error details**: the exact error and its cause, so the agent does not repeat the mistake.
- **Treat stubs as pointers**: a CLEARED RESULT STUB stands for a result removed earlier. Keep its tool, its arguments and its read path. Do not invent its content.
- **Be concise but complete**: target ~${String(maxTokens)} tokens. Every sentence carries information.`;
}

/**
 * Build the summarization prompt for fresh compaction (first time).
 */
export function buildSummarizationPrompt(
  entries: readonly TranscriptEntry[],
  pinnedState: PinnedState,
  template: SummaryTemplate,
  compressedTurnRange: [number, number],
): string {
  const transcript = serializeTranscript(entries);
  const sectionInstructions = renderSectionInstructions(template);
  const pinnedBlock = renderPinnedStateForSummarizer(pinnedState);

  return `You are a conversation summarizer for an AI agent workflow system.

## Task
Summarize the following conversation transcript (turns ${String(compressedTurnRange[0])}–${String(compressedTurnRange[1])}) into structured sections. This summary replaces the original messages in the agent's context window. The agent continues its work from the summary and the most recent turns alone, so the summary must hold everything it needs from these turns.

## Critical rules
${sharedRules(template.maxTokens)}
- **Do NOT duplicate pinned state**: the following facts are already captured separately and should NOT be repeated in the summary:

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
  newEntries: readonly TranscriptEntry[],
  pinnedState: PinnedState,
  previousSummary: string,
  template: SummaryTemplate,
  newTurnRange: [number, number],
): string {
  const transcript = serializeTranscript(newEntries);
  const sectionInstructions = renderSectionInstructions(template);
  const pinnedBlock = renderPinnedStateForSummarizer(pinnedState);

  return `You are a conversation summarizer for an AI agent workflow system.

## Task
Update an existing conversation summary with new turns (${String(newTurnRange[0])}–${String(newTurnRange[1])}). Do NOT re-summarize the existing summary from scratch — merge the new information into the existing sections.

## Critical rules
- **Merge, don't re-summarize**: add what the new turns read, decided and did to the matching sections. Remove a pending item the new turns resolved, and record how it was resolved. Keep every pending item they did not resolve.
${sharedRules(template.maxTokens)}
- **Do not grow without bound**: if a result supersedes an earlier one, update the entry rather than appending.
- **Do NOT duplicate pinned state**:

${pinnedBlock}

## Section structure

${sectionInstructions}
${template.emphasisInstructions ? `## Additional emphasis\n${template.emphasisInstructions}\n` : ''}
## Existing summary (to be updated)

${previousSummary}

## New turns to merge (${String(newTurnRange[0])}–${String(newTurnRange[1])})

${transcript}`;
}
