import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import { buildOperationId } from '../catalog/operationId.js';
import {
  ScheduleActionSchema,
  ScheduleKindSchema,
  ScheduleStatusSchema,
  FlowScheduleSchema,
} from './schedule.js';

// ============================================================================
// Guardrail constants
// ============================================================================

/** Hard cap on maxFirings for agent-created schedules */
export const MAX_FIRINGS_CAP = 50;

/** Maximum future horizon for one-shot schedules (90 days) */
export const ONE_SHOT_MAX_HORIZON_DAYS = 90;

/** Minimum cron interval in seconds (60s = 1/min) */
export const MIN_CRON_INTERVAL_SECONDS = 60;

// ============================================================================

/** Default minimum snooze duration: 1 second. */
export const SNOOZE_MIN_MS_DEFAULT = 1_000;

/** Default maximum snooze duration: 15 minutes. */
export const SNOOZE_MAX_MS_DEFAULT = 15 * 60_000;

/** The snooze operation id — derived, never hand-written. */
export const SNOOZE_OPERATION_ID = buildOperationId('agent', 'schedule', 'snooze');

/**
 * Read a positive-integer millisecond knob from the environment, falling
 * back to the default. Guarded for non-Node runtimes (schemas is imported
 * client-side) — `process` may not exist there.
 */
function readEnvMs(name: string, fallback: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Minimum snooze duration (ms). Env-gated platform config (`SNOOZE_MIN_MS`);
 * requests below it are clamped up, not rejected.
 */
export function getSnoozeMinMs(): number {
  return readEnvMs('SNOOZE_MIN_MS', SNOOZE_MIN_MS_DEFAULT);
}

/**
 * Maximum snooze duration (ms). Env-gated platform config (`SNOOZE_MAX_MS`);
 * requests above it are a validation error — durable waits beyond this are
 * `agent.schedule.create` `resume_run` schedules, not snoozes.
 */
export function getSnoozeMaxMs(): number {
  return readEnvMs('SNOOZE_MAX_MS', SNOOZE_MAX_MS_DEFAULT);
}

/** Clamp a requested snooze duration to the platform minimum. */
export function clampSnoozeDurationMs(requestedMs: number): number {
  return Math.max(requestedMs, getSnoozeMinMs());
}

/**
 * Parse + clamp a snooze input into the effective delay (ms) to apply
 * before dispatch. Throws on invalid input (including durationMs over the
 * platform max) — callers on the workflow-task path surface this as a
 * pre-claim dispatch failure; the session path never reaches it with
 * invalid input (step input validation runs the same schema first).
 */
export function resolveSnoozeDelayMs(input: unknown): number {
  const parsed = SnoozeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `${SNOOZE_OPERATION_ID} input invalid: ${parsed.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }
  return clampSnoozeDurationMs(parsed.data.durationMs);
}

// ============================================================================
// agent.schedule.create
// ============================================================================

export const FlowScheduleCreateInputSchema = z
  .object({
    /** Human-readable name */
    name: z.string().min(1).max(200),

    /** Why this schedule exists */
    description: z.string().max(2000).optional(),

    // --- Intent ---

    /** What to do: "start_run" (start a new flow run) or "resume_run" (resume a paused run). */
    action: ScheduleActionSchema,

    target: z
      .union([
        z.literal('self'),
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('platform-role'), systemRole: z.string().min(1).max(64) }),
          z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
        ]),
      ])
      .optional(),

    /** Target run ID (required for resume_run). Use "self" for the current run. */
    targetRunId: z.union([z.string().uuid(), z.literal('self')]).optional(),

    // --- Trigger (exactly one of scheduledAt, cron, or onFlowComplete) ---

    /** One-shot: fire once at this datetime (ISO 8601). */
    scheduledAt: z.string().datetime().optional(),

    /** Recurring: cron expression (e.g., '0 9 * * 1-5' = weekdays at 9am). */
    cron: z.string().max(100).optional(),

    /** IANA timezone for cron/scheduledAt evaluation (default: UTC) */
    timezone: z.string().default('UTC'),

    /** Event-driven: fire when another agent's run completes. */
    onFlowComplete: z
      .object({
        target: z.union([
          z.literal('self'),
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('platform-role'), systemRole: z.string().min(1).max(64) }),
            z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
          ]),
        ]),
        status: z.enum(['succeeded', 'failed', 'any_terminal']).default('succeeded'),
      })
      .optional(),

    // --- Input & limits ---

    /**
     * Run input for the scheduled flow. Standard format:
     *   { input: <primary value>, config?: { key: value } }
     * For agent flows, just set input to a string prompt.
     * Supports template expressions: { $now: 'iso' }, { $sourceRef: 'output' }.
     */
    input: z.object({
      input: z.unknown().optional().describe('Primary input value (string prompt, object, etc.)'),
      config: z.record(z.unknown()).optional().describe('Config overrides keyed by variable ID'),
    }),

    maxFirings: z
      .number()
      .int()
      .positive()
      .max(MAX_FIRINGS_CAP)
      .default(MAX_FIRINGS_CAP)
      .describe(
        `How many times this schedule may fire before it expires. The schedule also expires by time via expiresAt, whichever comes first. Defaults to ${String(MAX_FIRINGS_CAP)}, which comfortably covers a daily cron over a multi-week window — set it lower to cap the run tighter. A one-shot (scheduledAt) always fires exactly once regardless.`,
      ),

    /** Auto-expire after this datetime (ISO 8601). Auto-set for recurring schedules if omitted. */
    expiresAt: z.string().datetime().optional(),

    /** Arbitrary metadata */
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    // --- Action → target consistency ---
    if (data.action === 'start_run') {
      if (!data.target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'target is required for start_run. Use "self" to schedule the current agent.',
          path: ['target'],
        });
      }
      if (data.targetRunId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'targetRunId is not used with start_run. Did you mean action: "resume_run"?',
          path: ['targetRunId'],
        });
      }
    }
    if (data.action === 'resume_run') {
      if (!data.targetRunId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'targetRunId is required for resume_run. Use "self" to resume the current run.',
          path: ['targetRunId'],
        });
      }
      if (data.target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'target is not used with resume_run. Did you mean action: "start_run"?',
          path: ['target'],
        });
      }
    }

    // --- Trigger: exactly one of scheduledAt, cron, or onFlowComplete ---
    const triggers = [data.scheduledAt, data.cron, data.onFlowComplete].filter(
      (t) => t !== undefined,
    );
    if (triggers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide a trigger: scheduledAt (one-shot), cron (recurring), or onFlowComplete (event-driven).',
        path: ['scheduledAt'],
      });
    }
    if (triggers.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only one trigger allowed: scheduledAt, cron, or onFlowComplete.',
        path: ['cron'],
      });
    }
  });
export type FlowScheduleCreateInput = z.infer<typeof FlowScheduleCreateInputSchema>;

export const FlowScheduleCreateOutputSchema = z.object({
  scheduleId: z.string().uuid(),
  name: z.string(),
  kind: ScheduleKindSchema,
  status: ScheduleStatusSchema,
  maxFirings: z.number().int().positive(),
  nextFireAt: z.string().datetime().nullish(),
  expiresAt: z.string().datetime().nullish(),
  createdAt: z.string().datetime(),
});
export type FlowScheduleCreateOutput = z.infer<typeof FlowScheduleCreateOutputSchema>;

// ============================================================================
// agent.schedule.get
// ============================================================================

export const FlowScheduleGetInputSchema = z.object({
  scheduleId: z.string().uuid(),
});
export type FlowScheduleGetInput = z.infer<typeof FlowScheduleGetInputSchema>;

export const FlowScheduleGetOutputSchema = FlowScheduleSchema;
export type FlowScheduleGetOutput = z.infer<typeof FlowScheduleGetOutputSchema>;

// ============================================================================
// agent.schedule.list
// ============================================================================

export const FlowScheduleListInputSchema = z.object({
  status: ScheduleStatusSchema.optional(),
  target: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('platform-role'), systemRole: z.string().min(1).max(64) }),
      z.object({ kind: z.literal('custom-agent'), agentId: z.string().uuid() }),
    ])
    .optional(),
  kind: ScheduleKindSchema.optional(),
  createdByRunId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type FlowScheduleListInput = z.infer<typeof FlowScheduleListInputSchema>;

export const FlowScheduleListOutputSchema = z.object({
  schedules: z.array(FlowScheduleSchema),
  nextCursor: z.string().nullish(),
  totalCount: z.number().int().nonnegative().optional(),
});
export type FlowScheduleListOutput = z.infer<typeof FlowScheduleListOutputSchema>;

// ============================================================================
// agent.schedule.update
// ============================================================================

export const FlowScheduleUpdateInputSchema = z.object({
  scheduleId: z.string().uuid(),
  status: z.enum(['active', 'paused']).optional(),
  cron: z.string().max(100).optional(),
  timezone: z.string().optional(),
  input: z
    .object({
      input: z.unknown().optional(),
      config: z.record(z.unknown()).optional(),
    })
    .optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  maxFirings: z.number().int().positive().max(MAX_FIRINGS_CAP).optional(),
  name: z.string().max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export type FlowScheduleUpdateInput = z.infer<typeof FlowScheduleUpdateInputSchema>;

export const FlowScheduleUpdateOutputSchema = z.object({
  scheduleId: z.string().uuid(),
  status: ScheduleStatusSchema,
  nextFireAt: z.string().datetime().nullish(),
  updatedAt: z.string().datetime(),
});
export type FlowScheduleUpdateOutput = z.infer<typeof FlowScheduleUpdateOutputSchema>;

// ============================================================================
// agent.schedule.delete
// ============================================================================

export const FlowScheduleDeleteInputSchema = z.object({
  scheduleId: z.string().uuid(),
});
export type FlowScheduleDeleteInput = z.infer<typeof FlowScheduleDeleteInputSchema>;

export const FlowScheduleDeleteOutputSchema = z.object({
  scheduleId: z.string().uuid(),
  deleted: z.literal(true),
});
export type FlowScheduleDeleteOutput = z.infer<typeof FlowScheduleDeleteOutputSchema>;

// ============================================================================

export const SnoozeInputSchema = z
  .object({
    /** How long to wait before this step succeeds, in milliseconds. */
    durationMs: z
      .number()
      .int()
      .positive()
      .describe(
        'How long to wait, in milliseconds. Clamped up to the platform minimum; ' +
          'values above the platform maximum are rejected.',
      ),
  })
  .superRefine((data, ctx) => {
    const maxMs = getSnoozeMaxMs();
    if (data.durationMs > maxMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `durationMs exceeds the maximum snooze of ${String(maxMs)}ms. ` +
          'For longer waits, use agent.schedule.create with action "resume_run" ' +
          '(targetRunId: "self") — a durable schedule is the right primitive for ' +
          'hours/days-scale waits; snooze is intra-run only.',
        path: ['durationMs'],
      });
    }
  });
export type SnoozeInput = z.infer<typeof SnoozeInputSchema>;

export const SnoozeOutputSchema = z.object({
  /** The duration the caller asked for (ms). */
  requestedMs: z.number().int().positive(),
  /** The duration actually waited after clamping (ms). */
  waitedMs: z.number().int().positive(),
  /** When the wait ended and execution resumed (ISO 8601). */
  resumedAt: z.string().datetime(),
});
export type SnoozeOutput = z.infer<typeof SnoozeOutputSchema>;

// ============================================================================
// Operation Registrations
// ============================================================================

export const ScheduleOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'agent',
    group: 'schedule',
    verb: 'create',
    name: 'Create Schedule',
    actionLabel: 'Creating schedule…',
    semanticDescription:
      'Schedule an agent to run at a specific time, on a cron, or when another agent completes. ' +
      'Choose action: "start_run" (requires target — PersistentAgentTarget or "self") or "resume_run" (requires targetRunId, "self" = current run). ' +
      "The input object is passed as the scheduled run's input.",
    tags: ['schedule', 'flow', 'automation'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Schedule a flow to run at a time, on a cron, or on flow completion.',
      whenToUse: [
        'Running a task at a specific future time (one-shot — provide scheduledAt)',
        'Setting up recurring work (cron — provide cron expression)',
        'Reacting to another flow completing (provide onFlowComplete)',
        'Snoozing: pause current run, schedule resume later (targetRunId:"self")',
      ],
      whenNotToUse: [
        'Running a flow right now — use agent.control.delegate or agent.control.run_step',
      ],
      pitfalls: [
        'input is required — use { input: <value>, config?: {...} } format',
        'For agent flows, input.input is a string prompt',
        'maxFirings is required for cron schedules (max 50)',
      ],
      minimalExampleInput: {
        name: 'Check tax reports',
        action: 'start_run',
        scheduledAt: '2026-05-01T09:00:00Z',
        target: 'self',
        input: { input: 'Analyze newly published tax reports' },
      },
    },
    inputZod: FlowScheduleCreateInputSchema,
    outputZod: FlowScheduleCreateOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'schedule',
    verb: 'get',
    name: 'Get Schedule',
    actionLabel: 'Fetching schedule…',
    semanticDescription: 'Get a single flow schedule by ID.',
    tags: ['schedule', 'flow'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Get a schedule by ID.',
      whenToUse: ['Checking the details or status of a specific schedule'],
      whenNotToUse: ['Listing multiple schedules — use agent.schedule.list'],
      minimalExampleInput: { scheduleId: '00000000-0000-0000-0000-000000000000' },
    },
    inputZod: FlowScheduleGetInputSchema,
    outputZod: FlowScheduleGetOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'schedule',
    verb: 'list',
    name: 'List Schedules',
    actionLabel: 'Listing schedules…',
    semanticDescription:
      'List flow schedules in the current space with optional filtering by status, kind, or flow.',
    tags: ['schedule', 'flow'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'List flow schedules with optional filters.',
      whenToUse: [
        'Checking what schedules exist in the space',
        'Finding schedules created by a specific run',
      ],
      whenNotToUse: ['Fetching a single schedule — use agent.schedule.get'],
      minimalExampleInput: {},
    },
    inputZod: FlowScheduleListInputSchema,
    outputZod: FlowScheduleListOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'schedule',
    verb: 'update',
    name: 'Update Schedule',
    actionLabel: 'Updating schedule…',
    semanticDescription:
      'Update a flow schedule: change cron, pause/resume, update input, or modify expiry.',
    tags: ['schedule', 'flow'],
    idempotency: 'non_idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Update a schedule (pause, resume, change cron, modify input).',
      whenToUse: [
        'Pausing a schedule temporarily',
        'Changing a cron expression or timezone',
        'Updating the input for future firings',
      ],
      whenNotToUse: ['Deleting a schedule — use agent.schedule.delete'],
      minimalExampleInput: { scheduleId: '00000000-0000-0000-0000-000000000000', status: 'paused' },
    },
    inputZod: FlowScheduleUpdateInputSchema,
    outputZod: FlowScheduleUpdateOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'schedule',
    verb: 'delete',
    name: 'Delete Schedule',
    actionLabel: 'Deleting schedule…',
    semanticDescription: 'Soft-delete a flow schedule. The schedule will no longer fire.',
    tags: ['schedule', 'flow'],
    idempotency: 'idempotent',
    mutates: true,
    accessMode: 'write',
    usage: {
      oneLine: 'Delete a flow schedule (soft-delete).',
      whenToUse: ['Removing a schedule that is no longer needed'],
      whenNotToUse: [
        'Temporarily disabling a schedule — use agent.schedule.update with status: "paused"',
      ],
      minimalExampleInput: { scheduleId: '00000000-0000-0000-0000-000000000000' },
    },
    inputZod: FlowScheduleDeleteInputSchema,
    outputZod: FlowScheduleDeleteOutputSchema,
  },
  {
    stepType: 'agent',
    group: 'schedule',
    verb: 'snooze',
    name: 'Snooze',
    actionLabel: 'Waiting…',
    semanticDescription:
      'Wait in place for durationMs, then continue — the platform sleeps, no compute runs. ' +
      'The wait happens before the step is dispatched, so it costs nothing while waiting. ' +
      'This supersedes sleeping inside a sandbox: never use compute.sandbox.exec to sleep. ' +
      'durationMs is clamped up to the platform minimum; values above the platform maximum ' +
      'are rejected — use agent.schedule.create with action "resume_run" for longer, durable waits.',
    tags: ['schedule', 'wait', 'snooze', 'sleep', 'delay'],
    idempotency: 'idempotent',
    mutates: false,
    accessMode: 'read',
    usage: {
      oneLine: 'Wait durationMs before continuing — the platform sleeps, not a sandbox.',
      whenToUse: [
        'Waiting for an external system to settle before the next step (async job startup, eventual consistency, rate-limit backoff)',
        'Spacing out repeated checks of an external resource within a run',
      ],
      whenNotToUse: [
        'Never use compute.sandbox.exec to sleep (e.g. time.sleep) — snooze waits without spinning up a container or consuming compute',
        'Waits beyond the platform maximum (default 15 minutes) — use agent.schedule.create with action "resume_run" (targetRunId: "self") for durable cross-run waits',
      ],
      pitfalls: [
        'durationMs above the platform maximum is a validation error — switch to agent.schedule.create resume_run schedules for hours/days-scale waits',
        'durationMs below the platform minimum (default 1s) is silently raised to the minimum — check waitedMs in the output for the actual wait',
      ],
      minimalExampleInput: { durationMs: 60000 },
    },
    inputZod: SnoozeInputSchema,
    outputZod: SnoozeOutputSchema,
  },
];
