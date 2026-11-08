import type { z } from 'zod';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  AiConversationStateV1,
  AiMessageAtomV1,
  PinnedState,
  SummaryTemplate,
  CompactionArtifact,
} from '@aflow/schemas';
import { SummaryTemplateSchema, contentHash, textMessage } from '@aflow/schemas';
import type { AIClient } from '@aflow/ai-client';
import {
  buildSummarizationPrompt,
  buildMergePrompt,
  type TranscriptEntry,
} from './compaction-prompts.js';
import {
  extractNoteReadPointers,
  exchangeKeyForAtom,
  toolResultEnvelopeOfAtom,
} from './exchangeClearing.js';
import { estimateStringTokens } from './tokenEstimate.js';
import { RETENTION_POLICY, computePinnedAtomIds } from './retentionPolicy.js';
import { atomsAsSent } from './toolObservations.js';
import { splitActiveRefOwners, type ActiveRef } from './activeRefOwnership.js';

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
  /** The model that writes the summary; the retention policy's when absent. */
  summaryModel?: string | undefined;
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

/**
 * A result compacted with its turn stays re-readable at the path a
 * clear-to-ref note would have taught (§4.4), so what was read survives
 * compaction. Only the range's results: the rest are still in history.
 */
function compactedResultPointers(rangeAtoms: AiMessageAtomV1[]): ActiveRef[] {
  const refs: ActiveRef[] = [];
  for (const atom of rangeAtoms) {
    if (atom.sourceKind !== 'tool_result') continue;
    const envelope = toolResultEnvelopeOfAtom(atom);
    if (!envelope?.outputPath || envelope.outputRef?.startsWith(envelope.outputPath)) continue;
    refs.push({
      ref: `${envelope.outputPath}/data`,
      description: truncateDescription(
        `${envelope.toolName}: ${envelope.summary ?? envelope.status.toLowerCase()}`,
      ),
      fromTurn: atom.turnNumber ?? 0,
    });
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
  /** Atoms in the compaction range (to be archived and summarized), in history order. */
  atoms: AiMessageAtomV1[];
  /** The range's content as the agent was shown it, each entry with its turn (summarizer input). */
  entries: TranscriptEntry[];
}

/**
 * Identify the compaction range: every atom older than the recency floor that
 * is not pinned, the current run's included (§4.10). Returns undefined when
 * the range holds too few content turns to be worth a summarizer call. The pin
 * set replaces the 82-era `keepFirstTurns` anchor heuristic (§4.1).
 *
 * Selection is per atom, not per turn. A tool chain links every turn to the
 * next — a turn holds the previous call's result and the next call — so a
 * per-turn range that drops a turn for one straddling exchange drops the
 * whole chain with it, and a run of tool calls could never compact. Per atom,
 * a straddling exchange leaves the range alone and its turn's other atoms stay
 * in. Compacted atoms leave history, so nothing is compacted twice.
 */
function identifyCompactionRange(
  allAtoms: AiMessageAtomV1[],
  shownAtoms: AiMessageAtomV1[],
  currentTurn: number,
  pinnedAtomIds: Set<string>,
): CompactionRange | undefined {
  // Previous compaction_restore atoms ARE included — the new restore supersedes them.
  const inRange = new Set<string>();
  for (const atom of allAtoms) {
    if (atom.turnNumber === undefined) continue;
    // Tier-1 verbatim recency (§4.3) — shared with clearing.
    if (currentTurn - atom.turnNumber <= RETENTION_POLICY.keepRecentTurns) continue;
    if (pinnedAtomIds.has(atom.atomId)) continue;
    inRange.add(atom.atomId);
  }

  // Never strand a tool_use or orphan its results: an exchange with any atom
  // outside the range (pinned, recent, pre-turn-stamp) leaves it whole. Each
  // atom belongs to one exchange, so one pass reaches the fixed point.
  const atomById = new Map(allAtoms.map((a) => [a.atomId, a]));
  const exchangeAtoms = new Map<string, AiMessageAtomV1[]>();
  for (const atom of allAtoms) {
    const key = exchangeKeyForAtom(atom, atomById);
    if (key.startsWith('standalone:')) continue;
    const members = exchangeAtoms.get(key);
    if (members) members.push(atom);
    else exchangeAtoms.set(key, [atom]);
  }
  for (const members of exchangeAtoms.values()) {
    if (members.every((a) => inRange.has(a.atomId))) continue;
    for (const a of members) inRange.delete(a.atomId);
  }

  const atoms = allAtoms.filter((a) => inRange.has(a.atomId));
  // Restore atoms are removed with the range but do not count toward the
  // minimum — enough real content turns must justify the summarizer call.
  const contentTurns = new Set(
    atoms.filter((a) => a.sourceKind !== 'compaction_restore').map((a) => a.turnNumber!),
  );
  if (contentTurns.size < RETENTION_POLICY.minCompactableTurns) return undefined;

  const shownById = new Map(shownAtoms.map((a) => [a.atomId, a.message]));
  const entries: TranscriptEntry[] = [];
  for (const atom of atoms) {
    // Previous compaction_restore atoms are metadata, not conversation — the
    // previous summary is passed separately via the merge prompt.
    if (atom.sourceKind === 'compaction_restore') continue;
    entries.push({
      turnNumber: atom.turnNumber!,
      sourceKind: atom.sourceKind,
      message: shownById.get(atom.atomId) ?? atom.message,
    });
  }

  const turns = atoms.map((a) => a.turnNumber!);
  return { fromTurn: Math.min(...turns), toTurn: Math.max(...turns), atoms, entries };
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
  placement: { turnNumber: number; createdAtMs: number },
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
    // The restore is sent every turn and the refs carry forward through each
    // compaction, so it lists the newest. The summarizer was told to carry the
    // rest, and the artifact keeps them all.
    const { restoreListed: shown, summaryCarried } = splitActiveRefOwners(pinnedState.activeRefs);
    if (summaryCarried.length > 0) {
      parts.push(
        `  - (${String(summaryCarried.length)} older refs not listed — the summary carries their paths)`,
      );
    }
    for (const ref of shown) {
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
    // The restore takes the last compacted atom's slot, so a later re-sort by
    // (turn, createdAt) keeps it there — after a pinned atom kept inside the
    // range, before a straddling exchange kept at its end.
    createdAtMs: placement.createdAtMs,
    turnNumber: placement.turnNumber,
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

  // 1. Only atoms still in history, in history order. Clearing appends its
  // notes to the hydrated set out of position, and a compacted atom has left
  // history, so this is also what keeps a compaction from running twice.
  const hydratedById = new Map(hydratedAtoms.map((a) => [a.atomId, a]));
  const historyAtoms = state.history.atoms.flatMap((ref) => {
    const atom = hydratedById.get(ref.atomId);
    return atom ? [atom] : [];
  });

  // The summarizer reads, and the saving is measured against, history as
  // assembleRequest sends it: observations reduced and stamps removed. The
  // archive keeps the atoms as stored.
  const shownAtoms = atomsAsSent(historyAtoms);

  // 2. Identify compaction range
  const pinnedAtomIds = new Set<string>();
  for (const id of computePinnedAtomIds(historyAtoms, Math.max(currentTurn - 1, 0))) {
    if (hydratedById.get(id)?.sourceKind !== 'compaction_restore') pinnedAtomIds.add(id);
  }
  const range = identifyCompactionRange(historyAtoms, shownAtoms, currentTurn, pinnedAtomIds);

  if (!range) return undefined; // Nothing to compact

  // 3. Load the previous artifact (incremental merge + activeRef carry-forward)
  const previousArtifactRef = state.compaction?.artifactRef;
  let previousArtifact: CompactionArtifact | undefined;
  if (previousArtifactRef) {
    try {
      previousArtifact = (await config.payloadStore.retrieve(
        previousArtifactRef,
      )) as CompactionArtifact;
    } catch {
      // Previous artifact not found — treat as fresh compaction
    }
  }
  const previousSummary = previousArtifact?.summaryMarkdown;

  // 4. Extract pinned state (deterministic) + §4.8 sweep: pointers from
  // clear-to-ref notes in range and from superseded restores stay reachable.
  const pinnedState = extractPinnedState(shownAtoms, flowName);
  const mergedRefs = mergeActiveRefs(
    previousArtifact?.pinnedState.activeRefs,
    pinnedState.activeRefs,
    sweepClearedNotePointers(range.atoms),
    compactedResultPointers(range.atoms),
  );
  if (mergedRefs.length > 0) pinnedState.activeRefs = mergedRefs;

  // 5. Summary template — schema defaults fill omitted fields
  const template: SummaryTemplate = SummaryTemplateSchema.parse(summaryTemplate ?? {});

  // 6. Call summarizer LLM
  const summaryModel = config.summaryModel ?? RETENTION_POLICY.compactionSummaryModel;
  const summaryMaxTokens = template.maxTokens;

  const prompt = previousSummary
    ? buildMergePrompt(range.entries, pinnedState, previousSummary, template, [
        range.fromTurn,
        range.toTurn,
      ])
    : buildSummarizationPrompt(range.entries, pinnedState, template, [
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
    persist: true,
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
    persist: true,
  });

  // 8. Create compaction_restore atom
  const lastCompacted = range.atoms[range.atoms.length - 1]!;
  const restoreAtom = createCompactionRestoreAtom(
    pinnedState,
    summaryMarkdown,
    [range.fromTurn, range.toTurn],
    compactionNumber,
    currentTurn,
    { turnNumber: lastCompacted.turnNumber!, createdAtMs: lastCompacted.createdAtMs },
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
    persist: true,
  });

  // 9. Rewrite conversation state: the restore atom replaces the range in
  // the last compacted atom's position.
  const compactedAtomIds = new Set(range.atoms.map((a) => a.atomId));
  const restoreAtomRef = {
    atomId: restoreAtom.atomId,
    ref: restoreBatchRef,
    role: restoreAtom.role,
    sourceKind: restoreAtom.sourceKind,
    hash: contentHash(JSON.stringify(restoreAtom.message)),
    createdAtMs: restoreAtom.createdAtMs,
    turnNumber: restoreAtom.turnNumber,
  };
  const newAtoms: AiConversationStateV1['history']['atoms'] = [];
  for (const atomRef of state.history.atoms) {
    if (!compactedAtomIds.has(atomRef.atomId)) newAtoms.push(atomRef);
    else if (atomRef.atomId === lastCompacted.atomId) newAtoms.push(restoreAtomRef);
  }

  state.history.atoms = newAtoms;

  // Update compaction state
  state.compaction = {
    artifactRef,
    count: compactionNumber,
  };

  // 10. Persist updated state
  const conversationStateRef = await config.payloadStore.store({
    tenantId: config.tenantId as TenantId,
    runId: config.runId as SessionId,
    stepExecutionId: config.stepExecutionId as StepExecutionId,
    attempt: config.attempt,
    kind: 'state',
    data: state,
    persist: true,
  });

  // Estimate tokens saved
  const compactedTokens = range.entries.reduce(
    (sum, entry) => sum + estimateStringTokens(JSON.stringify(entry.message)),
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
