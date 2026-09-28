import { type z } from 'zod';
import type {
  StepHandler,
  ExecutorContext,
  TimeoutSpec,
  StepResult,
} from '@aflow/executor-runtime';
import { failureWithError, validationError, internalError } from '@aflow/executor-runtime';
import {
  AflowErrorSchema,
  createValidationError,
  errorContext,
  errorContextFromUnknown,
  AiImageGenerateInputSchema,
  AiImageEditInputSchema,
  AiVideoGenerateInputSchema,
  AiVideoFromImageInputSchema,
  AiDecideInputSchema,
  type AflowError,
  type TenantId,
  type ValidationErrorDetail,
  type AiImageGenerateInput,
  type AiImageEditInput,
  type AiVideoGenerateInput,
  type AiVideoFromImageInput,
  type AiDecideInput,
} from '@aflow/schemas';
import { AIClientError } from '@aflow/ai-client';
import { positiveMsEnv } from '@aflow/lib';
import type { ErrorObject } from 'ajv';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from '@aflow/redis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createAsyncJobRepository, createTenantContext } from '@aflow/database';
import { AISetupError, checkBudgetMock } from './aiClient.js';
import { ajv } from './ajv.js';
import {
  AiGenerateInputSchema,
  AiGenerateJsonInputSchema,
  AiGenerateStreamInputSchema,
  AiEmbedInputSchema,
  AgentTurnInputSchema,
} from './schema.js';
import type {
  AiGenerateInput,
  AiGenerateJsonInput,
  AiGenerateStreamInput,
  AiEmbedInput,
  AgentTurnInput,
} from './schema.js';
import { resolveVideoBudget, ASYNC_JOB_LIFECYCLE_OPERATIONS } from './handlers/mediaBudget.js';
import {
  handleGenerate,
  handleGenerateStream,
  handleGenerateJson,
  handleEmbed,
  handleDecide,
  handleAgentTurn,
  handleImageGenerate,
  handleImageEdit,
  handleVideoGenerate,
  handleVideoFromImage,
  type HandlerDeps,
} from './handlers/index.js';

type OperationHandler = (ctx: ExecutorContext, input: unknown) => Promise<StepResult>;

/**
 * Agent turns run a full (often reasoning-heavy) generation plus decision
 * parsing inside one step, so their timeout is progress-aware: a live stream
 * (content, tool-call, or thinking deltas arriving) is never reaped on
 * elapsed time alone. The idle window is the liveness signal — sized to
 * outlast the longest silent gap a healthy provider produces (request setup,
 * time-to-first-token, a thinking phase on a provider that does not stream
 * reasoning deltas). The ceiling only bounds runaway generation.
 */
// Silence is not the same as a dead stream. Anthropic's adaptive thinking
// buffers — `display` takes only 'summarized' or 'omitted', never a raw delta
// stream — so nothing at all crosses the wire while the model reasons, and no
// amount of progress reporting can tick a timer through it. A sonnet turn on a
// large prompt was cut three times at 120s with `firstChunkMs: null` and zero
// chunks. The window has to outlast a thinking phase, not a network hiccup;
// the 20-minute ceiling is what bounds a genuinely stuck turn.
const AGENT_TURN_STREAM_IDLE_MS = positiveMsEnv('AI_STREAM_IDLE_TIMEOUT_MS', 300_000);
const AGENT_TURN_MAX_MS = positiveMsEnv('AI_AGENT_TURN_MAX_TIMEOUT_MS', 1_200_000);

export class AiHandler implements StepHandler {
  readonly stepType = 'ai';

  resolveTimeoutMs(ctx: ExecutorContext): Promise<TimeoutSpec | undefined> {
    // An explicit step-definition timeout wins in both directions and stays a
    // flat wall clock (an operator who set a number meant a number); this only
    // replaces the executor-wide flat default.
    if (ctx.stepDefinition?.timeout?.executionTimeoutMs !== undefined) {
      return Promise.resolve(undefined);
    }
    if (ctx.operationId === 'ai.agent.turn') {
      return Promise.resolve({ idleMs: AGENT_TURN_STREAM_IDLE_MS, maxMs: AGENT_TURN_MAX_MS });
    }
    // A render outlasts the executor-wide default, and the step that dies
    // waiting was still billed for it.
    if (ASYNC_JOB_LIFECYCLE_OPERATIONS.has(ctx.operationId)) {
      return Promise.resolve(resolveVideoBudget().stepBudgetMs);
    }
    return Promise.resolve(undefined);
  }

  private readonly payloadStore: PayloadStore;

  private readonly operations: Record<
    string,
    {
      schema: z.ZodSchema;
      handler: OperationHandler;
    }
  >;

  constructor(deps: { payloadStore: PayloadStore; db?: PostgresJsDatabase; redis?: Redis }) {
    this.payloadStore = deps.payloadStore;

    const db = deps.db;
    const depsForHandlers: HandlerDeps = {
      payloadStore: this.payloadStore,
      handleError: (ctx, label, error) => this.handleError(ctx, label, error),
      validateToolArgs: (stepId, args, inputSchema) =>
        this.validateToolArgs(stepId, args, inputSchema),
      ...(db
        ? {
            db,
            asyncJobs: (tenantId: TenantId) =>
              createAsyncJobRepository(db, createTenantContext(tenantId)),
          }
        : {}),
      ...(deps.redis ? { redis: deps.redis } : {}),
    };

    const generateEntry = {
      schema: AiGenerateInputSchema,
      handler: (ctx: ExecutorContext, input: unknown) =>
        handleGenerate(ctx, input as AiGenerateInput, depsForHandlers),
    };
    const generateJsonEntry = {
      schema: AiGenerateJsonInputSchema,
      handler: (ctx: ExecutorContext, input: unknown) =>
        handleGenerateJson(ctx, input as AiGenerateJsonInput, depsForHandlers),
    };
    const generateStreamEntry = {
      schema: AiGenerateStreamInputSchema,
      handler: (ctx: ExecutorContext, input: unknown) =>
        handleGenerateStream(ctx, input as AiGenerateStreamInput, depsForHandlers),
    };

    this.operations = {
      'ai.text.generate': generateEntry,
      'ai.text.generate_json': generateJsonEntry,
      'ai.text.generate_stream': generateStreamEntry,
      'ai.embedding.generate': {
        schema: AiEmbedInputSchema,
        handler: (ctx, input) => handleEmbed(ctx, input as AiEmbedInput, depsForHandlers),
      },
      'ai.decision.decide': {
        schema: AiDecideInputSchema,
        handler: (ctx, input) => handleDecide(ctx, input as AiDecideInput, depsForHandlers),
      },
      'ai.agent.turn': {
        schema: AgentTurnInputSchema,
        handler: (ctx, input) => handleAgentTurn(ctx, input as AgentTurnInput, depsForHandlers),
      },
      'ai.media.image': {
        schema: AiImageGenerateInputSchema,
        handler: (ctx, input) =>
          handleImageGenerate(ctx, input as AiImageGenerateInput, depsForHandlers),
      },
      'ai.media.edit_image': {
        schema: AiImageEditInputSchema,
        handler: (ctx, input) => handleImageEdit(ctx, input as AiImageEditInput, depsForHandlers),
      },
      'ai.media.video': {
        schema: AiVideoGenerateInputSchema,
        handler: (ctx, input) =>
          handleVideoGenerate(ctx, input as AiVideoGenerateInput, depsForHandlers),
      },
      'ai.media.animate': {
        schema: AiVideoFromImageInputSchema,
        handler: (ctx, input) =>
          handleVideoFromImage(ctx, input as AiVideoFromImageInput, depsForHandlers),
      },
    };
  }

  private stepErrorPrefix(ctx: ExecutorContext): string {
    const stepName = ctx.stepDefinition?.name ?? ctx.job.stepId;
    const stepId = ctx.job.stepId;
    const op = ctx.operationId;
    return `[step "${stepName}" (${stepId}) | ${op}]`;
  }

  private async handleError(
    ctx: ExecutorContext,
    label: string,
    error: unknown,
  ): Promise<StepResult> {
    const prefix = this.stepErrorPrefix(ctx);
    const rawMsg = error instanceof Error ? error.message : String(error);

    const logCtx = {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.stepExecutionId,
      operationId: ctx.operationId,
      stepType: ctx.job.stepType,
      stepId: ctx.job.stepId,
      traceId: ctx.traceId,
    };

    if (error instanceof AIClientError) {
      const aflowErr = error.toAflowError();
      const diag = (error as unknown as Record<string, unknown>)['streamDiagnostics'] as
        Record<string, unknown> | undefined;
      ctx.log.error(`${prefix} ${label}`, {
        ...errorContext(aflowErr, logCtx),
        causeName: error.name,
        ...(error.stack ? { errorStack: error.stack } : {}),
        ...(diag ? { streamDiagnostics: diag } : {}),
      });
      return await failureWithError(ctx, { ...aflowErr, message: `${prefix} ${aflowErr.message}` });
    }

    if (error instanceof AISetupError) {
      const aflowErr = error.toAflowError();
      const cause = error.cause;
      ctx.log.error(`${prefix} ${label}`, {
        ...errorContext(aflowErr, logCtx),
        causeName: cause instanceof Error ? cause.name : error.name,
        ...(cause instanceof Error ? { causeMessage: cause.message } : {}),
        ...(error.stack ? { errorStack: error.stack } : {}),
      });
      return await failureWithError(ctx, { ...aflowErr, message: `${prefix} ${aflowErr.message}` });
    }

    if (error && typeof error === 'object') {
      const parsed = AflowErrorSchema.safeParse(error);
      if (parsed.success) {
        const aflowErr = parsed.data;
        ctx.log.error(`${prefix} ${label}`, {
          ...errorContext(aflowErr, logCtx),
          ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
        });
        return await failureWithError(ctx, {
          ...aflowErr,
          message: `${prefix} ${aflowErr.message}`,
        });
      }
    }

    ctx.log.error(`${prefix} ${label}`, {
      ...errorContextFromUnknown(error, logCtx),
      ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
    });

    return await failureWithError(ctx, internalError(`${prefix} ${rawMsg}`, { retryable: false }));
  }

  private validateToolArgs(
    stepId: string,
    args: Record<string, unknown>,
    inputSchema: Record<string, unknown>,
  ): AflowError | null {
    if (Object.keys(inputSchema).length === 0) {
      return null;
    }
    try {
      const validate = ajv.compile(inputSchema);
      const valid = validate(args);
      if (!valid) {
        const ajvErrors = (validate.errors ?? []) as ErrorObject[];
        const details: ValidationErrorDetail[] = ajvErrors.map((e) => {
          const rawPath = e.instancePath;
          const pathStr = rawPath ? rawPath.replace(/^\//, '') : '';
          const path = pathStr.length > 0 ? pathStr.split('/') : [];
          return {
            path,
            code: e.keyword,
            message: e.message ?? 'validation error',
          };
        });
        const summary = ajvErrors
          .map((e) => `${e.instancePath}: ${e.message ?? 'validation error'}`)
          .join('; ');
        return createValidationError(
          `Agent tool "${stepId}" arguments invalid: ${summary}`,
          details,
        );
      }
    } catch (compileErr) {
      const detailMsg = compileErr instanceof Error ? compileErr.message : String(compileErr);
      return createValidationError(
        `Agent tool "${stepId}" arguments could not be validated because the tool schema could not be compiled`,
        [
          {
            path: [],
            code: 'schema_compile_failed',
            message: detailMsg,
          },
        ],
      );
    }
    return null;
  }

  async validate(ctx: ExecutorContext): Promise<AflowError | null> {
    const input = await ctx.readPayload(ctx.job.inputRef);

    if (typeof input !== 'object' || input === null) {
      return validationError('Input must be an object');
    }

    if (!this.operations[ctx.operationId]) {
      return validationError(
        `Unsupported AI operation: "${ctx.operationId}". ` +
          `Supported operations: ${Object.keys(this.operations).join(', ')}`,
      );
    }

    return null;
  }

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const operationId = ctx.operationId;
    const input = await ctx.readPayload(ctx.job.inputRef);
    const typedInput = input as Record<string, unknown>;

    const budgetResult = checkBudgetMock({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepExecutionId: ctx.stepExecutionId,
    });

    if (!budgetResult.allowed) {
      ctx.log.warn('Budget exceeded, operation blocked', {
        reason: budgetResult.reason,
        currentUsage: budgetResult.currentUsage,
      });

      return await failureWithError(ctx, {
        code: 'BUDGET_EXCEEDED',
        message: budgetResult.reason ?? 'Budget limit exceeded',
        classification: 'validation',
        retryable: false,
        timestamp: new Date().toISOString(),
      });
    }

    const operation = this.operations[operationId];
    if (!operation) {
      return await failureWithError(
        ctx,
        validationError(
          `Unsupported AI operation: "${operationId}". ` +
            `Supported: ${Object.keys(this.operations).join(', ')}`,
        ),
      );
    }

    const parsed = operation.schema.safeParse(typedInput);
    if (!parsed.success) {
      return await failureWithError(
        ctx,
        validationError(`Invalid input for ${operationId}: ${parsed.error.message}`),
      );
    }

    return await operation.handler(ctx, parsed.data);
  }
}
