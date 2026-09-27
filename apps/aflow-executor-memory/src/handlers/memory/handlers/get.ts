import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { successWithData, failureWithError } from '@aflow/executor-runtime';
import { internalError, notFoundError, validationError } from '@aflow/executor-runtime';
import type { MemoryDoc, MemoryDocRepository, MemoryDocVersion } from '@aflow/database';
import type { AflowError, MemoryGetInput } from '@aflow/schemas';
import {
  isVirtualPath,
  resolveMemoryPath,
  MemoryPathError,
  MEMORY_READ_BUDGET_CHARS,
  buildOutline,
  packCompleteItems,
  packCompleteLineArray,
  selectJsonPath,
  windowArray,
} from '@aflow/memory-paths';
import {
  computeBytesHash,
  computeContentHash,
  isBinaryPayloadRef,
  makePreview,
} from '@aflow/memory-store';
import type { MemoryLinkRepository } from '@aflow/database';
import { taskDraftReadRefusal } from '@aflow/memory-store';
import { buildStat } from '../stat.js';
import type { MemoryHandlerDeps } from './types.js';
import { buildResolveContext } from './resolveContext.js';

const LINKS_VIEW_CAP = 100;
const CONTENT_BACKLINKS_CAP = 10;

function wantsStructural(input: MemoryGetInput): boolean {
  return input.view === 'outline' || input.jsonPath !== undefined || input.itemRange !== undefined;
}

function toBacklink(b: { fromPath: string; firstContext: string | null; updatedAt: Date }): {
  fromPath: string;
  context?: string;
  updatedAt: string;
} {
  return {
    fromPath: b.fromPath,
    updatedAt: b.updatedAt.toISOString(),
    ...(b.firstContext !== null ? { context: b.firstContext } : {}),
  };
}

/**
 * Both directions of the link graph around one doc: outgoing links this doc
 * authored (up to 100, ordered by ordinal) and backlinks from live sources
 * (up to 100). Totals come from the counts, so `truncated` is exact.
 */
async function buildLinksBlock(
  linkRepo: MemoryLinkRepository,
  docId: string,
  path: string,
  spaceId: string,
): Promise<Record<string, unknown>> {
  const [outgoingAll, backlinkPage, outgoingTotal, backlinkTotal] = await Promise.all([
    linkRepo.getOutgoingLinks(docId, spaceId),
    linkRepo.getBacklinks(path, spaceId, { limit: LINKS_VIEW_CAP }),
    linkRepo.countOutgoing(docId, spaceId),
    linkRepo.countBacklinks(path, spaceId),
  ]);

  const outgoingTotalCount = outgoingTotal.resolved + outgoingTotal.ghost;
  const outgoing = outgoingAll.slice(0, LINKS_VIEW_CAP).map((l) => ({
    targetPath: l.targetPath,
    resolved: l.resolved,
    occurrenceCount: l.occurrenceCount,
    ...(l.firstContext !== null ? { context: l.firstContext } : {}),
  }));
  const backlinks = backlinkPage.items.map(toBacklink);

  const truncated = outgoingTotalCount > LINKS_VIEW_CAP || backlinkPage.nextCursor !== undefined;

  return {
    outgoing,
    backlinks,
    outgoingTotal: outgoingTotalCount,
    backlinkTotal,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Up to 10 most-recently-updated backlinks plus the true total, attached to
 * content/preview reads so a reader sees what points here (outgoing links are
 * already visible in the body). Omitted entirely when nothing references the
 * doc, to keep the common no-backlink read clean.
 */
async function buildContentBacklinks(
  linkRepo: MemoryLinkRepository,
  path: string,
  spaceId: string,
): Promise<Record<string, unknown>> {
  const [page, backlinkTotal] = await Promise.all([
    linkRepo.getBacklinks(path, spaceId, { limit: CONTENT_BACKLINKS_CAP }),
    linkRepo.countBacklinks(path, spaceId),
  ]);
  if (backlinkTotal === 0) return {};
  return {
    backlinks: page.items.map(toBacklink),
    backlinkTotal,
  };
}

type StructuralOutcome =
  { ok: true; fields: Record<string, unknown> } | { ok: false; code: string; message: string };

function itemsRangeMeta(
  start: number,
  count: number,
  totalItems: number,
  jsonPath: string | undefined,
): Record<string, unknown> {
  return {
    kind: 'items' as const,
    start,
    count,
    totalItems,
    hasMore: start + count < totalItems,
    ...(jsonPath !== undefined ? { jsonPath } : {}),
  };
}

function buildStructuralResult(
  input: MemoryGetInput,
  value: unknown,
  isJson: boolean,
): StructuralOutcome {
  if (!isJson && (input.jsonPath !== undefined || input.itemRange !== undefined)) {
    return {
      ok: false,
      code: 'MEMORY_NOT_JSON',
      message:
        'MEMORY_NOT_JSON: jsonPath / itemRange require a JSON document. ' +
        'For text/CSV use positional reads (lineRange / byteRange) instead.',
    };
  }

  // 1. Drill to the subtree at jsonPath (root when absent).
  let subtree: unknown = value;
  if (input.jsonPath !== undefined && input.jsonPath !== '') {
    let selected;
    try {
      selected = selectJsonPath(value, input.jsonPath);
    } catch (err) {
      return {
        ok: false,
        code: 'MEMORY_JSONPATH_INVALID',
        message: `MEMORY_JSONPATH_INVALID: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!selected.found) {
      return {
        ok: false,
        code: 'MEMORY_JSONPATH_NOT_FOUND',
        message:
          `MEMORY_JSONPATH_NOT_FOUND: no value at jsonPath '${input.jsonPath}'. ` +
          "Use view='outline' to see the document shape before drilling.",
      };
    }
    subtree = selected.value;
  }

  const fields: Record<string, unknown> = {};
  const budget = input.maxBytes ?? MEMORY_READ_BUDGET_CHARS;
  const jsonPathLabel =
    input.jsonPath !== undefined && input.jsonPath !== '' ? input.jsonPath : undefined;

  // 2. Window an array at the subtree.
  let window: ReturnType<typeof windowArray> | undefined;
  if (input.itemRange) {
    if (!Array.isArray(subtree)) {
      return {
        ok: false,
        code: 'MEMORY_ITEMRANGE_NOT_ARRAY',
        message:
          'MEMORY_ITEMRANGE_NOT_ARRAY: itemRange requires the value at jsonPath to be an array. ' +
          "Use view='outline' to confirm the type before windowing.",
      };
    }
    window = windowArray(subtree, input.itemRange.start, input.itemRange.count);
    subtree = window.items;
  }

  // 3. Outline view — return the shape, not the data.
  if (input.view === 'outline') {
    if (window && input.itemRange) {
      fields['range'] = itemsRangeMeta(
        input.itemRange.start,
        window.items.length,
        window.totalItems,
        jsonPathLabel,
      );
    }
    fields['outline'] = buildOutline(subtree);
    return { ok: true, fields };
  }

  // 4a. Item window content read — pack complete serialized items so `data`
  // always parses and the reported range describes exactly what was returned.
  if (window && input.itemRange) {
    const packed = packCompleteItems(window.items, budget);
    if (packed.count === 0 && window.items.length > 0) {
      const itemPath = `${jsonPathLabel ?? ''}[${String(input.itemRange.start)}]`;
      return {
        ok: false,
        code: 'MEMORY_ITEM_TOO_LARGE',
        message:
          `MEMORY_ITEM_TOO_LARGE: the item at ${itemPath} serializes to ` +
          `${String(packed.oversizedItemChars ?? 0)} chars — larger than the ` +
          `${String(budget)}-char read budget. Drill into one of its fields with a narrower ` +
          `jsonPath (e.g. jsonPath: "${itemPath}.someField") instead of windowing whole items.`,
      };
    }
    fields['range'] = itemsRangeMeta(
      input.itemRange.start,
      packed.count,
      window.totalItems,
      jsonPathLabel,
    );
    fields['data'] = packed.json;
    if (packed.count === window.items.length) {
      fields['dataJson'] = window.items;
    }
    return { ok: true, fields };
  }

  // 4b. jsonPath-only content read — return the selected subtree.
  // `subtree` is always a parsed-JSON value here (jsonPath/itemRange on
  // non-JSON errored out above), so JSON.stringify yields a string.
  const json = JSON.stringify(subtree);
  if (json.length > budget) {
    fields['data'] = json.substring(0, budget);
    fields['truncated'] = true;
    // The window is over the SERIALIZED SUBTREE, not the raw document — the
    // jsonPath marker tells readers a byteRange continuation is not valid
    // here (byteRange indexes the document; refine structurally instead).
    fields['range'] = {
      kind: 'chars' as const,
      start: 0,
      end: budget,
      totalChars: json.length,
      hasMore: true,
      ...(jsonPathLabel !== undefined ? { jsonPath: jsonPathLabel } : {}),
    };
  } else {
    fields['data'] = json;
    fields['dataJson'] = subtree;
  }
  return { ok: true, fields };
}

interface PositionalWindowOutcome {
  data: string;
  rangeMeta?: Record<string, unknown>;
  truncated: boolean;
  /** The pre-cut window when truncated — available for by-reference storage. */
  fullWindow?: string;
}

/**
 * Apply a positional read (lineRange / byteRange / whole document) under the
 * read budget, cutting only on honest boundaries: a line read stops at the
 * last complete line that fits and reports the actual exclusive end, so a
 * continuation from `range.endLine` covers every line exactly once. Only two
 * cases return a mid-unit cut (with `truncated: true` and a `chars` range so
 * the reader can continue by byteRange): a single line larger than the whole
 * budget, and a whole-document read over the budget.
 */
function applyPositionalWindow(
  content: string,
  input: Pick<MemoryGetInput, 'lineRange' | 'byteRange' | 'maxBytes'>,
): PositionalWindowOutcome {
  const budget = input.maxBytes ?? MEMORY_READ_BUDGET_CHARS;

  if (input.lineRange) {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const requestedSlice = lines.slice(input.lineRange.startLine, input.lineRange.endLine);
    const packed = packCompleteLineArray(requestedSlice, budget);
    if (packed.lineCount === 0 && requestedSlice.length > 0) {
      // The first selected line alone exceeds the budget — return a bounded
      // prefix as a chars window (byteRange is the way to page through it).
      let lineStartOffset = 0;
      for (let i = 0; i < input.lineRange.startLine; i++) {
        lineStartOffset += lines[i]!.length + 1;
      }
      const requested = requestedSlice.join('\n');
      const prefix = requested.slice(0, budget);
      return {
        data: prefix,
        rangeMeta: {
          kind: 'chars' as const,
          start: lineStartOffset,
          end: lineStartOffset + prefix.length,
          totalChars: content.length,
          hasMore: true,
        },
        truncated: true,
        fullWindow: requested,
      };
    }
    const actualEnd = input.lineRange.startLine + packed.lineCount;
    return {
      data: packed.content,
      rangeMeta: {
        kind: 'lines' as const,
        startLine: input.lineRange.startLine,
        endLine: actualEnd,
        totalLines,
        hasMore: actualEnd < totalLines,
      },
      truncated: false,
    };
  }

  if (input.byteRange) {
    const totalChars = content.length;
    const effectiveEnd = Math.min(input.byteRange.end, input.byteRange.start + budget);
    const data = content.slice(input.byteRange.start, effectiveEnd);
    const actualEnd = input.byteRange.start + data.length;
    return {
      data,
      rangeMeta: {
        kind: 'chars' as const,
        start: input.byteRange.start,
        end: actualEnd,
        totalChars,
        hasMore: actualEnd < totalChars,
      },
      truncated: false,
    };
  }

  if (content.length > budget) {
    return {
      data: content.substring(0, budget),
      rangeMeta: {
        kind: 'chars' as const,
        start: 0,
        end: budget,
        totalChars: content.length,
        hasMore: true,
      },
      truncated: true,
      fullWindow: content,
    };
  }
  return { data: content, truncated: false };
}

/**
 * Coerce a resolved body into a JSON value for structural navigation.
 * Prefers an already-parsed object; otherwise tries JSON.parse and falls
 * back to the raw string (marked not-JSON) so `outline` still works on text.
 */
function coerceJsonForStructural(
  contentJson: unknown,
  content: string | null,
): { value: unknown; isJson: boolean } {
  if (contentJson !== undefined) return { value: contentJson, isJson: true };
  if (content === null) return { value: null, isJson: false };
  try {
    return { value: JSON.parse(content), isJson: true };
  } catch {
    return { value: content, isJson: false };
  }
}

type BodySource = Pick<MemoryDocVersion, 'inlineContent' | 'payloadRef'>;

type BodyLoad =
  | { ok: true; kind: 'text'; content: string | null; contentJson: unknown }
  | { ok: true; kind: 'binary'; payloadRef: string }
  | { ok: false; error: AflowError };

/**
 * Media bytes live in the payload store's binary lane, which `retrieve` cannot
 * read (it JSON-parses) — routing has to key on where the bytes actually are,
 * not on the docType alone. The write lane picks the ref, so the ref decides:
 * a docType 'binary' download lands on `.bin`, and a large SVG stored as
 * docType 'image' lands on the JSON lane.
 */
function bodyIsBinary(source: BodySource): boolean {
  return (
    source.inlineContent === null &&
    source.payloadRef !== null &&
    isBinaryPayloadRef(source.payloadRef)
  );
}

function payloadExpiredError(doc: MemoryDoc): AflowError {
  return internalError(
    'MEMORY_PAYLOAD_EXPIRED: document content has expired from the payload store. ' +
      'Re-upload the file via memory.store.put to restore it.',
    { retryable: false, details: { docId: doc.id, path: doc.path, sizeBytes: doc.sizeBytes } },
  );
}

/**
 * Fetch a body from wherever it lives (inline column or payload store). The
 * source is the pinned version row or the live doc row — the caller decides
 * which; this only knows how to fetch one.
 *
 * Binary bodies resolve to their payload handle, never their bytes: this feeds
 * an agent turn, and megabytes of encoded bytes would displace the conversation
 * while teaching the agent nothing the stat does not already say.
 */
async function loadBody(
  source: BodySource,
  doc: MemoryDoc,
  deps: MemoryHandlerDeps,
): Promise<BodyLoad> {
  if (source.inlineContent !== null) {
    return { ok: true, kind: 'text', content: source.inlineContent, contentJson: undefined };
  }
  const payloadRef = source.payloadRef;
  if (!payloadRef) return { ok: true, kind: 'text', content: null, contentJson: undefined };

  try {
    if (bodyIsBinary(source)) {
      if (!(await deps.payloadStore.exists(payloadRef))) {
        return { ok: false, error: payloadExpiredError(doc) };
      }
      return { ok: true, kind: 'binary', payloadRef };
    }

    const payload = await deps.payloadStore.retrieve(payloadRef);
    if (typeof payload === 'string')
      return { ok: true, kind: 'text', content: payload, contentJson: undefined };
    return { ok: true, kind: 'text', content: JSON.stringify(payload), contentJson: payload };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isNotFound = errMsg.includes('not found') || errMsg.includes('Not Found');
    return {
      ok: false,
      error: isNotFound
        ? payloadExpiredError(doc)
        : internalError(
            `MEMORY_PAYLOAD_RETRIEVAL_FAILED: could not retrieve document content — ${errMsg}`,
            {
              retryable: false,
              details: { docId: doc.id, path: doc.path, sizeBytes: doc.sizeBytes },
            },
          ),
    };
  }
}

/**
 * Hash what actually came back. The row-level check compares the caller's pin
 * against the version row, and the body lives at a separate address — only
 * hashing the loaded bytes turns `expectedContentHash` into a statement about
 * the content the caller receives.
 */
async function bodyHashMismatch(
  body: Extract<BodyLoad, { ok: true }>,
  expectedContentHash: string,
  doc: MemoryDoc,
  version: number,
  deps: MemoryHandlerDeps,
): Promise<AflowError | null> {
  const actual =
    body.kind === 'binary'
      ? computeBytesHash(await deps.payloadStore.retrieveBytes(body.payloadRef))
      : computeContentHash(body.content ?? '');
  if (actual === expectedContentHash) return null;
  return validationError(
    `MEMORY_CONTENT_HASH_MISMATCH: the content returned for ${doc.path} version ` +
      `${String(version)} hashes to ${actual}, but expectedContentHash was ` +
      `${expectedContentHash}. These are not the bytes this reference was pinned to — read the ` +
      'pinned target.version, or re-pin to the current content deliberately.',
    {
      path: doc.path,
      version,
      actualContentHash: actual,
      expectedContentHash,
    },
  );
}

export async function handleGet(
  ctx: ExecutorContext,
  repo: MemoryDocRepository,
  input: MemoryGetInput,
  deps: MemoryHandlerDeps,
): Promise<StepResult> {
  const target = input.target;

  if (target.path && isVirtualPath(target.path)) {
    if (target.version !== undefined || target.expectedContentHash !== undefined) {
      return await failureWithError(
        ctx,
        validationError(
          'MEMORY_PIN_UNSUPPORTED: /run/outputs paths are single-shot run artifacts with no ' +
            'version history — drop target.version / target.expectedContentHash, or pin a ' +
            'stored document instead.',
          { path: target.path },
        ),
      );
    }
    return handleVirtualGet(ctx, target.path, input, deps);
  }

  // Refused on the requested path before the lookup, so a draft is not read
  // just to be refused.
  const requestedDraftRefusal = taskDraftReadRefusal(target.path);
  if (requestedDraftRefusal) {
    return await failureWithError(ctx, validationError(requestedDraftRefusal));
  }

  const doc = deps.spaceId
    ? target.id
      ? await repo.getById(target.id, deps.spaceId)
      : target.path
        ? await repo.getByPath(target.path, deps.spaceId)
        : null
    : null;

  // And on the resolved path, which is the route an id lookup takes past every
  // path-shaped guard above.
  const resolvedDraftRefusal = taskDraftReadRefusal(doc?.path);
  if (resolvedDraftRefusal) {
    return await failureWithError(ctx, validationError(resolvedDraftRefusal));
  }

  if (!doc) {
    // Label the locator (path= / id=) so the message stays legible after
    // toAgentToolError → compactMessage strips UUIDs (an id lookup would
    // otherwise render as "no document at ").
    const locator = target.path
      ? `path=${target.path}`
      : target.id
        ? `id=${target.id}`
        : '(unknown target)';
    return await failureWithError(
      ctx,
      notFoundError(`MEMORY_NOT_FOUND: no document at ${locator}`, { target }),
    );
  }

  const spaceId = deps.spaceId;
  if (!spaceId) {
    return await failureWithError(
      ctx,
      validationError('MEMORY_NO_SPACE: memory operations require a space context'),
    );
  }
  let pinnedVersion: MemoryDocVersion | null = null;
  if (target.version !== undefined) {
    pinnedVersion = await repo.getVersion(doc.id, target.version);
    if (!pinnedVersion) {
      return await failureWithError(
        ctx,
        notFoundError(
          `MEMORY_VERSION_NOT_FOUND: ${doc.path} has no version ${String(target.version)} ` +
            `(current version is ${String(doc.currentVersion)}). A pinned read never falls back ` +
            'to the current version — request a version that exists, or drop target.version to ' +
            'read the current one.',
          {
            path: doc.path,
            requestedVersion: target.version,
            currentVersion: doc.currentVersion,
          },
        ),
      );
    }
  }

  const resolvedVersion = pinnedVersion?.version ?? doc.currentVersion;
  const resolvedContentHash = pinnedVersion ? pinnedVersion.contentHash : doc.contentHash;
  if (
    target.expectedContentHash !== undefined &&
    target.expectedContentHash !== resolvedContentHash
  ) {
    return await failureWithError(
      ctx,
      validationError(
        `MEMORY_CONTENT_HASH_MISMATCH: ${doc.path} version ${String(resolvedVersion)} has ` +
          `contentHash ${resolvedContentHash ?? '(none)'}, but expectedContentHash was ` +
          `${target.expectedContentHash}. These are not the bytes this reference was pinned to ` +
          '— read the pinned target.version, or re-pin to the current content deliberately.',
        {
          path: doc.path,
          version: resolvedVersion,
          actualContentHash: resolvedContentHash,
          expectedContentHash: target.expectedContentHash,
        },
      ),
    );
  }

  const stat = await buildStat(doc, deps.linkRepo, spaceId);
  if (pinnedVersion) {
    // stat has to describe the bytes being returned, not the live head.
    stat['version'] = pinnedVersion.version;
    stat['contentHash'] = pinnedVersion.contentHash;
    stat['sizeBytes'] = pinnedVersion.sizeBytes;
  }

  const view =
    input.lineRange || input.byteRange || wantsStructural(input) ? 'content' : input.view;

  if (view === 'stat') {
    return await successWithData(ctx, { stat });
  }

  if (view === 'links') {
    const links = await buildLinksBlock(deps.linkRepo, doc.id, doc.path, spaceId);
    return await successWithData(ctx, { stat, links });
  }

  if (view === 'preview') {
    const backlinkFields = await buildContentBacklinks(deps.linkRepo, doc.path, spaceId);
    if (bodyIsBinary(pinnedVersion ?? doc)) {
      return await successWithData(ctx, { stat, binary: true, ...backlinkFields });
    }
    let previewText: string | undefined;
    if (pinnedVersion) {
      // doc.preview summarizes the live head, so a pinned preview has to be
      // cut from the pinned bytes.
      const pinnedBody = await loadBody(pinnedVersion, doc, deps);
      if (!pinnedBody.ok) return await failureWithError(ctx, pinnedBody.error);
      if (target.expectedContentHash !== undefined) {
        const mismatch = await bodyHashMismatch(
          pinnedBody,
          target.expectedContentHash,
          doc,
          resolvedVersion,
          deps,
        );
        if (mismatch) return await failureWithError(ctx, mismatch);
      }
      previewText =
        pinnedBody.kind === 'text' && pinnedBody.content !== null
          ? makePreview(pinnedBody.content)
          : undefined;
    } else {
      previewText = doc.preview ?? (doc.inlineContent ? makePreview(doc.inlineContent) : undefined);
    }
    return await successWithData(ctx, {
      stat,
      content: previewText,
      ...backlinkFields,
    });
  }

  const body = await loadBody(pinnedVersion ?? doc, doc, deps);
  if (!body.ok) return await failureWithError(ctx, body.error);

  if (target.expectedContentHash !== undefined) {
    const mismatch = await bodyHashMismatch(
      body,
      target.expectedContentHash,
      doc,
      resolvedVersion,
      deps,
    );
    if (mismatch) return await failureWithError(ctx, mismatch);
  }

  if (body.kind === 'binary') {
    // `dataRef` is the platform's internal by-reference field: the orchestrator
    // strips it before the agent sees the result. A downstream step reaches the
    // file by `stat.path` (memory.store.get / bodySource.fromPath) — the
    // sibling-ref resolver reads the JSON lane and cannot deref a `.bin` ref.
    const binaryResult: Record<string, unknown> = {
      stat,
      binary: true,
      dataRef: body.payloadRef,
    };
    Object.assign(binaryResult, await buildContentBacklinks(deps.linkRepo, doc.path, spaceId));
    return await successWithData(ctx, binaryResult);
  }

  let content: string | null = body.content;
  let fullContent: string | null = null;
  const contentJson: unknown = body.contentJson;
  let truncated = false;

  if (wantsStructural(input)) {
    const { value, isJson } = coerceJsonForStructural(contentJson, content);
    const outcome = buildStructuralResult(input, value, isJson);
    if (!outcome.ok) {
      return await failureWithError(
        ctx,
        internalError(outcome.message, { retryable: false, details: { target } }),
      );
    }
    return await successWithData(ctx, { stat, ...outcome.fields });
  }

  let rangeMeta: Record<string, unknown> | undefined;

  if (content !== null) {
    // Note: lengths are UTF-16 code units, not bytes. Range metadata uses the
    // 'chars' kind to be honest about what slice() actually does.
    const windowed = applyPositionalWindow(content, input);
    content = windowed.data;
    rangeMeta = windowed.rangeMeta;
    truncated = windowed.truncated;
    fullContent = windowed.fullWindow ?? null;
  }

  const result: Record<string, unknown> = { stat };
  if (content !== null) result['data'] = content;
  // Only include dataJson if it fits within maxBytes (avoid context flooding).
  // When truncated or range-reading, the string `data` is already the right slice.
  if (contentJson !== undefined && !truncated && !input.lineRange && !input.byteRange)
    result['dataJson'] = contentJson;
  if (truncated) result['truncated'] = true;
  if (rangeMeta) result['range'] = rangeMeta;

  Object.assign(result, await buildContentBacklinks(deps.linkRepo, doc.path, spaceId));

  if (truncated && fullContent !== null) {
    try {
      const dataRef = await deps.payloadStore.store({
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.stepExecutionId,
        attempt: ctx.attempt,
        kind: 'body', // Use 'body' kind — 'output' would collide with successWithData
        data: fullContent,
      });
      result['dataRef'] = dataRef;
    } catch {
      // Best-effort — the inline truncated data is still available
    }
  }

  return await successWithData(ctx, result);
}

/**
 * Handle a virtual path get (/run/outputs/...).
 * Returns stat-only or full content depending on view.
 */
async function handleVirtualGet(
  ctx: ExecutorContext,
  path: string,
  input: MemoryGetInput,
  deps: MemoryHandlerDeps,
): Promise<StepResult> {
  const resolveCtx = buildResolveContext(ctx, deps);

  try {
    const resolved = await resolveMemoryPath(path, resolveCtx);

    // Build a synthetic stat for virtual paths
    const stat = {
      id: '00000000-0000-0000-0000-000000000000',
      path,
      docType: 'text' as const,
      mimeType: resolved.mimeType ?? 'application/octet-stream',
      sizeBytes: resolved.sizeBytes,
      tags: [],
      version: 1,
      embeddingStatus: 'disabled' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const effectiveView =
      input.lineRange || input.byteRange || wantsStructural(input) ? 'content' : input.view;

    if (effectiveView === 'stat') {
      return await successWithData(ctx, { stat });
    }

    if (effectiveView === 'links') {
      // Virtual /run/ paths have no persisted doc and thus no link graph — an
      // empty block is the honest answer, not the raw output body.
      return await successWithData(ctx, {
        stat,
        links: { outgoing: [], backlinks: [], outgoingTotal: 0, backlinkTotal: 0 },
      });
    }

    if (effectiveView === 'preview') {
      return await successWithData(ctx, {
        stat,
        content: makePreview(resolved.content),
      });
    }

    if (wantsStructural(input)) {
      const { value, isJson } = coerceJsonForStructural(undefined, resolved.content);
      const outcome = buildStructuralResult(input, value, isJson);
      if (!outcome.ok) {
        return await failureWithError(
          ctx,
          internalError(outcome.message, { retryable: false, details: { path } }),
        );
      }
      return await successWithData(ctx, { stat, ...outcome.fields });
    }

    const windowed = applyPositionalWindow(resolved.content, input);

    const result: Record<string, unknown> = { stat, data: windowed.data };
    if (windowed.truncated) result['truncated'] = true;
    if (windowed.rangeMeta) result['range'] = windowed.rangeMeta;

    return await successWithData(ctx, result);
  } catch (err) {
    if (err instanceof MemoryPathError) {
      return await failureWithError(
        ctx,
        notFoundError(`MEMORY_NOT_FOUND: ${err.message}`, { path, code: err.code }),
      );
    }
    throw err;
  }
}
