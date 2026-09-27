/**
 * The applet definition — versioned, immutable once published, emitted by the
 * generation call alongside the view code and colocated with it on the
 * artifact version. The contract travels with the artifact and is resolved at
 * use time, never injected as prose into a system prompt.
 */
import { z } from 'zod';
import {
  AppletActionGuardSchema,
  AppletActionPatchSchema,
  AppletJsonPointerSchema,
} from './patch.js';
import {
  APPLET_MAX_ACTIONS,
  APPLET_MAX_ROLES,
  APPLET_OUTCOME_MAX_LENGTH,
  APPLET_PROJECTION_MAX_POINTERS,
  APPLET_RECENT_ACTIONS_DEFAULT,
  APPLET_RECENT_ACTIONS_MAX,
  AppletLimitOverridesSchema,
} from './limits.js';

// ============================================================================
// Identifiers
// ============================================================================

export const AppletKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)
  .describe("Stable applet handle, e.g. 'chess', 'campaign-board'");
export type AppletKey = z.infer<typeof AppletKeySchema>;

/** Action names become lowered tool names (`<appletKey>.<action>`) — snake_case. */
export const AppletActionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/)
  .describe("Declared action name, e.g. 'move', 'set_budget'");
export type AppletActionName = z.infer<typeof AppletActionNameSchema>;

export const AppletRoleIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/)
  .describe("Applet role id, e.g. 'white', 'reviewer'");
export type AppletRoleId = z.infer<typeof AppletRoleIdSchema>;

/** Labels for people, not permissions — the platform never consults them. */
export const AppletRoleSchema = z.object({
  id: AppletRoleIdSchema,
  description: z.string().min(1).max(500),
});
export type AppletRole = z.infer<typeof AppletRoleSchema>;

// ============================================================================
// Actions
// ============================================================================

/** A hint for surfacing, not a gate — either actor may use any action. */
export const AppletActionAudienceSchema = z.enum(['human', 'agent', 'both']);
export type AppletActionAudience = z.infer<typeof AppletActionAudienceSchema>;

export const AppletActionSchema = z.object({
  name: AppletActionNameSchema,
  /** Rendered as a button label AND read by the agent. */
  description: z.string().min(1).max(500),
  whenToUse: z.array(z.string().min(1).max(500)).max(5).optional(),
  pitfalls: z.array(z.string().min(1).max(500)).max(5).optional(),
  inputSchema: z
    .record(z.unknown())
    .describe('JSON Schema for the action input — bounded by the applet schema safety limits'),
  patch: AppletActionPatchSchema,
  /** Declarative pre-apply assertion against current state — see AppletActionGuardSchema. */
  guard: AppletActionGuardSchema.optional(),
  audience: AppletActionAudienceSchema.default('both'),
  /** Post an attributed room message into the bound room. */
  notable: z.boolean().default(false),
  /** Ask the agent to act now. */
  wakes: z.boolean().default(false),
  /** Structural: the platform flips instance status to 'ended' without knowing why. */
  ends: z.boolean().default(false),
});
export type AppletAction = z.infer<typeof AppletActionSchema>;
export type AppletActionInput = z.input<typeof AppletActionSchema>;

// ============================================================================
// Built-in raw_patch — P5's escape hatch, declared once by the platform
// ============================================================================

export const RAW_PATCH_ACTION_NAME = 'raw_patch';

export const RAW_PATCH_ACTION: AppletAction = {
  name: RAW_PATCH_ACTION_NAME,
  description:
    'Apply a free-form RFC 6902 patch to state when no declared action covers the change',
  pitfalls: [
    'Prefer a declared action when one fits — raw_patch skips the shared verb vocabulary, never the journal',
    'The patch is actor-supplied: compute it against the version you just read',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        maxLength: APPLET_OUTCOME_MAX_LENGTH,
        description: 'What this change does, in the words of whoever made it',
      },
    },
    additionalProperties: false,
  },
  patch: 'actor_supplied',
  audience: 'both',
  notable: false,
  wakes: false,
  ends: false,
};

// ============================================================================
// Definition
// ============================================================================

/**
 * Pointers the platform reads without understanding them — the attention
 * builder cannot know which state path means "whose turn" without domain
 * knowledge, so the definition declares it.
 */
export const AppletAttentionProjectionSchema = z.object({
  title: AppletJsonPointerSchema.optional(),
  status: AppletJsonPointerSchema.optional(),
  waitingOn: AppletJsonPointerSchema.optional(),
});
export type AppletAttentionProjection = z.infer<typeof AppletAttentionProjectionSchema>;

// ============================================================================
// Agent grid view — a spatial state map rendered as text for the agent
// ============================================================================

/**
 * Declarative rendering of a cell-map state member as a labeled text grid.
 * The agent never runs the view, so a spatial applet (a board, a field, a
 * seating chart) declares how its map reads as rows and columns; the read
 * path materializes it fresh from current state — never cached, never stale.
 */
export const AppletAgentGridSchema = z.object({
  /** State pointer to the object holding one entry per cell. */
  mapPath: AppletJsonPointerSchema,
  /** Rendered top to bottom. */
  rowLabels: z.array(z.string().min(1).max(8)).min(1).max(26),
  /** Rendered left to right. */
  colLabels: z.array(z.string().min(1).max(8)).min(1).max(26),
  /** How a cell's map key is composed from its labels. */
  keyOrder: z.enum(['colRow', 'rowCol']).default('colRow'),
  /** Rendered for a cell whose entry is missing or ''. */
  emptyAs: z.string().min(1).max(4).default('.'),
  /** One line rendered under the grid explaining the cell symbols. */
  legend: z.string().max(300).optional(),
});
export type AppletAgentGrid = z.infer<typeof AppletAgentGridSchema>;

export const AppletDefinitionSchema = z
  .object({
    appletKey: AppletKeySchema,
    version: z.number().int().positive(),
    name: z.string().min(1).max(256),
    description: z.string().max(4000),
    /** Agent-facing: what this object IS and is for. */
    semanticDescription: z.string().min(1).max(4000),
    /** JSON Schema — well-formedness only. An unwise state is a valid state. */
    stateSchema: z.record(z.unknown()),
    /** The state an instance is born with — validated against stateSchema. */
    initialState: z.record(z.unknown()),
    /** Bounded view for the agent. Default: full state. */
    agentProjection: z
      .array(AppletJsonPointerSchema)
      .min(1)
      .max(APPLET_PROJECTION_MAX_POINTERS)
      .optional(),
    roles: z.array(AppletRoleSchema).min(1).max(APPLET_MAX_ROLES).optional(),
    /** Affordances for humans AND agent. `raw_patch` is built in — never declared here. */
    actions: z.array(AppletActionSchema).min(1).max(APPLET_MAX_ACTIONS),
    attentionProjection: AppletAttentionProjectionSchema.optional(),
    /** Renders state as a labeled text grid in agent-facing reads — see AppletAgentGridSchema. */
    agentGrid: AppletAgentGridSchema.optional(),
    /**
     * State pointers rendered as labeled lines in the turn-boundary situation
     * block — the applet's declaration of what a summoned agent must see
     * beyond the grid and receipts. Dereferenced fresh at assembly, values
     * clamped, never enforced.
     */
    situationProjection: z.array(AppletJsonPointerSchema).min(1).max(12).optional(),
    /** Receipts projected into a read. */
    recentActionsLimit: z
      .number()
      .int()
      .positive()
      .max(APPLET_RECENT_ACTIONS_MAX)
      .default(APPLET_RECENT_ACTIONS_DEFAULT),
    limits: AppletLimitOverridesSchema.optional(),
  })
  .superRefine((definition, ctx) => {
    const actionNames = new Set<string>();
    definition.actions.forEach((action, index) => {
      if (action.name === RAW_PATCH_ACTION_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'name'],
          message: `'${RAW_PATCH_ACTION_NAME}' is built in — every applet already carries it`,
        });
      }
      if (actionNames.has(action.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'name'],
          message: `Duplicate action name '${action.name}'`,
        });
      }
      actionNames.add(action.name);
    });
    const roleIds = new Set<string>();
    (definition.roles ?? []).forEach((role, index) => {
      if (roleIds.has(role.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles', index, 'id'],
          message: `Duplicate role id '${role.id}'`,
        });
      }
      roleIds.add(role.id);
    });
  });
export type AppletDefinition = z.infer<typeof AppletDefinitionSchema>;
export type AppletDefinitionInput = z.input<typeof AppletDefinitionSchema>;
