import type { ChatMessage } from '@aflow/ai-client';

// ============================================================================

/**
 * Counters accumulated across the message-sanitization pipeline. The sanitizers
 * are pure (no `ctx`), so they mutate this out-param and the call site emits the
 * structured fields. A spike in placeholders/relocations after a deploy is the
 * early warning that an upstream (§5/§6) regression slipped through.
 */
export interface SanitizationStats {
  /** §6: orphan tool messages converted to labelled `user` notes. */
  orphanToUserConversions: number;
  /** §6.2: raw-UUID tool results name-remapped onto a compact id. */
  rawUuidNameRemaps: number;
  /** §7.1: synthetic "result not available" placeholders injected for missing results. */
  syntheticPlaceholders: number;
  /** §7.1: tool results relocated across a non-tool message to restore adjacency. */
  resultsRelocatedAcrossNonTool: number;
}

export function emptySanitizationStats(): SanitizationStats {
  return {
    orphanToUserConversions: 0,
    rawUuidNameRemaps: 0,
    syntheticPlaceholders: 0,
    resultsRelocatedAcrossNonTool: 0,
  };
}

/** Copy shown to the model when a tool_use has no retained result. */
const TOOL_RESULT_NOT_AVAILABLE =
  'Tool result not available. The tool call has no matching result in conversation history — ' +
  'it may have been superseded or its result was lost. Do NOT retry unless the user explicitly asks.';

// ============================================================================
// Message Pre-processing (shared + native FC)
// ============================================================================

export function convertOrphanToolMessages(
  messages: ChatMessage[],
  stats?: SanitizationStats,
): ChatMessage[] {
  // Every id owned by some assistant tool_use — exact-id pairing is sound
  // against this whole set; §7.1 fixes any resulting ordering.
  const allAssistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) allAssistantToolCallIds.add(tc.id);
    }
  }

  const result: ChatMessage[] = [];

  // Per-name queues from the assistant run the current position immediately
  // follows — used ONLY for raw-UUID name-remap. Reset on any non-tool message.
  let currentNameQueues = new Map<string, string[]>();

  for (const msg of messages) {
    if (msg.role !== 'tool') {
      // Any non-tool message ends the current assistant's name-match window (§6.1).
      currentNameQueues = new Map<string, string[]>();
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          let queue = currentNameQueues.get(tc.function.name);
          if (!queue) {
            queue = [];
            currentNameQueues.set(tc.function.name, queue);
          }
          queue.push(tc.id);
        }
      }
      result.push(msg);
      continue;
    }

    // Exact ID match — sound at any distance.
    if (allAssistantToolCallIds.has(msg.toolCallId)) {
      // Consume it from the current name-match window so a later raw-UUID result
      // for the same name doesn't re-grab this id.
      if (msg.name) {
        const queue = currentNameQueues.get(msg.name);
        if (queue) {
          const idx = queue.indexOf(msg.toolCallId);
          if (idx >= 0) queue.splice(idx, 1);
        }
      }
      result.push(msg);
      continue;
    }

    // Name match — ONLY for raw-UUID results (§6.2). Dequeue the earliest
    // unconsumed call id for this tool name from the immediately-preceding
    // assistant run (§6.1). A compact-id result that didn't id-match is never guessed.
    if (msg.name && !isCompactToolCallId(msg.toolCallId)) {
      const queue = currentNameQueues.get(msg.name);
      if (queue && queue.length > 0) {
        const matchedId = queue.shift()!;
        result.push({ ...msg, toolCallId: matchedId });
        if (stats) stats.rawUuidNameRemaps++;
        continue;
      }
    }

    // True orphan — no id-exact partner, and not an eligible raw-UUID name-match.
    // Use `user` (never `system`): tool-originated content must not gain instruction-level authority.
    const name = msg.name ?? msg.toolCallId;
    result.push({
      role: 'user' as const,
      content: `[Context result from ${name}]: ${msg.content}`,
    });
    if (stats) stats.orphanToUserConversions++;
  }

  return result;
}

/**
 * Whether a toolCallId is a deterministic compact id (`${compactStepExecId}_${i}`):
 * 32 hex chars (a UUID with hyphens stripped) + `_` + an index. recordAssistantResponse
 * and the orchestrator stamp results with this shape; a raw UUID (with hyphens) is the
 * last-resort fallback that §6.2's name-remap is scoped to.
 */
function isCompactToolCallId(id: string): boolean {
  return /^[0-9a-f]{32}_\d+$/i.test(id);
}

// ============================================================================

export interface AdjacencyViolation {
  /** Index of the assistant message whose tool_use ids are not immediately paired. */
  assistantIndex: number;
  /** The ids missing from the contiguous tool-message run right after the assistant. */
  missingOrLateIds: string[];
  /**
   * Ids present in that contiguous run that the assistant did NOT call — an
   * unowned/stray tool result or a duplicate of an owned id. Either breaks the
   * "exactly those ids" invariant just as a missing result does.
   */
  unexpectedIds: string[];
}

export function checkToolResultAdjacency(messages: ChatMessage[]): {
  ok: boolean;
  violations: AdjacencyViolation[];
} {
  const violations: AdjacencyViolation[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !msg.toolCalls?.length) continue;

    // Count the ids in the contiguous run of tool messages immediately after.
    const runCounts = new Map<string, number>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const id = (messages[j] as { role: 'tool'; toolCallId: string }).toolCallId;
      runCounts.set(id, (runCounts.get(id) ?? 0) + 1);
      j++;
    }

    const expectedIds = msg.toolCalls.map((tc) => tc.id);
    const expectedSet = new Set(expectedIds);
    const missingOrLateIds = expectedIds.filter((id) => (runCounts.get(id) ?? 0) === 0);
    const unexpectedIds: string[] = [];
    for (const [id, count] of runCounts) {
      // An unowned id is always unexpected; an owned id appearing more than once
      // is a duplicate result, also a violation.
      if (!expectedSet.has(id) || count > 1) unexpectedIds.push(id);
    }

    if (missingOrLateIds.length > 0 || unexpectedIds.length > 0) {
      violations.push({ assistantIndex: i, missingOrLateIds, unexpectedIds });
    }
  }
  return { ok: violations.length === 0, violations };
}

export function enforceToolResultAdjacency(
  messages: ChatMessage[],
  stats?: SanitizationStats,
): ChatMessage[] {
  if (messages.length === 0) return messages;

  // Index the FIRST tool message for each exact id (first-wins, so the
  // representative result is stable), and the set of ids owned by some assistant
  // tool_use. A tool message whose id is owned belongs in that assistant's block;
  // an unowned tool message is left untouched (it should not occur after
  // convertOrphanToolMessages, which converts true orphans to user notes).
  const toolMsgById = new Map<string, ChatMessage & { role: 'tool' }>();
  const assistantOwnedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool') {
      if (!toolMsgById.has(msg.toolCallId)) toolMsgById.set(msg.toolCallId, msg);
    } else if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) assistantOwnedIds.add(tc.id);
    }
  }

  const out: ChatMessage[] = [];
  const consumed = new Set<string>();
  let changed = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'tool') {
      if (assistantOwnedIds.has(msg.toolCallId)) {
        // The representative result is emitted from its assistant's block — skip
        // the standalone copy. If we reach it before its assistant (tool precedes
        // assistant), dropping it here counts as a relocation we'll re-add below.
        if (toolMsgById.get(msg.toolCallId) === msg) {
          if (!consumed.has(msg.toolCallId)) changed = true;
          continue;
        }
        // A duplicate result for an already-represented id — preserve its content
        // as a labelled user note instead of silently dropping it.
        out.push({
          role: 'user',
          content: `[Duplicate tool result for ${msg.name ?? msg.toolCallId}]: ${msg.content}`,
        });
        changed = true;
        if (stats) stats.orphanToUserConversions++;
        continue;
      }
      out.push(msg);
      continue;
    }

    if (msg.role !== 'assistant' || !msg.toolCalls?.length) {
      out.push(msg);
      continue;
    }

    out.push(msg);

    // The original contiguous tool run right after this assistant — anything
    // outside it that we pull in is a relocation across a non-tool message.
    const originalAdjacent = new Set<string>();
    for (let k = i + 1; k < messages.length && messages[k]!.role === 'tool'; k++) {
      originalAdjacent.add((messages[k] as { role: 'tool'; toolCallId: string }).toolCallId);
    }

    for (const tc of msg.toolCalls) {
      const found = toolMsgById.get(tc.id);
      if (found && !consumed.has(tc.id)) {
        out.push(found);
        consumed.add(tc.id);
        if (!originalAdjacent.has(tc.id)) {
          changed = true;
          if (stats) stats.resultsRelocatedAcrossNonTool++;
        }
      } else {
        out.push({
          role: 'tool',
          toolCallId: tc.id,
          name: tc.function.name,
          content: TOOL_RESULT_NOT_AVAILABLE,
        });
        changed = true;
        if (stats) stats.syntheticPlaceholders++;
      }
    }
  }

  return changed ? out : messages;
}

/**
 * Remap function names in conversation history for native FC.
 *
 * Assistant `toolCalls` store original step IDs as names (e.g., `search-1`),
 * but function declarations use sanitized names (`search_1`). This maps them
 * so Gemini can match them to declared functions.
 *
 * Should be applied AFTER `convertOrphanToolMessages` (orphan tool messages
 * are already converted to user messages and won't be affected).
 */
export function remapFunctionNamesForNativeFC(
  messages: ChatMessage[],
  toolIdToFnNameMap: Map<string, string>,
): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const remappedToolCalls = msg.toolCalls.map((tc) => ({
        ...tc,
        function: {
          ...tc.function,
          name: toolIdToFnNameMap.get(tc.function.name) ?? tc.function.name,
        },
      }));
      return { ...msg, toolCalls: remappedToolCalls };
    }

    if (msg.role === 'tool' && msg.name) {
      const sanitizedName = toolIdToFnNameMap.get(msg.name) ?? msg.name;
      return { ...msg, name: sanitizedName };
    }

    return msg;
  });
}
