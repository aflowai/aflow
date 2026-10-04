/**
 * ConversationStateStore — Manages V1 conversation state for agent turns.
 *
 * Responsibilities:
 * 1. Load existing AiConversationStateV1 (or create new)
 * 2. Append new atoms (user messages, tool results) with idempotent dedup
 * 3. Assemble the exact model request (messages array) from state
 * 4. Store atoms + updated conversation state
 * 5. Return conversationStateRef for the orchestrator to persist
 *
 * See: docs/plans/aflow/handoff-agent-history-architecture.md
 */
import type { PayloadStore } from '@aflow/payload-store';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  RoomExchangeEntry,
  RoomSpeaker,
} from '@aflow/schemas';
import {
  type AiClearingStateV1,
  type AiConversationStateV1,
  type AiMessageV1,
  type AiMessageAtomV1,
  type AiToolResultEnvelopeV1,
  type AiContextBlockRef,
  type AiToolCallV1,
  type AiProviderReasoningV1,
  AiConversationStateV1Schema,
  textMessage,
  toolResultMessage,
  contentHash,
} from '@aflow/schemas';
import { RETENTION_POLICY, computePinnedAtomIds } from './retentionPolicy.js';

/**
 * Put a name on what a person said.
 *
 * One function for every human message however it arrived — posted into the
 * room, or typed to steer the run — because a person appearing as themselves
 * on one message and as nobody on the next reads as two different speakers.
 * Bracketed so it stays distinguishable from prose that happens to contain a
 * colon, and skipped entirely when nobody is named, which is what keeps a
 * scheduled or API-triggered turn looking exactly as it always has.
 */
function attributeToSpeaker(text: string, speaker: RoomSpeaker | undefined): string {
  if (!speaker) return text;
  // The display name is user-controlled profile text: brackets, newlines and
  // control characters could forge another participant's attribution or
  // fabricate message structure inside the model's view. Attribution is the
  // trust signal, so the label is flattened to one bracket-free line; the
  // roster block carries the authoritative userId↔name mapping.
  const raw = speaker.actorDisplayName ?? speaker.actorUserId;
  const label = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `[${label.length > 0 ? label : speaker.actorUserId}] ${text}`;
}
import {
  retainReasoningForRequest,
  type ReasoningContinuityMode,
  type ReasoningContinuityResetReason,
} from './reasoningContinuity.js';
import {
  type AtomRef,
  type ClearNoteOptions,
  type Exchange,
  type ResurrectionDetection,
  PROTECTION_CLASS,
  exchangeKeyForAtom,
  exchangeProtectionClass,
  earliestCreatedAtMs,
  estimateExchangeClearingTokens,
  estimateExchangeNetTokenSavings,
  buildClearedExchangeNote,
  clearedCallEntries,
  detectResurrections,
} from './exchangeClearing.js';
import { estimateStringTokens, estimateMessageTokens } from './tokenEstimate.js';
import { atomsAsSent } from './toolObservations.js';
import {
  ConversationHistoryHydrationError,
  type HistoryIntegrityIssue,
  noteCommittedTurn,
  type UnreadableHistoryBatch,
  unreadableHistoryBatch,
} from './historyHydrationError.js';

// ============================================================================
// Types
// ============================================================================

export interface ConversationStateStoreConfig {
  payloadStore: PayloadStore;
  tenantId: string;
  runId: string;
  stepId: string;
  stepExecutionId: string;
  attempt: number;
}

export interface NewUserInput {
  /** Client-generated idempotency key (stable across retries) */
  userInputId: string;
  /** User message text */
  text: string;
  /** Timestamp */
  createdAtMs: number;
  /** Who said it, when a person did. */
  author?: RoomSpeaker | undefined;
}

/**
 * Cache tiers, longest-lived first — the order they ship in. `run_stable` is
 * fixed within a run but differs between runs, so keeping it out of `stable` is
 * what lets a space's context survive in the cache across runs.
 */
export const CONTEXT_CACHE_TIERS = ['stable', 'run_stable', 'volatile'] as const;
export type ContextCacheTier = (typeof CONTEXT_CACHE_TIERS)[number];

export interface ContextBlock {
  /** Context key (e.g., 'DiscoverableTools') */
  key: string;
  /** Resolved content (string or serializable object) */
  content: unknown;
  /** Defaults to `stable` — a block says so only when it is shorter-lived. */
  cacheHint?: ContextCacheTier;
}

export interface TokenBreakdown {
  system: number;
  context: number;
  history: number;
  /** Tool surface (native-FC declarations / JSON-mode tool section). Filled by the caller. */
  tools: number;
  total: number;
}

export interface AssembledRequest {
  /** The exact message array to send to the model */
  messages: AiMessageV1[];
  /** Hashes for caching/diffing */
  systemHash: string;
  contextHash: string;
  historyHash: string;
  tokenBreakdown: TokenBreakdown;
  activeMemoryInjected: boolean;
  /**
   * Leading system blocks worth a cache breakpoint: the prompt plus every
   * non-volatile tier actually emitted. Derived, because only non-empty tiers
   * ship — a fixed count would mark the volatile tail on a turn that emits
   * fewer, paying a cache write every turn for a block that never repeats.
   */
  cacheableSystemBlockCount: number;
  /** Provider-native reasoning retained into this request (Plan 259). */
  reasoningContinuity?: {
    stateBytes: number;
    stateItems: number;
    resetReason?: ReasoningContinuityResetReason;
  };
}

/** Resolved continuity context for `assembleRequest` reasoning retention. */
export interface ReasoningContinuityContext {
  mode: ReasoningContinuityMode;
  provider: string;
  model: string;
}

export interface TurnResult {
  /** Updated conversation state ref */
  conversationStateRef: string;
  /** Turn number that was executed */
  turnNumber: number;
}

export interface ClearExchangesResult {
  conversationStateRef: string;
  clearedExchangeCount: number;
  atomsSummarized: number;
}

export interface ClearUnderPressureResult extends ClearExchangesResult {
  /** §4.3 savings-ledger total — the Tier-3/Tier-4 pressure input. */
  estimatedTokensFreed: number;
  /** §4.6 resurrection counters — new detections this pass only. */
  reexecutions: number;
  refetches: number;
}

/**
 * Thrown when a conversation-state ref resolves to a payload that is not an
 * AiConversationStateV1 — corrupt state, never transient. Retrying replays
 * the same corrupt payload, so callers must fail the step instead.
 */
export class ConversationStateCorruptError extends Error {
  readonly code = 'CONVERSATION_STATE_CORRUPT';

  constructor(ref: string, foundShape: string) {
    super(
      `Conversation state at ref ${ref} is not a valid AiConversationStateV1 — found ${foundShape}. ` +
        `Corrupt state is not retryable: every retry reads the same payload.`,
    );
    this.name = 'ConversationStateCorruptError';
  }
}

function describePayloadShape(value: unknown): string {
  if (typeof value === 'string') return `a string of length ${String(value.length)}`;
  if (Array.isArray(value)) return `an array of length ${String(value.length)}`;
  if (value !== null && typeof value === 'object') {
    return `an object with keys [${Object.keys(value as Record<string, unknown>).join(', ')}]`;
  }
  return typeof value;
}

// ============================================================================
// ConversationStateStore
// ============================================================================

export class ConversationStateStore {
  private readonly config: ConversationStateStoreConfig;
  private state: AiConversationStateV1;
  /** Atoms created during this turn (to be stored) */
  private pendingAtoms: AiMessageAtomV1[] = [];
  /** Hydrated atoms from last assembleRequest() — used by compaction. */
  private lastHydratedAtoms: AiMessageAtomV1[] | undefined;

  constructor(config: ConversationStateStoreConfig, state: AiConversationStateV1) {
    this.config = config;
    this.state = state;
  }

  // --------------------------------------------------------------------------
  // Static factory: load or create
  // --------------------------------------------------------------------------

  static async loadOrCreate(
    config: ConversationStateStoreConfig,
    conversationStateRef?: string,
  ): Promise<ConversationStateStore> {
    if (conversationStateRef) {
      let retrieved: unknown;
      let notFound = false;
      try {
        retrieved = await config.payloadStore.retrieve(conversationStateRef as never);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        notFound =
          errMsg.includes('not found') ||
          errMsg.includes('Not Found') ||
          errMsg.includes('404') ||
          errMsg.includes('NoSuchKey') ||
          errMsg.includes('ENOENT');
        if (!notFound) {
          // Transient error — propagate so the step fails and gets retried
          throw new Error(
            `Transient error loading conversation state (ref: ${conversationStateRef}): ${errMsg}`,
          );
        }
        // Legitimate 404 — fall through to create fresh state
      }

      if (!notFound) {
        // Schema-parse the retrieved payload (defaults fill fields persisted
        // states predate). A shape mismatch is corrupt state, not transient —
        // blind property access here would crash into an infinite retry loop.
        const parsed = AiConversationStateV1Schema.safeParse(retrieved);
        if (!parsed.success) {
          throw new ConversationStateCorruptError(
            conversationStateRef,
            describePayloadShape(retrieved),
          );
        }
        const state = parsed.data;
        state.history.maxAtomsStructural = RETENTION_POLICY.maxAtomsStructural;
        return new ConversationStateStore(config, state);
      }
    }

    // Create fresh state
    const state: AiConversationStateV1 = {
      schemaVersion: 1,
      conversationId: `${config.tenantId}:${config.runId}:${config.stepId}`,
      turnNumber: 0,
      context: {},
      history: { atoms: [], maxAtomsStructural: RETENTION_POLICY.maxAtomsStructural },
      seenSourceIds: {},
    };
    return new ConversationStateStore(config, state);
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  get turnNumber(): number {
    return this.state.turnNumber;
  }

  /**
   * Access the current conversation state (for compaction).
   * The returned object is the live state — mutations affect the store.
   */
  getState(): AiConversationStateV1 {
    return this.state;
  }

  /**
   * Get the hydrated atoms from the last assembleRequest() call.
   * Used by compaction to avoid re-hydrating atoms.
   * Falls back to pending atoms if assembly hasn't run yet.
   */
  getHydratedAtoms(): AiMessageAtomV1[] {
    return this.lastHydratedAtoms ?? this.pendingAtoms;
  }

  // --------------------------------------------------------------------------
  // Mutators (before assembly)
  // --------------------------------------------------------------------------

  /**
   * Update the system prompt ref/hash. Only stores a new ref if hash changed.
   */
  async updateSystem(systemPrompt: string): Promise<void> {
    const hash = contentHash(systemPrompt);
    if (this.state.systemHash === hash && this.state.systemRef) {
      return; // Unchanged
    }
    const ref = await this.storePayload('state', { systemPrompt });
    this.state.systemRef = ref;
    this.state.systemHash = hash;
  }

  /**
   * Update context blocks. Only stores new refs for changed blocks.
   */
  async updateContext(blocks: ContextBlock[]): Promise<void> {
    for (const block of blocks) {
      const serialized =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      const hash = contentHash(serialized);

      const existing = this.state.context[block.key];
      if (existing?.hash === hash) {
        continue; // Unchanged — skip storage
      }

      const ref = await this.storePayload('state', { [block.key]: block.content });
      const sizeBytes = Buffer.byteLength(serialized, 'utf8');
      const blockRef: AiContextBlockRef = {
        ref,
        hash,
        sizeBytes,
        contentType: 'application/json',
      };
      this.state.context[block.key] = blockRef;
    }
  }

  /**
   * Append tool result atoms (from completed tool steps since last turn).
   * Idempotent: skips atoms whose sourceId was already seen.
   */
  appendToolResults(envelopes: AiToolResultEnvelopeV1[]): void {
    for (const envelope of envelopes) {
      const sourceId = envelope.toolCallId;
      if (this.state.seenSourceIds[sourceId]) continue; // Already seen

      const message = toolResultMessage(envelope);
      const atom = this.createAtom('tool_result', sourceId, message);
      this.pendingAtoms.push(atom);
      this.state.seenSourceIds[sourceId] = true;
    }
  }

  /**
   * Append user input atom.
   * Idempotent: skips if userInputId was already seen.
   */
  appendUserInput(input: NewUserInput): void {
    const sourceId = input.userInputId;
    if (this.state.seenSourceIds[sourceId]) return; // Already seen

    const message = textMessage('user', attributeToSpeaker(input.text, input.author));
    const atom = this.createAtom('user_input', sourceId, message);
    this.pendingAtoms.push(atom);
    this.state.seenSourceIds[sourceId] = true;
  }

  /**
   * Append what people said in the room, each attributed to its author.
   *
   * A room has several people in it, so `role: 'user'` no longer identifies
   * anyone — the name has to travel with the words or the agent cannot tell a
   * teammate thinking out loud from the person asking it for something. Each
   * message is its own atom keyed by its position, so handing over the recent
   * window every turn appends only what is new.
   */
  appendRoomMessages(entries: readonly RoomExchangeEntry[]): void {
    for (const entry of entries) {
      const sourceId = `room:${String(entry.messageSeq)}`;
      if (this.state.seenSourceIds[sourceId]) continue;

      const message = textMessage('user', attributeToSpeaker(entry.body, entry));
      const atom = this.createAtom('user_input', sourceId, message);
      this.pendingAtoms.push(atom);
      this.state.seenSourceIds[sourceId] = true;
    }
  }

  // --------------------------------------------------------------------------
  // Assembly (deterministic, replayable)
  // --------------------------------------------------------------------------

  /**
   * Assemble the exact model request from the current conversation state.
   * This is what will be sent to the model.
   */
  async assembleRequest(
    systemPrompt: string,
    contextBlocks: ContextBlock[],
    activeMemory?: { anchorText: string; memoryText: string },
    continuity?: ReasoningContinuityContext,
  ): Promise<AssembledRequest> {
    const messages: AiMessageV1[] = [];

    // -- 1. System message --
    const systemHash = contentHash(systemPrompt);
    messages.push(textMessage('system', systemPrompt));

    // Separate MESSAGES per tier, not regions of one: Anthropic marks
    // `cache_control` per system block, so a block containing `runId` is
    // invalidated in full and reordering inside it would buy nothing there.
    // Prefix-caching providers gain from the ordering alone; splitting serves both.
    const tierParts: Record<ContextCacheTier, string[]> = {
      stable: [],
      run_stable: [],
      volatile: [],
    };
    for (const block of contextBlocks) {
      let value: string;
      if (typeof block.content === 'string') {
        value = block.content;
      } else {
        // Compact: the only reader of this block is the model, and pretty
        // printing a real SpaceContext costs ~1,281 chars of pure indentation.
        value = '```json\n' + JSON.stringify(block.content) + '\n```';
      }
      tierParts[block.cacheHint ?? 'stable'].push(`### ${block.key}\n${value}`);
    }

    const tierTexts: string[] = [];
    let cacheableSystemBlockCount = 1; // the system prompt itself
    for (const tier of CONTEXT_CACHE_TIERS) {
      const parts = tierParts[tier];
      if (parts.length === 0) continue;
      const heading = tierTexts.length === 0 ? '## Context' : '## Context (continued)';
      const text = `${heading}\n${parts.join('\n')}`;
      tierTexts.push(text);
      messages.push(textMessage('system', text));
      if (tier !== 'volatile') cacheableSystemBlockCount += 1;
    }
    const contextHash_ = contentHash(tierTexts.join(''));

    // -- 3. History: hydrate atoms (every committed atom — no windowing here;
    const committedAtoms = this.state.history.atoms;

    // Hydrate committed atoms from payload store.
    // Atoms are stored in batches (one batch per turn) — deduplicate ref loads.
    const historyMessages: AiMessageV1[] = [];
    const distinctRefs = [...new Set(committedAtoms.map((a) => a.ref))];
    const loadedBatches = new Map<string, AiMessageAtomV1[]>();

    // Parallel fetch of all distinct batch refs — any failure fails the whole assembly
    // so we never silently shorten committed history on transient store errors.
    const batchResults = await Promise.allSettled(
      distinctRefs.map(async (ref) => {
        const payload = await this.config.payloadStore.retrieve(ref as never);
        const batch = Array.isArray(payload)
          ? (payload as AiMessageAtomV1[])
          : [payload as AiMessageAtomV1];
        return { ref, batch };
      }),
    );

    const failedBatches = new Map<string, UnreadableHistoryBatch>();
    for (let i = 0; i < batchResults.length; i++) {
      const ref = distinctRefs[i]!;
      const result = batchResults[i]!;
      if (result.status === 'fulfilled') {
        loadedBatches.set(ref, result.value.batch);
      } else {
        failedBatches.set(ref, unreadableHistoryBatch(ref, result.reason));
      }
    }

    const integrityIssues: HistoryIntegrityIssue[] = [];
    const hydratedFullAtoms: AiMessageAtomV1[] = [];

    for (const atomRef of committedAtoms) {
      const failedBatch = failedBatches.get(atomRef.ref);
      if (failedBatch) {
        noteCommittedTurn(failedBatch, atomRef.turnNumber);
        integrityIssues.push({
          atomId: atomRef.atomId,
          ref: atomRef.ref,
          reason: 'batch_retrieve_failed',
        });
        continue;
      }
      const batch = loadedBatches.get(atomRef.ref);
      if (!batch) {
        integrityIssues.push({
          atomId: atomRef.atomId,
          ref: atomRef.ref,
          reason: 'batch_missing_after_load',
        });
        continue;
      }
      const atom = batch.find((a) => a.atomId === atomRef.atomId);
      if (!atom) {
        integrityIssues.push({
          atomId: atomRef.atomId,
          ref: atomRef.ref,
          reason: 'atom_not_found_in_batch',
        });
        continue;
      }
      hydratedFullAtoms.push(atom);
    }

    if (integrityIssues.length > 0) {
      throw new ConversationHistoryHydrationError(
        this.state.turnNumber,
        [...failedBatches.values()],
        integrityIssues,
      );
    }
    this.lastHydratedAtoms = [...hydratedFullAtoms, ...this.pendingAtoms];

    // Provider-native reasoning continuity (Plan 259): decide which assistant
    // atoms keep their `providerReasoning` for this request, bounded by mode and
    // reset on provider/model switch. Stripped copies never mutate stored atoms.
    const retention = continuity
      ? retainReasoningForRequest(this.lastHydratedAtoms, continuity)
      : undefined;

    // Earlier observations of a key are reduced here, at assembly, and never in
    // stored history. A result changes form at most once per facet — on the
    // first turn a later result replaces that facet and part of its page, or
    // moves or ends the page — and is byte-identical on every turn between
    // and after, so the provider's prefix cache breaks only at that message and
    // the messages before it are untouched. Nothing in the reduced form may
    // vary turn to turn: no count of later results, no time.
    for (const atom of atomsAsSent(this.lastHydratedAtoms)) {
      if (
        retention &&
        atom.message.providerReasoning !== undefined &&
        !retention.keptAtomIds.has(atom.atomId)
      ) {
        const { providerReasoning: _dropped, ...stripped } = atom.message;
        historyMessages.push(stripped);
      } else {
        historyMessages.push(atom.message);
      }
    }
    messages.push(...historyMessages);

    // Ephemeral active-memory pair (never committed as atoms): inserted before
    // the most recent user message so it is never first-non-system on resumed
    // histories, never adjacent to a real assistant turn, never the final
    // message, and never splits an assistant toolCall from its tool results.
    // A request with no user message in history skips injection (fail-safe).
    let activeMemoryTokens = 0;
    let activeMemoryInjected = false;
    if (activeMemory) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx !== -1) {
        // Walk back over a run of consecutive user messages so the anchor never
        // fuses into a preceding user message during consecutive-role merging.
        let insertIdx = lastUserIdx;
        while (insertIdx > 0 && messages[insertIdx - 1]!.role === 'user') insertIdx--;
        const anchor = textMessage('user', activeMemory.anchorText);
        const memory = textMessage('assistant', activeMemory.memoryText);
        messages.splice(insertIdx, 0, anchor, memory);
        activeMemoryInjected = true;
        activeMemoryTokens =
          estimateStringTokens(activeMemory.anchorText) +
          estimateStringTokens(activeMemory.memoryText);
      }
    }

    // Compute history hash from atom IDs
    const historyAtomIds = [
      ...committedAtoms.map((a) => a.atomId),
      ...this.pendingAtoms.map((a) => a.atomId),
    ];
    const historyHash = contentHash(historyAtomIds.join(','));

    const systemTokens = estimateStringTokens(systemPrompt);
    const contextTokens =
      tierTexts.reduce((sum, text) => sum + estimateStringTokens(text), 0) + activeMemoryTokens;
    let historyTokens = 0;
    for (const msg of historyMessages) {
      historyTokens += estimateMessageTokens(msg);
    }
    // `tools` is partitioned by the caller (it knows deliveryMode + the tool
    // section chars); assembleRequest stays a pure text estimator.
    const tokenBreakdown: TokenBreakdown = {
      system: systemTokens,
      context: contextTokens,
      history: historyTokens,
      tools: 0,
      total: systemTokens + contextTokens + historyTokens,
    };

    return {
      messages,
      systemHash,
      contextHash: contextHash_,
      historyHash,
      tokenBreakdown,
      activeMemoryInjected,
      cacheableSystemBlockCount,
      ...(retention
        ? {
            reasoningContinuity: {
              stateBytes: retention.stateBytes,
              stateItems: retention.stateItems,
              ...(retention.resetReason ? { resetReason: retention.resetReason } : {}),
            },
          }
        : {}),
    };
  }

  // --------------------------------------------------------------------------
  // Post-turn: record assistant response + store everything
  // --------------------------------------------------------------------------

  /**
   * Record the assistant's response as a new atom.
   * @param toolCallSignatures - Gemini 3 thought signatures, indexed by tool call position.
   * @param providerReasoning - Provider-native reasoning captured this turn (Plan 259),
   *   stored inline for tool-use continuity replay.
   */
  recordAssistantResponse(
    decision: Record<string, unknown>,
    turnNumber: number,
    toolCallSignatures?: string[],
    providerReasoning?: AiProviderReasoningV1,
  ): void {
    const action = decision['action'] as string | undefined;
    const messageText = decision['message'] as string | undefined;
    const sourceId = `turn:${String(turnNumber)}`;

    // OpenAI limits tool_call IDs to 40 chars. Use compact format:
    // strip UUID hyphens (32 hex) + "_" + index = 34 chars max.
    const compactId = this.config.stepExecutionId.replaceAll('-', '');

    let message: AiMessageV1;
    if (action === 'invoke_step') {
      const toolId = (decision['toolId'] ?? decision['stepId']) as string | undefined;
      const args = decision['args'];
      const toolCalls: AiToolCallV1[] = toolId
        ? [
            {
              toolCallId: `${compactId}_${String(0)}`,
              name: toolId,
              argumentsJson: args ?? {},
              ...(toolCallSignatures?.[0] ? { thoughtSignature: toolCallSignatures[0] } : {}),
            },
          ]
        : [];
      message = {
        role: 'assistant',
        parts: [
          ...(messageText ? [{ kind: 'text' as const, text: messageText }] : []),
          { kind: 'json' as const, json: decision },
        ],
        toolCalls,
      };
    } else if (action === 'invoke_steps') {
      const calls = decision['calls'] as
        Array<{ toolId?: string; stepId?: string; args?: unknown }> | undefined;
      const toolCalls: AiToolCallV1[] = (calls ?? []).map((c, i) => ({
        toolCallId: `${compactId}_${String(i)}`,
        name: c.toolId ?? c.stepId ?? 'unknown',
        argumentsJson: c.args ?? {},
        ...(toolCallSignatures?.[i] ? { thoughtSignature: toolCallSignatures[i] } : {}),
      }));
      message = {
        role: 'assistant',
        parts: [
          ...(messageText ? [{ kind: 'text' as const, text: messageText }] : []),
          { kind: 'json' as const, json: decision },
        ],
        toolCalls,
      };
    } else {
      // For pause_for_input/complete, keep a readable message but also
      // include the full decision JSON for traceability.
      message = {
        role: 'assistant',
        parts: [
          ...(messageText ? [{ kind: 'text' as const, text: messageText }] : []),
          { kind: 'json' as const, json: decision },
        ],
      };
    }

    if (providerReasoning) {
      message.providerReasoning = providerReasoning;
    }

    const atom = this.createAtom('assistant_turn', sourceId, message);
    this.pendingAtoms.push(atom);
    this.state.seenSourceIds[sourceId] = true;
  }

  /**
   * Store all pending atoms and the updated conversation state.
   * Returns the conversationStateRef for the orchestrator to persist.
   */
  async storeTurn(): Promise<TurnResult> {
    const { payloadStore, tenantId, runId, stepExecutionId, attempt } = this.config;

    // 1. Store all pending atoms as a single batch payload.
    //    PayloadStore keys are deterministic per (stepExecId, attempt, kind),
    //    so storing atoms individually would overwrite — batch them instead.
    if (this.pendingAtoms.length > 0) {
      const batchRef = await payloadStore.store({
        tenantId: tenantId as TenantId,
        runId: runId as SessionId,
        stepExecutionId: stepExecutionId as StepExecutionId,
        attempt,
        kind: 'history',
        data: this.pendingAtoms,
        persist: true,
      });
      for (const atom of this.pendingAtoms) {
        const serialized = JSON.stringify(atom.message);
        this.state.history.atoms.push({
          atomId: atom.atomId,
          ref: batchRef,
          role: atom.role,
          sourceKind: atom.sourceKind,
          hash: contentHash(serialized),
          createdAtMs: atom.createdAtMs,
          ...(atom.turnNumber !== undefined ? { turnNumber: atom.turnNumber } : {}),
        });
      }
    }

    // 2. Increment turn number
    const turnNumber = this.state.turnNumber;
    this.state.turnNumber = turnNumber + 1;

    // 3. Store updated conversation state
    const conversationStateRef = await payloadStore.store({
      tenantId: tenantId as TenantId,
      runId: runId as SessionId,
      stepExecutionId: stepExecutionId as StepExecutionId,
      attempt,
      kind: 'state',
      data: this.state,
      persist: true,
    });

    this.pendingAtoms = [];

    return {
      conversationStateRef,
      turnNumber,
    };
  }

  // --------------------------------------------------------------------------

  async clearUnderPressure(input: {
    /** Provider-reported promptTokens (ground truth) or the assembly estimate. */
    pressureTokens: number;
    effectiveBudget: number;
    /** §4.9 honest degrade — the read op on this turn's tool surface, if any. */
    availableReadOpId: string | undefined;
  }): Promise<ClearUnderPressureResult | undefined> {
    const { pressureTokens, effectiveBudget, availableReadOpId } = input;
    if (effectiveBudget <= 0 || this.state.history.atoms.length === 0) return undefined;
    if (pressureTokens / effectiveBudget <= RETENTION_POLICY.clearHighWater) return undefined;

    const noteOptions: ClearNoteOptions = { availableReadOpId };
    const currentTurn = this.state.turnNumber; // already incremented by storeTurn()
    const hydratedById = this.hydratedAtomsById();
    const sentById = this.sentAtomsById();
    const exchanges = this.groupExchanges(hydratedById);

    // §4.6: re-execution/re-fetch of cleared content marks the new exchange
    // resurrected — class 5, last to clear — before this pass ranks anything.
    const detection = detectResurrections(
      exchanges.values(),
      this.state.clearing?.clearedCalls ?? [],
      new Set(this.state.clearing?.resurrectedExchanges ?? []),
    );
    if (detection.newlyResurrectedKeys.length > 0) {
      this.ensureClearingState().resurrectedExchanges.push(...detection.newlyResurrectedKeys);
    }
    const resurrectedKeys = new Set(this.state.clearing?.resurrectedExchanges ?? []);

    // Idempotency guard — never re-archive an already-cleared exchange.
    const alreadyClearedExchanges = new Set<string>(this.state.clearing?.clearedExchanges ?? []);
    const pinned = this.pinnedAtomIds();

    // §4.9: a note without a working re-read pointer protects its exchange one
    // class harder — clearing is more expensive when re-access is not teachable.
    const degradeBoost = availableReadOpId !== undefined ? 0 : 1;

    const candidates: Array<{
      exchange: Exchange;
      protectionClass: number;
      netSavings: number;
      newestTurn: number;
    }> = [];
    for (const ex of exchanges.values()) {
      if (!ex.hasToolResult) continue;
      if (alreadyClearedExchanges.has(ex.key)) continue;
      if (ex.atomRefs.some((a) => pinned.has(a.atomId))) continue;

      // Tier-1 verbatim recency: retain the whole exchange if any part is recent.
      const turns = [...ex.turns];
      if (turns.some((tn) => currentTurn - tn <= RETENTION_POLICY.keepRecentTurns)) continue;

      const { noteTokens, netSavings } = estimateExchangeClearingTokens(
        ex,
        hydratedById,
        sentById,
        noteOptions,
      );
      if (netSavings <= RETENTION_POLICY.minClearNetSavings(noteTokens)) continue;

      candidates.push({
        exchange: ex,
        protectionClass: resurrectedKeys.has(ex.key)
          ? PROTECTION_CLASS.resurrected
          : Math.min(
              exchangeProtectionClass(ex, hydratedById) + degradeBoost,
              PROTECTION_CLASS.resurrected,
            ),
        netSavings,
        newestTurn: Math.max(...turns),
      });
    }
    if (candidates.length === 0) return await this.persistDetectionOnly(detection);

    candidates.sort((a, b) => {
      if (a.protectionClass !== b.protectionClass) return a.protectionClass - b.protectionClass;
      if (a.netSavings !== b.netSavings) return b.netSavings - a.netSavings;
      return a.newestTurn - b.newestTurn; // age DESC — older exchanges first
    });

    // Greedy pass with a savings ledger: pressure is recomputed after every
    // selection; stop at the low watermark (hysteresis), never below.
    const targetTokens = RETENTION_POLICY.clearLowWater * effectiveBudget;
    const selected: Exchange[] = [];
    let remainingTokens = pressureTokens;
    for (const candidate of candidates) {
      if (remainingTokens <= targetTokens) break;
      selected.push(candidate.exchange);
      remainingTokens -= candidate.netSavings;
    }
    if (selected.length === 0) return await this.persistDetectionOnly(detection);

    const result = await this.clearExchanges(selected, hydratedById, noteOptions);
    return {
      ...result,
      estimatedTokensFreed: pressureTokens - remainingTokens,
      reexecutions: detection.reexecutions,
      refetches: detection.refetches,
    };
  }

  /**
   * §4.6: a pass that cleared nothing still persists newly detected
   * resurrection marks (and surfaces the counters) — otherwise the in-memory
   * ledger update would be lost with the state never stored.
   */
  private async persistDetectionOnly(
    detection: ResurrectionDetection,
  ): Promise<ClearUnderPressureResult | undefined> {
    if (detection.newlyResurrectedKeys.length === 0) return undefined;
    const conversationStateRef = await this.storePayload('state', this.state);
    return {
      conversationStateRef,
      clearedExchangeCount: 0,
      atomsSummarized: 0,
      estimatedTokensFreed: 0,
      reexecutions: detection.reexecutions,
      refetches: detection.refetches,
    };
  }

  async forceClearExcess(target: {
    excessAtoms: number;
    excessTokens: number;
    /** §4.9 honest degrade — the read op on this turn's tool surface, if any. */
    availableReadOpId: string | undefined;
  }): Promise<(ClearExchangesResult & { estimatedTokensFreed: number }) | undefined> {
    if (target.excessAtoms <= 0 && target.excessTokens <= 0) return undefined;

    const noteOptions: ClearNoteOptions = { availableReadOpId: target.availableReadOpId };
    const hydratedById = this.hydratedAtomsById();
    const sentById = this.sentAtomsById();
    const exchanges = this.groupExchanges(hydratedById);
    const alreadyClearedExchanges = new Set<string>(this.state.clearing?.clearedExchanges ?? []);
    const pinned = this.pinnedAtomIds();

    const candidates = [...exchanges.values()]
      .filter(
        (ex) =>
          ex.hasToolResult &&
          !alreadyClearedExchanges.has(ex.key) &&
          !ex.atomRefs.some((a) => pinned.has(a.atomId)),
      )
      .sort((a, b) => {
        const newestA = Math.max(...a.turns);
        const newestB = Math.max(...b.turns);
        if (newestA !== newestB) return newestA - newestB;
        return earliestCreatedAtMs(a) - earliestCreatedAtMs(b);
      });

    // §4.3: the bound is re-evaluated after each forced exchange.
    const selected: Exchange[] = [];
    let atomsFreed = 0;
    let tokensFreed = 0;
    for (const ex of candidates) {
      const atomsDone = target.excessAtoms <= 0 || atomsFreed >= target.excessAtoms;
      const tokensDone = target.excessTokens <= 0 || tokensFreed >= target.excessTokens;
      if (atomsDone && tokensDone) break;
      selected.push(ex);
      atomsFreed += ex.atomRefs.length - 1; // one note replaces the whole exchange
      tokensFreed += estimateExchangeNetTokenSavings(ex, hydratedById, sentById, noteOptions);
    }

    if (selected.length === 0) return undefined;

    const result = await this.clearExchanges(selected, hydratedById, noteOptions);
    return { ...result, estimatedTokensFreed: Math.max(0, tokensFreed) };
  }

  /** Atoms over the structural cap — positive when the Tier-4 bound binds. */
  structuralAtomExcess(): number {
    return this.state.history.atoms.length - this.state.history.maxAtomsStructural;
  }

  pinnedAtomIds(): Set<string> {
    return computePinnedAtomIds(this.state.history.atoms, this.executedTurnNumber());
  }

  // --------------------------------------------------------------------------
  // Exchange machinery (shared by stale + forced clearing paths)
  // --------------------------------------------------------------------------

  /**
   * Hydrated full atoms (with message bodies) from this turn's assembleRequest —
   * needed to read assistant toolCalls + result envelopes for grouping/summaries.
   */
  private hydratedAtomsById(): Map<string, AiMessageAtomV1> {
    return new Map((this.lastHydratedAtoms ?? []).map((atom) => [atom.atomId, atom]));
  }

  /** The same atoms as the model is sent them — what clearing one frees. */
  private sentAtomsById(): Map<string, AiMessageAtomV1> {
    return new Map(atomsAsSent(this.lastHydratedAtoms ?? []).map((atom) => [atom.atomId, atom]));
  }

  /** The turn currently being executed — its atoms are pinned (§4.1). */
  private executedTurnNumber(): number {
    return this.currentTurnNumber ?? Math.max(this.state.turnNumber - 1, 0);
  }

  /**
   * Group committed atoms into exchanges keyed by compact-id base S. Atoms with
   * no tool-call linkage (user input, tool-less assistant turns, cleared
   * summaries) are standalone units keyed by their atomId. Atoms without a
   * turnNumber are excluded — they predate turn stamping and are never cleared.
   */
  private groupExchanges(hydratedById: Map<string, AiMessageAtomV1>): Map<string, Exchange> {
    const exchanges = new Map<string, Exchange>();
    for (const ref of this.state.history.atoms) {
      if (ref.turnNumber === undefined || ref.turnNumber === null) continue;
      const key = exchangeKeyForAtom(ref, hydratedById);
      let ex = exchanges.get(key);
      if (!ex) {
        ex = { key, atomRefs: [], turns: new Set(), hasToolResult: false };
        exchanges.set(key, ex);
      }
      ex.atomRefs.push(ref);
      ex.turns.add(ref.turnNumber);
      if (ref.sourceKind === 'tool_result') ex.hasToolResult = true;
      if (ref.sourceKind === 'assistant_turn') {
        const full = hydratedById.get(ref.atomId);
        if (full?.message.toolCalls?.length) ex.assistantAtom = full;
      }
    }
    return exchanges;
  }

  /**
   * Remove the given exchanges from history — archiving every raw atom and
   * emitting one in-position cleared_summary note per exchange. The only way
   * atoms leave the committed list outside compaction; never a silent removal.
   */
  private async clearExchanges(
    exchangesToClear: Exchange[],
    hydratedById: Map<string, AiMessageAtomV1>,
    noteOptions: ClearNoteOptions,
  ): Promise<ClearExchangesResult> {
    // Archive removed atoms + build one summary per exchange.
    const atomsToArchive: AtomRef[] = [];
    const atomIdsToRemove = new Set<string>();
    const newlyClearedKeys: string[] = [];
    const newlyClearedCalls: AiClearingStateV1['clearedCalls'] = [];
    const summaryFullAtoms: AiMessageAtomV1[] = [];
    const spannedTurns: number[] = [];
    const clearedAtMs = Date.now();
    let atomsSummarized = 0;

    for (const ex of exchangesToClear) {
      newlyClearedKeys.push(ex.key);
      // §4.6: index every cleared call so later passes can detect re-execution
      // (argsHash) and re-fetch (/run/outputs/<toolCallId>).
      newlyClearedCalls.push(...clearedCallEntries(ex, hydratedById, clearedAtMs));
      let placementTurn = Number.POSITIVE_INFINITY;
      let placementCreatedAtMs = Number.POSITIVE_INFINITY;
      for (const ref of ex.atomRefs) {
        atomsToArchive.push(ref);
        atomIdsToRemove.add(ref.atomId);
        atomsSummarized++;
        if (ref.turnNumber !== undefined) spannedTurns.push(ref.turnNumber);
        placementCreatedAtMs = Math.min(placementCreatedAtMs, ref.createdAtMs);
      }
      // Place the summary at the assistant's original slot (or the exchange's
      // earliest atom when there is no surviving assistant).
      placementTurn = ex.assistantAtom?.turnNumber ?? Math.min(...ex.turns);

      summaryFullAtoms.push({
        schemaVersion: 1,
        atomId: crypto.randomUUID(),
        role: 'user',
        sourceId: `cleared:exchange:${ex.key}`,
        sourceKind: 'cleared_summary',
        message: textMessage('user', buildClearedExchangeNote(ex, hydratedById, noteOptions)),
        createdAtMs: placementCreatedAtMs,
        turnNumber: placementTurn,
      });
    }

    // Store archive and summaries with unique keys to avoid overwriting the
    // regular 'history' batch from storeTurn(). PayloadStore keys are deterministic
    // per (stepExecId, attempt, kind) — we use a synthetic stepExecId suffix.
    // The suffix carries the clearing-cycle index: Tier-2 and Tier-4 can both
    // clear within one turn, and a same-key second store() would overwrite the
    // first pass's batch, leaving its note atomRefs dangling forever.
    const { payloadStore, tenantId, runId, stepExecutionId, attempt } = this.config;
    const clearingCycle = String(this.state.clearing?.ranges.length ?? 0);

    // Archive: raw atom refs for this clearing cycle (debug/export only)
    const rawAtomsRef = await payloadStore.store({
      tenantId: tenantId as TenantId,
      runId: runId as SessionId,
      stepExecutionId: `${stepExecutionId}-archive-${clearingCycle}` as StepExecutionId,
      attempt,
      kind: 'history',
      data: atomsToArchive,
      persist: true,
    });

    // Summary atoms: stored as a batch that hydration can load normally
    const summaryBatchRef = await payloadStore.store({
      tenantId: tenantId as TenantId,
      runId: runId as SessionId,
      stepExecutionId: `${stepExecutionId}-clear-${clearingCycle}` as StepExecutionId,
      attempt,
      kind: 'history',
      data: summaryFullAtoms,
      persist: true,
    });

    // Build atom refs for the summaries
    const summaryAtomRefs: AtomRef[] = summaryFullAtoms.map((atom) => ({
      atomId: atom.atomId,
      ref: summaryBatchRef,
      role: atom.role,
      sourceKind: atom.sourceKind,
      hash: contentHash(JSON.stringify(atom.message)),
      createdAtMs: atom.createdAtMs,
      turnNumber: atom.turnNumber,
    }));

    // Replace cleared atoms with summary atom refs, preserving all others.
    const newAtoms: AtomRef[] = [
      ...this.state.history.atoms.filter((a) => !atomIdsToRemove.has(a.atomId)),
      ...summaryAtomRefs,
    ];
    // Sort by turnNumber, then by createdAtMs (summaries inherit the exchange's
    // earliest position, so they land where the assistant was).
    newAtoms.sort((a, b) => {
      const tnA = a.turnNumber ?? -1;
      const tnB = b.turnNumber ?? -1;
      if (tnA !== tnB) return tnA - tnB;
      return a.createdAtMs - b.createdAtMs;
    });

    this.state.history.atoms = newAtoms;

    // Keep the hydrated set honest for same-turn consumers — Tier-3 compaction
    // must see the in-position notes it sweeps (§4.8), not the cleared atoms.
    if (this.lastHydratedAtoms) {
      this.lastHydratedAtoms = [
        ...this.lastHydratedAtoms.filter((a) => !atomIdsToRemove.has(a.atomId)),
        ...summaryFullAtoms,
      ];
    }

    const clearing = this.ensureClearingState();
    clearing.ranges.push({
      fromTurn: Math.min(...spannedTurns),
      toTurn: Math.max(...spannedTurns),
      rawAtomsRef,
      clearedAt: clearedAtMs,
    });
    clearing.clearedExchanges.push(...newlyClearedKeys);
    clearing.clearedCalls.push(...newlyClearedCalls);

    // Persist updated state
    const conversationStateRef = await this.storePayload('state', this.state);

    return {
      conversationStateRef,
      clearedExchangeCount: exchangesToClear.length,
      atomsSummarized,
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private ensureClearingState(): AiClearingStateV1 {
    return (this.state.clearing ??= {
      ranges: [],
      clearedExchanges: [],
      clearedCalls: [],
      resurrectedExchanges: [],
    });
  }

  private currentTurnNumber: number | undefined;

  setTurnNumber(turnNumber: number): void {
    this.currentTurnNumber = turnNumber;
  }

  private createAtom(
    sourceKind:
      'user_input' | 'assistant_turn' | 'tool_result' | 'cleared_summary' | 'compaction_restore',
    sourceId: string,
    message: AiMessageV1,
  ): AiMessageAtomV1 {
    return {
      schemaVersion: 1,
      atomId: crypto.randomUUID(),
      role: message.role,
      sourceId,
      sourceKind,
      message,
      createdAtMs: Date.now(),
      ...(this.currentTurnNumber !== undefined ? { turnNumber: this.currentTurnNumber } : {}),
    };
  }

  private async storePayload(kind: 'state' | 'history', data: unknown): Promise<string> {
    const { payloadStore, tenantId, runId, stepExecutionId, attempt } = this.config;
    return payloadStore.store({
      tenantId: tenantId as TenantId,
      runId: runId as SessionId,
      stepExecutionId: stepExecutionId as StepExecutionId,
      attempt,
      kind,
      data,
      persist: true,
    });
  }
}
