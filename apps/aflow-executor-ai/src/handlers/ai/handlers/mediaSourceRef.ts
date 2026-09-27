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
} from '@aflow/schemas';
import type { MediaPersistenceTarget } from './mediaPersist.js';

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
      ? await this.fromPayload(ref, request.field)
      : await this.fromMemory(ref, request);
  }

  private async fromPayload(ref: string, field: string): Promise<MediaSourceResolution> {
    let payload: { data?: string; mimeType?: string };
    try {
      payload = await this.ctx.readPayload<{ data?: string; mimeType?: string }>(ref);
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
    return {
      ok: true,
      source: { data: payload.data, mimeType: payload.mimeType ?? 'image/png', bound: undefined },
    };
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
