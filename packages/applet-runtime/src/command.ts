/**
 * Pure command-pipeline steps: resolve the declared action, then produce the
 * bounded /state-confined patch the gateway will apply — materialized for
 * template actions, bounded actor-supplied otherwise. Whoever acts computes
 * the change; the platform never does.
 */
import {
  ACTOR_SUPPLIED_PATCH,
  RAW_PATCH_ACTION,
  RAW_PATCH_ACTION_NAME,
  resolveAppletLimits,
  type AppletAction,
  type AppletCommand,
  type AppletDefinition,
  type AppletLimits,
  type AppletStatePatchOp,
} from '@aflow/schemas';
import { AppletCommandError } from './errors.js';
import { boundAppletStatePatch } from './patchBounds.js';
import { materializeAppletTemplatePatch } from './template.js';

/** The declared surface: every definition action plus the built-in raw_patch. */
export function availableActionNames(definition: AppletDefinition): string[] {
  return [...definition.actions.map((action) => action.name), RAW_PATCH_ACTION_NAME];
}

export function resolveAppletAction(definition: AppletDefinition, name: string): AppletAction {
  if (name === RAW_PATCH_ACTION_NAME) return RAW_PATCH_ACTION;
  const action = definition.actions.find((candidate) => candidate.name === name);
  if (action === undefined) {
    throw new AppletCommandError(
      'unknown_action',
      `No declared action '${name}'`,
      availableActionNames(definition),
    );
  }
  return action;
}

/**
 * Produce the patch a command will apply, bounded. Template actions must not
 * carry proposedPatch (the platform materializes from input alone);
 * actor_supplied actions must (the actor computed the change).
 */
export function resolveCommandPatch(
  action: AppletAction,
  command: AppletCommand,
  limits: AppletLimits = resolveAppletLimits(),
): AppletStatePatchOp[] {
  if (action.patch === ACTOR_SUPPLIED_PATCH) {
    if (command.proposedPatch === undefined) {
      throw new AppletCommandError(
        'patch_required',
        `Action '${action.name}' is actor-supplied — the command must carry proposedPatch`,
      );
    }
    boundAppletStatePatch(command.proposedPatch, limits);
    return command.proposedPatch;
  }
  if (command.proposedPatch !== undefined) {
    throw new AppletCommandError(
      'patch_forbidden',
      `Action '${action.name}' is a template action — the platform materializes its patch`,
    );
  }
  const materialized = materializeAppletTemplatePatch(action.patch.template, command.input);
  boundAppletStatePatch(materialized, limits);
  return materialized;
}
