/**
 * Generated media: what an operation returns, and what makes it re-issuable.
 *
 * Two constraints shape everything here. A render is large, so it is returned
 * as a reference to stored bytes and never as data in a turn. And a render is
 * paid for and lineage-bound — a provider extends its own asset under its own
 * rules, so an operation that returns a file and forgets how it was made has
 * made extension unimplementable. The receipt is that memory.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AsyncJobCostSchema } from '../runtime/asyncJob.js';
import { MEDIA_BINDING_ROLES } from '../operations/enums.js';

// ============================================================================
// Pinned reference
// ============================================================================

/**
 * The immutable binding: a path is not enough, because a path follows the
 * document and a later write silently changes what a re-render reads.
 */
export const PinnedMemoryRefSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      'Memory path of the document holding these bytes. Read it back with ' +
        "memory.store.get({ target: { path, version, expectedContentHash }, view: 'content' }) — " +
        'a path on its own follows the document and returns whatever version it holds now.',
    ),
  version: z
    .number()
    .int()
    .positive()
    .describe(
      'The exact version to read, as memory.store.get target.version. Versions are immutable, ' +
        'so this reference keeps resolving to the same bytes after the path is overwritten; a ' +
        'version that no longer exists fails the read instead of falling back to the current one.',
    ),
  contentHash: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'The hash these bytes were pinned to, as memory.store.get target.expectedContentHash. ' +
        'Every read compares it against the version it resolved, whatever view it asks for, and ' +
        'a content read hashes the bytes it delivers as well. The read fails naming both hashes, ' +
        'so a swapped document surfaces as an error rather than as different bytes.',
    ),
});
export type PinnedMemoryRef = z.infer<typeof PinnedMemoryRefSchema>;

// ============================================================================
// Provider-native lineage
// ============================================================================

/**
 * Extension eligibility is a property of an asset, so the answer is carried on
 * each one rather than inferred from the operation that made it. Every route
 * behind these operations answers the same way today: an image route
 * regenerates from a prompt and holds no asset of ours, and no video route
 * offers continuation at all.
 */
export const ProviderNativeHandleSchema = z.object({
  status: z.literal('none'),
  reason: z
    .literal('route_issues_none')
    .describe(
      'The route that made this asset has no in-place extension surface, so the asset can be ' +
        're-generated and never extended. Re-uploading its bytes to another route is not a ' +
        'substitute — a provider extends assets in its own lineage, not arbitrary files.',
    ),
});
export type ProviderNativeHandle = z.infer<typeof ProviderNativeHandleSchema>;

// ============================================================================
// What a render was conditioned on
// ============================================================================

export const MediaBoundEntitySchema = PinnedMemoryRefSchema.extend({
  role: z.enum(MEDIA_BINDING_ROLES).describe('What this document contributed to the render.'),
  label: z
    .string()
    .max(120)
    .optional()
    .describe('The name the prompt used for this binding, sent to the route alongside it.'),
});
export type MediaBoundEntity = z.infer<typeof MediaBoundEntitySchema>;

// ============================================================================
// Receipt parts
// ============================================================================

export const MediaCapabilityRouteSchema = z.object({
  routeId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'The capability route that served this request — provider, model line and dispatch mode ' +
        'as one identity. Re-issuing an identical request means naming the route, not only the ' +
        'model: two routes can serve one model line under different reference and continuity rules.',
    ),
  requestedModel: z
    .string()
    .max(128)
    .optional()
    .describe(
      'The model the caller named before routing resolved it. Absent when the caller named none ' +
        'and the route default applied.',
    ),
});
export type MediaCapabilityRoute = z.infer<typeof MediaCapabilityRouteSchema>;

export const MediaRenderedFormatSchema = z
  .object({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSeconds: z.number().positive().optional(),
  })
  .describe(
    'What the delivered file itself states, read from its own container rather than echoed from ' +
      'the request — a route that clamps a 12s request to 8s bills and delivers 8. Extension ' +
      'eligibility is judged against these numbers, not against the request. A field is absent ' +
      'when the container does not carry it.',
  );
export type MediaRenderedFormat = z.infer<typeof MediaRenderedFormatSchema>;

export const MediaCostRecordSchema = z.object({
  quoted: AsyncJobCostSchema.optional().describe(
    'What the request was quoted before dispatch, against the price catalog in effect at that ' +
      'moment. Absent when nothing priced it.',
  ),
  actual: AsyncJobCostSchema.optional().describe(
    'What the settled request cost, as recorded on its durable job row. Absent means no priced ' +
      'quantity was reported — unknown spend, never a free render.',
  ),
});
export type MediaCostRecord = z.infer<typeof MediaCostRecordSchema>;

/**
 * The real identity of the one execution that issued the one provider request.
 * Nothing here is minted: a second asset from the same request is addressed by
 * its candidate index, not by a second execution id.
 */
export const MediaExecutionRecordSchema = z.object({
  runId: z.string().min(1).max(200),
  logicalExecutionId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The unit of work that issued the provider request — a workflow task on a workflow run, a ' +
        'step execution on a session. It is stable across the attempts at that work, so a retry ' +
        'names the same issuer. One execution issues exactly one request; every asset it produced ' +
        'is addressed by candidateIndex under this same id.',
    ),
  attempt: z.number().int().nonnegative(),
  requestKey: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'Deterministic key of the one provider request behind these assets, and what every assetId ' +
        'here is derived from. Addressing and adoption are separate guarantees. The key addresses ' +
        'the assets on every route: a re-issue that derives the same key resolves to these same ' +
        'ids and paths rather than filing a second copy under new ones. Adopting the paid work ' +
        'belongs only to the operations that own the async-job lifecycle, which reserve a durable ' +
        'row under this key — a re-dispatch there drives the render already in flight to its end ' +
        'instead of buying it again. An operation whose provider call returns inside its own ' +
        'request has no such row: a re-dispatch issues and pays for the request a second time, ' +
        'and bytes that differ from the first delivery fail the write rather than replace it.',
    ),
  providerJobId: z
    .string()
    .max(256)
    .optional()
    .describe('The provider-side job id, for reconciling this render against a provider invoice.'),
});
export type MediaExecutionRecord = z.infer<typeof MediaExecutionRecordSchema>;

/**
 * A render parameter is a short scalar the route acts on — a clip length, an
 * aspect ratio, a candidate count, an output format. The bound is what
 * separates a knob from content: a prompt or a base64 frame is content, and
 * content belongs to the asset that holds it rather than to every receipt.
 */
const renderParameterValueSchema = z.union([z.string().max(64), z.number(), z.boolean()]);

export const MediaRenderParametersSchema = z
  .record(renderParameterValueSchema)
  .describe(
    'Every render parameter the provider acted on, under the names the request used — the settled ' +
      'clip length rather than the one asked for, the aspect ratio, the resolution, the candidate ' +
      'count. Re-issuing means sending these back with the prompt; without them the receipt ' +
      'identifies the request without being able to restate it.',
  );
export type MediaRenderParameters = z.infer<typeof MediaRenderParametersSchema>;

const mediaRequestRecordShape = {
  prompt: z.string().max(32_000),
  negativePrompt: z.string().max(32_000).optional(),
  parameters: MediaRenderParametersSchema,
  boundEntityVersions: z
    .array(MediaBoundEntitySchema)
    .max(32)
    .describe(
      'Every memory document this render read, pinned to the exact version and hash it read. ' +
        'Empty when the render read none — a prompt-only generation, or one whose inputs ' +
        'arrived as payload references, which carry no document version to pin.',
    ),
} as const;

export const MediaRequestRecordSchema = z.object(mediaRequestRecordShape);
export type MediaRequestRecord = z.infer<typeof MediaRequestRecordSchema>;

/**
 * The parameter half of the very object the request identity is hashed from, so
 * the receipt and the identity cannot end up naming different requests. What
 * the receipt already records in its own right is not repeated, and what the
 * parameter schema refuses is content rather than a knob.
 */
export function mediaRenderParameters(request: Record<string, unknown>): MediaRenderParameters {
  const knobs: Array<[string, string | number | boolean]> = [];
  for (const [key, value] of Object.entries(request)) {
    if (Object.hasOwn(mediaRequestRecordShape, key)) continue;
    const knob = renderParameterValueSchema.safeParse(value);
    if (knob.success) knobs.push([key, knob.data]);
  }
  return Object.fromEntries(knobs);
}

export const MediaGenerationReceiptSchema = z.object({
  execution: MediaExecutionRecordSchema,
  request: MediaRequestRecordSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128).describe('The model id the route reports it ran.'),
  capabilityRoute: MediaCapabilityRouteSchema,
  cost: MediaCostRecordSchema,
  rendered: MediaRenderedFormatSchema,
  createdAt: z.string().datetime(),
});
export type MediaGenerationReceipt = z.infer<typeof MediaGenerationReceiptSchema>;

// ============================================================================
// Assets
// ============================================================================

export const MediaAssetKindSchema = z.enum(['image', 'video']);
export type MediaAssetKind = z.infer<typeof MediaAssetKindSchema>;

/**
 * The address of one candidate of one provider request. Derived rather than
 * assigned, so a re-dispatch that adopts the paid job resolves to the same
 * asset instead of storing the same bytes under a second name.
 *
 * @param requestKey the execution's `requestKey` (`deriveAsyncJobKey`).
 */
export function deriveMediaAssetId(requestKey: string, candidateIndex: number): string {
  const digest = createHash('sha256').update(requestKey).digest('hex').slice(0, 24);
  return `${digest}-${String(candidateIndex)}`;
}

export const MediaAssetSchema = PinnedMemoryRefSchema.extend({
  assetId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'Stable id of this asset, derived from the provider request and this candidate index. It ' +
        'names the asset in the receipt and in the path the bytes were filed at, so a re-dispatch ' +
        'of the same request resolves to this same asset rather than storing it a second time.',
    ),
  candidateIndex: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Position among the candidates of one provider request. Candidates share one receipt and ' +
        'one cost — they are alternatives to pick between, not separate renders to bill for.',
    ),
  docId: z
    .string()
    .uuid()
    .describe(
      'Id of the memory document holding these bytes, which is what the authenticated ranged ' +
        'byte read is addressed by. It is a transport handle, not the binding — reproducing a ' +
        'render still needs path, version and contentHash.',
    ),
  kind: MediaAssetKindSchema,
  mimeType: z.string().min(1).max(128),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Size of the stored bytes. Reading the asset back confirms the pin and returns its ' +
        'metadata; the bytes themselves never enter a turn, whatever view the read asks for.',
    ),
  revisedPrompt: z
    .string()
    .max(32_000)
    .optional()
    .describe(
      'The prompt the route reports it actually rendered, when it rewrites the one it was given. ' +
        'It can differ between candidates of the same request.',
    ),
  providerNative: ProviderNativeHandleSchema.describe(
    'Whether the provider that made this asset can extend it in place.',
  ),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

// ============================================================================
// Production record — assets plus the receipt they share
// ============================================================================

const mediaProductionShape = {
  assets: z
    .array(MediaAssetSchema)
    .min(1)
    .describe(
      'The assets one provider request produced, in candidate order. Each carries a pinned ' +
        'reference to its bytes; the bytes are never returned inline.',
    ),
  receipt: MediaGenerationReceiptSchema.describe(
    'How every asset here was made: execution identity, prompt and render parameters, route, ' +
      'cost, and what the delivered file turned out to be. It is the record that makes an ' +
      'identical re-issue possible at all.',
  ),
} as const;

function checkCandidateAddressing(
  value: { assets: MediaAsset[]; receipt: MediaGenerationReceipt },
  ctx: z.RefinementCtx,
): void {
  const { requestKey } = value.receipt.execution;
  value.assets.forEach((asset, index) => {
    if (asset.candidateIndex !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets', index, 'candidateIndex'],
        message:
          `candidateIndex is ${String(asset.candidateIndex)} at position ${String(index)}. ` +
          'Candidates of one provider request are addressed by their position, so a gap or a ' +
          'repeat means two requests were merged into one receipt.',
      });
    }
    const expected = deriveMediaAssetId(requestKey, asset.candidateIndex);
    if (asset.assetId !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assets', index, 'assetId'],
        message:
          `assetId must be deriveMediaAssetId(receipt.execution.requestKey, candidateIndex) — ` +
          `expected "${expected}", got "${asset.assetId}". Minting an id another way (a fresh ` +
          'uuid, a synthesised step execution id) breaks retry adoption: the same paid request ' +
          'would store its bytes twice under two names.',
      });
    }
  });
}

/**
 * The durable sidecar written beside the assets. Self-contained on purpose —
 * provenance that only exists inside a step output dies with the run.
 */
export const MediaReceiptDocumentSchema = z
  .object(mediaProductionShape)
  .superRefine(checkCandidateAddressing);
export type MediaReceiptDocument = z.infer<typeof MediaReceiptDocumentSchema>;

/** What every media operation that produces bytes returns. */
export const AiMediaOutputSchema = z
  .object({
    ...mediaProductionShape,
    receiptRef: PinnedMemoryRefSchema.describe(
      'Pinned reference to the stored copy of this receipt, so the provenance outlives the run ' +
        'that produced it.',
    ),
  })
  .superRefine(checkCandidateAddressing);
export type AiMediaOutput = z.infer<typeof AiMediaOutputSchema>;
