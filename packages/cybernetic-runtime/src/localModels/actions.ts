/**
 * The changes the platform makes to a space's runtime on this computer (Plan
 * 323 D10), applied the same way whoever asked: the operator from a card, or
 * Helmsman once the operator approved.
 */
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { contextWindowForModel, createDefaultModelCatalog, sameLocalTag } from '@aflow/ai-client';
import { createTenantContext, providerCredentials, withTenantSchema } from '@aflow/database';
import {
  claimLocalPull,
  endLocalPull,
  recordLocalPullProgress,
  requestLocalPullCancel,
  type Redis,
} from '@aflow/redis';
import { THIS_MACHINE_RUNTIME_HOST, type LocalModelAction, type TenantId } from '@aflow/schemas';
import type { SpaceLocalRuntime } from './runtime.js';

/** Room a download leaves on the disk: the runtime writes a manifest and temporary parts beside the layers. */
export const PULL_DISK_HEADROOM_BYTES = 2 * 1024 ** 3;
/** Progress is written at most this often; the runtime reports many times a second. */
const PULL_PROGRESS_INTERVAL_MS = 1_000;

export type LocalModelActionOutcome =
  | { ok: true; message: string }
  | {
      ok: false;
      reason: 'not_local' | 'no_disk' | 'runtime' | 'not_here';
      message: string;
    };

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

export interface LocalModelActionContext {
  db: PostgresJsDatabase;
  redis: Redis | undefined;
  tenantId: string;
  runtime: SpaceLocalRuntime;
  log?: { warn(message: string, fields?: Record<string, unknown>): void };
}

export async function applyLocalModelAction(
  ctx: LocalModelActionContext,
  action: LocalModelAction,
): Promise<LocalModelActionOutcome> {
  if (action.action === 'set_context') return setContext(ctx, action.contextTokens);
  if (action.action === 'use_for_every_role') {
    return {
      ok: false,
      reason: 'not_here',
      message:
        "A role's model is the space's setting: assign it under Settings → Agents, where every role is set at once.",
    };
  }
  const model = createDefaultModelCatalog().getModel(action.model);
  if (model?.provider !== 'ollama') {
    return {
      ok: false,
      reason: 'not_local',
      message: `${action.model} is not a model on this computer.`,
    };
  }
  const tag = model.providerModelId ?? model.id;
  const { client } = ctx.runtime;
  try {
    switch (action.action) {
      case 'pull':
        return await startPull(ctx, tag, model.local?.downloadBytes);
      case 'delete':
        await client.remove(tag);
        return { ok: true, message: `Deleted ${tag}.` };
      case 'warm': {
        const window = contextWindowForModel(model, ctx.runtime.config);
        await client.warm(tag, window);
        return { ok: true, message: `Loaded ${tag} at a ${window}-token window.` };
      }
      case 'unload':
        await client.unload(tag);
        return { ok: true, message: `Unloaded ${tag}.` };
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'runtime',
      message: `Ollama refused: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function cancelLocalModelPull(
  redis: Redis,
  runtime: SpaceLocalRuntime,
  modelId: string,
): Promise<boolean> {
  const model = createDefaultModelCatalog().getModel(modelId);
  if (model?.provider !== 'ollama') return false;
  return requestLocalPullCancel(redis, runtime.runtimeId, model.providerModelId ?? model.id);
}

async function startPull(
  ctx: LocalModelActionContext,
  tag: string,
  downloadBytes: number | undefined,
): Promise<LocalModelActionOutcome> {
  const { redis, runtime } = ctx;
  if (!redis) {
    return {
      ok: false,
      reason: 'runtime',
      message: 'Downloads need Redis to record their progress.',
    };
  }
  const installed = await runtime.client.installed();
  if (installed?.some((m) => sameLocalTag(m.tag, tag)))
    return { ok: true, message: `${tag} is already downloaded.` };
  const free = runtime.runtimeId.startsWith(`${THIS_MACHINE_RUNTIME_HOST}:`)
    ? runtime.hostMachine?.freeDiskBytes
    : undefined;
  if (
    downloadBytes !== undefined &&
    free !== undefined &&
    free < downloadBytes + PULL_DISK_HEADROOM_BYTES
  ) {
    return {
      ok: false,
      reason: 'no_disk',
      message: `${tag} is ${gb(downloadBytes)} and this computer has ${gb(free)} free; free ${gb(
        downloadBytes + PULL_DISK_HEADROOM_BYTES - free,
      )} and download it again.`,
    };
  }
  if (!(await claimLocalPull(redis, runtime.runtimeId, tag))) {
    return { ok: true, message: `${tag} is already downloading.` };
  }
  // Held by this process for the length of the download, not awaited by the
  // request that started it. The claim's lifetime is what the request leaves
  // behind: a process that dies stops renewing it, and the runtime keeps the
  // layers it already has for the next pull to resume from.
  void runPull(redis, runtime, tag, ctx.log);
  return { ok: true, message: `Downloading ${tag}.` };
}

async function runPull(
  redis: Redis,
  runtime: SpaceLocalRuntime,
  tag: string,
  log: LocalModelActionContext['log'],
): Promise<void> {
  const controller = new AbortController();
  let cancelled = false;
  let lastWrite = 0;
  let writing: Promise<void> = Promise.resolve();
  try {
    await runtime.client.pull(
      tag,
      (progress) => {
        const now = Date.now();
        if (now - lastWrite < PULL_PROGRESS_INTERVAL_MS) return;
        lastWrite = now;
        writing = recordLocalPullProgress(redis, runtime.runtimeId, tag, {
          completedBytes: progress.completedBytes,
          totalBytes: progress.totalBytes,
          detail: progress.status,
        })
          .then((read) => {
            if (read.cancelled) {
              cancelled = true;
              controller.abort();
            }
          })
          .catch(() => undefined);
      },
      controller.signal,
    );
    await writing;
    await endLocalPull(redis, runtime.runtimeId, tag, { status: 'installed' });
  } catch (error) {
    await writing;
    await endLocalPull(
      redis,
      runtime.runtimeId,
      tag,
      cancelled
        ? { status: 'interrupted', error: null }
        : { status: 'failed', error: error instanceof Error ? error.message : String(error) },
    ).catch(() => undefined);
    if (!cancelled) log?.warn('Local model pull failed', { tag, error: String(error) });
  }
}

async function setContext(
  ctx: LocalModelActionContext,
  contextTokens: number | null,
): Promise<LocalModelActionOutcome> {
  const { credential } = ctx.runtime;
  await withTenantSchema(ctx.db, createTenantContext(ctx.tenantId as TenantId), async (tx) => {
    const db = tx;
    const [row] = await db
      .select({ configJson: providerCredentials.configJson })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, credential.id))
      .limit(1);
    const config = { ...((row?.configJson as Record<string, unknown> | undefined) ?? {}) };
    if (contextTokens === null) delete config['context_tokens'];
    else config['context_tokens'] = String(contextTokens);
    await db
      .update(providerCredentials)
      .set({ configJson: config, updatedAt: new Date() })
      .where(eq(providerCredentials.id, credential.id));
  });
  return {
    ok: true,
    message:
      contextTokens === null
        ? 'Requests now get the largest window that fits this computer.'
        : `Requests now get a ${contextTokens}-token window.`,
  };
}
