import type { z } from 'zod';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  AiConversationStateV1,
  AiMessageAtomV1,
  AiMessageV1,
  PinnedState,
  SummaryTemplate,
  CompactionArtifact,
} from '@aflow/schemas';
import { SummaryTemplateSchema, contentHash, textMessage } from '@aflow/schemas';
import type { AIClient } from '@aflow/ai-client';
import { buildSummarizationPrompt, buildMergePrompt } from './compaction-prompts.js';
import {
  extractNoteReadPointers,
  exchangeKeyForAtom,
  toolResultEnvelopeOfAtom,
} from './exchangeClearing.js';
import { estimateStringTokens } from './tokenEstimate.js';
import { RETENTION_POLICY, computePinnedAtomIds } from './retentionPolicy.js';

// ============================================================================
// Types
// ============================================================================

export interface CompactionConfig {
  payloadStore: PayloadStore;
  tenantId: string;
  runId: string;
  stepId: string;
  stepExecutionId: string;
  attempt: number;
  /** The read op on this turn's tool surface (§4.9) — teaches the restore-atom pointers. */
  availableReadOpId?: string | undefined;
}

export interface CompactionResult {
  /** New conversation state ref after compaction. */
  conversationStateRef: string;
  /** Compaction cycle number (1, 2, 3...). */
  compactionNumber: number;
  /** Tokens saved (estimated). */
  tokensSaved: number;
}

// ============================================================================
// Pinned State Extraction (Deterministic — no LLM)
// ============================================================================

/**
 * Extract pinned state from conversation atoms.
 * Purely deterministic: reads typed fields from tool_result envelopes
 * and assistant_turn atoms. No LLM, no nondeterminism.
 */
export function extractPinnedState(atoms: AiMessageAtomV1[], flowName?: string): PinnedState {
  let objective: string | undefined;
  let activeSubGoal: string | undefined;
  const activeRefs: Array<{ ref: string; description: string; fromTurn: number }> = [];
  const writtenVarsMap = new Map<string, { variableKey: string; ref?: string; summary?: string }>();

  for (const atom of atoms) {
    // Extract objective from first user_input
    if (atom.sourceKind === 'user_input' && !objective) {
      const textPart = atom.message.parts.find((p) => p.kind === 'text');
      if (textPart?.kind === 'text') {
        // Use first 200 chars of first user message as objective
        objective =
          textPart.text.length > 200 ? textPart.text.slice(0, 200) + '...' : textPart.text;
      }
    }

    // Extract activeSubGoal from last assistant_turn with a message
    if (atom.sourceKind === 'assistant_turn') {
      const textPart = atom.message.parts.find((p) => p.kind === 'text');
      if (textPart?.kind === 'text' && textPart.text.trim()) {
        activeSubGoal =
          textPart.text.length > 300 ? textPart.text.slice(0, 300) + '...' : textPart.text;
      }
    }

    // Extract activeRefs and writtenVariables from tool_result envelopes
    if (atom.sourceKind === 'tool_result') {
      const envelope = toolResultEnvelopeOfAtom(atom);
      if (!envelope) continue;

      const turnNumber = atom.turnNumber ?? 0;

      // outputRef → activeRefs
      if (envelope.outputRef) {
        const rawDesc = envelope.summary ?? `${envelope.toolName} output`;
        activeRefs.push({
          ref: envelope.outputRef,
          description: truncateDescription(rawDesc),
          fromTurn: turnNumber,
        });
      }

      // wroteVariables → writtenVariables + activeRefs
      if (envelope.wroteVariables) {
        for (const wv of envelope.wroteVariables) {
          writtenVarsMap.set(wv.variableKey, {
            variableKey: wv.variableKey,
            ...(wv.ref ? { ref: wv.ref } : {}),
            ...(wv.summary ? { summary: truncateDescription(wv.summary) } : {}),
          });
          if (wv.ref) {
            activeRefs.push({
              ref: wv.ref,
              description: truncateDescription(wv.summary ?? `state.${wv.variableKey}`),
              fromTurn: turnNumber,
            });
          }
        }
      }
    }
  }

  // Use flowName as fallback objective
  if (!objective && flowName) {
    objective = flowName;
  }

  const dedupedRefs = mergeActiveRefs(activeRefs);

  return {
    ...(objective ? { objective } : {}),
    ...(activeSubGoal ? { activeSubGoal } : {}),
    ...(dedupedRefs.length > 0 ? { activeRefs: dedupedRefs } : {}),
    ...(writtenVarsMap.size > 0 ? { writtenVariables: [...writtenVarsMap.values()] } : {}),
  };
}

type ActiveRef = NonNullable<PinnedState['activeRefs']>[number];

/** Merge activeRef groups, deduplicating by ref string and keeping the latest turn. */
function mergeActiveRefs(...groups: Array<readonly ActiveRef[] | undefined>): ActiveRef[] {
  const byRef = new Map<string, ActiveRef>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const existing = byRef.get(ref.ref);
      if (!existing || ref.fromTurn > existing.fromTurn) {
        byRef.set(ref.ref, ref);
      }
    }
  }
  return [...byRef.values()];
}

/**
 * §4.8 sweep — clear-to-ref notes inside the compaction range fold into the
 * summary; their `memory.store.get` pointers survive as pinned-state
 * activeRefs so re-access paths outlive compaction.
 */
function sweepClearedNotePointers(rangeAtoms: AiMessageAtomV1[]): ActiveRef[] {
  const refs: ActiveRef[] = [];
  for (const atom of rangeAtoms) {
    if (atom.sourceKind !== 'cleared_summary') continue;
    const text = atom.message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n');
    for (const pointer of extractNoteReadPointers(text)) {
      refs.push({
        ref: pointer.path,
        description: truncateDescription(`cleared ${pointer.toolName ?? 'tool'} output`),
        fromTurn: atom.turnNumber ?? 0,
      });
    }
  }
  return refs;
}

/** Truncate a description string to avoid bloating the restore atom. */
function truncateDescription(text: string, maxLen = RETENTION_POLICY.noteDigestMaxChars): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

// ============================================================================
// Compaction Range Identification
// ============================================================================

interface CompactionRange {
  fromTurn: number;
  toTurn: number;
  /**
   * Earliest CONTENT turn — superseded restore atoms sit at the previous
   * range's fromTurn, so the re-compaction idempotency guard must key on
   * content turns or a second compaction could never fire.
   */
  contentFromTurn: number;
  /** Atoms in the compaction range (to be archived and summarized). */
  atoms: AiMessageAtomV1[];
  /** Hydrated messages in the compaction range (for summarizer input). */
  messages: AiMessageV1[];
}

/**
 * Identify the compaction range: middle zone atoms eligible for compression.
 * Returns undefined if no compaction is needed or the range is too small.
 * The pin set replaces the 82-era `keepFirstTurns` anchor heuristic (§4.1).
 */
function identifyCompactionRange(
  allAtoms: AiMessageAtomV1[],
  currentTurn: number,
  pinnedAtomIds: Set<string>,
  lastCompactedTurn?: number,
): CompactionRange | undefined {
  // Group atoms by turnNumber
  const turnGroups = new Map<number, AiMessageAtomV1[]>();
  for (const atom of allAtoms) {
    if (atom.turnNumber === undefined || atom.turnNumber === null) continue;
    const group = turnGroups.get(atom.turnNumber);
    if (group) {
      group.push(atom);
    } else {
      turnGroups.set(atom.turnNumber, [atom]);
    }
  }

  const turnNumbers = [...turnGroups.keys()].sort((a, b) => a - b);
  if (turnNumbers.length === 0) return undefined;

  // Identify compactable turns (middle zone)
  // Previous compaction_restore atoms ARE included — the new restore supersedes them.
  const compactableTurns: number[] = [];
  for (const tn of turnNumbers) {
    // Tier-1 verbatim recency (§4.3) — shared with clearing.
    if (currentTurn - tn <= RETENTION_POLICY.keepRecentTurns) continue;
    const group = turnGroups.get(tn)!;
    if (group.some((a) => pinnedAtomIds.has(a.atomId))) continue;
    // Skip if already compacted (idempotency) — but only for non-restore atoms
    const isRestoreAtom = group.every((a) => a.sourceKind === 'compaction_restore');
    if (lastCompactedTurn !== undefined && tn <= lastCompactedTurn && !isRestoreAtom) continue;

    compactableTurns.push(tn);
  }

  // Exchanges span turns (assistant tool_use in turn N, results in N+1), so a
  // turn-granular range could strand a tool_use or orphan its results. Snap to
  // exchange boundaries: a turn leaves the range when any of its atoms belongs
  // to an exchange with atoms outside it (pinned, recent, pre-turn-stamp).
  // Removing a turn can re-straddle another exchange — iterate to a fixed point.
  const inRange = new Set(compactableTurns);
  const atomById = new Map(allAtoms.map((a) => [a.atomId, a]));
  const exchangeTurnSets = new Map<string, Set<number | undefined>>();
  for (const atom of allAtoms) {
    const key = exchangeKeyForAtom(atom, atomById);
    if (key.startsWith('standalone:')) continue;
    let turns = exchangeTurnSets.get(key);
    if (!turns) {
      turns = new Set();
      exchangeTurnSets.set(key, turns);
    }
    turns.add(atom.turnNumber);
  }
  let snapped = true;
  while (snapped) {
    snapped = false;
    for (const turns of exchangeTurnSets.values()) {
      const memberTurns = [...turns];
      const inside = memberTurns.filter((t): t is number => t !== undefined && inRange.has(t));
      if (inside.length === 0 || inside.length === memberTurns.length) continue;
      for (const t of inside) inRange.delete(t);
      snapped = true;
    }
  }
  const rangeTurns = compactableTurns.filter((tn) => inRange.has(tn));

  // Filter out turns that ONLY have restore atoms — we include them for removal
  // but don't count them towards the minimum. Need enough real content turns
  // to justify the summarizer overhead.
  const contentTurns = rangeTurns.filter((tn) => {
    const group = turnGroups.get(tn)!;
    return !group.every((a) => a.sourceKind === 'compaction_restore');
  });

  if (contentTurns.length < RETENTION_POLICY.minCompactableTurns) return undefined;

  const fromTurn = Math.min(...rangeTurns);
  const toTurn = Math.max(...rangeTurns);
  const contentFromTurn = Math.min(...contentTurns);

  const atoms: AiMessageAtomV1[] = [];
  const messages: AiMessageV1[] = [];
  for (const tn of rangeTurns) {
    const group = turnGroups.get(tn)!;
    for (const atom of group) {
      atoms.push(atom);
      // Don't feed previous compaction_restore atoms to the summarizer —
      // they're metadata, not real conversation. The previous summary
      // is passed separately via the merge prompt.
      if (atom.sourceKind !== 'compaction_restore') {
        messages.push(atom.message);
      }
    }
  }

  return { fromTurn, toTurn, contentFromTurn, atoms, messages };
}

// ============================================================================
// Compaction Restore Atom
// ============================================================================

function createCompactionRestoreAtom(
  pinnedState: PinnedState,
  summaryMarkdown: string,
  compressedTurnRange: [number, number],
  compactionNumber: number,
  currentTurnNumber: number,
  availableReadOpId?: string,
): AiMessageAtomV1 {
  const parts: string[] = [];
  parts.push(
    `[Context note — conversation history before turn ${String(currentTurnNumber)} was compressed; summary follows (turns ${String(compressedTurnRange[0])}–${String(compressedTurnRange[1])} → summary #${String(compactionNumber)}).]`,
  );

  // Verified state block (deterministic facts)
  parts.push('');
  parts.push('### Verified State (deterministic — these are facts, not summaries)');
  if (pinnedState.objective) {
    parts.push(`- Objective: ${pinnedState.objective}`);
  }
  if (pinnedState.activeSubGoal) {
    parts.push(`- Active sub-goal: ${pinnedState.activeSubGoal}`);
  }
  if (pinnedState.activeRefs && pinnedState.activeRefs.length > 0) {
    parts.push('- Active refs:');
    for (const ref of pinnedState.activeRefs) {
      // §4.8/§4.9: a /run/outputs ref keeps the read affordance ONLY when the
      // agent actually holds a callable read op — teaching a specific op name
      // the turn can't call would be a dishonest (and now ceiling-rejected)
      // promise. Degrade to the bare $ref otherwise.
      parts.push(
        ref.ref.startsWith('/run/outputs/') && availableReadOpId !== undefined
          ? `  - ${availableReadOpId} { path: '${ref.ref}', view: 'outline' } → ${ref.description}`
          : `  - {"$ref": "${ref.ref}"} → ${ref.description}`,
      );
    }
  }
  if (pinnedState.writtenVariables && pinnedState.writtenVariables.length > 0) {
    parts.push('- Written variables:');
    for (const v of pinnedState.writtenVariables) {
      parts.push(`  - state.${v.variableKey}${v.summary ? ` → ${v.summary}` : ''}`);
    }
  }

  // Narrative summary
  parts.push('');
  parts.push(
    `### Summary (turns ${String(compressedTurnRange[0])}–${String(compressedTurnRange[1])})`,
  );
  parts.push(summaryMarkdown);

  // Footer
  parts.push('');
  parts.push('---');
  parts.push(
    'Data references from compressed turns remain valid — {"$ref": "output.<id>/field"} resolves the full data.',
  );
  parts.push('The messages after this note are the most recent turns of the conversation.');

  const text = parts.join('\n');

  return {
    schemaVersion: 1,
    atomId: crypto.randomUUID(),
    role: 'user',
    sourceId: `compaction:${String(compactionNumber)}`,
    sourceKind: 'compaction_restore',
    message: textMessage('user', text),
    createdAtMs: Date.now(),
    turnNumber: compressedTurnRange[0], // Place at the start of compressed range
  };
}

// ============================================================================
// Summarizer LLM Call
// ============================================================================

/**
 * Call the summarizer LLM to compress conversation messages.
 * Returns the summary markdown and token usage.
 */
async function callSummarizer(
  client: AIClient,
  config: CompactionConfig,
  summaryModel: string,
  prompt: string,
  maxTokens: number,
): Promise<{
  summaryMarkdown: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const response = await client.generateText({
    model: summaryModel,
    messages: [{ role: 'user' as const, content: prompt }],
    maxTokens,
    temperature: 0.1,
    tenantId: config.tenantId as TenantId,
    runId: config.runId as SessionId,
    stepExecutionId: config.stepExecutionId as StepExecutionId,
    attempt: config.attempt,
  });

  return {
    summaryMarkdown: response.content ?? '',
    inputTokens: response.usage.promptTokens,
    outputTokens: response.usage.completionTokens,
  };
}

// ============================================================================
// Main Compaction Trigger
// ============================================================================

export async function triggerCompaction(
  config: CompactionConfig,
  state: AiConversationStateV1,
  hydratedAtoms: AiMessageAtomV1[],
  summaryTemplate: z.input<typeof SummaryTemplateSchema> | undefined,
  client: AIClient,
  flowName?: string,
): Promise<(CompactionResult & { updatedState: AiConversationStateV1 }) | undefined> {
  const currentTurn = state.turnNumber;

  // 1. Idempotency guard: check watermark
  const lastCompactedTurn = state.compaction?.lastCompactedTurn;

  // 2. Identify compaction range
  const pinnedAtomIds = new Set<string>();
  const atomById = new Map(hydratedAtoms.map((a) => [a.atomId, a]));
  for (const id of computePinnedAtomIds(hydratedAtoms, Math.max(currentTurn - 1, 0))) {
    if (atomById.get(id)?.sourceKind !== 'compaction_restore') pinnedAtomIds.add(id);
  }
  const range = identifyCompactionRange(
    hydratedAtoms,
    currentTurn,
    pinnedAtomIds,
    lastCompactedTurn,
  );

  if (!range) return undefined; // Nothing to compact

  // Idempotency: ensure we're not re-compacting content turns (the superseded
  // restore atom legitimately sits inside the previous range).
  if (lastCompactedTurn !== undefined && range.contentFromTurn <= lastCompactedTurn) {
    return undefined;
  }

  // 3. Load the previous artifact (incremental merge + activeRef carry-forward)
  const previousArtifactRef = state.compaction?.artifactRef;
  let previousArtifact: CompactionArtifact | undefined;
  if (previousArtifactRef) {
    try {
      previousArtifact = (await config.payloadStore.retrieve(
        previousArtifactRef as never,
      )) as CompactionArtifact;
    } catch {
      // Previous artifact not found — treat as fresh compaction
    }
  }
  const previousSummary = previousArtifact?.summaryMarkdown;

  // 4. Extract pinned state (deterministic) + §4.8 sweep: pointers from
  // clear-to-ref notes in range and from superseded restores stay reachable.
  const pinnedState = extractPinnedState(hydratedAtoms, flowName);
  const mergedRefs = mergeActiveRefs(
    previousArtifact?.pinnedState.activeRefs,
    pinnedState.activeRefs,
    sweepClearedNotePointers(range.atoms),
  );
  if (mergedRefs.length > 0) pinnedState.activeRefs = mergedRefs;

  // 5. Summary template — schema defaults fill omitted fields
  const template: SummaryTemplate = SummaryTemplateSchema.parse(summaryTemplate ?? {});

  // 6. Call summarizer LLM
  const summaryModel = RETENTION_POLICY.compactionSummaryModel;
  const summaryMaxTokens = template.maxTokens;

  const prompt = previousSummary
    ? buildMergePrompt(range.messages, pinnedState, previousSummary, template, [
        range.fromTurn,
        range.toTurn,
      ])
    : buildSummarizationPrompt(range.messages, pinnedState, template, [
        range.fromTurn,
        range.toTurn,
      ]);

  const { summaryMarkdown, inputTokens, outputTokens } = await callSummarizer(
    client,
    config,
    summaryModel,
    prompt,
    summaryMaxTokens,
  );

  // 7. Store compaction artifact
  const compactionNumber = (state.compaction?.count ?? 0) + 1;

  // Archive raw atoms for this range
  const rawAtomsRef = await config.payloadStore.store({
    tenantId: config.tenantId as TenantId,
    runId: config.runId as SessionId,
    stepExecutionId: `${config.stepExecutionId}-compact` as StepExecutionId,
    attempt: config.attempt,
    kind: 'history',
    data: range.atoms,
  });

  const artifact: CompactionArtifact = {
    version: 1,
    pinnedState,
    summaryMarkdown,
    compressedTurnRange: [range.fromTurn, range.toTurn],
    rawAtomsRef,
    ...(previousArtifactRef ? { parentArtifactRef: previousArtifactRef } : {}),
    summaryModel,
    summaryInputTokens: inputTokens,
    summaryOutputTokens: outputTokens,
    generatedAt: Date.now(),
    compactionNumber,
  };

  const artifactRef = await config.payloadStore.store({
    tenantId: config.tenantId as TenantId,
    runId: config.runId as SessionId,
    stepExecutionId: `${config.stepExecutionId}-compact` as StepExecutionId,
    attempt: config.attempt,
    kind: 'state',
    data: artifact,
  });

  // 8. Create compaction_restore atom
  const restoreAtom = createCompactionRestoreAtom(
    pinnedState,
    summaryMarkdown,
    [range.fromTurn, range.toTurn],
    compactionNumber,
    currentTurn,
    config.availableReadOpId,
  );

  // Store the restore atom batch (distinct suffix from -compact to avoid key collision)
  const restoreBatchRef = await config.payloadStore.store({
    tenantId: config.tenantId as TenantId,
    runId: config.runId as SessionId,
    stepExecutionId: `${config.stepExecutionId}-restore` as StepExecutionId,
    attempt: config.attempt,
    kind: 'history',
    data: [restoreAtom],
  });

  // 9. Rewrite conversation state
  // Remove compacted atoms, replace with restore atom
  const compactedAtomIds = new Set(range.atoms.map((a) => a.atomId));
  const keptAtomRefs = state.history.atoms.filter((a) => !compactedAtomIds.has(a.atomId));

  // Build atom ref for restore atom
  const restoreAtomRef = {
    atomId: restoreAtom.atomId,
    ref: restoreBatchRef,
    role: restoreAtom.role,
    sourceKind: restoreAtom.sourceKind,
    hash: contentHash(JSON.stringify(restoreAtom.message)),
    createdAtMs: restoreAtom.createdAtMs,
    turnNumber: restoreAtom.turnNumber,
  };

  // Insert restore atom at the correct position (before recent turns)
  const newAtoms = [];
  let restoreInserted = false;
  for (const atomRef of keptAtomRefs) {
    const tn = atomRef.turnNumber ?? -1;
    if (!restoreInserted && tn > range.toTurn) {
      newAtoms.push(restoreAtomRef);
      restoreInserted = true;
    }
    newAtoms.push(atomRef);
  }
  if (!restoreInserted) {
    // All remaining atoms are from before the range — append restore at end
    newAtoms.push(restoreAtomRef);
  }

  state.history.atoms = newAtoms;

  // Update compaction state
  state.compaction = {
    artifactRef,
    count: compactionNumber,
    lastCompactedTurn: range.toTurn,
  };

  // 10. Persist updated state
  const conversationStateRef = await config.payloadStore.store({
    tenantId: config.tenantId as TenantId,
    runId: config.runId as SessionId,
    stepExecutionId: config.stepExecutionId as StepExecutionId,
    attempt: config.attempt,
    kind: 'state',
    data: state,
  });

  // Estimate tokens saved
  const compactedTokens = range.messages.reduce(
    (sum, msg) => sum + estimateStringTokens(JSON.stringify(msg)),
    0,
  );
  const restoreTokens = estimateStringTokens(
    restoreAtom.message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(''),
  );
  const tokensSaved = Math.max(0, compactedTokens - restoreTokens);

  return {
    conversationStateRef,
    compactionNumber,
    tokensSaved,
    updatedState: state,
  };
}
