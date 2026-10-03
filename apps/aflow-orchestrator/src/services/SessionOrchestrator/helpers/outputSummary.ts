import {
  MEMORY_READ_BUDGET_CHARS,
  buildOutline,
  packCompleteItems,
  packCompleteLines,
} from '@aflow/memory-paths';
import type { OutlineNode } from '@aflow/memory-paths';
import {
  AiMediaOutputSchema,
  MEMORY_READ_OPERATION_ID,
  MemoryReadRangeMetaSchema,
  RUN_OUTPUT_READ_OPERATION_ID,
  TOOL_RESULT_INLINE_MAX_CHARS,
  type AiMediaOutput,
  type MemoryReadRangeMeta,
} from '@aflow/schemas';

const SUMMARY_HARD_CAP = 12_000;
const PASSTHROUGH_THRESHOLD = TOOL_RESULT_INLINE_MAX_CHARS;
/** Lines to show in preview sections */
const PREVIEW_LINES = 5;

/** The two explicit-read operations whose `data` IS the requested result. */
const MEMORY_READ_OPERATIONS = new Set<string>([
  MEMORY_READ_OPERATION_ID,
  RUN_OUTPUT_READ_OPERATION_ID,
]);

/**
 * The whole assembled read summary (header + content + continuation) must stay
 * under the 16,000-char tool-result envelope ceiling (AiToolResult
 * summary.text). MEMORY_READ_BUDGET_CHARS content plus variable parts (the
 * document path appears in the header AND the continuation; a jsonPath and a
 * backlinks line may too) is bounded against this, not assumed.
 */
const READ_SUMMARY_SAFE_MAX = 15_800;

// ============================================================================
// Shape detectors
// ============================================================================

interface ApiShape {
  type: 'api';
  statusCode: number;
  data: unknown;
  contentType?: string;
  truncated?: boolean;
  originalSizeBytes?: number;
}

interface MemoryShape {
  type: 'memory';
  data: unknown;
  stat: { path?: string; sizeBytes?: number; mimeType?: string };
  truncated?: boolean;
  originalSizeBytes?: number;
}

interface ComputeShape {
  type: 'compute';
  data: unknown;
  stderr: unknown;
  exitCode: number;
  durationMs?: number;
  truncated?: boolean;
  outputFiles?: Record<string, unknown>;
  originalSizeBytes?: number;
}

interface MediaShape {
  type: 'media';
  output: AiMediaOutput;
}

type OutputShape = ApiShape | MemoryShape | ComputeShape | MediaShape | { type: 'generic' };

function detectShape(output: unknown): OutputShape {
  if (output == null || typeof output !== 'object') return { type: 'generic' };
  const obj = output as Record<string, unknown>;

  // Generated media: pinned assets and the receipt they share. Matched against
  // the output schema rather than sniffed key by key, so a rename cannot leave
  // this reading a field nothing writes.
  if ('assets' in obj && 'receipt' in obj) {
    const media = AiMediaOutputSchema.safeParse(obj);
    if (media.success) return { type: 'media', output: media.data };
  }

  // API response: has data + statusCode
  if ('data' in obj && 'statusCode' in obj && typeof obj['statusCode'] === 'number') {
    const shape: ApiShape = {
      type: 'api',
      statusCode: obj['statusCode'],
      data: obj['data'],
      truncated: obj['truncated'] === true,
    };
    const parsedMeta = obj['parsedMeta'];
    const parsedContentType =
      parsedMeta != null && typeof parsedMeta === 'object'
        ? (parsedMeta as Record<string, unknown>)['contentType']
        : undefined;
    if (typeof parsedContentType === 'string') shape.contentType = parsedContentType;
    else if (typeof obj['contentType'] === 'string') shape.contentType = obj['contentType'];
    if (typeof obj['originalSizeBytes'] === 'number')
      shape.originalSizeBytes = obj['originalSizeBytes'];
    return shape;
  }

  // Memory doc (get): has data + stat
  if ('stat' in obj && typeof obj['stat'] === 'object' && obj['stat'] !== null) {
    const stat = obj['stat'] as Record<string, unknown>;
    if ('data' in obj || 'dataJson' in obj) {
      const statObj: MemoryShape['stat'] = {};
      if (typeof stat['path'] === 'string') statObj.path = stat['path'];
      if (typeof stat['sizeBytes'] === 'number') statObj.sizeBytes = stat['sizeBytes'];
      if (typeof stat['mimeType'] === 'string') statObj.mimeType = stat['mimeType'];
      return {
        type: 'memory',
        data: obj['data'] ?? obj['dataJson'],
        stat: statObj,
        truncated: obj['truncated'] === true,
        ...(typeof obj['originalSizeBytes'] === 'number'
          ? { originalSizeBytes: obj['originalSizeBytes'] }
          : {}),
      };
    }
  }

  // Memory put: has path + sizeBytes + data (no stat wrapper)
  if (
    'path' in obj &&
    typeof obj['path'] === 'string' &&
    'sizeBytes' in obj &&
    typeof obj['sizeBytes'] === 'number' &&
    'data' in obj
  ) {
    return {
      type: 'memory',
      data: obj['data'],
      stat: {
        path: obj['path'],
        sizeBytes: obj['sizeBytes'],
      },
      truncated: 'dataRef' in obj,
    };
  }

  // Compute result: has data + exitCode
  if ('exitCode' in obj && typeof obj['exitCode'] === 'number') {
    const shape: ComputeShape = {
      type: 'compute',
      data: obj['data'],
      stderr: obj['stderr'],
      exitCode: obj['exitCode'],
      truncated: obj['truncated'] === true,
    };
    if (typeof obj['durationMs'] === 'number') shape.durationMs = obj['durationMs'];
    if (obj['outputFiles'] != null && typeof obj['outputFiles'] === 'object') {
      shape.outputFiles = obj['outputFiles'] as Record<string, unknown>;
    }
    if (typeof obj['originalSizeBytes'] === 'number')
      shape.originalSizeBytes = obj['originalSizeBytes'];
    return shape;
  }

  return { type: 'generic' };
}

// ============================================================================
// Helpers
// ============================================================================

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function firstLines(text: string, n: number): string {
  const lines = text.split('\n').slice(0, n);
  return lines.map((l) => `  ${l}`).join('\n');
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

function isStructuredForRender(data: unknown): boolean {
  if (data == null) return false;
  return Array.isArray(data) || typeof data === 'object';
}

function visualizeAffordance(toolCallId: string, field: string): string {
  const ref = `output.${toolCallId}/${field}`;
  return `To visualize: ui.surface.visualize({ data: { "$ref": "${ref}" }, ... }) or ui.artifact.render({ data: { "$ref": "${ref}" }, ... })`;
}

function returnAsOutputAffordance(ref: string): string {
  return `To return as your output (e.g. submit_output, or a task output field): set the field to { "$ref": "${ref}" } — do NOT read the value into your context first.`;
}

function structuralNavAffordance(path: string): string {
  return (
    `To navigate structure: memory.store.get({ target: { path: "${path}" }, view: "outline" }) ` +
    `then drill with jsonPath / itemRange (e.g. jsonPath: "a.b[3]", itemRange: { start: 0, count: 20 })`
  );
}

function renderOutlineLines(
  node: OutlineNode,
  indent: string,
  out: string[],
  maxLines: number,
): void {
  if (!node.children) return;
  for (const child of node.children) {
    if (out.length >= maxLines) {
      out.push(`${indent}… (more — use view:"outline" to see all)`);
      return;
    }
    const label = child.key ?? '(item)';
    let desc: string;
    switch (child.type) {
      case 'object':
        desc = `object{${String(child.length ?? 0)} keys}`;
        break;
      case 'array':
        desc = `array[${String(child.length ?? 0)}]`;
        break;
      case 'string':
        desc = `string(${String(child.length ?? 0)} chars)`;
        break;
      case 'number':
      case 'boolean':
      case 'null':
        desc = child.type;
        break;
    }
    out.push(`${indent}${label}: ${desc} — ${formatSize(child.bytes)}`);
    if (child.children) renderOutlineLines(child, indent + '  ', out, maxLines);
  }
}

// ============================================================================

function buildApiSummary(shape: ApiShape, toolCallId: string): string {
  const dataStr = stringify(shape.data);
  const size = formatSize(shape.originalSizeBytes ?? dataStr.length);
  const ct = shape.contentType ?? (typeof shape.data === 'string' ? 'text' : 'json');
  const lc = lineCount(dataStr);
  const truncNote = shape.truncated ? ' — TRUNCATED preview; read full via reference' : '';

  const lines: string[] = [];
  lines.push(`[API ${String(shape.statusCode)} — ${size} ${ct} — ${String(lc)} lines${truncNote}]`);

  const isBinaryContent =
    ct === 'binary' ||
    ct === 'application/octet-stream' ||
    ct.startsWith('image/') ||
    ct.startsWith('audio/') ||
    ct.startsWith('video/');
  if (!isBinaryContent) {
    lines.push(
      `To read content: memory.store.get({ target: { path: "/run/outputs/${toolCallId}/data" }, view: "content", lineRange: { startLine: 1, endLine: 100 } })`,
    );
  }
  lines.push(`To load in compute: inputPaths: ["/run/outputs/${toolCallId}/data"]`);
  lines.push(
    `To persist to memory: memory.store.put(content: {fromPath: "/run/outputs/${toolCallId}/data"})`,
  );
  if (isStructuredForRender(shape.data)) {
    lines.push(structuralNavAffordance(`/run/outputs/${toolCallId}/data`));
    lines.push(visualizeAffordance(toolCallId, 'data'));
  }

  if (dataStr.length > 0) {
    lines.push('Preview:');
    lines.push(firstLines(dataStr, PREVIEW_LINES));
  }

  return lines.join('\n');
}

function buildMemorySummary(shape: MemoryShape, toolCallId: string): string {
  const dataStr = stringify(shape.data);
  const path = shape.stat.path ?? '(unknown path)';
  const size =
    shape.stat.sizeBytes != null ? formatSize(shape.stat.sizeBytes) : formatSize(dataStr.length);
  const mime = shape.stat.mimeType ?? '';
  const lc = lineCount(dataStr);

  const lines: string[] = [];
  lines.push(`[Memory ${path} — ${size}${mime ? ` ${mime}` : ''} — ${String(lc)} lines]`);

  const isBinary =
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/octet-stream';
  if (!isBinary) {
    lines.push(
      `To read content: memory.store.get({ target: { path: "/run/outputs/${toolCallId}/data" }, view: "content", lineRange: { startLine: 1, endLine: 100 } })`,
    );
  }
  lines.push(`To load in compute: inputPaths: ["/run/outputs/${toolCallId}/data"]`);
  lines.push(
    `To persist to memory: memory.store.put(content: {fromPath: "/run/outputs/${toolCallId}/data"})`,
  );
  lines.push(returnAsOutputAffordance(`output.${toolCallId}/data`));
  if (isStructuredForRender(shape.data)) {
    lines.push(structuralNavAffordance(`/run/outputs/${toolCallId}/data`));
    lines.push(visualizeAffordance(toolCallId, 'data'));
  }

  if (dataStr.length > 0) {
    lines.push(`Preview (first ${String(PREVIEW_LINES)} lines):`);
    lines.push(firstLines(dataStr, PREVIEW_LINES));
  }

  return lines.join('\n');
}

function buildComputeSummary(shape: ComputeShape, toolCallId: string): string {
  const dataStr = stringify(shape.data);
  const duration = shape.durationMs != null ? `${(shape.durationMs / 1000).toFixed(1)}s` : '';

  const lines: string[] = [];
  lines.push(`[Compute exit ${String(shape.exitCode)}${duration ? ` — ${duration}` : ''}]`);

  const stderrStr = stringify(shape.stderr);
  if (stderrStr.length > 0) {
    lines.push(`stderr: ${stderrStr.slice(0, 200)}`);
  }

  // Show output files with virtual filesystem paths.
  // File content is base64-encoded — derive actual size from base64 length.
  if (shape.outputFiles && Object.keys(shape.outputFiles).length > 0) {
    const fileNames = Object.keys(shape.outputFiles);
    lines.push(`Output files: ${fileNames.join(', ')}`);
    for (const name of fileNames.slice(0, 5)) {
      const content = shape.outputFiles[name];
      const fileSize =
        typeof content === 'string' ? formatSize(Buffer.byteLength(content, 'utf8')) : 'unknown';
      lines.push(`  /run/outputs/${toolCallId}/outputFiles/${name} (${fileSize})`);
    }
    const firstFile = fileNames[0]!;
    lines.push(returnAsOutputAffordance(`output.${toolCallId}/outputFiles/${firstFile}`));
  }

  lines.push(
    `To read content: memory.store.get({ target: { path: "/run/outputs/${toolCallId}/data" }, view: "content", lineRange: { startLine: 1, endLine: 100 } })`,
  );
  lines.push(`To load in compute: inputPaths: ["/run/outputs/${toolCallId}/data"]`);
  lines.push(
    `To persist to memory: memory.store.put(content: {fromPath: "/run/outputs/${toolCallId}/data"})`,
  );
  if (isStructuredForRender(shape.data)) {
    lines.push(structuralNavAffordance(`/run/outputs/${toolCallId}/data`));
    lines.push(visualizeAffordance(toolCallId, 'data'));
  }

  if (dataStr.length > 0) {
    const lc = lineCount(dataStr);
    lines.push(`stdout (${formatSize(dataStr.length)}, ${String(lc)} lines):`);
    lines.push(firstLines(dataStr, PREVIEW_LINES));
  }

  return lines.join('\n');
}

// ============================================================================
// Generated media
// ============================================================================

/** Prose kept per field while the pins are still comfortably inside the budget. */
const MEDIA_PROSE_PREVIEW_CHARS = 240;
/** Prose kept once the pins are what the budget is being spent on. */
const MEDIA_PROSE_MINIMUM_CHARS = 40;
/**
 * Held under SUMMARY_HARD_CAP, whose tail truncation would cut this summary
 * mid-token and hand the agent something it cannot parse.
 */
const MEDIA_SUMMARY_MAX_CHARS = 11_000;

interface MediaSummaryBudget {
  proseChars: number;
  includeBoundEntities: boolean;
  maxAssets: number;
}

/**
 * What a media summary gives up, in the order it can afford to. The prompt is
 * the bulk of a large media output and the agent wrote it; the pins are what the
 * next render reads, and they are two orders of magnitude smaller.
 */
function* mediaSummaryBudgets(assetCount: number): Generator<MediaSummaryBudget> {
  yield {
    proseChars: MEDIA_PROSE_PREVIEW_CHARS,
    includeBoundEntities: true,
    maxAssets: assetCount,
  };
  yield {
    proseChars: MEDIA_PROSE_MINIMUM_CHARS,
    includeBoundEntities: true,
    maxAssets: assetCount,
  };
  for (let maxAssets = assetCount; maxAssets >= 1; maxAssets -= 1) {
    yield { proseChars: MEDIA_PROSE_MINIMUM_CHARS, includeBoundEntities: false, maxAssets };
  }
}

function clampProse(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function listPhrase(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function mediaSummaryPayload(
  output: AiMediaOutput,
  budget: MediaSummaryBudget,
): Record<string, unknown> {
  const dropped: string[] = [];

  const shown = output.assets.slice(0, budget.maxAssets);
  if (shown.length < output.assets.length) {
    dropped.push(
      `${String(output.assets.length - shown.length)} of ${String(output.assets.length)} candidates`,
    );
  }
  if (shown.some((asset) => (asset.revisedPrompt?.length ?? 0) > budget.proseChars)) {
    dropped.push('the revised-prompt tails');
  }
  const assets = shown.map((asset) =>
    asset.revisedPrompt === undefined || asset.revisedPrompt.length <= budget.proseChars
      ? asset
      : { ...asset, revisedPrompt: clampProse(asset.revisedPrompt, budget.proseChars) },
  );

  const { prompt, negativePrompt, parameters, boundEntityVersions } = output.receipt.request;
  if (
    prompt.length > budget.proseChars ||
    (negativePrompt !== undefined && negativePrompt.length > budget.proseChars)
  ) {
    dropped.push('the prompt tail');
  }
  if (!budget.includeBoundEntities && boundEntityVersions.length > 0) {
    dropped.push(`the ${String(boundEntityVersions.length)} pins this render read`);
  }
  const request: Record<string, unknown> = {
    prompt: clampProse(prompt, budget.proseChars),
    ...(negativePrompt !== undefined
      ? { negativePrompt: clampProse(negativePrompt, budget.proseChars) }
      : {}),
    parameters,
    ...(budget.includeBoundEntities ? { boundEntityVersions } : {}),
  };

  const payload: Record<string, unknown> = {
    assets,
    receipt: { ...output.receipt, request },
    receiptRef: output.receiptRef,
  };
  if (dropped.length > 0) {
    payload['note'] =
      `This view drops ${listPhrase(dropped)} so every asset keeps its path, version and ` +
      'contentHash. The receipt document named by receiptRef holds the complete record.';
  }
  return payload;
}

/**
 * A render is returned as pins to stored bytes, and those pins are the whole
 * point of the output: the next render binds them, and nothing else addresses
 * the asset. So a media output over the passthrough threshold is cut down rather
 * than replaced by an outline — an outline names the keys and drops the values,
 * which loses the identity the chain runs on.
 */
function buildMediaSummary(shape: MediaShape): string {
  let text = '';
  for (const budget of mediaSummaryBudgets(shape.output.assets.length)) {
    text = JSON.stringify(mediaSummaryPayload(shape.output, budget));
    if (text.length <= MEDIA_SUMMARY_MAX_CHARS) break;
  }
  return text;
}

/**
 * Detect and replace base64-encoded blobs in a JSON string.
 * Base64 strings > 256 chars are almost certainly binary data (images, files)
 * that are useless when truncated. Replace with a size placeholder.
 */
function sanitizeBase64InJson(json: string): string {
  // Match quoted strings that look like base64 (long runs of base64 chars)
  return json.replace(/"([A-Za-z0-9+/=]{256,})"/g, (_match, b64: string) => {
    const approxSize = formatSize(Math.round((b64.length * 3) / 4));
    return `"[base64 data, ${approxSize}]"`;
  });
}

function buildGenericSummary(output: unknown, toolCallId: string): string {
  const outline = buildOutline(output, { maxDepth: 2, maxChildren: 40 });

  // A structural outline only helps navigable (object/array) outputs. A large
  // *scalar* (e.g. a raw text blob) has no shape to drill and no jsonPath to
  // follow — give it a content preview + a positional read hint instead, so the
  // agent can actually inspect the text.
  if (outline.type !== 'object' && outline.type !== 'array') {
    return buildScalarSummary(output, toolCallId, outline);
  }

  const header =
    outline.type === 'array'
      ? `[Large result — array of ${String(outline.length ?? 0)} items — ${formatSize(outline.bytes)}]`
      : `[Large result — ${String(outline.length ?? 0)} top-level keys — ${formatSize(outline.bytes)}]`;

  const lines: string[] = [header];

  // Affordances first — they survive the tail-truncating hard cap.
  lines.push(structuralNavAffordance(`/run/outputs/${toolCallId}`));
  lines.push(`To load in compute: inputPaths: ["/run/outputs/${toolCallId}"]`);
  lines.push(
    `To persist to memory: memory.store.put(content: {fromPath: "/run/outputs/${toolCallId}"})`,
  );
  lines.push(returnAsOutputAffordance(`output.${toolCallId}`));

  // Inline outline so the agent can often drill in a single follow-up call.
  if (outline.children && outline.children.length > 0) {
    lines.push('Outline:');
    const outlineLines: string[] = [];
    renderOutlineLines(outline, '  ', outlineLines, 40);
    lines.push(...outlineLines);
  }

  return lines.join('\n');
}

function buildScalarSummary(output: unknown, toolCallId: string, outline: OutlineNode): string {
  const text = stringify(output);
  const sizeLabel =
    outline.type === 'string'
      ? `${formatSize(outline.bytes)}, ${String(lineCount(text))} lines`
      : formatSize(outline.bytes);
  const lines: string[] = [`[Large result — ${sizeLabel}]`];

  // Affordances first — they survive the tail-truncating hard cap.
  lines.push(
    `To read content: memory.store.get({ target: { path: "/run/outputs/${toolCallId}" }, view: "content", lineRange: { startLine: 1, endLine: 100 } })`,
  );
  lines.push(`To load in compute: inputPaths: ["/run/outputs/${toolCallId}"]`);
  lines.push(
    `To persist to memory: memory.store.put(content: {fromPath: "/run/outputs/${toolCallId}"})`,
  );
  lines.push(returnAsOutputAffordance(`output.${toolCallId}`));

  if (text.length > 0) {
    lines.push('Preview:');
    lines.push(firstLines(sanitizeBase64InJson(text), PREVIEW_LINES));
  }

  return lines.join('\n');
}

// ============================================================================

/**
 * When the step output declares `presentation.mode === 'rendered_inline'`
 * (emitted by `ui.artifact.render`, `ui.surface.visualize`, and
 * `ui.applet.instantiate` / `ui.applet.get` / `ui.applet.act`), the next
 * agent turn must NOT
 * see the raw HTML / mutation array / applet state. The chat already
 * shows the rendered output; restating the data wastes tokens, leaks
 * numerics, and contradicts the "inline = canonical view" invariant.
 *
 * Returns the stub string when the output qualifies, or `null` to let the
 * caller fall through to the normal summary path. Shape validation is
 * intentionally lenient — we only check the discriminator + substrate so
 * an output that drifts from the contract still routes through here as
 * long as the marker is present.
 */
function buildRenderedInlineStub(output: unknown): string | null {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) return null;
  const presentation = (output as Record<string, unknown>)['presentation'];
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
    return null;
  }
  const p = presentation as Record<string, unknown>;
  if (p['mode'] !== 'rendered_inline') return null;
  const substrate = p['substrate'];
  if (substrate !== 'artifact' && substrate !== 'surface' && substrate !== 'applet') return null;

  const stub: Record<string, unknown> = {
    rendered: true,
    substrate,
    note:
      substrate === 'applet'
        ? 'Board already rendered in the chat. Do not restate the position.'
        : 'Output already rendered in the chat. Do not restate.',
  };
  if (substrate === 'artifact') {
    if (typeof p['artifactId'] === 'string') stub['artifactId'] = p['artifactId'];
    if (typeof p['versionId'] === 'string') stub['versionId'] = p['versionId'];
  } else if (substrate === 'surface') {
    if (typeof p['surfaceId'] === 'string') stub['surfaceId'] = p['surfaceId'];
  } else {
    if (typeof p['instanceId'] === 'string') stub['instanceId'] = p['instanceId'];
    // The artifact/surface stubs strip data the agent itself supplied — but a
    // ui.applet.get IS the agent's own read of the board: the projection is
    // what it came for (computing a move, learning the baseVersion). Keep the
    // functional fields; the note only stops it repainting the position in
    // prose next to the live card.
    const out = output as Record<string, unknown>;
    for (const key of [
      'state',
      'stateVersion',
      'receipt',
      'recentReceipts',
      'availableActions',
      'roleBindings',
      'definitionHash',
      'gridView',
      'situation',
    ]) {
      if (out[key] !== undefined) stub[key] = out[key];
    }
  }
  // The stub bypasses normal summarization, and the turn input hard-caps the
  // summary — an oversized one FAILS the turn, killing the session. Degrade by
  // dropping the heaviest fields first; the agent can always re-read narrower.
  let text = JSON.stringify(stub);
  if (text.length > RENDERED_STUB_MAX_CHARS) {
    const dropped: string[] = [];
    for (const heavyKey of ['state', 'recentReceipts', 'receipt', 'gridView']) {
      if (text.length <= RENDERED_STUB_MAX_CHARS) break;
      if (stub[heavyKey] === undefined) continue;
      delete stub[heavyKey];
      dropped.push(heavyKey);
      text = JSON.stringify(stub);
    }
    if (dropped.length > 0) {
      const priorNote = typeof stub['note'] === 'string' ? stub['note'] : '';
      stub['note'] =
        `${priorNote} Output exceeded the turn budget — dropped ` +
        `${dropped.join(', ')}; re-read a narrower slice if needed.`;
      text = JSON.stringify(stub);
    }
  }
  return text;
}

/** Margin under the 16000-char turn-input cap on newToolResults summaries. */
const RENDERED_STUB_MAX_CHARS = 15000;

// ============================================================================
// Internal ref stripping
// ============================================================================

const INTERNAL_REF_FIELDS = new Set([
  'dataRef',
  'bodyRef',
  'contentRef',
  'rawBodyRef',
  'outputFiles',
]);

function carriesByReferenceData(output: unknown): boolean {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) return false;
  const obj = output as Record<string, unknown>;
  if (obj['truncated'] === true) return true;
  if (typeof obj['originalSizeBytes'] === 'number') return true;
  const outputFiles = obj['outputFiles'];
  if (
    outputFiles != null &&
    typeof outputFiles === 'object' &&
    !Array.isArray(outputFiles) &&
    Object.keys(outputFiles as Record<string, unknown>).length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Strip internal ref fields from an output object so agents only see
 * the summary and the unified $ref hint — never raw PayloadStore URIs.
 */
function stripInternalRefs(output: unknown): unknown {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) return output;
  const obj = output as Record<string, unknown>;
  let changed = false;
  for (const key of INTERNAL_REF_FIELDS) {
    if (key in obj) {
      changed = true;
    }
  }
  if (!changed) return output;
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (!INTERNAL_REF_FIELDS.has(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

// ============================================================================
// Memory read summary — an explicit read's content is the requested result
// ============================================================================

/** Render a continuation call from the ORIGINAL path — never the read call's own output path. */
function readContinuation(operationId: string, path: string, rangeArg: string): string {
  const target =
    operationId === RUN_OUTPUT_READ_OPERATION_ID
      ? `path: "${path}"`
      : `target: { path: "${path}" }`;
  return `[More: ${operationId}({ ${target}, ${rangeArg} })]`;
}

const BACKLINKS_LINE_CAP = 400;

/**
 * Compact "what points here" line so a large read keeps the backlinks the
 * content view documents — they exist in the stored output but would otherwise
 * never reach the model for over-budget reads.
 */
function buildBacklinksLine(obj: Record<string, unknown>): string | undefined {
  const backlinks = obj['backlinks'];
  if (!Array.isArray(backlinks) || backlinks.length === 0) return undefined;
  const paths: string[] = [];
  for (const backlink of backlinks) {
    if (backlink != null && typeof backlink === 'object') {
      const fromPath = (backlink as Record<string, unknown>)['fromPath'];
      if (typeof fromPath === 'string') paths.push(fromPath);
    }
  }
  if (paths.length === 0) return undefined;
  const total = typeof obj['backlinkTotal'] === 'number' ? obj['backlinkTotal'] : paths.length;
  let line = `[Backlinks (${String(total)}): ${paths.join(', ')}]`;
  if (line.length > BACKLINKS_LINE_CAP) line = `${line.slice(0, BACKLINKS_LINE_CAP - 2)}…]`;
  return line;
}

interface MemoryReadSummary {
  text: string;
  continuationEmitted: boolean;
}

/**
 * Bounded presentation of an explicit memory read. The executor already
 * applied the requested range; this boundary shows that content (re-cut on
 * the same semantic units when it exceeds the display budget) with a header
 * and one concrete continuation from the original path when more remains.
 * Returns null when the output is not a content read (stat/outline/links
 * views) so the caller falls through to the ordinary summary path.
 */
function buildMemoryReadSummary(output: unknown, operationId: string): MemoryReadSummary | null {
  if (output == null || typeof output !== 'object' || Array.isArray(output)) return null;
  const obj = output as Record<string, unknown>;
  const stat = obj['stat'];
  if (stat == null || typeof stat !== 'object') return null;
  const statObj = stat as Record<string, unknown>;
  const path = typeof statObj['path'] === 'string' ? statObj['path'] : undefined;
  const data = obj['data'];
  if (path === undefined || typeof data !== 'string') return null;

  const mime = typeof statObj['mimeType'] === 'string' ? statObj['mimeType'] : undefined;
  const sizeBytes = typeof statObj['sizeBytes'] === 'number' ? statObj['sizeBytes'] : undefined;
  const executorTruncated = obj['truncated'] === true;
  const parsedRange = MemoryReadRangeMetaSchema.safeParse(obj['range']);
  const range: MemoryReadRangeMeta | undefined = parsedRange.success ? parsedRange.data : undefined;
  const backlinks = buildBacklinksLine(obj);

  // The path (twice: header + continuation), any jsonPath (twice), and the
  // backlinks line all ride the envelope alongside the content — size the
  // content budget so the ASSEMBLED text stays under the envelope ceiling.
  const jsonPathLength =
    (range?.kind === 'items' || range?.kind === 'chars') && range.jsonPath !== undefined
      ? range.jsonPath.length
      : 0;
  const overhead = 2 * path.length + 2 * jsonPathLength + (backlinks?.length ?? 0) + 400;
  const contentBudget = Math.min(MEMORY_READ_BUDGET_CHARS, READ_SUMMARY_SAFE_MAX - overhead);
  if (contentBudget <= 0) return null;

  const headerPrefix =
    `[Read ${path}` +
    (mime !== undefined && mime !== '' ? ` — ${mime}` : '') +
    (sizeBytes !== undefined ? `, ${formatSize(sizeBytes)}` : '');

  let shown: string;
  let rangeDesc: string;
  let note: string | undefined;
  let continuation: string | undefined;

  if (range?.kind === 'lines') {
    shown = data;
    let shownLineCount = Math.max(range.endLine - range.startLine, 0);
    if (data.length > contentBudget) {
      const packed = packCompleteLines(data, contentBudget);
      if (packed.lineCount > 0) {
        shown = packed.content;
        shownLineCount = packed.lineCount;
      } else {
        shown = data.slice(0, contentBudget);
        shownLineCount = 0;
      }
    }
    if (shownLineCount === 0) {
      // A single line larger than the display budget. Its document offset is
      // unknown here, so teach a re-read whose smaller maxBytes forces the
      // executor's oversized-line path — that response reports an exact chars
      // window (with the true offset) to page from.
      rangeDesc = `line ${String(range.startLine)} (partial) of ${String(range.totalLines)}`;
      note = `(the line at ${String(range.startLine)} exceeds the display budget — the re-read below returns an exact chars window to page with byteRange)`;
      continuation = readContinuation(
        operationId,
        path,
        `lineRange: { startLine: ${String(range.startLine)}, endLine: ${String(range.startLine + 1)} }, maxBytes: ${String(contentBudget)}`,
      );
    } else {
      const shownEnd = range.startLine + shownLineCount;
      rangeDesc = `lines ${String(range.startLine)}..${String(shownEnd)} of ${String(range.totalLines)}`;
      const hasMore = range.hasMore || shownEnd < range.endLine;
      if (hasMore) {
        const window = Math.max(shownLineCount, 1);
        continuation = readContinuation(
          operationId,
          path,
          `lineRange: { startLine: ${String(shownEnd)}, endLine: ${String(shownEnd + window)} }`,
        );
      }
    }
  } else if (range?.kind === 'chars') {
    shown = data.length > contentBudget ? data.slice(0, contentBudget) : data;
    const shownEnd = range.start + shown.length;
    const subtreeSuffix =
      range.jsonPath !== undefined ? ` of the serialized subtree at ${range.jsonPath}` : '';
    rangeDesc = `chars ${String(range.start)}..${String(shownEnd)} of ${String(range.totalChars)}${subtreeSuffix}`;
    const hasMore = range.hasMore || shown.length < data.length;
    if (hasMore) {
      if (range.jsonPath !== undefined) {
        // The window indexes the SERIALIZED SUBTREE, not the document —
        // byteRange (a document offset) would return unrelated content.
        note = `(a byteRange continuation is not valid here — refine with a deeper jsonPath or window an array with itemRange)`;
        continuation = readContinuation(
          operationId,
          path,
          `jsonPath: "${range.jsonPath}", view: "outline"`,
        );
      } else {
        const window = Math.max(shownEnd - range.start, 1);
        continuation = readContinuation(
          operationId,
          path,
          `byteRange: { start: ${String(shownEnd)}, end: ${String(shownEnd + window)} }`,
        );
      }
    }
  } else if (range?.kind === 'items') {
    const itemPathPrefix = range.jsonPath ?? '';
    shown = data;
    let shownCount = range.count;
    if (data.length > contentBudget) {
      let items: unknown[] | undefined;
      try {
        const parsed: unknown = JSON.parse(data);
        items = Array.isArray(parsed) ? parsed : undefined;
      } catch {
        items = undefined;
      }
      if (items === undefined) return null;
      const packed = packCompleteItems(items, contentBudget);
      shown = packed.count > 0 ? packed.json : '';
      shownCount = packed.count;
    }
    const atSuffix = range.jsonPath !== undefined ? ` at ${range.jsonPath}` : '';
    if (shownCount === 0) {
      rangeDesc = `item ${String(range.start)} of ${String(range.totalItems)}${atSuffix}`;
      note = `(the item at index ${String(range.start)} exceeds the display budget — drill into one field)`;
      continuation = readContinuation(
        operationId,
        path,
        `jsonPath: "${itemPathPrefix}[${String(range.start)}]"`,
      );
    } else {
      rangeDesc = `items ${String(range.start)}..${String(range.start + shownCount)} of ${String(range.totalItems)}${atSuffix}`;
      const hasMore = range.hasMore || shownCount < range.count;
      if (hasMore) {
        const jsonPathArg = range.jsonPath !== undefined ? `jsonPath: "${range.jsonPath}", ` : '';
        continuation = readContinuation(
          operationId,
          path,
          `${jsonPathArg}itemRange: { start: ${String(range.start + shownCount)}, count: ${String(Math.max(shownCount, 1))} }`,
        );
      }
    }
  } else {
    // No range metadata — a whole-document content read.
    shown = data;
    if (data.length > contentBudget) {
      const packed = packCompleteLines(data, contentBudget);
      shown = packed.lineCount > 0 ? packed.content : data.slice(0, contentBudget);
    }
    const summaryCut = shown.length < data.length;
    rangeDesc =
      executorTruncated || summaryCut
        ? `first ${formatSize(shown.length)} (${String(lineCount(shown))} lines)`
        : `${String(lineCount(shown))} lines`;
    if (executorTruncated) {
      // Without range metadata the shown data's offset space is unknown (it
      // may be a serialized subtree) — do not fabricate a byteRange call.
      note =
        '(content truncated — re-read the path with lineRange/byteRange windows, or view: "outline" to navigate JSON)';
    } else if (summaryCut) {
      // data is the complete document body, so document offsets are exact.
      continuation = readContinuation(
        operationId,
        path,
        `byteRange: { start: ${String(shown.length)}, end: ${String(shown.length + contentBudget)} }`,
      );
    }
  }

  const lines: string[] = [`${headerPrefix} — ${rangeDesc}]`];
  if (backlinks !== undefined) lines.push(backlinks);
  if (note !== undefined) lines.push(note);
  if (shown.length > 0) lines.push(shown);
  if (continuation !== undefined) lines.push(continuation);
  return { text: lines.join('\n'), continuationEmitted: continuation !== undefined };
}

// ============================================================================
// Public API
// ============================================================================

export interface ToolSummaryMeta {
  kind: 'rendered_inline' | 'passthrough' | 'memory_read' | 'source_preview';
  chars: number;
  continuationEmitted: boolean;
}

/**
 * Build a type-aware summary of a step's output for inclusion in agent tool
 * results. Detects output shape (API/memory/compute) and produces a summary
 * with virtual filesystem paths (/run/outputs/<toolCallId>/<field>) for piping.
 *
 * An explicit memory read (`memory.store.get` / `memory.run_output.get`,
 * identified via `operationId`) is NOT re-summarized like a source result:
 * its bounded content is shown whole with a continuation from the original
 * path. Everything else is capped at SUMMARY_HARD_CAP.
 */
export function buildToolResultSummary(
  output: unknown,
  toolCallId: string,
  operationId?: string,
): string {
  return buildToolResultSummaryWithMeta(output, toolCallId, operationId).text;
}

/** As buildToolResultSummary, plus compact observability fields for the summary boundary. */
export function buildToolResultSummaryWithMeta(
  output: unknown,
  toolCallId: string,
  operationId?: string,
): { text: string; meta: ToolSummaryMeta } {
  const result = buildToolResultSummaryUnbounded(output, toolCallId, operationId);
  if (result.text.length <= READ_SUMMARY_SAFE_MAX) return result;
  // Last-resort cap: the turn input rejects oversized summaries outright, and
  // a rejected turn kills the session — degrade instead, whatever the path.
  let slice = RENDERED_STUB_MAX_CHARS - 500;
  let text: string;
  do {
    text = JSON.stringify({
      note: 'Tool result exceeded the turn budget — truncated. Re-read a narrower slice.',
      truncated: result.text.slice(0, slice),
    });
    slice = Math.floor(slice / 2);
  } while (text.length > RENDERED_STUB_MAX_CHARS && slice > 0);
  return { text, meta: { ...result.meta, chars: text.length } };
}

function buildToolResultSummaryUnbounded(
  output: unknown,
  toolCallId: string,
  operationId?: string,
): { text: string; meta: ToolSummaryMeta } {
  const renderedStub = buildRenderedInlineStub(output);
  if (renderedStub !== null) {
    return {
      text: renderedStub,
      meta: { kind: 'rendered_inline', chars: renderedStub.length, continuationEmitted: false },
    };
  }

  // Strip internal ref fields (dataRef, bodyRef, contentRef) so agents
  // never see raw PayloadStore URIs and are not tempted to copy them.
  const cleaned = stripInternalRefs(output);
  const raw = stringify(cleaned);

  // Small outputs pass through as-is (now without internal ref fields),
  // but still sanitize base64 blobs which are useless inline.
  //
  if (raw.length <= PASSTHROUGH_THRESHOLD && !carriesByReferenceData(output)) {
    const text = sanitizeBase64InJson(raw);
    return { text, meta: { kind: 'passthrough', chars: text.length, continuationEmitted: false } };
  }

  // An explicit read's content is the requested result — do not summarize it
  // a second time into a source preview.
  if (operationId !== undefined && MEMORY_READ_OPERATIONS.has(operationId)) {
    const readSummary = buildMemoryReadSummary(output, operationId);
    if (readSummary !== null) {
      return {
        text: readSummary.text,
        meta: {
          kind: 'memory_read',
          chars: readSummary.text.length,
          continuationEmitted: readSummary.continuationEmitted,
        },
      };
    }
  }

  const shape = detectShape(output);
  let summary: string;

  switch (shape.type) {
    case 'api':
      summary = buildApiSummary(shape, toolCallId);
      break;
    case 'memory':
      summary = buildMemorySummary(shape, toolCallId);
      break;
    case 'compute':
      summary = buildComputeSummary(shape, toolCallId);
      break;
    case 'media':
      summary = buildMediaSummary(shape);
      break;
    case 'generic':
      summary = buildGenericSummary(output, toolCallId);
      break;
  }

  if (summary.length > SUMMARY_HARD_CAP) {
    summary = summary.slice(0, SUMMARY_HARD_CAP - 20) + '\n… [truncated]';
  }

  return {
    text: summary,
    meta: { kind: 'source_preview', chars: summary.length, continuationEmitted: false },
  };
}
