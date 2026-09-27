/**
 * The single write gateway — every mutation enters here, from a human click
 * (phoenix:action) and from the agent (ui.applet.act) alike. Pipeline, all
 * under the instance row lock in one transaction: replay known actionIds,
 * authorize, resolve the action, validate input, CAS on baseVersion
 * (template: rematerialize against current · actor_supplied: conflict),
 * bound and apply the patch, validate the resulting state, persist snapshot +
 * receipt atomically. Effects are recorded on the receipt only — relay and
 * realtime publish happen after commit, by the caller.
 */
import {
  ACTOR_SUPPLIED_PATCH,
  resolveAppletLimits,
  type AppletActionReceipt,
  type AppletActor,
  type AppletCommand,
  type AppletDefinition,
  type AppletEffectDelivery,
  type AppletStatePatchOp,
  type AppletStateVersion,
  type SpaceRole,
} from '@aflow/schemas';
import { availableActionNames, resolveAppletAction, resolveCommandPatch } from './command.js';
import {
  AppletCommandError,
  AppletPatchApplyError,
  AppletPatchBoundsError,
  AppletPersistenceError,
  AppletSchemaSafetyError,
  AppletTemplateError,
} from './errors.js';
import { canonicalJsonStringify, exceedsJsonDepth, jsonUtf8Bytes } from './json.js';
import { applyAppletStatePatch } from './applyStatePatch.js';
import { evaluateAppletActionGuard } from './guard.js';
import type { AppletPersistence } from './persistence.js';
import { validateAgainstAppletSchema } from './schemaValidation.js';

export interface ApplyAppletCommandParams {
  persistence: AppletPersistence;
  instanceId: string;
  /** Server-stamped at the authenticated boundary — never client-supplied. */
  actor: AppletActor;
  /** Server-stamped space permission — viewers cannot write. Applet roles are labels, never consulted. */
  spaceRole: SpaceRole;
  command: AppletCommand;
}

export type AppletCommandRejectionReason =
  | 'forbidden'
  | 'instance_not_active'
  | 'idempotency_mismatch'
  | 'unknown_action'
  | 'invalid_input'
  | 'invalid_schema'
  | 'guard_rejected'
  | 'invalid_patch'
  | 'invalid_state';

export type ApplyAppletCommandResult =
  | {
      status: 'applied';
      receipt: AppletActionReceipt;
      state: Record<string, unknown>;
      stateVersion: AppletStateVersion;
      /** True when a known actionId replayed — the caller skips the realtime publish. */
      replayed: boolean;
    }
  | {
      /** Retryable — but only after a re-read and recomputation. */
      status: 'conflict';
      currentVersion: AppletStateVersion;
    }
  | {
      /** The same arguments can never succeed. */
      status: 'rejected';
      reason: AppletCommandRejectionReason;
      message: string;
      availableActions: string[];
      /** Structural validation failures, when the rejection carries them. */
      validation?: string[];
    };

export async function applyAppletCommand(
  params: ApplyAppletCommandParams,
): Promise<ApplyAppletCommandResult> {
  const { persistence, instanceId, actor, spaceRole, command } = params;

  return persistence.transact(async (tx) => {
    const record = await tx.loadInstanceForUpdate(instanceId);
    if (record === null) {
      throw new AppletPersistenceError(
        'instance_not_found',
        `No applet instance '${instanceId}'`,
        instanceId,
      );
    }
    const { definition } = record;
    const declaredActions = availableActionNames(definition);

    const existing = await tx.getJournalEntry(instanceId, command.actionId);
    if (existing !== null) {
      if (!isExactReplay(command, existing.receipt, definition)) {
        return rejected(
          'idempotency_mismatch',
          `actionId '${command.actionId}' was already used with a different payload`,
          declaredActions,
        );
      }
      return {
        status: 'applied' as const,
        receipt: existing.receipt,
        state: record.state,
        stateVersion: record.stateVersion,
        replayed: true,
      };
    }

    if (spaceRole === 'viewer') {
      return rejected('forbidden', 'Viewers cannot act on an applet instance', declaredActions);
    }
    if (record.instance.status !== 'active') {
      return rejected(
        'instance_not_active',
        `Instance is '${record.instance.status}' — only active instances accept actions`,
        declaredActions,
      );
    }

    let action;
    try {
      action = resolveAppletAction(definition, command.name);
    } catch (err) {
      if (err instanceof AppletCommandError) {
        return rejected('unknown_action', err.message, err.availableActions ?? declaredActions);
      }
      throw err;
    }

    const limits = resolveAppletLimits(definition.limits);
    const inputBytes = jsonUtf8Bytes(command.input);
    if (inputBytes > limits.maxInputBytes) {
      return rejected(
        'invalid_input',
        `Input serializes to ${inputBytes} bytes (max ${limits.maxInputBytes})`,
        declaredActions,
      );
    }
    if (exceedsJsonDepth(command.input, limits.maxJsonDepth)) {
      return rejected(
        'invalid_input',
        `Input nests deeper than ${limits.maxJsonDepth} levels`,
        declaredActions,
      );
    }
    if (command.outcome !== undefined && command.outcome.length > limits.maxOutcomeLength) {
      return rejected(
        'invalid_input',
        `Outcome exceeds ${limits.maxOutcomeLength} characters`,
        declaredActions,
      );
    }

    try {
      const inputCheck = validateAgainstAppletSchema({
        schema: action.inputSchema,
        cacheKey: `${record.instance.definitionHash}#action:${action.name}`,
        data: command.input,
      });
      if (!inputCheck.valid) {
        return rejected(
          'invalid_input',
          `Input does not match the '${action.name}' schema`,
          declaredActions,
          inputCheck.errors,
        );
      }
    } catch (err) {
      if (err instanceof AppletSchemaSafetyError) {
        return rejected('invalid_schema', err.message, declaredActions);
      }
      throw err;
    }

    // Conflict follows from the patch mode: a template patch is a pure
    // function of input, so it rematerializes against the current version; an
    // actor-supplied patch is meaningless against another state.
    if (command.baseVersion !== record.stateVersion && action.patch === ACTOR_SUPPLIED_PATCH) {
      return { status: 'conflict' as const, currentVersion: record.stateVersion };
    }

    if (action.guard !== undefined) {
      const verdict = evaluateAppletActionGuard({
        guard: action.guard,
        state: record.state,
        input: command.input,
      });
      if (!verdict.ok) {
        return rejected('guard_rejected', verdict.message, declaredActions);
      }
    }

    let patch: AppletStatePatchOp[];
    try {
      patch = resolveCommandPatch(action, command, limits);
    } catch (err) {
      if (
        err instanceof AppletCommandError ||
        err instanceof AppletTemplateError ||
        err instanceof AppletPatchBoundsError
      ) {
        return rejected('invalid_patch', err.message, declaredActions);
      }
      throw err;
    }

    let nextState: Record<string, unknown>;
    try {
      nextState = applyAppletStatePatch(record.state, patch);
    } catch (err) {
      if (err instanceof AppletPatchApplyError) {
        return rejected('invalid_patch', err.message, declaredActions);
      }
      throw err;
    }

    const stateBytes = jsonUtf8Bytes(nextState);
    if (stateBytes > limits.maxStateBytes) {
      return rejected(
        'invalid_state',
        `Resulting state serializes to ${stateBytes} bytes (max ${limits.maxStateBytes})`,
        declaredActions,
      );
    }
    if (exceedsJsonDepth(nextState, limits.maxJsonDepth)) {
      return rejected(
        'invalid_state',
        `Resulting state nests deeper than ${limits.maxJsonDepth} levels`,
        declaredActions,
      );
    }
    try {
      const stateCheck = validateAgainstAppletSchema({
        schema: definition.stateSchema,
        cacheKey: `${record.instance.definitionHash}#state`,
        data: nextState,
      });
      if (!stateCheck.valid) {
        return rejected(
          'invalid_state',
          'Resulting state does not match the stateSchema',
          declaredActions,
          stateCheck.errors,
        );
      }
    } catch (err) {
      if (err instanceof AppletSchemaSafetyError) {
        return rejected('invalid_schema', err.message, declaredActions);
      }
      throw err;
    }

    const seq = await tx.nextSeq(instanceId);
    const afterVersion = await tx.writeSnapshot(record.instance, nextState);
    const receipt: AppletActionReceipt = {
      actionId: command.actionId,
      seq,
      actor,
      name: action.name,
      input: command.input,
      beforeVersion: record.stateVersion,
      afterVersion,
      patch,
      ...(command.outcome !== undefined ? { outcome: command.outcome } : {}),
      effects: { notable: action.notable, waking: action.wakes, ending: action.ends },
      at: new Date().toISOString(),
    };
    const effectDeliveries: AppletEffectDelivery[] = [];
    if (action.notable) effectDeliveries.push({ effect: 'notable', status: 'pending' });
    if (action.wakes) effectDeliveries.push({ effect: 'waking', status: 'pending' });
    await tx.appendJournalEntry({ instanceId, receipt, effectDeliveries });
    await tx.touchInstance(instanceId, action.ends ? { status: 'ended' } : {});

    return {
      status: 'applied' as const,
      receipt,
      state: nextState,
      stateVersion: afterVersion,
      replayed: false,
    };
  });
}

function rejected(
  reason: AppletCommandRejectionReason,
  message: string,
  availableActions: string[],
  validation?: string[],
): ApplyAppletCommandResult {
  return {
    status: 'rejected',
    reason,
    message,
    availableActions,
    ...(validation !== undefined ? { validation } : {}),
  };
}

/**
 * The [[260]] Phase 1A idempotency rule: an exact retry replays, the same key
 * with a different payload is refused. `baseVersion` is deliberately excluded
 * — a template rebase records a different beforeVersion than the command
 * asserted, and replaying with any baseVersion is a safe no-op.
 */
function isExactReplay(
  command: AppletCommand,
  receipt: AppletActionReceipt,
  definition: AppletDefinition,
): boolean {
  if (command.name !== receipt.name) return false;
  if (canonicalJsonStringify(command.input) !== canonicalJsonStringify(receipt.input)) return false;
  if ((command.outcome ?? null) !== (receipt.outcome ?? null)) return false;
  const action = resolveAppletActionOrNull(definition, receipt.name);
  const actorSupplied = action !== null && action.patch === ACTOR_SUPPLIED_PATCH;
  // For actor-supplied actions the applied patch is the proposedPatch
  // verbatim; template commands carry none, so nothing further to compare.
  if (actorSupplied) {
    return (
      canonicalJsonStringify(command.proposedPatch ?? null) ===
      canonicalJsonStringify(receipt.patch)
    );
  }
  return command.proposedPatch === undefined;
}

function resolveAppletActionOrNull(definition: AppletDefinition, name: string) {
  try {
    return resolveAppletAction(definition, name);
  } catch {
    return null;
  }
}
