/**
 * Surface visualize step handler.
 *
 * Handles: ui.surface.visualize
 *
 * Generates streamable realtime UI surfaces by:
 * 1. Loading the surface catalog
 * 2. Building the generation prompt with catalog + examples
 * 3. Calling the AI client with streaming
 * 4. Buffering tokens into complete JSONL messages
 * 5. Validating each message against the surface catalog
 * 6. Emitting validated mutations (buffered for step output)
 * 7. Returning a final snapshot
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StepHandler, ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  validationError,
  internalError,
} from '@aflow/executor-runtime';
import type {
  SurfaceMutation,
  UiSurfaceVisualizeInput,
  UiSurfaceVisualizeOutput,
  StepUsageBreakdown,
} from '@aflow/schemas';
import { UiSurfaceVisualizeInputSchema } from '@aflow/schemas';
import {
  SurfaceStore,
  MessageAssembler,
  SurfaceMutationValidator,
  buildSurfaceSystemPrompt,
  buildSurfaceUserPrompt,
  getSurfaceExample,
} from '@aflow/surface-engine';
import type { ChatMessage } from '@aflow/ai-client';
import { ICON_MAP } from '@aflow/design-system';

import { getAIClientForContext, resolveGenerationModel, ByokCredentialError } from '../aiClient.js';
import { DEFAULT_UI_MODEL } from './uiModelDefaults.js';

/** Icon names derived from the design system — passed to the prompt so the model uses valid names. */
const DS_ICON_NAMES = Object.keys(ICON_MAP) as readonly string[];

// =============================================================================
// Catalog version loading
// =============================================================================

const __surfaceDirname = dirname(fileURLToPath(import.meta.url));

let cachedCatalogVersion: string | undefined;

function getCatalogVersion(): string {
  if (cachedCatalogVersion) return cachedCatalogVersion;
  try {
    const contractPath = resolve(
      __surfaceDirname,
      '../../../../packages/design-system/dist/design-system-contract-compact-surface.json',
    );
    const contract = JSON.parse(readFileSync(contractPath, 'utf-8')) as {
      catalogVersion?: string;
      catalogHash?: string;
    };
    cachedCatalogVersion = contract.catalogVersion ?? contract.catalogHash ?? 'unknown';
    return cachedCatalogVersion;
  } catch {
    cachedCatalogVersion = `v${new Date().toISOString().slice(0, 10)}`;
    return cachedCatalogVersion;
  }
}

// =============================================================================
// Handler
// =============================================================================

export class SurfaceHandler implements StepHandler {
  readonly stepType = 'ui';

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    if (ctx.operationId !== 'ui.surface.visualize') {
      return failureWithError(
        ctx,
        validationError(`SurfaceHandler does not handle ${ctx.operationId}`),
      );
    }

    return this.handleVisualize(ctx);
  }

  private async handleVisualize(ctx: ExecutorContext): Promise<StepResult> {
    const startTime = Date.now();

    // Parse and validate input
    const inputPayload = ctx.job.inputRef
      ? await ctx.readPayload<Record<string, unknown>>(ctx.job.inputRef)
      : {};

    const parseResult = UiSurfaceVisualizeInputSchema.safeParse(inputPayload);
    if (!parseResult.success) {
      return failureWithError(
        ctx,
        validationError(
          `Invalid input: ${parseResult.error.issues.map((i: { message: string }) => i.message).join('; ')}`,
        ),
      );
    }

    const input: UiSurfaceVisualizeInput = parseResult.data;

    const surfaceId = input.surfaceId ?? `surface-${randomUUID().slice(0, 8)}`;
    const catalogVersion = getCatalogVersion();

    // Auto-wrap array data
    let data = input.data as Record<string, unknown> | undefined;
    if (Array.isArray(input.data)) {
      data = { items: input.data };
    }

    // Determine whether data is pre-loaded (provided as input) or model-generated
    const hasPreloadedData = data != null && Object.keys(data).length > 0;

    // Build prompts
    const systemPrompt = buildSurfaceSystemPrompt(
      catalogVersion,
      input.allowedComponents as string[] | undefined,
      DS_ICON_NAMES,
      hasPreloadedData,
    );

    const userPrompt = buildSurfaceUserPrompt(
      input.prompt,
      surfaceId,
      input.dataSchema,
      data,
      hasPreloadedData,
    );

    // Set up surface engine
    const store = new SurfaceStore();
    const validator = new SurfaceMutationValidator();
    const mutations: SurfaceMutation[] = [];
    const errors: string[] = [];
    const coercions: Array<{ original: string; coerced: string }> = [];

    // Pre-loaded data model — keyed by JSON Pointer paths for injection into createSurface
    const preloadedDataModel = hasPreloadedData
      ? Object.fromEntries(Object.entries(data!).map(([key, value]) => [`/${key}`, value]))
      : undefined;

    // Batch buffer for streaming — accumulate mutations and flush periodically
    let pendingMutations: SurfaceMutation[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_INTERVAL_MS = 150; // Flush every 150ms for smooth streaming

    const isWorkflowTaskJob = ctx.job.sessionId === undefined;
    let progressSequence = 0;

    const flushPending = async () => {
      if (pendingMutations.length === 0) return;
      const batch = pendingMutations;
      pendingMutations = [];
      const mutationRecords = batch.map((m) => m as unknown as Record<string, unknown>);
      if (isWorkflowTaskJob) {
        progressSequence += 1;
        await ctx.emitWorkflowProgress({
          eventType: 'WorkflowTaskSurfaceUpdate',
          surfaceId,
          surfaceMutations: mutationRecords,
          sequence: progressSequence,
          metadata: { streaming: true },
        });
      } else {
        await ctx.emitRunEvent({
          eventType: 'SurfaceUpdate',
          surfaceId,
          surfaceMutations: mutationRecords,
          metadata: { streaming: true },
        });
      }
    };

    const scheduleBatchFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushPending();
      }, FLUSH_INTERVAL_MS);
    };

    // Use MessageAssembler to buffer streaming tokens into complete messages
    const assembler = new MessageAssembler({
      onMessage: (rawMutation: SurfaceMutation, _rawJson: string) => {
        // Inject pre-loaded data into createSurface so bindings resolve immediately
        let mutation = rawMutation;
        if (mutation.type === 'createSurface' && preloadedDataModel) {
          mutation = {
            ...mutation,
            dataModel: { ...preloadedDataModel, ...(mutation.dataModel ?? {}) },
          };
        }

        // Validate against catalog
        const result = validator.validate(mutation);
        if (result.valid) {
          store.apply(mutation);
          mutations.push(mutation);
          pendingMutations.push(mutation);
          scheduleBatchFlush();
        } else {
          // Log warnings but still apply if no errors
          for (const w of result.warnings) {
            ctx.log.debug(`Validation warning: ${w.message}`);
          }
          if (result.errors.length === 0) {
            store.apply(mutation);
            mutations.push(mutation);
            pendingMutations.push(mutation);
            scheduleBatchFlush();
          } else {
            for (const e of result.errors) {
              errors.push(e.message);
            }
          }
        }
      },
      onError: (error: string, rawText: string) => {
        ctx.log.warn(`Assembler error: ${error}`, { rawText: rawText.slice(0, 500) });
        errors.push(error);
      },
      onCoercion: (original: string, coerced: string) => {
        ctx.log.debug('Auto-coerced mutation', { original, coerced });
        coercions.push({ original, coerced });
      },
    });

    // Build AI messages
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Here is an example of a well-formed surface:\n\n${getSurfaceExample(hasPreloadedData)}\n\n---\n\n${userPrompt}`,
      },
    ];

    // Call AI with streaming
    let usage: StepUsageBreakdown | undefined;
    let rawOutput = ''; // Capture full model output for diagnostics
    try {
      const model = await resolveGenerationModel(ctx, [
        input.model,
        ctx.callerModel,
        process.env['UI_GEN_MODEL'],
        DEFAULT_UI_MODEL,
      ]);
      if (model === null) {
        throw new ByokCredentialError(
          'No AI provider is connected for this space, so the surface cannot be generated. ' +
            'Connect a provider credential in Integrations, then retry.',
          null,
        );
      }
      const aiClient = await getAIClientForContext(ctx, model);

      const { stream, response } = aiClient.generateTextStream({
        model,
        messages,
        temperature: 0.3,
        maxTokens: 16_000,
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepExecutionId: ctx.stepExecutionId,
      });

      for await (const chunk of stream) {
        if (chunk.delta) {
          rawOutput += chunk.delta;
          assembler.feed(chunk.delta);
        }
      }

      // Flush remaining buffer
      assembler.flush();

      // Flush any remaining pending mutations
      if (flushTimer) clearTimeout(flushTimer);
      await flushPending();

      const finalResponse = await response;

      // Log diagnostics for debugging surface generation issues
      ctx.log.info('Surface AI response', {
        finishReason: finalResponse.finishReason,
        completionTokens: finalResponse.usage.completionTokens ?? 0,
        totalTokens: finalResponse.usage.totalTokens ?? 0,
        rawOutputLength: rawOutput.length,
        rawOutputPreview: rawOutput.slice(0, 500),
        rawOutputTail: rawOutput.slice(-300),
        mutationsEmitted: mutations.length,
        errorsEncountered: errors.length,
      });

      if (finalResponse.usage.totalTokens) {
        usage = {
          provider: finalResponse.provider ?? 'unknown',
          model: finalResponse.model,
          promptTokens: finalResponse.usage.promptTokens ?? 0,
          completionTokens: finalResponse.usage.completionTokens ?? 0,
          totalTokens: finalResponse.usage.totalTokens ?? 0,
          promptCostUsd: finalResponse.cost?.promptCost ?? 0,
          completionCostUsd: finalResponse.cost?.completionCost ?? 0,
          totalCostUsd: finalResponse.cost?.totalCost ?? 0,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error('Surface generation failed', {
        error: message,
        rawOutputLength: rawOutput.length,
        rawOutputPreview: rawOutput.slice(0, 500),
      });
      return failureWithError(ctx, internalError(`Surface generation failed: ${message}`));
    }

    const durationMs = Date.now() - startTime;
    const snapshot = store.toSnapshot();

    // Build output
    const output: UiSurfaceVisualizeOutput = {
      surfaceId,
      catalogVersion,
      snapshot,
      mutations: mutations.map((m) => m as unknown as Record<string, unknown>),
      componentCount: snapshot.rootIds.length > 0 ? store.getState().components.size : 0,
      mutationCount: mutations.length,
      durationMs,
      ...(input.dataSchema ? { dataSchema: input.dataSchema } : {}),
      presentation: {
        mode: 'rendered_inline',
        substrate: 'surface',
        surfaceId,
      },
    };

    if (errors.length > 0 || coercions.length > 0) {
      ctx.log.info('Surface generation diagnostics', {
        errorCount: errors.length,
        coercionCount: coercions.length,
      });
      // Include generation diagnostics in output for observability
      const diagnostics: Record<string, unknown> = {};
      if (errors.length > 0) diagnostics['errors'] = errors;
      if (coercions.length > 0) diagnostics['coercions'] = coercions;
      (output as Record<string, unknown>)['generationDiagnostics'] = diagnostics;
    }

    if (usage) {
      return successWithData(ctx, output, { costJson: { ...usage } });
    }
    return successWithData(ctx, output);
  }
}
