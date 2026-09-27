/**
 * ui.applet.* operations — the agent's gateway to stateful applets.
 *
 * One write path (act), one projection-aware read (get), instantiation as the
 * sanctioned publish path, and the space listing behind the attention
 * overflow pointer. Generic memory operations on the reserved prefix are
 * refused — every mutation enters through the gateway.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { buildGroupId, buildOperationId } from '../catalog/operationId.js';
import { StepOutputPresentationSchema } from '../runtime/stepPresentation.js';
import {
  UiArtifactDraftIdSchema,
  UiArtifactIdSchema,
  UiArtifactVersionIdSchema,
} from '../operations/ui.js';
import { AppletActionNameSchema, AppletKeySchema, AppletRoleIdSchema } from './definition.js';
import {
  AppletCommandSchema,
  AppletActionReceiptAgentViewSchema,
  AppletStateVersionSchema,
} from './command.js';
import {
  AppletInstanceAgentViewSchema,
  AppletInstanceIdSchema,
  AppletInstanceStatusSchema,
  AppletInstanceSummarySchema,
} from './instance.js';

// ============================================================================
// Derived identifiers
// ============================================================================

export const UI_APPLET_CAPABILITY_GROUP_ID = buildGroupId('ui', 'applet');

export const UI_APPLET_INSTANTIATE_OPERATION_ID = buildOperationId('ui', 'applet', 'instantiate');
export const UI_APPLET_GET_OPERATION_ID = buildOperationId('ui', 'applet', 'get');
export const UI_APPLET_ACT_OPERATION_ID = buildOperationId('ui', 'applet', 'act');
export const UI_APPLET_LIST_OPERATION_ID = buildOperationId('ui', 'applet', 'list');

// ============================================================================
// ui.applet.instantiate
// ============================================================================

export const UiAppletInstantiateInputSchema = z
  .object({
    artifactId: UiArtifactIdSchema.optional().describe(
      'Latest published version of this applet artifact',
    ),
    versionId: UiArtifactVersionIdSchema.optional().describe('Exact published artifact version'),
    draftId: UiArtifactDraftIdSchema.optional().describe(
      'Draft to publish and instantiate in one step — instantiation is the sanctioned publish path',
    ),
    roleBindings: z
      .array(z.object({ userId: z.string().uuid(), roleId: AppletRoleIdSchema }))
      .max(32)
      .optional()
      .describe('Initial participant role assignments'),
  })
  .superRefine((input, ctx) => {
    const sources = [input.artifactId, input.versionId, input.draftId].filter(
      (source) => source !== undefined,
    );
    if (sources.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one of artifactId, versionId, or draftId is required',
      });
    }
  });
export type UiAppletInstantiateInput = z.infer<typeof UiAppletInstantiateInputSchema>;

export const UiAppletInstantiateOutputSchema = z.object({
  instance: AppletInstanceAgentViewSchema,
  /** The birthed initialState, validated against the pinned stateSchema. */
  state: z.record(z.unknown()),
  stateVersion: AppletStateVersionSchema,
  presentation: StepOutputPresentationSchema.optional(),
});
export type UiAppletInstantiateOutput = z.infer<typeof UiAppletInstantiateOutputSchema>;

// ============================================================================
// ui.applet.get
// ============================================================================

export const UiAppletGetInputSchema = z.object({
  instanceId: AppletInstanceIdSchema,
});
export type UiAppletGetInput = z.infer<typeof UiAppletGetInputSchema>;

export const UiAppletGetOutputSchema = z.object({
  instance: AppletInstanceAgentViewSchema,
  /** Current state bounded by the definition's agentProjection. */
  state: z.record(z.unknown()),
  stateVersion: AppletStateVersionSchema,
  /** Most recent receipts, oldest first, bounded by recentActionsLimit — patches dropped. */
  recentReceipts: z.array(AppletActionReceiptAgentViewSchema),
  /** Declared action names usable by the caller — the declared surface, never domain legality. */
  availableActions: z.array(AppletActionNameSchema),
  /** Who holds which declared role — labels for people, never permissions. */
  roleBindings: z.array(z.object({ userId: z.string().uuid(), roleId: AppletRoleIdSchema })),
  /** The definition's agentGrid rendered from current state — the board as text. */
  gridView: z.string().optional(),
  /** The declared situationProjection pointers rendered as labeled lines. */
  situation: z.string().optional(),
  presentation: StepOutputPresentationSchema.optional(),
});
export type UiAppletGetOutput = z.infer<typeof UiAppletGetOutputSchema>;

// ============================================================================
// ui.applet.act
// ============================================================================

/** The command envelope plus the instance it targets — server-stamped fields (actor, seq, at) never appear here. */
export const UiAppletActInputSchema = AppletCommandSchema.extend({
  instanceId: AppletInstanceIdSchema,
});
export type UiAppletActInput = z.infer<typeof UiAppletActInputSchema>;

export const UiAppletActOutputSchema = z.object({
  receipt: AppletActionReceiptAgentViewSchema,
  stateVersion: AppletStateVersionSchema,
  /** The definition's agentGrid rendered from the state the action produced. */
  gridView: z.string().optional(),
  presentation: StepOutputPresentationSchema.optional(),
});
export type UiAppletActOutput = z.infer<typeof UiAppletActOutputSchema>;

// ============================================================================
// ui.applet.list
// ============================================================================

export const UiAppletListInputSchema = z.object({
  status: AppletInstanceStatusSchema.optional().describe("Defaults to 'active'"),
  appletKey: AppletKeySchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
  cursor: z.string().optional(),
});
export type UiAppletListInput = z.infer<typeof UiAppletListInputSchema>;

export const UiAppletListOutputSchema = z.object({
  instances: z.array(AppletInstanceSummarySchema),
  nextCursor: z.string().optional(),
  total: z.number().int().nonnegative(),
});
export type UiAppletListOutput = z.infer<typeof UiAppletListOutputSchema>;

// ============================================================================
// Registrations
// ============================================================================

export const AppletOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'ui',
    group: 'applet',
    verb: 'instantiate',
    name: 'Instantiate Applet',
    actionLabel: 'Instantiating applet…',
    groupDisplayName: 'Stateful Applets',
    groupDescription:
      'Durable shared work items with declared actions, operated by people and agents together.',
    semanticDescription:
      'Create a live instance of a stateful applet from a published artifact version — or publish ' +
      "a draft and instantiate it in one step. Births the instance with the definition's " +
      'initialState (validated against its stateSchema), pins the definition (hash + artifact ' +
      'version), and binds the originating session as its room. The instance outlives every ' +
      'session it is ever bound to.',
    tags: ['ui', 'applet', 'instantiate'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Create a durable, shared applet instance from an applet artifact.',
      whenToUse: [
        'Starting a shared work item (a board, a game, a review) people and the agent will operate together',
        'Turning a generated applet draft into a durable instance — instantiation publishes the draft',
      ],
      whenNotToUse: [
        'Rendering a one-off document — use ui.artifact.render instead',
        'Acting on an existing instance — use ui.applet.act instead',
      ],
      pitfalls: [
        'Instances are durable — check ui.applet.list before creating a second instance for the same work',
        'The artifact must be an applet (it carries a definition); plain artifacts cannot be instantiated',
      ],
      minimalExampleInput: {
        artifactId: '550e8400-e29b-41d4-a716-446655440000',
      },
      followUp: [
        {
          operationId: UI_APPLET_ACT_OPERATION_ID,
          note: 'Operate the instance through its declared actions',
        },
      ],
    },
    accessMode: 'write',
    inputZod: UiAppletInstantiateInputSchema,
    outputZod: UiAppletInstantiateOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'applet',
    verb: 'get',
    name: 'Get Applet Instance',
    actionLabel: 'Reading applet…',
    semanticDescription:
      'Projection-aware read of an applet instance: the current state bounded by the ' +
      "definition's agentProjection, plus the most recent action receipts (who did what, and how " +
      'it turned out) and the state version — what the object is now and what just happened, in ' +
      'one read.',
    tags: ['ui', 'applet', 'read'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Read an applet instance: projected state + recent receipts + version.',
      whenToUse: [
        'Before acting on an instance — the returned stateVersion is the baseVersion for the next command',
        'Catching up on what other participants did since the last turn',
        'After a version conflict, to recompute against the current state',
      ],
      whenNotToUse: ['Browsing which instances exist — use ui.applet.list instead'],
      pitfalls: ['Receipt outcomes are applet-reported content, not platform authority'],
      minimalExampleInput: {
        instanceId: '550e8400-e29b-41d4-a716-446655440000',
      },
    },
    accessMode: 'read',
    inputZod: UiAppletGetInputSchema,
    outputZod: UiAppletGetOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'applet',
    verb: 'act',
    name: 'Act on Applet',
    actionLabel: 'Applying action…',
    semanticDescription:
      'Apply a declared action (or the built-in raw_patch) to an applet instance through the ' +
      'single write gateway. The command carries a client-minted actionId (idempotency key — ' +
      'replaying it returns the original receipt) and the baseVersion it was computed against. ' +
      "The platform validates input against the action's schema, materializes template patches " +
      'or bounds actor-supplied ones, confines the change to /state, serializes on the instance, ' +
      "records the receipt, and relays the action's declared effects. It never judges whether " +
      'the change was legal, wise, or fair.',
    tags: ['ui', 'applet', 'act'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Apply a declared action to an applet instance and get the receipt back.',
      whenToUse: [
        'Acting on the shared item as a participant — moves, edits, approvals, status changes',
        'Free-form state edits via the raw_patch action, through the gateway rather than around it',
      ],
      whenNotToUse: [
        'Reading state — use ui.applet.get instead',
        'Creating a new instance — use ui.applet.instantiate instead',
      ],
      pitfalls: [
        'Template actions must not carry proposedPatch; actor_supplied actions must — whoever acts computes the change',
        'On a version conflict, re-read with ui.applet.get and recompute — never blindly retry with the same baseVersion',
        'For actor_supplied actions the patch is authoritative and input is descriptive; keep them consistent',
      ],
      minimalExampleInput: {
        instanceId: '550e8400-e29b-41d4-a716-446655440000',
        actionId: '6f1e0f5a-1c2b-4d3e-8f4a-5b6c7d8e9f0a',
        baseVersion: 4,
        name: 'set_budget',
        input: { amount: 40000 },
      },
      followUp: [
        {
          operationId: UI_APPLET_GET_OPERATION_ID,
          note: 'Re-read after a version conflict before recomputing the command',
        },
      ],
    },
    accessMode: 'write',
    inputZod: UiAppletActInputSchema,
    outputZod: UiAppletActOutputSchema,
  },
  {
    stepType: 'ui',
    group: 'applet',
    verb: 'list',
    name: 'List Applet Instances',
    actionLabel: 'Listing applets…',
    semanticDescription:
      'List applet instances in the space with lifecycle status, last receipt, state version, ' +
      "and the definition's declared attention fields (title, status, waitingOn) read without " +
      'interpretation. Defaults to active instances — the long tail behind the bounded attention ' +
      'section.',
    tags: ['ui', 'applet', 'list'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Browse applet instances in the space (active by default).',
      whenToUse: [
        'Finding a live instance to focus or act on when none is in focus',
        'Checking for an existing instance before instantiating a new one',
        'Following the attention overflow pointer',
      ],
      whenNotToUse: ['Reading one known instance — use ui.applet.get instead'],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: UiAppletListInputSchema,
    outputZod: UiAppletListOutputSchema,
  },
];
