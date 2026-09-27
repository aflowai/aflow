import type {
  AiClearedToolCallV1,
  AiConversationStateV1,
  AiMessageAtomV1,
  AiToolResultEnvelopeV1,
} from '@aflow/schemas';
import {
  MEMORY_READ_OPERATION_ID,
  RUN_OUTPUT_READ_OPERATION_ID,
  computeToolCallArgsHash,
  getOperation,
} from '@aflow/schemas';
import { buildOutline, type OutlineNode } from '@aflow/memory-paths';
import { RETENTION_POLICY } from './retentionPolicy.js';
import {
  ESTIMATED_CHARS_PER_TOKEN,
  estimateMessageTokens,
  estimateStringTokens,
} from './tokenEstimate.js';

export type AtomRef = AiConversationStateV1['history']['atoms'][number];

export interface Exchange {
  key: string;
  atomRefs: AtomRef[];
  turns: Set<number>;
  hasToolResult: boolean;
  /** Hydrated assistant atom (with toolCalls) when its producer turn survives. */
  assistantAtom?: AiMessageAtomV1;
}

/** Strip the trailing `_${index}` from a compact id, yielding its base `S`. */
function baseOfToolCallId(toolCallId: string): string | undefined {
  const m = /^(.+)_\d+$/.exec(toolCallId);
  return m ? m[1] : undefined;
}

export function exchangeKeyForAtom(
  ref: { atomId: string; sourceKind?: string | undefined },
  hydratedById: Map<string, AiMessageAtomV1>,
): string {
  const full = hydratedById.get(ref.atomId);
  if (ref.sourceKind === 'assistant_turn' && full?.message.toolCalls?.length) {
    const base = baseOfToolCallId(full.message.toolCalls[0]!.toolCallId);
    if (base) return base;
  }
  if (ref.sourceKind === 'tool_result' && full?.message.toolCallId) {
    const base = baseOfToolCallId(full.message.toolCallId);
    if (base) return base;
  }
  return `standalone:${ref.atomId}`;
}

/** The tool_result envelope embedded in a hydrated atom's json part. */
export function toolResultEnvelopeOfAtom(
  atom: AiMessageAtomV1,
): AiToolResultEnvelopeV1 | undefined {
  for (const part of atom.message.parts) {
    if (part.kind !== 'json') continue;
    const json = part.json as Record<string, unknown> | null;
    if (json?.['kind'] === 'tool_result') return json as unknown as AiToolResultEnvelopeV1;
  }
  return undefined;
}

/** Whether a hydrated tool_result atom's envelope reports a FAILED status. */
export function isFailedToolResultAtom(atom: AiMessageAtomV1): boolean {
  return toolResultEnvelopeOfAtom(atom)?.status === 'FAILED';
}

export const PROTECTION_CLASS = {
  /** Succeeded results of idempotent ops — cheapest to restore, safe to re-derive. */
  idempotent: 1,
  /** Succeeded results of unknown-idempotency ops (catalog lookup miss). */
  unknown: 2,
  /** Succeeded results of non-idempotent ops — clearing invites re-execution. */
  nonIdempotent: 3,
  /** Failed exchanges — kept longest; they prevent mistake repetition. */
  failed: 4,
  resurrected: 5,
} as const;

/**
 * Protection class of an exchange — the MOST protective class across its
 * results. Idempotency resolves via the catalog registry from the typed
 * envelope `operationId` (§4.4a); unresolved ids are `unknown`.
 */
export function exchangeProtectionClass(
  ex: Exchange,
  hydratedById: Map<string, AiMessageAtomV1>,
): number {
  let cls: number = PROTECTION_CLASS.idempotent;
  for (const ref of ex.atomRefs) {
    if (ref.sourceKind !== 'tool_result') continue;
    const full = hydratedById.get(ref.atomId);
    const envelope = full ? toolResultEnvelopeOfAtom(full) : undefined;
    if (!envelope) {
      cls = Math.max(cls, PROTECTION_CLASS.unknown);
      continue;
    }
    if (envelope.status === 'FAILED') {
      cls = Math.max(cls, PROTECTION_CLASS.failed);
      continue;
    }
    const idempotency = envelope.operationId
      ? (getOperation(envelope.operationId)?.idempotency ?? 'unknown')
      : 'unknown';
    cls = Math.max(
      cls,
      idempotency === 'idempotent'
        ? PROTECTION_CLASS.idempotent
        : idempotency === 'non_idempotent'
          ? PROTECTION_CLASS.nonIdempotent
          : PROTECTION_CLASS.unknown,
    );
  }
  return cls;
}

export function earliestCreatedAtMs(ex: Exchange): number {
  let min = Number.POSITIVE_INFINITY;
  for (const ref of ex.atomRefs) min = Math.min(min, ref.createdAtMs);
  return min;
}

/**
 * Per-call records for a cleared exchange (§4.6) — toolName + stable args hash
 * from the assistant atom's tool calls. Result-only exchanges (producer gone)
 * record toolCallId/toolName from the envelopes without an argsHash, so
 * re-fetch detection still works for them.
 */
export function clearedCallEntries(
  ex: Exchange,
  hydratedById: Map<string, AiMessageAtomV1>,
  clearedAtMs: number,
): AiClearedToolCallV1[] {
  const calls = ex.assistantAtom?.message.toolCalls;
  if (calls?.length) {
    return calls.map((call) => ({
      exchangeKey: ex.key,
      toolCallId: call.toolCallId,
      toolName: call.name,
      argsHash: computeToolCallArgsHash(call.name, call.argumentsJson),
      clearedAtMs,
    }));
  }
  const entries: AiClearedToolCallV1[] = [];
  for (const ref of ex.atomRefs) {
    if (ref.sourceKind !== 'tool_result') continue;
    const full = hydratedById.get(ref.atomId);
    const envelope = full ? toolResultEnvelopeOfAtom(full) : undefined;
    if (!envelope) continue;
    entries.push({
      exchangeKey: ex.key,
      toolCallId: envelope.toolCallId,
      toolName: envelope.toolName,
      clearedAtMs,
    });
  }
  return entries;
}

export interface ResurrectionDetection {
  /** New tool calls re-executing a cleared call (argsHash match) — the note failed. */
  reexecutions: number;
  /** New memory.store.get reads of a cleared output (`/run/outputs/<toolCallId>`) — working as designed, note was lean. */
  refetches: number;
  /** Exchange keys to mark resurrected (not yet in the persisted ledger). */
  newlyResurrectedKeys: string[];
}

/**
 * §4.6 — scan surviving exchanges for re-execution/re-fetch of cleared calls.
 * Matches only assistant atoms newer than the clear; exchanges already in the
 * resurrected ledger are skipped (counter dedup across passes).
 */
export function detectResurrections(
  exchanges: Iterable<Exchange>,
  clearedCalls: readonly AiClearedToolCallV1[],
  alreadyResurrected: ReadonlySet<string>,
): ResurrectionDetection {
  if (clearedCalls.length === 0) {
    return { reexecutions: 0, refetches: 0, newlyResurrectedKeys: [] };
  }
  const byArgsHash = new Map<string, AiClearedToolCallV1>();
  const byToolCallId = new Map<string, AiClearedToolCallV1>();
  for (const call of clearedCalls) {
    if (call.argsHash !== undefined && !byArgsHash.has(call.argsHash)) {
      byArgsHash.set(call.argsHash, call);
    }
    if (!byToolCallId.has(call.toolCallId)) byToolCallId.set(call.toolCallId, call);
  }

  let reexecutions = 0;
  let refetches = 0;
  const newlyResurrected = new Set<string>();
  for (const ex of exchanges) {
    if (alreadyResurrected.has(ex.key)) continue;
    const assistant = ex.assistantAtom;
    const calls = assistant?.message.toolCalls;
    if (!assistant || !calls?.length) continue;
    for (const call of calls) {
      const reexecuted = byArgsHash.get(computeToolCallArgsHash(call.name, call.argumentsJson));
      if (reexecuted && assistant.createdAtMs > reexecuted.clearedAtMs) {
        reexecutions++;
        newlyResurrected.add(ex.key);
        continue;
      }
      if (call.name !== MEMORY_READ_OPERATION_ID && call.name !== RUN_OUTPUT_READ_OPERATION_ID)
        continue;
      const targetId = refetchTargetToolCallId(call.argumentsJson);
      const refetched = targetId !== undefined ? byToolCallId.get(targetId) : undefined;
      if (refetched && assistant.createdAtMs > refetched.clearedAtMs) {
        refetches++;
        newlyResurrected.add(ex.key);
      }
    }
  }
  return { reexecutions, refetches, newlyResurrectedKeys: [...newlyResurrected] };
}

/** `/run/outputs/<toolCallId>[/…]` → toolCallId, for any other path undefined. */
function refetchTargetToolCallId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const path = (args as Record<string, unknown>)['path'];
  if (typeof path !== 'string') return undefined;
  const match = /^\/run\/outputs\/([^/]+)/.exec(path);
  return match?.[1];
}

export interface ExchangeClearingEstimate {
  removedTokens: number;
  noteTokens: number;
  /** removedTokens − noteTokens — the §4.3 savings-ledger unit. */
  netSavings: number;
}

/** Estimated token effect of clearing an exchange (atoms removed vs note added). */
export function estimateExchangeClearingTokens(
  ex: Exchange,
  hydratedById: Map<string, AiMessageAtomV1>,
  noteOptions: ClearNoteOptions,
): ExchangeClearingEstimate {
  let removedTokens = 0;
  for (const ref of ex.atomRefs) {
    const full = hydratedById.get(ref.atomId);
    if (full) removedTokens += estimateMessageTokens(full.message);
  }
  const noteTokens = estimateStringTokens(buildClearedExchangeNote(ex, hydratedById, noteOptions));
  return { removedTokens, noteTokens, netSavings: removedTokens - noteTokens };
}

/** Estimated tokens freed by clearing an exchange (atoms removed − note added). */
export function estimateExchangeNetTokenSavings(
  ex: Exchange,
  hydratedById: Map<string, AiMessageAtomV1>,
  noteOptions: ClearNoteOptions,
): number {
  return estimateExchangeClearingTokens(ex, hydratedById, noteOptions).netSavings;
}

/** Bounded snippet of a tool call's arguments — enough to answer "what did we ask?". */
function digestArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  const max = RETENTION_POLICY.noteDigestMaxChars;
  return s.length > max ? `${s.slice(0, max)}…(${String(s.length)}b)` : s;
}

/**
 * §4.9 honest degrade — which read op is on this turn's tool surface
 * (`memory.store.get` or the floor-granted `memory.run_output.get`).
 * Undefined = neither: notes omit the read promise.
 */
export interface ClearNoteOptions {
  availableReadOpId: string | undefined;
}

export function buildClearedExchangeNote(
  ex: {
    atomRefs: Array<{ atomId: string; sourceKind?: string | undefined }>;
    assistantAtom?: AiMessageAtomV1 | undefined;
  },
  hydratedById: Map<string, AiMessageAtomV1>,
  options: ClearNoteOptions,
): string {
  return boundedNote((lean) => renderClearedExchangeNote(ex, hydratedById, options, lean));
}

function renderClearedExchangeNote(
  ex: {
    atomRefs: Array<{ atomId: string; sourceKind?: string | undefined }>;
    assistantAtom?: AiMessageAtomV1 | undefined;
  },
  hydratedById: Map<string, AiMessageAtomV1>,
  options: ClearNoteOptions,
  lean: boolean,
): string {
  // Index result envelopes by their toolCallId for status/ref lookup.
  const resultByToolCallId = new Map<string, AiMessageAtomV1>();
  for (const ref of ex.atomRefs) {
    if (ref.sourceKind !== 'tool_result') continue;
    const full = hydratedById.get(ref.atomId);
    if (full?.message.toolCallId) resultByToolCallId.set(full.message.toolCallId, full);
  }

  const calls = ex.assistantAtom?.message.toolCalls;
  if (!calls?.length) {
    // Result-only exchange (producer cleared earlier) — digest-only fallback.
    const lines: string[] = [];
    for (const ref of ex.atomRefs) {
      if (ref.sourceKind !== 'tool_result') continue;
      const full = hydratedById.get(ref.atomId);
      lines.push((full && buildClearedToolLine(full)) || '• (tool result cleared)');
    }
    const header = `[Context note — ${String(lines.length)} earlier tool result${lines.length !== 1 ? 's' : ''} cleared to save space.]`;
    return lines.length > 0 ? `${header}\n${lines.join('\n')}` : header;
  }

  const blocks: string[] = [];
  let anyReadable = false;
  for (const call of calls) {
    const resultAtom = resultByToolCallId.get(call.toolCallId);
    const envelope = resultAtom ? toolResultEnvelopeOfAtom(resultAtom) : undefined;
    const statusStr = resultAtom
      ? formatResultStatus(resultAtom, { withRefTail: false })
      : 'result not retained';
    const lines = [
      `• ${call.name}(${digestArgs(call.argumentsJson)}) [${call.toolCallId}] → ${statusStr}`,
    ];

    const hint = lean ? undefined : buildShapeHint(envelope);
    const readable = options.availableReadOpId !== undefined && envelope?.outputPath !== undefined;
    if (readable) {
      anyReadable = true;
      lines.push(
        `  read: ${options.availableReadOpId} { path: '${envelope.outputPath}/data', view: 'outline' }${hint ? ` (${hint})` : ''}`,
      );
    } else if (hint) {
      lines.push(`  stored result: ${hint}`);
    }

    const idempotency = envelope?.operationId
      ? (getOperation(envelope.operationId)?.idempotency ?? 'unknown')
      : 'unknown';
    if (idempotency === 'non_idempotent') {
      lines.push(
        readable
          ? '  ⚠ not idempotent — do NOT re-run this call; re-read the stored result instead.'
          : '  ⚠ not idempotent — do NOT re-run this call.',
      );
    }
    blocks.push(lines.join('\n'));
  }

  const count = calls.length;
  const header = anyReadable
    ? `[Context note — earlier tool exchange (${String(count)} tool call${count !== 1 ? 's' : ''}) cleared to save space. Results remain readable — see below.]`
    : `[Context note — earlier tool exchange (${String(count)} tool call${count !== 1 ? 's' : ''}) cleared to save space.]`;
  return `${header}\n${blocks.join('\n')}`;
}

/** Enforce `noteMaxTokens`: full note → no shape hints → hard char truncation. */
function boundedNote(render: (lean: boolean) => string): string {
  const maxTokens = RETENTION_POLICY.noteMaxTokens;
  const full = render(false);
  if (estimateStringTokens(full) <= maxTokens) return full;
  const lean = render(true);
  if (estimateStringTokens(lean) <= maxTokens) return lean;
  const maxChars = Math.floor(maxTokens * ESTIMATED_CHARS_PER_TOKEN);
  return `${lean.slice(0, Math.max(0, maxChars - 1))}…`;
}

export interface NoteReadPointer {
  path: string;
  toolName?: string;
}

const READ_POINTER_PATTERN = new RegExp(
  `read: (?:${MEMORY_READ_OPERATION_ID.replaceAll('.', '\\.')}|${RUN_OUTPUT_READ_OPERATION_ID.replaceAll(
    '.',
    '\\.',
  )}) \\{ path: '([^']+)', view: 'outline' \\}`,
);

/**
 * Parse the read-pointer lines back out of a clear-to-ref note (§4.8 sweep) —
 * co-located with the builder above so render and parse can never drift.
 */
export function extractNoteReadPointers(noteText: string): NoteReadPointer[] {
  const pointers: NoteReadPointer[] = [];
  let lastToolName: string | undefined;
  for (const line of noteText.split('\n')) {
    const bullet = /^• ([^\s(]+)\(/.exec(line);
    if (bullet) {
      lastToolName = bullet[1];
      continue;
    }
    const path = READ_POINTER_PATTERN.exec(line)?.[1];
    if (path !== undefined) {
      pointers.push({ path, ...(lastToolName !== undefined ? { toolName: lastToolName } : {}) });
    }
  }
  return pointers;
}

/**
 * One-level shape hint (§4.4): outline of the result data when it is still
 * inline in the hydrated envelope, else the typed `outputFields` paths.
 */
function buildShapeHint(envelope: AiToolResultEnvelopeV1 | undefined): string | undefined {
  if (!envelope) return undefined;
  const data = parseInlineResultData(envelope);
  if (data !== undefined) {
    return renderOutlineHint(buildOutline(data, { maxDepth: 1 }));
  }
  if (envelope.outputFields?.length) {
    return `fields: ${envelope.outputFields.join(', ')}`;
  }
  return undefined;
}

/** Result data is "available" when the envelope summary is inline JSON. */
function parseInlineResultData(envelope: AiToolResultEnvelopeV1): unknown {
  const text = envelope.summary?.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function renderOutlineHint(node: OutlineNode): string {
  const size = formatBytes(node.bytes);
  if (node.type === 'object') {
    const keys = (node.children ?? [])
      .map((c) => `${c.key ?? '?'}${c.type === 'array' ? `[${String(c.length ?? 0)}]` : ''}`)
      .join(', ');
    return `~${size}, object: {${keys}${node.truncatedChildren ? ', …' : ''}}`;
  }
  if (node.type === 'array') return `~${size}, array[${String(node.length ?? 0)}]`;
  return `~${size}, ${node.type}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Build a compact one-liner for a cleared tool result atom.
 * Extracts tool name, status, duration, and $ref from the embedded envelope.
 *
 * Example output:
 *   • memory.store.get("/test/data.csv") → succeeded (192ms). Full: $ref output.abc123/content
 *   • compute.sandbox.exec(python3) → FAILED: ValueError. Full: $ref output.def456/stderr
 */
function buildClearedToolLine(atom: AiMessageAtomV1): string | undefined {
  for (const part of atom.message.parts) {
    if (part.kind !== 'json') continue;
    const json = part.json as Record<string, unknown> | null;
    if (json?.['kind'] !== 'tool_result') continue;
    const toolName = (json['toolName'] as string) ?? 'unknown';
    return `• ${toolName} → ${formatResultStatus(atom, { withRefTail: true })}`;
  }
  return undefined;
}

/**
 * Format the status of a tool_result atom's envelope. Returns just the status
 * portion (no bullet/name), e.g. `succeeded (192ms) — …`. The `$ref` tail is
 * emitted only for the digest-only fallback — the clear-to-ref note replaces
 * it with the `memory.store.get` pointer (§4.4).
 */
function formatResultStatus(atom: AiMessageAtomV1, opts: { withRefTail: boolean }): string {
  for (const part of atom.message.parts) {
    if (part.kind !== 'json') continue;
    const json = part.json as Record<string, unknown> | null;
    if (json?.['kind'] !== 'tool_result') continue;

    const status = (json['status'] as string) ?? 'unknown';
    const durationMs = json['durationMs'] as number | undefined;
    const outputRef = json['outputRef'] as string | undefined;
    const errorRef = json['errorRef'] as string | undefined;
    const summary = json['summary'] as string | undefined;
    const error = json['error'] as Record<string, unknown> | undefined;

    const max = RETENTION_POLICY.noteSnippetMaxChars;
    const durationStr = durationMs !== undefined ? ` (${formatDuration(durationMs)})` : '';
    let statusStr: string;
    if (status === 'SUCCEEDED') {
      const snippet = summary
        ? ` — ${summary.slice(0, max)}${summary.length > max ? '…' : ''}`
        : '';
      statusStr = `succeeded${durationStr}${snippet}`;
    } else if (status === 'FAILED') {
      const errMsg = (error?.['message'] as string) ?? '';
      const errSnippet = errMsg ? `: ${errMsg.slice(0, max)}${errMsg.length > max ? '…' : ''}` : '';
      statusStr = `FAILED${errSnippet}${durationStr}`;
    } else {
      statusStr = `${status.toLowerCase()}${durationStr}`;
    }

    const refStr = !opts.withRefTail
      ? ''
      : outputRef
        ? `. Full: $ref ${outputRef}`
        : errorRef
          ? `. Error: $ref ${errorRef}`
          : '';
    return `${statusStr}${refStr}`;
  }
  return 'cleared';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
