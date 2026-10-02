import { z } from 'zod';
import { SkillDiagnosticSchema } from '../cybernetic/skillValidity.js';
import { InstalledAppletSummarySchema } from '../applet/installed.js';
import { HostPublishedChecksSchema, HostPushApprovalSchema } from '../operations/host.js';

// ============================================================================

/** Network egress policy for sandboxed code execution containers. */
export const ComputeNetworkPolicySchema = z.object({
  mode: z.enum(['blocked', 'allowlist']).default('blocked'),
  allowedHosts: z.array(z.string().max(256)).max(50).optional(),
});

/** Resource limits for sandboxed code execution containers. */
export const ComputeResourceLimitsSchema = z.object({
  maxCpus: z.number().positive().max(4).default(2),
  maxMemoryMb: z.number().int().positive().max(8192).default(4096),
  maxExecutionSeconds: z.number().int().positive().max(3600).default(300),
});

export const ComputeWorkspacePolicySchema = z.object({
  enabled: z.boolean().default(true),
  /** Hard cap on total workspace bytes, regardless of agent request. */
  maxBytes: z.number().int().positive().max(10_737_418_240).default(1_073_741_824),
  /** Hard cap on per-file bytes. */
  maxFileBytes: z.number().int().positive().max(1_073_741_824).default(268_435_456),
  /** Hard cap on file count. */
  maxFileCount: z.number().int().positive().max(100_000).default(10_000),
});

export const ComputeSessionPolicySchema = z.object({
  enabled: z.boolean().default(false),
  maxIdleTtlSeconds: z.number().int().positive().max(7200).default(3600),
  maxCheckpointTtlSeconds: z.number().int().positive().max(259200).default(86400),
  maxSessionLifetimeSeconds: z.number().int().positive().max(14400).default(7200),
  maxCheckpointSizeBytes: z.number().int().positive().max(500_000_000).default(100_000_000),
  maxConcurrentSessions: z.number().int().positive().max(10).default(3),
  workspace: ComputeWorkspacePolicySchema.optional(),
});

/**
 * Space-level compute policy — controls sandboxed code execution.
 * Stored as `compute_policy` JSONB on the `spaces` table.
 * Compute is opt-in: disabled by default per space.
 */
export const SpaceComputePolicySchema = z.object({
  enabled: z.boolean().default(false),
  networkEgress: ComputeNetworkPolicySchema.default({ mode: 'blocked' }),
  resources: ComputeResourceLimitsSchema.optional(),
  maxConcurrentContainers: z.number().int().positive().max(20).default(5),
  sessions: ComputeSessionPolicySchema.optional(),
});

export type SpaceComputePolicy = z.infer<typeof SpaceComputePolicySchema>;

/**
 * Space-level coding-lane policy — controls whether the lane may run here at
 * all. Stored as `code_policy` JSONB on the `spaces` table.
 *
 * Separate from the `code.agent` capability, and stricter. That capability is
 * granted to every Full Access profile, so it answers "may this principal use
 * the lane" and not "has anyone decided this space should have a
 * credential-bearing agent with network egress". Without this flag the lane
 * would arrive switched on everywhere the moment it is deployed.
 *
 * Unlike compute, a new space starts with this OFF.
 */
export const SpaceCodePolicySchema = z.object({
  enabled: z.boolean().default(false),
});

export type SpaceCodePolicy = z.infer<typeof SpaceCodePolicySchema>;

/** Coding-lane policy a new space starts with: off, until an admin decides otherwise. */
export const DEFAULT_SPACE_CODE_POLICY: SpaceCodePolicy = {
  enabled: false,
};

/** Compute policy a new space starts with when the creator specifies none. */
export const DEFAULT_SPACE_COMPUTE_POLICY: SpaceComputePolicy = {
  enabled: true,
  networkEgress: { mode: 'blocked' },
  resources: { maxCpus: 2, maxMemoryMb: 2048, maxExecutionSeconds: 900 },
  maxConcurrentContainers: 5,
};

export type ComputeNetworkPolicy = z.infer<typeof ComputeNetworkPolicySchema>;
export type ComputeResourceLimits = z.infer<typeof ComputeResourceLimitsSchema>;
export type ComputeSessionPolicy = z.infer<typeof ComputeSessionPolicySchema>;
export type ComputeWorkspacePolicy = z.infer<typeof ComputeWorkspacePolicySchema>;

// ============================================================================

/** Named egress preset — a reusable set of approved hosts for common patterns. */
export const EgressPresetSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(500).optional(),
  hosts: z.array(z.string().max(256)).min(1).max(50),
});
export type EgressPreset = z.infer<typeof EgressPresetSchema>;

/**
 * Tenant-level compute defaults — approved hosts and presets available
 * to all spaces in the tenant by default.
 * Stored as `compute_defaults` JSONB on the `tenants` table.
 */
export const TenantComputeDefaultsSchema = z.object({
  /** Hosts approved by default for compute egress across the tenant. */
  approvedHosts: z
    .array(z.string().max(256))
    .max(100)
    .default([])
    .describe('Tenant-wide approved hosts for compute egress.'),
  /** Named egress presets for common integration patterns (e.g., "gcs-upload", "kaggle"). */
  presets: z.array(EgressPresetSchema).max(20).default([]).describe('Reusable named host presets.'),
});
export type TenantComputeDefaults = z.infer<typeof TenantComputeDefaultsSchema>;

// ============================================================================

export const EgressApprovalStatusSchema = z.enum(['pending_approval', 'approved', 'rejected']);
export type EgressApprovalStatus = z.infer<typeof EgressApprovalStatusSchema>;

/**
 * A request for additional compute egress hosts beyond the current approved set.
 * Created by the API Configurator agent or manually by admins.
 * Must be explicitly approved before the hosts become active.
 */
export const EgressApprovalRequestSchema = z.object({
  /** Unique request ID. */
  requestId: z.string().uuid(),
  /** Hosts being requested. */
  requestedHosts: z.array(z.string().max(256)).min(1).max(50),
  /** Target scope: tenant-wide or a specific space. */
  scope: z.enum(['tenant', 'space']),
  /** Space ID when scope is 'space'. */
  spaceId: z.string().uuid().optional(),
  /** Who/what created this request (agent name, user email, etc.). */
  requestedBy: z.string().max(256),
  /** When the request was created. */
  requestedAt: z.string().datetime(),
  /** Context for why these hosts are needed. */
  reason: z.string().max(1000).optional(),
  /** Current status. */
  status: EgressApprovalStatusSchema.default('pending_approval'),
  /** Who reviewed this request. */
  reviewedBy: z.string().max(256).optional(),
  /** When the request was reviewed. */
  reviewedAt: z.string().datetime().optional(),
});
export type EgressApprovalRequest = z.infer<typeof EgressApprovalRequestSchema>;

// ============================================================================
// Space Rules
// ============================================================================

/** A single behavioral directive authored by the space owner. */
export const SpaceRuleSchema = z.object({
  text: z.string().min(1).max(500),
});

export type SpaceRule = z.infer<typeof SpaceRuleSchema>;

/** Ordered array of space rules — stored cap equals the injection cap (`SPACE_CONTEXT_LIMITS.rules`). */
export const SpaceRulesSchema = z.array(SpaceRuleSchema).max(10);

export type SpaceRules = z.infer<typeof SpaceRulesSchema>;

// ============================================================================
// SpaceContext — injected as a context block in agent turns
// ============================================================================

/** Max items per section when building context. */
export const SPACE_CONTEXT_LIMITS = {
  rules: 10,
  memoryDirectories: 25,
  integrations: 15,
  repositories: 15,
  skills: 25,
  applets: 10,
} as const;

/** Cache TTL for SpaceContext in SessionHotState (1 hour). */
export const SPACE_CONTEXT_TTL_MS = 60 * 60 * 1000;

/**
 * The space's memory-map projection injected into agent context. Every field is
 * a parsed, bounded, sanitized derivation of the `/index.md` note — never its
 * raw body. Hooks are control/bidi-stripped and capped to 160 code units at
 * write; the entry list is capped to 50. This is the injection boundary: raw
 * note prose cannot reach the agent as free-form text.
 */
export const SpaceContextIndexNoteSchema = z.object({
  path: z.literal('/index.md'),
  entries: z
    .array(
      z.object({
        path: z.string().max(256),
        hook: z.string().max(160),
        resolved: z.boolean(),
      }),
    )
    .max(50),
  omittedEntries: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
});
export type SpaceContextIndexNote = z.infer<typeof SpaceContextIndexNoteSchema>;

export const SpaceContextMemorySectionSchema = z.object({
  rootDirectories: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
  totalDocuments: z.number().int().nonnegative(),
  totalDirectories: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  indexNote: SpaceContextIndexNoteSchema.optional(),
  guidance: z.string(),
});

export const SpaceContextIntegrationsSectionSchema = z.object({
  items: z.array(
    z.object({
      sourceKind: z.enum(['api', 'mcp']),
      integrationId: z.string(),
      bindingId: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      status: z.enum(['bound', 'needs_credentials', 'disabled']),
      toolCount: z.number().int().min(0),
      credentialStatus: z.enum(['ready', 'missing', 'unpinned', 'expired']).optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
  /** Count of installed-but-unbound integrations hidden from `items`. */
  definitionOnlyCount: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  guidance: z.string(),
});
export type SpaceContextIntegrationsSection = z.infer<typeof SpaceContextIntegrationsSectionSchema>;

/**
 * Ready coding repos (Plan 222 P2) — the agent's picking surface for the `repo`
 * coordinate a coding skill's campaign needs. Only `status='ready'` rows appear;
 * the `code_repo` capability gate (skills.needsSetup) handles "no ready repo", so
 * this is a clean instance list, not the old guidance band-aid. A `repo` here is
 * what the coding skills (open-pr-from-request, review-pull-request, pr-shepherd)
 * take as campaignConfig.repo — never an API binding id (e.g. github-default).
 */
/**
 * Folders on the operator's own machine this space may reach.
 *
 * Context rather than tools: the agent needs to know a folder exists to answer
 * whether it can reach one, while the operations that read it stay on demand
 * and cost nothing until used. The same split integrations already use — the
 * connection is context, the calls are found when needed.
 */
/**
 * Everything armed to start work here without anybody asking.
 *
 * A clock and an inbound event are one thing from the operator's side, so they
 * are one section: what runs on its own. Until now nothing said either existed — not this context, not any page. An operator learned
 * of a daily job by thinking to ask, and the agent learned of it by calling a
 * list operation it had no reason to call. A durable unattended action nobody
 * can see is the part that should feel wrong; the authority is ordinary, because
 * a scheduled run reaches exactly what an interactive one reaches.
 *
 * Listed here so the agent can say what is armed when the operator asks what
 * happens in this space, and can notice that the thing they are describing
 * already runs nightly.
 */
export const SpaceContextTriggersSectionSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** What starts it: a clock, or somebody else's call. */
      kind: z.enum(['schedule', 'webhook']),
      /** Human-readable recurrence, not a cron string nobody reads aloud. */
      recurrence: z.string(),
      nextFireAt: z.string().optional(),
      lastFiredAt: z.string().optional(),
      /** What it starts, so the operator can tell a report from a repo job. */
      target: z.string(),
      /**
       * Whether an agent armed this, which is worth seeing at a glance.
       *
       * Absent where provenance was never recorded — a webhook endpoint keeps
       * no session against it — because a reader can act on "unknown" and can
       * only be misled by a guess rendered as a fact.
       */
      createdByAgent: z.boolean().optional(),
      status: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  guidance: z.string(),
});

export const SpaceContextHostFoldersSectionSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      root: z.string(),
      /** What may be done there, so the agent does not offer what it cannot do. */
      access: z.enum(['read', 'read_write']),
      canRunCommands: z.boolean(),
      /**
       * Which branches this folder may be pushed to: the folder pushes only to
       * branches under this prefix. Absent, it pushes nothing at all, whatever
       * else it allows.
       */
      branchPrefix: z.string().optional(),
      /**
       * When a publication from this folder asks the operator before pushing,
       * as the machine holding it declares. Absent where the folder pushes
       * nothing, or no machine holding it is running right now.
       */
      pushApproval: HostPushApprovalSchema.optional(),
      /**
       * That a publication from this folder runs checks in a checkout of its
       * commit before it scans or pushes, and the program they run, as the
       * machine holding it declares. Absent where the folder declares none — a
       * publication then runs no checks and says so — or no machine holding it
       * is running right now.
       */
      checks: HostPublishedChecksSchema.optional(),
      /**
       * MCP servers the operator configured to run in this folder. Named here
       * because a capability nobody can discover is one nobody uses; what each
       * one actually offers is asked for on demand.
       */
      mcpServers: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
    }),
  ),
  /**
   * Harnesses `host.harness.run` accepts, as the paired machines offer them
   * right now: the id a run addresses, and the name an operator would recognise
   * where the machine gave one. A property of the machine rather than of any one
   * folder, so it sits beside the items. Empty means no paired machine is
   * running at the moment — not that the operator has none.
   */
  harnesses: z.array(z.object({ id: z.string(), label: z.string().optional() })),
  total: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  guidance: z.string(),
});

export const SpaceContextRepositoriesSectionSchema = z.object({
  items: z.array(
    z.object({
      repo: z.string(),
      defaultBranch: z.string(),
    }),
  ),
  total: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  guidance: z.string(),
});
export type SpaceContextRepositoriesSection = z.infer<typeof SpaceContextRepositoriesSectionSchema>;

export const SpaceContextComputeSectionSchema = z.object({
  enabled: z.boolean(),
  runtimes: z.array(z.string()),
  networkEgress: z.enum(['blocked', 'allowlist']),
  maxExecutionSeconds: z.number().int().positive(),
  sessionsEnabled: z.boolean().optional(),
  guidance: z.string(),
});

export const SpaceContextSkillsSectionSchema = z.object({
  active: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(['optimization', 'process', 'project']),
      status: z.enum(['draft', 'approved']),
      progress: z.string(),
      bestResult: z.string().optional(),
      origin: z.enum(['platform', 'space']),
      firstTaskInputContract: z.record(z.unknown()).optional(),
    }),
  ),
  needsSetup: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        activationStatus: z.enum(['needs_binding', 'degraded']),
        /** `needs_binding` payload — capability prefixes with no bound integration. */
        missingCapabilities: z.array(z.string()).max(20),
        /** One line per missing capability: what it means and what closes it. */
        setup: z.array(z.string()).max(20).optional(),
        missingEndpointIds: z.array(z.string()).max(20).optional(),
      }),
    )
    .max(10)
    .optional(),
  needsRepair: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        diagnostics: z.array(SkillDiagnosticSchema).max(10),
      }),
    )
    .max(10)
    .optional(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  guidance: z.string(),
});

/**
 * Installed applet definitions (§4.13 tier 1 — the capability). Live
 * instances are tier 2 (attention) and are not listed here; `liveInstances`
 * carries only the count so the agent knows whether to join or start.
 */
export const SpaceContextAppletsSectionSchema = z.object({
  installed: z.array(InstalledAppletSummarySchema),
  total: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  guidance: z.string(),
});

export const SpaceContextNavigationSchema = z.object({
  baseUrl: z.string().url(),
  spaceSlug: z.string(),
  routes: z.object({
    agent: z.string(),
    skill: z.string(),
    session: z.string(),
    memory: z.string(),
    integration: z.string(),
    chat: z.string(),
    /** A live applet instance's board/page — where the rendered view lives. */
    applet: z.string(),
    store: z.string(),
    /** Personal provider keys (user-scoped — not under the space prefix). */
    credentials: z.string(),
    /** Space model/reasoning settings (the cybernetic settings tab). */
    agentSettings: z.string(),
    /** The operator machine this space reaches: connected folders and what each allows. */
    computer: z.string(),
    /** Everything armed to start work here on its own — schedules and webhooks. */
    triggers: z.string(),
  }),
  /**
   * That this list is exhaustive.
   *
   * A route is data, and an agent asked "where do I do X" will otherwise answer
   * from the shape of other web applications it has seen — confidently, with a
   * path that returns a 404. Stating the closure is a property of the block, not
   * a fact about any one page: a route added here needs no prose, and one that
   * does not exist cannot be rescued by any.
   */
  guidance: z.string(),
});
export type SpaceContextNavigation = z.infer<typeof SpaceContextNavigationSchema>;

/**
 * Build a {@link SpaceContextNavigation} block for a given baseUrl
 * and space slug. The `{agentSlug}` / `{skillSlug}` / etc. placeholders
 * are left in for the agent to fill at link-emission time.
 *
 * `baseUrl` should be the public web origin (e.g. `https://app.aflow.ai`,
 * or `http://localhost:3001` in dev). Trailing slashes are stripped.
 */
export const NAVIGATION_GUIDANCE =
  'Every page of this app an agent may link to. This list is complete: if something is not ' +
  'here there is no page for it, so say so rather than describing a screen that does not ' +
  'exist. Never construct a path that is not built from one of these.';

export function buildSpaceContextNavigation(
  baseUrl: string,
  spaceSlug: string,
): SpaceContextNavigation {
  const normalized = baseUrl.replace(/\/+$/, '');
  const prefix = `${normalized}/s/${encodeURIComponent(spaceSlug)}`;
  return {
    baseUrl: normalized,
    spaceSlug,
    routes: {
      agent: `${prefix}/agents/{agentSlug}`,
      skill: `${prefix}/skills/{skillSlug}`,
      session: `${prefix}/sessions/{sessionId}`,
      memory: `${prefix}/memory/{path}`,
      integration: `${prefix}/integrations/{bindingId}`,
      chat: `${prefix}/chat/{agentSlug}`,
      applet: `${prefix}/applets/{instanceId}`,
      store: `${prefix}/store`,
      credentials: `${normalized}/settings/credentials`,
      agentSettings: `${prefix}/settings/agent`,
      computer: `${prefix}/computer`,
      triggers: `${prefix}/triggers`,
    },
    guidance: NAVIGATION_GUIDANCE,
  };
}

export const SpaceContextSchema = z.object({
  version: z.literal(1),

  space: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    rules: z.array(z.object({ text: z.string() })).optional(),
    directives: z.unknown().optional(),
  }),

  memories: SpaceContextMemorySectionSchema.optional(),
  integrations: SpaceContextIntegrationsSectionSchema.optional(),
  repositories: SpaceContextRepositoriesSectionSchema.optional(),
  hostFolders: SpaceContextHostFoldersSectionSchema.optional(),
  triggers: SpaceContextTriggersSectionSchema.optional(),
  compute: SpaceContextComputeSectionSchema.optional(),
  skills: SpaceContextSkillsSectionSchema.optional(),
  applets: SpaceContextAppletsSectionSchema.optional(),
  navigation: SpaceContextNavigationSchema.optional(),
});

export type SpaceContext = z.infer<typeof SpaceContextSchema>;
export type SpaceContextMemorySection = z.infer<typeof SpaceContextMemorySectionSchema>;
export type SpaceContextComputeSection = z.infer<typeof SpaceContextComputeSectionSchema>;
export type SpaceContextSkillsSection = z.infer<typeof SpaceContextSkillsSectionSchema>;
export type SpaceContextAppletsSection = z.infer<typeof SpaceContextAppletsSectionSchema>;

// ============================================================================
// Model-facing projection
// ============================================================================

/**
 * Which agent the projection is being built for.
 *
 * Only the cybernetic roles are named because only their prompts are known
 * here; anything else is `other` and keeps whatever a named role would keep,
 * since an unrecognised agent has no prompt this module can reason about.
 */
export type SpaceContextConsumerRole = 'helmsman' | 'runner' | 'coach' | 'other';

/**
 * Directive fields that steer the orchestrator and never the model: run
 * budgets, model and reasoning selection, Coach learning policy, and the
 * capability-discovery allowlists. Derived by exclusion from the governance
 * triple below so a directive field added later is dropped by default —
 * defaulting the other way would silently start shipping it to every agent.
 */
const MODEL_FACING_DIRECTIVE_FIELDS = ['responsibility', 'priorities', 'style'] as const;

/**
 * Strip `SpaceContext` down to what the model is actually meant to read.
 *
 * `SpaceContext` serves two masters. The orchestrator reads `space.directives`
 * to detect a Helmsman, resolve the discovery override, and pick the role's
 * model — so the field cannot leave `buildSpaceContext`. The model has no use
 * for any of it, and pays for all of it on every turn.
 *
 * Transport is not injection: the cached object keeps every field, and this
 * projection runs at the point the block is handed to the model.
 *
 * The governance triple is role-dependent. `buildGovernanceSection` renders
 * `responsibility` / `priorities` / `style` into the Helmsman prompt, so for
 * that role the copy here is a duplicate. No other role's prompt carries it,
 * and for a custom agent this may be the only statement of the space's
 * mandate it ever sees — so the triple survives everywhere except the Helmsman.
 */
export function projectSpaceContextForModel(
  context: SpaceContext,
  role: SpaceContextConsumerRole,
): SpaceContext {
  const { directives, ...space } = context.space;

  if (role === 'helmsman' || directives == null || typeof directives !== 'object') {
    return { ...context, space };
  }

  const source = directives as Record<string, unknown>;
  const governance: Record<string, unknown> = {};
  for (const field of MODEL_FACING_DIRECTIVE_FIELDS) {
    if (source[field] !== undefined) governance[field] = source[field];
  }

  if (Object.keys(governance).length === 0) return { ...context, space };
  return { ...context, space: { ...space, directives: governance } };
}
