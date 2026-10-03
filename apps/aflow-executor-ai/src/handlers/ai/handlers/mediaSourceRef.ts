/**
 * Where a media operation's input image comes from.
 *
 * Two forms reach here. A PayloadRef is a run artifact a workflow step was
 * wired to: it has no document behind it, so nothing about it can be pinned or
 * quoted afterwards. A pinned memory reference is the triple every media
 * operation returns, which is what makes one render the input of the next — and
 * because it names a version and a hash, the render can record exactly which
 * bytes it read.
 */
import { createMemoryDocRepository, createTenantContext } from '@aflow/database';
import type { MemoryDocRepository } from '@aflow/database';
import type { ExecutorContext } from '@aflow/executor-runtime';
import {
  PayloadAccessError,
  notFoundError,
  permissionError,
  validationError,
} from '@aflow/executor-runtime';
import { PinnedMemoryReadError, readPinnedMemoryDoc } from '@aflow/memory-store';
import type {
  AflowError,
  MediaBindingRole,
  MediaBoundEntity,
  MediaSourceRef,
  PinnedMemoryRef,
  StepImageContentType,
} from '@aflow/schemas';
import type { ToolImageResolver } from '@aflow/ai-client';
import type { MediaPersistenceTarget } from './mediaPersist.js';
import { IMAGE_SIGNATURE_BYTES, imageContentTypeFromSignature } from './mediaProbe.js';

/** One resolved input, in the shape the provider adapters take it. */
export interface ResolvedMediaSource {
  /** Base64 image bytes. */
  data: string;
  mimeType: string;
  /** Present only for a pinned reference — a PayloadRef has no version to record. */
  bound: MediaBoundEntity | undefined;
}

export type MediaSourceResolution =
  { ok: true; source: ResolvedMediaSource } | { ok: false; error: AflowError };

export interface MediaSourceRequest {
  ref: MediaSourceRef;
  role: MediaBindingRole;
  label?: string | undefined;
  /** The input field this ref arrived on, so a refusal names what to fix. */
  field: string;
}

type PayloadImageRead =
  { ok: true; data: string; mimeType: string | undefined } | { ok: false; error: AflowError };

async function readPayloadImageBytes(
  ctx: ExecutorContext,
  ref: string,
  field: string,
): Promise<PayloadImageRead> {
  let payload: { data?: string; mimeType?: string };
  try {
    payload = await ctx.readPayload<{ data?: string; mimeType?: string }>(ref);
  } catch (error) {
    // A ref the run may not read is a refusal about the input the caller
    // wrote, so it names the field rather than failing the step opaquely.
    if (!(error instanceof PayloadAccessError)) throw error;
    return { ok: false, error: permissionError(`${field}: ${error.message}`, { field, ref }) };
  }
  if (!payload.data) {
    return {
      ok: false,
      error: validationError(
        `${field} resolved to a payload with no 'data' field, so there are no image bytes to ` +
          'render from.',
        { field, ref },
      ),
    };
  }
  return { ok: true, data: payload.data, mimeType: payload.mimeType };
}

/** Image bytes behind a PayloadRef, read with the run's own payload access. */
export async function readPayloadImage(
  ctx: ExecutorContext,
  ref: string,
  field: string,
): Promise<MediaSourceResolution> {
  const read = await readPayloadImageBytes(ctx, ref, field);
  if (!read.ok) return read;
  return {
    ok: true,
    source: { data: read.data, mimeType: read.mimeType ?? 'image/png', bound: undefined },
  };
}

/**
 * Why bytes may not go to a provider as the image a step declared, or
 * undefined when the signature, the payload's mimeType where it states one,
 * and the declared content type all name the same one of png, jpeg and webp.
 * A provider refuses bytes that are not the type it is told, and that refusal
 * fails the whole request.
 */
function toolImageDisagreement(
  data: string,
  payloadMimeType: string | undefined,
  declared: StepImageContentType,
): string | undefined {
  const base64Prefix = data.slice(0, Math.ceil(IMAGE_SIGNATURE_BYTES / 3) * 4);
  const actual = imageContentTypeFromSignature(Buffer.from(base64Prefix, 'base64'));
  if (actual === undefined) return 'they are not a png, jpeg or webp image';
  if (actual !== declared) return `they are ${actual}, but the image is declared ${declared}`;
  if (payloadMimeType !== undefined && payloadMimeType.toLowerCase() !== actual) {
    return `they are ${actual}, but their payload says ${payloadMimeType}`;
  }
  return undefined;
}

/**
 * How an agent turn's request reads the tool images its model is shown. An
 * image that cannot be read, or whose bytes are not the image it claims to be,
 * becomes its description in the tool message, so a bad screenshot costs the
 * model the picture, not the turn.
 */
export function toolImageResolver(ctx: ExecutorContext): ToolImageResolver {
  const refuse = (reason: string): { ok: false; reason: string } => {
    ctx.log.warn('agent_turn_tool_image_not_shown', {
      tenantId: ctx.job.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.job.stepExecutionId,
      reason,
    });
    return { ok: false, reason };
  };
  return async (image) => {
    try {
      const read = await readPayloadImageBytes(ctx, image.ref, 'image');
      if (!read.ok) return refuse(read.error.message);
      const disagreement = toolImageDisagreement(read.data, read.mimeType, image.contentType);
      if (disagreement !== undefined) return refuse(disagreement);
      return { ok: true, data: read.data, mediaType: image.contentType };
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }
  };
}

export class MediaSourceResolver {
  /** Built on first pinned read: a request made entirely of payload refs needs no repository. */
  private repo: MemoryDocRepository | undefined;

  constructor(
    private readonly ctx: ExecutorContext,
    private readonly target: MediaPersistenceTarget,
  ) {}

  private documents(): MemoryDocRepository {
    this.repo ??= createMemoryDocRepository(this.target.db, createTenantContext(this.ctx.tenantId));
    return this.repo;
  }

  async resolve(request: MediaSourceRequest): Promise<MediaSourceResolution> {
    const { ref } = request;
    return typeof ref === 'string'
      ? await readPayloadImage(this.ctx, ref, request.field)
      : await this.fromMemory(ref, request);
  }

  private async fromMemory(
    ref: PinnedMemoryRef,
    request: MediaSourceRequest,
  ): Promise<MediaSourceResolution> {
    try {
      const content = await readPinnedMemoryDoc({
        repo: this.documents(),
        payloadStore: this.target.payloadStore,
        spaceId: this.target.spaceId,
        ref,
      });
      return {
        ok: true,
        source: {
          data: content.bytes.toString('base64'),
          mimeType: content.mimeType,
          bound: {
            path: content.path,
            version: content.version,
            contentHash: content.contentHash,
            role: request.role,
            ...(request.label !== undefined ? { label: request.label } : {}),
          },
        },
      };
    } catch (error) {
      if (!(error instanceof PinnedMemoryReadError)) throw error;
      const details = { field: request.field, ...error.details };
      return {
        ok: false,
        error:
          error.code === 'not_found' || error.code === 'version_not_found'
            ? notFoundError(`${request.field}: ${error.message}`, details)
            : validationError(`${request.field}: ${error.message}`, details),
      };
    }
  }
}
