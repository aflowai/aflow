/**
 * Memory v2 step handler.
 *
 * Repo-like document store with 6 operations:
 * - memory.store.query  (list / search / grep — directory-aware browsing)
 * - memory.store.get    (stat / preview / content + range reads)
 * - memory.store.put    (create / upsert with versioning + auto-mkdir)
 * - memory.store.patch  (partial update via json_patch / text_patch)
 * - memory.store.delete (soft-delete documents or directories)
 * - memory.store.mkdir  (create directories explicitly)
 */
import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import { failureWithError, validationError, internalError } from '@aflow/executor-runtime';
import type { AflowError } from '@aflow/schemas';
import type {
  MemoryQueryInput,
  MemoryGetInput,
  MemoryRunOutputGetInput,
  MemoryPutInput,
  MemoryPatchInput,
  MemoryDeleteInput,
  MemoryMkdirInput,
  MemoryContextRememberInput,
  MemoryContextForgetInput,
} from '@aflow/schemas';
import {
  createTenantContext,
  createMemoryDocRepository,
  createMemoryLinkRepository,
  createEmbeddingBudgetLimitsLoader,
  type EmbeddingBudgetLimitsView,
  createMemoryDirRepository,
} from '@aflow/database';
import type { Redis } from 'ioredis';
import type { PayloadStore } from '@aflow/payload-store';
import { isVirtualPath } from '@aflow/memory-paths';
import {
  handleQuery,
  handleGet,
  handlePut,
  handlePatch,
  handleDelete,
  handleMkdir,
} from './handlers/index.js';
import {
  handleContextRemember,
  handleContextForget,
  handleContextList,
} from './handlers/contextRegister.js';

const VALID_OPS = [
  'memory.store.query',
  'memory.store.get',
  'memory.run_output.get',
  'memory.store.put',
  'memory.store.patch',
  'memory.store.delete',
  'memory.store.mkdir',
  'memory.context.remember',
  'memory.context.forget',
  'memory.context.list',
];

type PostgresJsDatabase = Parameters<typeof createMemoryDocRepository>[0];

/** Read a { target: { path } } | { path } locator off an already-parsed input. */
function readTargetPath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const target = record['target'];
  const path =
    typeof target === 'object' && target !== null
      ? (target as Record<string, unknown>)['path']
      : record['path'];
  return typeof path === 'string' ? path : undefined;
}

function readStringField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether an op touches persistent memory (and thus needs a space) or resolves
 * a virtual /run/outputs/* path (which does not). `get` and `query` can go
 * either way depending on their target/prefix; everything else is persistent.
 */
function requiresSpaceContext(operationId: string, input: unknown): boolean {
  if (operationId === 'memory.run_output.get') return false;
  if (operationId === 'memory.store.get') {
    const path = readTargetPath(input);
    return !(path !== undefined && isVirtualPath(path));
  }
  if (operationId === 'memory.store.query') {
    const prefix = readStringField(input, 'pathPrefix');
    return !(prefix !== undefined && isVirtualPath(prefix));
  }
  return true;
}

export class MemoryHandler implements StepHandler {
  readonly stepType = 'memory';

  constructor(
    private db: PostgresJsDatabase,
    private redis: Redis,
    private payloadStore: PayloadStore,
  ) {
    this.loadEmbeddingBudgetLimits = createEmbeddingBudgetLimitsLoader(db);
  }

  private loadEmbeddingBudgetLimits: (tenantId: string) => Promise<EmbeddingBudgetLimitsView>;

  validate(ctx: ExecutorContext): Promise<AflowError | null> {
    const operationId = ctx.operationId;
    if (!VALID_OPS.includes(operationId)) {
      return Promise.resolve(validationError(`Unknown memory v2 operation: ${operationId}`));
    }
    return Promise.resolve(null);
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const operationId = ctx.operationId;
    const input = await ctx.readPayload(ctx.job.inputRef);

    // Fail-closed space gate. Persistent memory is strictly space-scoped, so a
    // run with no space context can neither write nor read a persistent doc.
    // The only space-less reads are virtual /run/outputs/* paths (the run's own
    // tool outputs, resolved from hot state), which stay ungated.
    if (!ctx.job.spaceId && requiresSpaceContext(operationId, input)) {
      return await failureWithError(
        ctx,
        validationError('MEMORY_NO_SPACE: memory operations require a space context'),
      );
    }

    const tenantContext = createTenantContext(ctx.tenantId);
    const repo = createMemoryDocRepository(this.db, tenantContext);
    const dirRepo = createMemoryDirRepository(this.db, tenantContext);
    const linkRepo = createMemoryLinkRepository(this.db, tenantContext);

    // Space ID is enforced from the flow run context — agents cannot specify
    // it. Memory is strictly isolated per space.
    const deps = {
      payloadStore: this.payloadStore,
      redis: this.redis,
      spaceId: ctx.job.spaceId,
      loadEmbeddingBudgetLimits: this.loadEmbeddingBudgetLimits,
      linkRepo,
    };

    try {
      let result: StepResult;
      switch (operationId) {
        case 'memory.store.query':
          result = await handleQuery(ctx, repo, input as MemoryQueryInput, deps, dirRepo);
          break;
        case 'memory.store.get':
          result = await handleGet(ctx, repo, input as MemoryGetInput, deps);
          break;
        case 'memory.run_output.get': {
          // Same read path as memory.store.get, but only /run/outputs/* paths
          // are admitted — handleGet routes those to the virtual-path
          // resolver, so the repo is never consulted. The prefix is enforced
          // here as well as in the input schema so this operation can never
          // reach a persistent memory document regardless of how the input
          // arrived.
          const runOutputInput = input as MemoryRunOutputGetInput;
          const { path: runOutputPath, ...rest } = runOutputInput;
          if (typeof runOutputPath !== 'string' || !runOutputPath.startsWith('/run/outputs/')) {
            result = await failureWithError(
              ctx,
              validationError(
                'memory.run_output.get reads /run/outputs/<toolCallId>/... paths only. ' +
                  'General memory documents are read with memory.store.get.',
              ),
            );
            break;
          }
          result = await handleGet(
            ctx,
            repo,
            { ...rest, target: { path: runOutputPath } } as MemoryGetInput,
            deps,
          );
          break;
        }
        case 'memory.store.put':
          result = await handlePut(ctx, repo, input as MemoryPutInput, deps, dirRepo);
          break;
        case 'memory.store.patch':
          result = await handlePatch(ctx, repo, input as MemoryPatchInput, deps);
          break;
        case 'memory.store.delete':
          result = await handleDelete(ctx, repo, dirRepo, input as MemoryDeleteInput, deps);
          break;
        case 'memory.store.mkdir':
          result = await handleMkdir(ctx, dirRepo, input as MemoryMkdirInput, deps);
          break;
        case 'memory.context.remember':
          result = await handleContextRemember(
            ctx,
            this.db,
            tenantContext,
            input as MemoryContextRememberInput,
            ctx.job.spaceId!,
          );
          break;
        case 'memory.context.forget':
          result = await handleContextForget(
            ctx,
            this.db,
            tenantContext,
            input as MemoryContextForgetInput,
            ctx.job.spaceId!,
          );
          break;
        case 'memory.context.list':
          result = await handleContextList(ctx, this.db, tenantContext, ctx.job.spaceId!);
          break;
        default:
          result = await failureWithError(
            ctx,
            validationError(`Unknown operation: ${operationId}`),
          );
      }
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : undefined;
      ctx.log.error('Memory operation failed', {
        operationId,
        error: errMsg,
        stack: errStack,
        tenantId: ctx.tenantId,
        stepExecutionId: ctx.job.stepExecutionId,
      });

      const code =
        error instanceof Error && errMsg.startsWith('MEMORY_')
          ? errMsg.split(':')[0]!
          : 'MEMORY_INTERNAL';

      return await failureWithError(
        ctx,
        internalError(errMsg || 'Memory operation failed', {
          retryable: code === 'MEMORY_INTERNAL',
          details: { operation: operationId, code },
        }),
      );
    }
  }
}
