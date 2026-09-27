/**
 * Payload reference schemas for GCS object pointers.
 * Large payloads are stored in GCS and referenced via payload_ref.
 */
import { z } from 'zod';

// ============================================================================
// Payload Reference
// ============================================================================

/** GCS URI format: gs://bucket/path/to/object */
const gcsUriRegex = /^gs:\/\/[a-z0-9_.-]+\/.+$/;

/** Inline payload format: inline:<base64-encoded-json> */
const inlinePayloadRegex = /^inline:[A-Za-z0-9+/=]+$/;

/**
 * Canonical base64: whole 4-character groups, padding only in the final group
 * and only as much as the group is short.
 *
 * The alphabet alone is not the encoding. `====` is drawn entirely from it and
 * decodes to nothing, so an alphabet test admits strings that name no payload —
 * and callers that ask only whether a ref parses then report those as present.
 */
const canonicalBase64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Bytes an inline body decodes to, or null when it is not canonical base64.
 *
 * The size that matters is the decoded one: the cap bounds the payload a reader
 * materializes, not the characters it arrives as. Deriving the encoded length
 * from the cap instead rounds up to the next whole group, which admits a body
 * two bytes over.
 */
function decodedInlineBytes(body: string): number | null {
  if (body.length === 0 || !canonicalBase64Regex.test(body)) return null;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return (body.length / 4) * 3 - padding;
}

/** Payload kind discriminator */
export const PayloadKindSchema = z.enum([
  'input',
  'output',
  'error',
  'requested_input',
  'resolved_input',
  'logs',
  // Executor-owned conversation state for an agent-turn step. Payload paths
  // are deterministic per (stepExecutionId, attempt, kind), so no other
  // writer may reuse this kind for the same step — reusing it silently
  // replaces the conversation state.
  'state',
  // Orchestrator-owned workflow state-variable spill (large variable values,
  // subagent complete.result). Distinct from 'state' so the two writers can
  // never collide on one path.
  'state_variable',
  // Executor-owned batches of conversation ATOMS for an agent-turn step.
  'history',
  // Orchestrator-owned `ai.history.<stepId>` conversation record. Distinct from
  // 'history' because that kind is the executor's atom batch for the same step
  // execution, and a shared path means whichever writes second silently
  // replaces the other — leaving the survivor's atom refs pointing at a payload
  // their atoms are not in, which fails hydration on the NEXT turn rather than
  // at the write.
  'conversation',
  'body',
  // Untransformed response text kept alongside a transformed `body` — the
  // two must never share a path or the normalized value overwrites the raw.
  'raw_body',
  // A generated UI artifact keeps three blobs from one step — what the author
  // wrote, what the compiler emitted, and the standalone page. A payload path
  // is deterministic per (step, attempt, kind), so one kind for all three
  // makes them one object and the last write is the only survivor.
  'artifact_source',
  'artifact_compiled',
  'artifact_html',
  'session',
  // The activity feed of a harness step — what it did, one line per event.
  // Distinct from 'output' because the step's own result takes that path, and
  // one kind for both would make the feed and the result a single object with
  // only the last write surviving.
  'activity',
  // One simulated call's world mutations. Distinct from the step's own output
  // because the payload path is deterministic per (step, attempt, kind): the
  // delta and the response the agent sees would otherwise be one object, and
  // the journal would reference whichever was written last.
  'simulation_delta',
  // The answer a simulated call recorded in its journal, kept raw and
  // pre-transform. `body` cannot hold it: the shared response downstream
  // rewrites that path with the transformed value, and a replay must return
  // what the agent was actually handed.
  'simulation_response',
  // The simulation artifact and the endpoint set it was resolved against,
  // frozen at pin time. Content-addressed and persisted: the run context holds
  // only the ref, and a run that resumes past its hot state must still read
  // the artifact it started on rather than whatever the row says today.
  'simulation_snapshot',
]);
export type PayloadKind = z.infer<typeof PayloadKindSchema>;

/**
 * Reference to a payload stored in GCS or inline.
 * Format:
 *   - Run-scoped GCS: gs://<bucket>/tenants/<tenant_id>/runs/<run_id>/steps/<step_execution_id>/attempt/<attempt>/<kind>.json
 *   - Content-addressed GCS: gs://<bucket>/tenants/<tenant_id>/content/<sha256>/<kind>.json
 *   - Inline (dev/small payloads): inline:<base64-encoded-json>
 */
export const PayloadRefSchema = z
  .string()
  .refine(
    (val) => gcsUriRegex.test(val) || inlinePayloadRegex.test(val),
    'Must be a valid GCS URI (gs://bucket/path) or inline reference (inline:<base64>)',
  )
  .describe('Payload reference (GCS object or inline)');

export type PayloadRef = z.infer<typeof PayloadRefSchema>;

/**
 * Structured payload reference with metadata.
 */
export const PayloadRefWithMetadataSchema = z.object({
  /** GCS URI to the payload */
  uri: PayloadRefSchema,
  /** Type of payload */
  kind: PayloadKindSchema,
  /** Content type (MIME) */
  contentType: z.string().default('application/json').describe('MIME content type'),
  /** Size in bytes (if known) */
  sizeBytes: z.number().int().nonnegative().optional().describe('Size in bytes'),
  /** SHA-256 hash of content (for integrity) */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'Must be a valid SHA-256 hex string')
    .optional()
    .describe('SHA-256 content hash'),
  /** Compression algorithm used */
  compression: z.enum(['none', 'gzip', 'zstd']).optional().default('none'),
});

export type PayloadRefWithMetadata = z.infer<typeof PayloadRefWithMetadataSchema>;

// ============================================================================
// Canonical Reference Parsing
// ============================================================================

/**
 * A payload ref is caller-supplied data, never authority. Parsing exists so
 * the identifiers embedded in a ref can be compared against authenticated
 * state *before* any store call — an unparsed ref must never reach
 * `retrieve` / `delete` / `getSignedUrl`.
 *
 * Only the canonical layout is accepted. The segment charset admits no dot,
 * slash, backslash, or percent, so traversal and encoding-ambiguity variants
 * fail to parse rather than needing their own rejection rules.
 *
 * `:` is admitted because the orchestrator derives step ids like
 * `<taskId>:poll` and `<taskId>:projected`; it carries no traversal or
 * encoding meaning in an object path. Any writer's id shape must be
 * representable here or its payloads become unreadable after storage.
 */
const PAYLOAD_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

/** Label of the run-independent lane whose address is the content's own hash. */
export const CONTENT_ADDRESSED_LABEL = 'content';

/** Lowercase SHA-256 hex — the only address the content lane accepts. */
export const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

interface ParsedObjectRefBase {
  form: 'object';
  bucket: string;
  objectPath: string;
  tenantId: string;
  payloadKind: PayloadKind;
  extension: 'json' | 'bin';
}

export type ParsedPayloadRef =
  | { form: 'inline' }
  /** Addressed by the step attempt that produced it — one object per attempt. */
  | (ParsedObjectRefBase & {
      layout: 'run';
      runId: string;
      stepExecutionId: string;
      attempt: number;
    })
  /**
   * Addressed by the SHA-256 of its own bytes. No run identity is recoverable
   * from such a ref, so anything that authorizes by run cannot authorize one.
   */
  | (ParsedObjectRefBase & { layout: 'content'; contentHash: string });

function parseFilename(
  filename: string,
): Pick<ParsedObjectRefBase, 'payloadKind' | 'extension'> | null {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return null;
  const kindResult = PayloadKindSchema.safeParse(filename.slice(0, dotIndex));
  if (!kindResult.success) return null;
  const extension = filename.slice(dotIndex + 1);
  if (extension !== 'json' && extension !== 'bin') return null;
  return { payloadKind: kindResult.data, extension };
}

/** Returns null for any ref that is not exactly canonical. */
export function parsePayloadRef(ref: string): ParsedPayloadRef | null {
  if (ref.startsWith('inline:')) {
    // An inline ref that decodes to more than the inline cap is not an inline
    // ref by this system's own definition, so it fails to parse rather than
    // being handed to a base64 decode and a JSON parse.
    const body = ref.slice('inline:'.length);

    // Bound the length before scanning it. Base64 expands 3 bytes into 4
    // characters, so this refuses an oversized body without the regex having to
    // walk it — the point of the cap is that an unbounded, caller-supplied
    // string never reaches work proportional to its size.
    if (body.length > Math.ceil(MAX_INLINE_PAYLOAD_BYTES / 3) * 4) return null;

    const bytes = decodedInlineBytes(body);
    if (bytes === null || bytes > MAX_INLINE_PAYLOAD_BYTES) return null;
    return { form: 'inline' };
  }

  const uriMatch = /^gs:\/\/([a-z0-9_.-]+)\/(.+)$/.exec(ref);
  const bucket = uriMatch?.[1];
  const objectPath = uriMatch?.[2];
  if (!bucket || !objectPath) return null;

  const segments = objectPath.split('/');

  if (segments.length === 5) {
    const [tenantsLabel, tenantId, contentLabel, contentHash, filename] = segments;
    if (tenantsLabel !== 'tenants' || contentLabel !== CONTENT_ADDRESSED_LABEL) return null;
    if (!tenantId || !contentHash || !filename) return null;
    if (!PAYLOAD_PATH_SEGMENT.test(tenantId)) return null;
    if (!CONTENT_HASH_PATTERN.test(contentHash)) return null;
    const parsedName = parseFilename(filename);
    if (!parsedName) return null;
    return {
      form: 'object',
      layout: 'content',
      bucket,
      objectPath,
      tenantId,
      contentHash,
      ...parsedName,
    };
  }

  if (segments.length !== 9) return null;
  const [tenantsLabel, tenantId, runsLabel, runId, stepsLabel, stepExecutionId, attemptLabel] =
    segments;
  const attemptRaw = segments[7];
  const filename = segments[8];

  if (tenantsLabel !== 'tenants' || runsLabel !== 'runs') return null;
  if (stepsLabel !== 'steps' || attemptLabel !== 'attempt') return null;
  if (!tenantId || !runId || !stepExecutionId || !attemptRaw || !filename) return null;
  if (!PAYLOAD_PATH_SEGMENT.test(tenantId)) return null;
  if (!PAYLOAD_PATH_SEGMENT.test(runId)) return null;
  if (!PAYLOAD_PATH_SEGMENT.test(stepExecutionId)) return null;
  if (!/^\d{1,4}$/.test(attemptRaw)) return null;

  const parsedName = parseFilename(filename);
  if (!parsedName) return null;

  return {
    form: 'object',
    layout: 'run',
    bucket,
    objectPath,
    tenantId,
    runId,
    stepExecutionId,
    attempt: Number(attemptRaw),
    ...parsedName,
  };
}

// ============================================================================
// Payload Size Limits
// ============================================================================

/** Maximum inline payload size (bytes) before requiring GCS storage */
export const MAX_INLINE_PAYLOAD_BYTES = 64 * 1024; // 64 KB

/** Maximum Redis stream entry size (bytes) */
export const MAX_STREAM_ENTRY_BYTES = 1024; // 1 KB for metadata only
