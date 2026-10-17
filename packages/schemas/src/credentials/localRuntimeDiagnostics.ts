/**
 * What is wrong with a space's models on this computer and what fixes it
 * (Plan 323 D15). One record, computed by `diagnoseLocalRuntime`, read by
 * readiness, the models surface and Helmsman alike, so the same fault is
 * described in the same words everywhere and its fix is the same action.
 */
import { z } from 'zod';

/** The roles a space assigns a model to, as readiness reports them. */
export const LOCAL_MODEL_ROLES = ['default', 'helmsman', 'runner', 'coach', 'judge'] as const;
export const LocalModelRoleSchema = z.enum(LOCAL_MODEL_ROLES);
export type LocalModelRole = z.infer<typeof LocalModelRoleSchema>;

const model = z.string().min(1).describe('The catalog id of a model on this computer.');

const pull = z
  .object({ action: z.literal('pull'), model })
  .describe('Download a model to this computer.');
const remove = z
  .object({ action: z.literal('delete'), model })
  .describe('Delete a downloaded model from this computer, freeing its disk.');
const warm = z
  .object({ action: z.literal('warm'), model })
  .describe('Load a model now, at the window its requests use.');
const unload = z
  .object({ action: z.literal('unload'), model })
  .describe(
    'Unload a model, freeing its memory and every conversation it holds. Runs using it reload it on their next turn.',
  );
const setContext = z
  .object({
    action: z.literal('set_context'),
    contextTokens: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe('The window every request gets, or null for the largest that fits the machine.'),
  })
  .describe("Set the context window on the space's Ollama connection.");
const useForEveryRole = z
  .object({ action: z.literal('use_for_every_role'), model })
  .describe('Assign one model to every role, so the runtime never switches models between them.');

/**
 * The changes to the runtime itself, which Helmsman may propose for approval.
 * A role's model is not among them: it is the space's setting, written where
 * every role is set at once.
 */
export const LocalRuntimeChangeSchema = z.discriminatedUnion('action', [
  pull,
  remove,
  warm,
  unload,
  setContext,
]);
export type LocalRuntimeChange = z.infer<typeof LocalRuntimeChangeSchema>;

/**
 * Every change the platform can make to a space's local runtime. An issue's
 * remedy names one with its arguments filled in; the operator runs it from the
 * issue's card, and Helmsman proposes the runtime changes for approval.
 */
export const LocalModelActionSchema = z.discriminatedUnion('action', [
  pull,
  remove,
  warm,
  unload,
  setContext,
  useForEveryRole,
]);
export type LocalModelAction = z.infer<typeof LocalModelActionSchema>;

export const LocalRuntimeRemedySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('action'),
    action: LocalModelActionSchema,
    label: z.string().describe('What the action does, as its button says it.'),
  }),
  z.object({
    kind: z.literal('instruction'),
    text: z.string().describe('What the operator does where nothing in Aflow can fix it.'),
  }),
]);
export type LocalRuntimeRemedy = z.infer<typeof LocalRuntimeRemedySchema>;

export const LocalRuntimeIssueCodeSchema = z.enum([
  /** The runtime does not answer at the connection's URL. */
  'runtime_unreachable',
  /** A role is assigned a model the runtime has not downloaded. */
  'model_not_installed',
  /** Even the agents' smallest window spills past the GPU. */
  'window_does_not_fit',
  /** The model fits the GPU, but with everything else running the machine will swap. */
  'window_tight',
  /** A loaded model has grown past the GPU, holding every conversation's cache. */
  'model_spilling',
  /** Part of a loaded model runs on the CPU. */
  'model_partly_on_cpu',
  /** The downloaded build is not the one the catalog entry measured. */
  'build_unverified',
  /** Roles use different models, and each switch between them reloads. */
  'mixed_local_models',
]);
export type LocalRuntimeIssueCode = z.infer<typeof LocalRuntimeIssueCodeSchema>;

export const LocalRuntimeIssueSchema = z.object({
  code: LocalRuntimeIssueCodeSchema,
  /** `error` stops a role from running; the others slow it or cost the operator something. */
  severity: z.enum(['error', 'warning', 'info']),
  model: model.optional(),
  cause: z.string().describe('What is wrong, with the numbers that show it.'),
  remedy: LocalRuntimeRemedySchema,
});
export type LocalRuntimeIssue = z.infer<typeof LocalRuntimeIssueSchema>;

export const LocalModelFitStatusSchema = z.enum(['fits', 'tight', 'does_not_fit', 'unknown']);

export const LocalModelPullSchema = z.object({
  status: z.enum(['downloading', 'interrupted', 'failed']),
  completedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable(),
  /** What the runtime last said: a layer's digest, `verifying`, `writing manifest`. */
  detail: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
});
export type LocalModelPull = z.infer<typeof LocalModelPullSchema>;

export const LocalModelDiagnosisSchema = z.object({
  model,
  /** What a role assignment stores for this model: its alias where it has one, since an id names one version. */
  ref: z.string(),
  tag: z.string(),
  displayName: z.string(),
  installed: z.boolean(),
  /** The download's size: what `/api/tags` reports once installed, the catalog's measure before. */
  downloadBytes: z.number().nullable(),
  roles: z.array(LocalModelRoleSchema),
  fit: z.object({
    status: LocalModelFitStatusSchema,
    window: z.number().int(),
    largestFittingWindow: z.number().int().nullable(),
    bytesAtWindow: z.number().nullable(),
  }),
  /** What the runtime holds now, or null when the model is not loaded. */
  loaded: z
    .object({
      sizeBytes: z.number(),
      /** The part on the GPU; below `sizeBytes` the rest runs on the CPU. */
      gpuBytes: z.number().nullable(),
      contextLength: z.number().nullable(),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
  /** `verified` when the installed build is the one measured; `unmeasured` before it is installed. */
  build: z.enum(['verified', 'unverified', 'unmeasured']),
  pull: LocalModelPullSchema.nullable(),
});
export type LocalModelDiagnosis = z.infer<typeof LocalModelDiagnosisSchema>;

export const LocalRuntimeDiagnosticsSchema = z.object({
  runtime: z.object({
    baseUrl: z.string(),
    reachable: z.boolean(),
    version: z.string().nullable(),
  }),
  machine: z
    .object({
      totalMemoryBytes: z.number(),
      gpuWorkingSetBytes: z.number().nullable(),
      freeDiskBytes: z.number().nullable(),
    })
    .nullable(),
  connection: z.object({
    /** The window the operator set, or null for the largest that fits. */
    contextTokens: z.number().int().nullable(),
    keepAlive: z.string().nullable(),
    parallel: z.number().int(),
  }),
  /** The lineup's models and any role's model, installed or not. */
  models: z.array(LocalModelDiagnosisSchema),
  issues: z.array(LocalRuntimeIssueSchema),
});
export type LocalRuntimeDiagnostics = z.infer<typeof LocalRuntimeDiagnosticsSchema>;
