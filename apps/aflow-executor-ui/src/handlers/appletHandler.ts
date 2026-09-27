/**
 * Stateful-applet step handler — the agent's side of the applet gateway.
 *
 * Handles: ui.applet.instantiate, ui.applet.get, ui.applet.act, ui.applet.list
 *
 * All applet-table access goes through the AppletPersistence port and every
 * mutation through applyAppletCommand — this handler never touches tables.
 */
import { randomUUID } from 'node:crypto';
import type { ExecutorContext, StepResult } from '@aflow/executor-runtime';
import {
  successWithData,
  failureWithError,
  validationError,
  notFoundError,
  internalError,
} from '@aflow/executor-runtime';
import type {
  AflowError,
  AppletActionReceipt,
  AppletActionReceiptAgentView,
  AppletDefinition,
  AppletInstance,
  AppletInstanceAgentView,
  StepOutputPresentation,
  TenantId,
  UiAppletActOutput,
  UiAppletGetOutput,
  UiAppletInstantiateOutput,
  UiAppletListOutput,
} from '@aflow/schemas';
import {
  appletStatePath,
  RAW_PATCH_ACTION_NAME,
  UiAppletActInputSchema,
  UiAppletGetInputSchema,
  UiAppletInstantiateInputSchema,
  UiAppletListInputSchema,
} from '@aflow/schemas';
import type { AppletInstanceDelta } from '@aflow/schemas';
import type { AppletPersistence, ApplyAppletCommandResult } from '@aflow/applet-runtime';
import {
  applyAppletCommand,
  AppletPersistenceError,
  AppletSchemaSafetyError,
  projectAppletAttention,
  projectAppletState,
  projectRecentReceipts,
  renderAppletAgentGrid,
  renderAppletSituationLines,
  validateAgainstAppletSchema,
} from '@aflow/applet-runtime';
import type { ZodError, ZodSchema } from 'zod';

export type AppletPersistenceFactory = (tenantId: TenantId) => AppletPersistence;

/** Post-commit realtime fanout — fire-and-forget; a miss costs a refetch, never a wrong state. */
export type AppletDeltaPublisher = (
  tenantId: TenantId,
  spaceId: string,
  delta: AppletInstanceDelta,
) => Promise<void>;

/**
 * Publish-on-instantiate: promotes a definition-bearing draft to a published
 * artifact version (deleting the draft) so the instance pins something
 * durable, never a 24h draft.
 */
export type AppletDraftPublisher = (
  ctx: ExecutorContext,
  params: { spaceId: string; draftId: string },
) => Promise<{ ok: true; artifactVersionId: string } | { ok: false; error: AflowError }>;

const DEFAULT_LIST_LIMIT = 50;

export class AppletHandler {
  constructor(
    private readonly persistenceFor: AppletPersistenceFactory,
    private readonly publishDelta?: AppletDeltaPublisher,
    private readonly publishDraft?: AppletDraftPublisher,
  ) {}

  async execute(ctx: ExecutorContext): Promise<StepResult> {
    const spaceId = ctx.spaceId;
    if (!spaceId) {
      return await failureWithError(
        ctx,
        validationError(
          `execution context is missing spaceId — ${ctx.operationId} runs only in the originating session space (platform invariant)`,
        ),
      );
    }
    try {
      switch (ctx.operationId) {
        case 'ui.applet.instantiate':
          return await this.handleInstantiate(ctx, spaceId);
        case 'ui.applet.get':
          return await this.handleGet(ctx, spaceId);
        case 'ui.applet.act':
          return await this.handleAct(ctx, spaceId);
        case 'ui.applet.list':
          return await this.handleList(ctx, spaceId);
        default:
          return await failureWithError(
            ctx,
            validationError(`AppletHandler does not handle ${ctx.operationId}`),
          );
      }
    } catch (err) {
      if (err instanceof AppletPersistenceError) {
        return await failureWithError(ctx, persistenceFailure(err));
      }
      throw err;
    }
  }

  // ── ui.applet.instantiate ────────────────────────────────────────────────

  private async handleInstantiate(ctx: ExecutorContext, spaceId: string): Promise<StepResult> {
    const input = await this.parseInput(ctx, UiAppletInstantiateInputSchema);
    if ('error' in input) return await failureWithError(ctx, input.error);
    const { artifactId, draftId, roleBindings } = input.data;
    let { versionId } = input.data;

    if (draftId !== undefined) {
      if (!this.publishDraft) {
        return await failureWithError(
          ctx,
          internalError('Draft publishing is not wired for this executor', { retryable: false }),
        );
      }
      const published = await this.publishDraft(ctx, { spaceId, draftId });
      if (!published.ok) {
        return await failureWithError(ctx, published.error);
      }
      versionId = published.artifactVersionId;
    }

    const persistence = this.persistenceFor(ctx.tenantId);
    const resolution = await persistence.transact((tx) =>
      tx.resolveAppletArtifact({
        spaceId,
        ...(artifactId !== undefined ? { artifactId } : {}),
        ...(versionId !== undefined ? { versionId } : {}),
      }),
    );
    switch (resolution.outcome) {
      case 'not_found':
        return await failureWithError(
          ctx,
          notFoundError(
            `No artifact ${versionId !== undefined ? 'version ' : ''}'${versionId ?? artifactId}' in this space`,
          ),
        );
      case 'not_an_applet':
        return await failureWithError(
          ctx,
          validationError(
            `Artifact version '${resolution.artifactVersionId}' carries no applet definition — only applet artifacts can be instantiated`,
          ),
        );
      case 'definition_invalid':
        return await failureWithError(
          ctx,
          internalError(
            `Pinned definition on artifact version '${resolution.artifactVersionId}' does not parse: ${resolution.message}`,
            { retryable: false },
          ),
        );
      case 'resolved':
        break;
    }
    const { definition, definitionHash, artifactVersionId } = resolution;

    const birthCheck = this.validateBirthState(definition, definitionHash);
    if (birthCheck !== null) return await failureWithError(ctx, birthCheck);

    const now = new Date().toISOString();
    const instanceId = randomUUID();
    const instance: AppletInstance = {
      instanceId,
      spaceId,
      appletKey: definition.appletKey,
      definitionHash,
      artifactVersionId,
      statePath: appletStatePath(instanceId),
      status: 'active',
      boundSessionId: ctx.job.sessionId ?? null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    };
    const stateVersion = await persistence.transact((tx) =>
      tx.createInstance({
        instance,
        initialState: definition.initialState,
        roleBindings: roleBindings ?? [],
      }),
    );

    const output: UiAppletInstantiateOutput = {
      instance: agentInstanceView(instance),
      state: definition.initialState,
      stateVersion,
      presentation: appletPresentation(instanceId),
    };
    return await successWithData(ctx, output);
  }

  private validateBirthState(
    definition: AppletDefinition,
    definitionHash: string,
  ): AflowError | null {
    try {
      const check = validateAgainstAppletSchema({
        schema: definition.stateSchema,
        cacheKey: `${definitionHash}#state`,
        data: definition.initialState,
      });
      if (!check.valid) {
        return validationError('initialState does not satisfy the declared stateSchema', {
          validation: check.errors,
        });
      }
      return null;
    } catch (err) {
      if (err instanceof AppletSchemaSafetyError) {
        return validationError(`Declared stateSchema is unsafe: ${err.message}`);
      }
      throw err;
    }
  }

  // ── ui.applet.get ────────────────────────────────────────────────────────

  private async handleGet(ctx: ExecutorContext, spaceId: string): Promise<StepResult> {
    const input = await this.parseInput(ctx, UiAppletGetInputSchema);
    if ('error' in input) return await failureWithError(ctx, input.error);
    const { instanceId } = input.data;

    const persistence = this.persistenceFor(ctx.tenantId);
    const loaded = await persistence.transact(async (tx) => {
      const record = await tx.loadInstanceForUpdate(instanceId);
      if (record?.instance.spaceId !== spaceId) return null;
      const receipts = await tx.listRecentReceipts(
        instanceId,
        record.definition.recentActionsLimit,
      );
      const bindings = await tx.listRoleBindings(instanceId);
      return { record, receipts, bindings };
    });
    if (loaded === null) {
      return await failureWithError(
        ctx,
        notFoundError(`No applet instance '${instanceId}' in this space`),
      );
    }
    const { record, receipts, bindings } = loaded;
    const { definition } = record;

    const gridView =
      definition.agentGrid !== undefined
        ? renderAppletAgentGrid(definition.agentGrid, record.state)
        : undefined;
    const situationLines = renderAppletSituationLines(definition, record.state);
    const output: UiAppletGetOutput = {
      instance: agentInstanceView(record.instance),
      state: projectAppletState(record.state, definition.agentProjection),
      stateVersion: record.stateVersion,
      recentReceipts: projectRecentReceipts(receipts, definition.recentActionsLimit).map(
        agentReceiptView,
      ),
      availableActions: agentAvailableActions(definition),
      roleBindings: bindings.map((binding) => ({
        userId: binding.userId,
        roleId: binding.roleId,
      })),
      ...(gridView !== undefined ? { gridView } : {}),
      ...(situationLines.length > 0 ? { situation: situationLines.join('\n') } : {}),
      presentation: appletPresentation(instanceId),
    };
    return await successWithData(ctx, output);
  }

  // ── ui.applet.act ────────────────────────────────────────────────────────

  private async handleAct(ctx: ExecutorContext, spaceId: string): Promise<StepResult> {
    const input = await this.parseInput(ctx, UiAppletActInputSchema);
    if ('error' in input) return await failureWithError(ctx, input.error);
    const { instanceId, ...command } = input.data;

    // Cross-space ids must read as nonexistent. Wrapping the load keeps the
    // check inside the gateway's single transaction and single row lock.
    const persistence = this.persistenceFor(ctx.tenantId);
    let loadedDefinition: AppletDefinition | undefined;
    const spaceGuarded: AppletPersistence = {
      transact: (fn) =>
        persistence.transact((tx) =>
          fn({
            ...tx,
            loadInstanceForUpdate: async (id) => {
              const record = await tx.loadInstanceForUpdate(id);
              if (record !== null && record.instance.spaceId !== spaceId) return null;
              loadedDefinition = record?.definition;
              return record;
            },
          }),
        ),
    };

    let result: ApplyAppletCommandResult;
    try {
      result = await applyAppletCommand({
        persistence: spaceGuarded,
        instanceId,
        actor: { kind: 'agent', agentRole: 'agent' },
        spaceRole: 'editor',
        command,
      });
    } catch (err) {
      if (err instanceof AppletPersistenceError && err.code === 'instance_not_found') {
        return await failureWithError(
          ctx,
          notFoundError(`No applet instance '${instanceId}' in this space`),
        );
      }
      throw err;
    }

    switch (result.status) {
      case 'applied': {
        // Same post-commit fanout the HTTP route performs — without it every
        // mounted human view stays stale until the NEXT human action arrives.
        if (!result.replayed && this.publishDelta) {
          await this.publishDelta(ctx.tenantId, spaceId, {
            instanceId,
            seq: result.receipt.seq,
            stateVersion: result.stateVersion,
            patch: result.receipt.patch,
            ...(result.receipt.effects.ending ? { status: 'ended' as const } : {}),
          });
        }
        // An agent move re-mounts the board at the conversation tail (older
        // cards freeze) — without this the user watches a stale card while the
        // agent narrates moves they cannot see.
        const gridView =
          loadedDefinition?.agentGrid !== undefined
            ? renderAppletAgentGrid(loadedDefinition.agentGrid, result.state)
            : undefined;
        const output: UiAppletActOutput = {
          receipt: agentReceiptView(result.receipt),
          stateVersion: result.stateVersion,
          ...(gridView !== undefined ? { gridView } : {}),
          presentation: appletPresentation(instanceId),
        };
        return await successWithData(ctx, output);
      }
      case 'conflict':
        return await failureWithError(ctx, {
          code: 'APPLET_VERSION_CONFLICT',
          message:
            `Stale baseVersion — the instance is at version ${result.currentVersion}. ` +
            'Re-read with ui.applet.get and recompute before retrying.',
          classification: 'conflict',
          retryable: true,
          timestamp: new Date().toISOString(),
          details: { currentVersion: result.currentVersion },
        });
      case 'rejected':
        return await failureWithError(
          ctx,
          validationError(result.message, {
            reason: result.reason,
            availableActions: result.availableActions,
            ...(result.validation !== undefined ? { validation: result.validation } : {}),
          }),
        );
    }
  }

  // ── ui.applet.list ───────────────────────────────────────────────────────

  private async handleList(ctx: ExecutorContext, spaceId: string): Promise<StepResult> {
    const input = await this.parseInput(ctx, UiAppletListInputSchema);
    if ('error' in input) return await failureWithError(ctx, input.error);
    const { status, appletKey, limit, cursor } = input.data;

    const offset = cursor !== undefined ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      return await failureWithError(ctx, validationError(`Invalid cursor '${cursor ?? ''}'`));
    }

    const persistence = this.persistenceFor(ctx.tenantId);
    const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
    const { items, total } = await persistence.transact((tx) =>
      tx.listInstances({
        spaceId,
        status: status ?? 'active',
        ...(appletKey !== undefined ? { appletKey } : {}),
        limit: effectiveLimit,
        offset,
      }),
    );

    const instances = items.map((item) => {
      const attention = projectAppletAttention(item.state, item.definition.attentionProjection);
      return {
        ...agentInstanceView(item.instance),
        stateVersion: item.stateVersion,
        ...(item.lastReceipt !== undefined
          ? { lastReceipt: agentReceiptView(item.lastReceipt) }
          : {}),
        ...(attention !== undefined ? { attention } : {}),
      };
    });
    const nextOffset = offset + items.length;
    const output: UiAppletListOutput = {
      instances,
      ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
      total,
    };
    return await successWithData(ctx, output);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async parseInput<T>(
    ctx: ExecutorContext,
    schema: ZodSchema<T>,
  ): Promise<{ data: T } | { error: AflowError }> {
    const raw = await ctx.readPayload(ctx.job.inputRef);
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      return { error: validationError(formatZodError(parsed.error)) };
    }
    return { data: parsed.data };
  }
}

/** Op outputs never carry statePath — the raw state doc is not the agent's read surface. */
function agentInstanceView(instance: AppletInstance): AppletInstanceAgentView {
  const { statePath: _statePath, ...view } = instance;
  return view;
}

/** Agent-facing receipts drop the applied patch — derivable, and the heaviest field by far. */
function agentReceiptView(receipt: AppletActionReceipt): AppletActionReceiptAgentView {
  const { patch: _patch, ...view } = receipt;
  return view;
}

/**
 * Every applet step carries the mount hint: the chat renders a live card at
 * the step's anchor and freezes older cards for the same instance, so the
 * newest board always arrives with the step that changed it.
 */
function appletPresentation(instanceId: string): StepOutputPresentation {
  return { mode: 'rendered_inline', substrate: 'applet', instanceId };
}

/** The declared surface for an agent caller — `audience` is a hint, and 'human' hints are omitted, never gated. */
function agentAvailableActions(definition: AppletDefinition): string[] {
  const forAgent = definition.actions
    .filter((action) => action.audience !== 'human')
    .map((action) => action.name);
  return [...forAgent, RAW_PATCH_ACTION_NAME];
}

function persistenceFailure(err: AppletPersistenceError): AflowError {
  if (err.code === 'instance_not_found') {
    return notFoundError(err.message, { instanceId: err.instanceId });
  }
  // Broken pinning or a corrupted snapshot — persistent until repaired, so a
  // retry cannot succeed.
  return internalError(err.message, {
    retryable: false,
    details: { code: err.code, instanceId: err.instanceId },
  });
}

function formatZodError(error: ZodError): string {
  return `Invalid input: ${error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ')}`;
}
