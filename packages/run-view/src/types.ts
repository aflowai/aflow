import type {
  ApiSessionEvent,
  MissingVariable,
  UserFacingError,
  WorkflowHumanDecision,
  WorkflowResumeContract,
  WorkflowRunResult,
} from '@aflow/schemas';
import type { MediaItem } from './content-extraction.js';

// Re-export schema types so consumers can pull them via this barrel.
export type { UserFacingError };

/**
 * Alias for backward-compat — consumers that imported MissingVariableInfo
 * now get the canonical MissingVariable from @aflow/schemas.
 */
export type MissingVariableInfo = MissingVariable;

export interface RequiredInput {
  stepExecutionId: string;
  prompt?: string;
  /** Typed interrupt pause type — used for context-aware status labels */
  pauseType?: string;
  /** Missing variables from pre-execution state variable gating */
  missingVariables?: MissingVariable[];
  subflowPause?: boolean;
  /** Human-readable name of the subflow step (e.g. "evals-agent") */
  subflowStepName?: string;
  /** Structured response options from agent pause_for_input */
  responseOptions?: {
    type: 'single' | 'multi';
    options: Array<{ value: string; label?: string }>;
  };
  placement?: 'chat_inline';
}

export interface McpElicitationEntry {
  elicitationId: string;
  stepExecutionId: string;
  bindingId: string;
  serverId: string;
  /** Form mode: schema-driven form. URL mode: external link + accept/decline. */
  mode: 'form' | 'url';
  message: string;
  /** Form-mode JSON Schema describing the response shape (passed to AJV for client-side preflight). */
  requestedSchema?: Record<string, unknown>;
  /** URL-mode out-of-band link the user opens. */
  url?: string;
  /** ISO timestamp the executor's lease expires (UI displays a countdown). */
  leaseExpiresAt: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Structured data for rich rendering (JSON viewer, etc.) */
  richContent?: unknown;
  /** Media items (images/videos) from AI generation steps */
  mediaItems?: MediaItem[];
  timestamp: string;
  /**
   * Optional display name shown in place of the generic role label.
   * For assistant messages this is typically the flow name or step name
   * (e.g. "Summariser", "Research Agent"). Falls back to the role label
   * ("Phoenix") when absent.
   */
  senderName?: string;
  /** Content-focused detail from step input (e.g. document path, search query) */
  stepDetail?: string;
  /** Payload ref for lazy-loading full content (when preview is truncated) */
  payloadRef?: string;
  /** Semantic type hint for specialized rendering (e.g. 'compute_result', 'guardrail_policy') */
  semanticType?: string;
  /**
   * Stable grouping key for a consecutive run of sub-agent messages. Doubles
   * as the cluster key in groupConversationItems — keep it stable per source,
   * not display-friendly.
   */
  subflowSource?: string;
  /**
   * Friendly display label for a delegated sub-agent (custom-agent name or
   * capitalized platform role). Present only for plain delegations; absent for
   * workflow-run subflows, whose header renders the `slug › task` path from
   * `subflowSource` instead.
   */
  subflowLabel?: string;
  /** True for intermediate assistant messages that can be collapsed in chat */
  isInterim?: boolean;
  stepExecutionId?: string;
  deliveryState?: 'queued' | 'delivering';
  /**
   * Who wrote this, stamped by the server at the authenticated boundary.
   * A room has several people in it, so `role: 'user'` no longer identifies
   * anyone; this does. Never inferred from a turn's contents.
   */
  authorUserId?: string;
  authorDisplayName?: string;
  /** Position in the room's message sequence, for ordering and read cursors. */
  messageSeq?: number;
  /**
   * The step behind this message was answered by a simulation rather than by a
   * real party. Carried per message rather than only per run, because a mixed
   * run's timeline has to say WHICH facts were fabricated.
   */
  simulated?: boolean;
}

export interface OutputVariable {
  key: string;
  name?: string;
  value?: StateValueRef;
  semanticType?: string;
}

export interface StateValueRef {
  kind: string;
  value?: unknown;
  payloadRef?: string;
  preview?: { text?: string; json?: unknown };
  /** Semantic type hint for specialized rendering (e.g. 'compute_result', 'guardrail_policy') */
  semanticType?: string;
}

// ---------------------------------------------------------------------------
// Conversation items — used by the chat UI to render messages + run separators
// ---------------------------------------------------------------------------

export interface MessageItem {
  kind: 'message';
  message: Message;
}

export interface RunErrorDetail {
  stepName?: string;
  errorCode?: string;
  operationId?: string;
}

export interface RunSeparatorItem {
  kind: 'run-separator';
  id: string;
  status: string;
  errorMessage?: string | null;
  errorDetail?: RunErrorDetail;
  timestamp: string;
}

export interface WorkflowRunSurfaceItem {
  kind: 'workflow_run_surface';
  runId: string;
  revision: number;
  anchorStepExecutionId?: string;
  createdAtMs?: number;
  frozenSnapshot?: WorkflowRunSurfaceState;
  displaySource?: 'op';
}

export interface InlineArtifactItem {
  kind: 'inline_artifact';
  itemId: string;
  anchorStepExecutionId: string;
  artifactId: string;
  versionId: string;
  /** Runtime data passed into the artifact at render time (small or
   *  by-ref; large data already inlined into the HTML payload). */
  data?: unknown;
  /** Set when sourced from a skill workflow task. */
  workflowRunId?: string;
  /**
   * Epoch-ms timestamp of the event that first mounted this item. Used
   * as the chronological fallback in `appendInlineUiItems` when both
   * the workflow-surface lookup and the anchor-message lookup miss —
   * without it, orphan inline items get `items.push`-ed to the bottom
   * and end up below later-turn content.
   */
  createdAtMs: number;
}

export interface InlineSurfaceItem {
  kind: 'inline_surface';
  itemId: string;
  anchorStepExecutionId: string;
  surfaceId: string;
  /** True while mutations are still streaming; flips to false on the
   *  op's completion event. */
  isStreaming: boolean;
  mutations: Array<Record<string, unknown>>;
  lastSurfaceSequence?: number;
  lastSurfaceStepExecutionId?: string;
  /** Set when sourced from a skill workflow task. */
  workflowRunId?: string;
  /** See `InlineArtifactItem.createdAtMs`. Preserved across subsequent
   *  `WorkflowTaskSurfaceUpdate` batches so the item keeps its original
   *  chronological slot. */
  createdAtMs: number;
}

export interface InlineAppletItem {
  kind: 'inline_applet';
  itemId: string;
  anchorStepExecutionId: string;
  /** Live applet instance id — the card self-fetches its snapshot and
   *  subscribes to realtime deltas, so this is the only ref it needs. */
  instanceId: string;
  /** Set when sourced from a skill workflow task. */
  workflowRunId?: string;
  /** See `InlineArtifactItem.createdAtMs`. */
  createdAtMs: number;
}

export type ConversationItem =
  | MessageItem
  | RunSeparatorItem
  | WorkflowRunSurfaceItem
  | InlineArtifactItem
  | InlineSurfaceItem
  | InlineAppletItem;

export interface InlineProposalFocusPayload {
  /** Action Center item id — e.g. `proposal:<uuid>`, `step:<uuid>`. */
  itemId: string;
  /** Optional rationale shown alongside the card. */
  reason?: string;
}

export interface InlineHitlPayload {
  /** `step:<stepExecutionId>` — matches `pausedStepSource`'s Action Center item id. */
  itemId: string;
  /** Step execution id of the paused `user.interaction.*` child step. */
  stepExecutionId: string;
  /** Discriminator on the pause kind. */
  hitlKind: 'human_input' | 'human_approval';
  title?: string;
  /** For input kinds, this is `prompt`. For approvals, the original `description`. */
  body: string;
  /** Approval-only: structured data shown alongside the description. */
  reviewData?: unknown;
  /** Input-only: JSON Schema for the expected response. */
  inputSchema?: Record<string, unknown>;
  uiHints?: {
    mode?: 'text' | 'textarea' | 'form' | 'chat' | 'choices' | 'diff';
    submitLabel?: string;
    approveLabel?: string;
    rejectLabel?: string;
    placeholder?: string;
  };
  /** Lifecycle: 'open' while paused, 'resolved' after the step succeeds. */
  status: 'open' | 'resolved';
  /** Set when status flips to 'resolved' (StepSucceeded for the same stepExecutionId). */
  resolution?:
    | { kind: 'input'; value: unknown; providedAt: string; providedBy?: string }
    | {
        kind: 'approval';
        decision: 'approved' | 'rejected';
        comment?: string;
        decidedAt: string;
        decidedBy?: string;
      };
}

// ---------------------------------------------------------------------------

/** Task row vocabulary — mirrors `WorkflowRunTaskStatusSchema` in @aflow/schemas. */
export type WorkflowSurfaceTaskStatus =
  'scheduled' | 'running' | 'succeeded' | 'failed' | 'paused' | 'blocked' | 'skipped' | 'cancelled';

/** Run-level vocabulary — mirrors `WorkflowRunStatusSchema`. */
export type WorkflowSurfaceRunStatus =
  'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'in_flight' | 'skipped';

export interface WorkflowSurfaceTaskState {
  taskId: string;
  label: string;
  status: WorkflowSurfaceTaskStatus;
  attempt: number;
  workerSessionId?: string;
  operationId?: string;
  /**
   * Dispatch family (`agent` | `operation` | `human`) — the durable signal
   * the task-row icon resolver keys off. A `human` row records no
   * `operationId` and (once resolved) no `humanIntent`, so this is the only
   * thing distinguishing it from an unknown op. Hydrated from the BFF detail
   * and stamped on the live dispatch event; preserved across later lifecycle
   * updates that omit it.
   */
  taskType?: 'agent' | 'operation' | 'human';
  stepCount?: number;
  totalTokens?: number;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  failure?: { code: string; classification: string; retryable: boolean };
  summary?: string;
  inputRef?: string;
  outputRef?: string;
  errorRef?: string;
  lastMutatedAtMs: number;
  activeOp?: string;
  activeStepName?: string;
  activeDetail?: string;
  /** Epoch ms of the last accepted WorkflowTaskActivity. Used for staleness eviction. */
  activeOpUpdatedAtMs?: number;
  /**
   * Monotonic-per-task sequence number from the most recent accepted
   * WorkflowTaskActivity. Incoming activities with `sequence <= this`
   * are dropped (out-of-order delivery from React strict-mode
   * double-dispatch, retry loops).
   */
  activeOpSequence?: number;
  lastSubstantiveOp?: string;
  lastSubstantiveDetail?: string;
  lastSubstantiveOpUpdatedAtMs?: number;
  humanIntent?: 'approve' | 'collect';
  /**
   * Resolved-decision trace for a `type: 'human'`, `intent: 'approve'` row
   * (approved → succeeded; rejected → failed). Drives the surface's
   * resolved-decision pill. Set from the BFF detail and the resume emit;
   * preserved across later lifecycle updates that omit it.
   */
  humanDecision?: WorkflowHumanDecision;
  resolutionSchema?: Record<string, unknown>;
  actionPreview?: { op: string; input: unknown };
  resumeContract?: unknown;
  pauseVersion?: number;
  failureMode?: 'isolate' | 'cancel_siblings';
}

/** Display-ready `when` guard — mirrors `WorkflowWhenViewSchema` in @aflow/schemas. */
export interface WorkflowSurfaceTaskWhen {
  mode: 'single' | 'any' | 'all';
  clauses: string[];
  onMissingRef: 'skip' | 'error';
}

/** Definition-sourced display hint for a forward-DAG node. */
export interface WorkflowSurfaceGraphTaskHint {
  taskId: string;
  label: string;
  taskType?: 'agent' | 'operation' | 'human';
  humanIntent?: 'approve' | 'collect';
  operationId?: string;
  /** Present when the task is guarded by a `when` condition. */
  when?: WorkflowSurfaceTaskWhen;
}

export interface WorkflowSurfaceGraph {
  taskIds: string[];
  edges: Array<{ from: string; to: string }>;
  taskHints?: WorkflowSurfaceGraphTaskHint[];
}

export type WorkflowSurfaceGraphFidelity = 'full' | 'degraded';

export interface WorkflowRunSurfaceState {
  runId: string;
  slug: string;
  workflowTitle?: string;
  status: WorkflowSurfaceRunStatus;
  pauseVersion: number;
  pausedReason?: string;
  allowedResumeModes?: string[];
  startedAt: string;
  completedAt?: string;
  tasks: Record<string, WorkflowSurfaceTaskState>;
  workflowGraph?: WorkflowSurfaceGraph;
  graphFidelity?: WorkflowSurfaceGraphFidelity;
  /**
   * Live promoted run-level state (sanitized) — accumulated from
   * `WorkflowTaskUpdate.promotedState` as promoting tasks succeed, then
   * reconciled with `result.output` on the terminal `WorkflowRunUpdate` /
   * BFF hydration. Renders the surface's "Output" rows mid-run.
   */
  outputs?: Record<string, unknown>;
  /**
   * Structured run result (goal, output values, score vs target, outcome
   * checks, summary, guidance) — set by the terminal `WorkflowRunUpdate`
   * and by BFF hydration. Same object Helmsman receives in its tool result.
   */
  result?: WorkflowRunResult;
  /**
   * Rich pause explanation — present iff `status === 'paused'`. The structured
   * contract (cause, human-readable prompt, contract errors, blocked bindings,
   * transient error code/message, attempt count) the resume handler builds.
   * Surfaced via `workflow.run.detail` (a payload ref, kept off the hot event
   * stream); the surface renders a `<PauseExplanation>` from it. Dropped when
   * the run leaves paused.
   */
  resumeContract?: WorkflowResumeContract;
  /** True once the run reaches a terminal status (completed | failed | cancelled). */
  isFrozen: boolean;
  needsHydration: boolean;
}

export interface WorkflowSurfaceItemEntry {
  runId: string;
  /** `pausedAtStepExecutionId` (mount rule A) or `waiterStepExecutionId` (mount rule B). */
  anchorStepExecutionId: string;
  /** Bumped on every state mutation for this run. */
  revision: number;
  createdAtMs: number;
  frozenSnapshot?: WorkflowRunSurfaceState;
  displaySource?: 'op';
}

/**
 * SSE run event — derived from the canonical ApiSessionEvent schema with an
 * extended `data` index signature so the reducer can access dynamic fields
 * (stepName, agentMessage, displayOutput, etc.) that are not part of the
 * fixed schema but appear on the wire.
 */
export type SessionEvent = Omit<ApiSessionEvent, 'data'> & {
  data: ApiSessionEvent['data'] & Record<string, unknown>;
};
