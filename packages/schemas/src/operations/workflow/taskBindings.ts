import { z } from 'zod';

// ============================================================================
// Task Input Binding Schema (104j §6.2)
// ============================================================================

/**
 * Declarative binding for a task input field.
 *
 * Discriminated union over `kind` — each variant declares where the
 * value comes from. The Driver resolves bindings at task-launch time
 * and overlays them onto `task.inputs`.
 */
export const WorkflowTaskInputBindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run_input'),
    /** Dot path into the run input object (e.g. "goal" or "rationale.notes"). */
    path: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('task_output'),
    /** Task ID of the upstream producer. Must be in dependsOn closure. */
    taskId: z.string().min(1).max(64),
    /** Dot path into the task's structured output. Absent = whole output. */
    path: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('task_summary'),
    /** Task ID of the upstream producer. Must be in dependsOn closure. */
    taskId: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('campaign_input'),
    /** Dot path into the campaign config (e.g. "competitionSlug"). The head
     *  segment must name a declared campaign-contract field. */
    path: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('system_feedback'),
  }),
  z.object({
    /** Resolves to the run's single pinned GitHub connection (an
     *  `api_bindings.bindingId`). No args — the campaign identity is one repo
     *  on one connection. The api executor pins this exact binding instead of
     *  scope-resolving an arbitrary GitHub account. */
    kind: z.literal('connection_binding'),
  }),
  z.object({
    /** Resolves to the task-targeted active learning set for the run's
     *  skill (and campaign, when one is bound), rendered as a compact
     *  text block — one `- [category] observation → recommendation` line
     *  per learning, trajectory line first; `''` when the set is empty.
     *  Platform-resolved at dispatch; no args. */
    kind: z.literal('learning_set'),
  }),
  z.object({
    kind: z.literal('artifact_binding'),
    /** Bundle that ships the artifact seed. Authored explicitly on
     *  the workflow task (the install-time `artifact_bindings` PK is
     *  `(spaceId, bundleId, bindingId)`). */
    bundleId: z.string().min(1).max(128),
    /** Stable binding identifier within the bundle. Matches the
     *  `bindingId` on a `BundleArtifactSeed` and the manifest's
     *  `uiOutput.bindingId`. */
    bindingId: z.string().min(1).max(128),
  }),
]);
export type WorkflowTaskInputBinding = z.infer<typeof WorkflowTaskInputBindingSchema>;

// ============================================================================
// Task Output Promotion Schema (104j §6.3)
// ============================================================================

/**
 * Declares how a task's output is promoted into workflow-run state.
 *
 * Discriminated union over `kind` — each variant declares what to
 * extract and which state variable to write it to.
 */
export const WorkflowTaskOutputPromotionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('output_root'),
    /** State variable to write the whole structured task output into. */
    toState: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('output_path'),
    /** Dot path within the structured output. */
    path: z.string().min(1).max(200),
    /** State variable to write the extracted value into. */
    toState: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('metric'),
    /** Metric key within the task's metrics object. */
    metric: z.string().min(1).max(64),
    /** State variable to write the metric value into. */
    toState: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('task_summary'),
    /** State variable to write the task's prose summary into. */
    toState: z.string().min(1).max(64),
  }),
]);
export type WorkflowTaskOutputPromotion = z.infer<typeof WorkflowTaskOutputPromotionSchema>;
