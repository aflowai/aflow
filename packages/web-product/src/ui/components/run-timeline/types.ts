/**
 * Optional fields here are declared `?: T | undefined` rather than `?: T`.
 *
 * The package compiles under `exactOptionalPropertyTypes`, where those two are
 * different: the second forbids an explicit `undefined`, and this module builds
 * its objects from event metadata that is frequently absent. Widening the
 * declaration says what the values already are; rewriting the construction to
 * omit keys instead would change the objects at runtime — a key that is missing
 * is not a key that is present and undefined, and anything asking `in` would see
 * the difference.
 */
import type { ReactNode } from 'react';
import type { SessionEvent, UserFacingError } from '../../lib/types.js';

/** A step "group" aggregated from related events */
export interface StepGroup {
  stepId: string;
  stepExecutionId?: string | undefined;
  stepName: string;
  stepType: string;
  operationId: string;
  /** Content-focused detail from input (e.g. document path, query text) */
  stepDetail?: string | undefined;
  /** Agent turn action outcome (invoke_step, invoke_steps, complete, pause_for_input) */
  agentAction?: string | undefined;
  /** Tools invoked by this agent turn */
  invokedTools?: Array<{ stepId: string; name: string; operation: string }>;
  /** Structured response options presented to the user (from pause_for_input) */
  responseOptions?: { type: string; options: Array<{ value: string; label?: string }> };
  /**
   * Synthetic agent.control.run_step step that only dispatches the real
   * operation as a child. Hidden from the timeline once it succeeds — the
   * child carries the actual output/cost — but kept visible if it fails,
   * since no child is created in that case.
   */
  dispatchWrapper?: boolean | undefined;
  status:
    'scheduled' | 'running' | 'succeeded' | 'failed' | 'paused' | 'waiting_on_child' | 'retrying';
  pauseKind?: string | undefined;
  events: SessionEvent[];
  scheduledAt?: string | number | undefined;
  startedAt?: string | number | undefined;
  completedAt?: string | number | undefined;
  durationMs?: number | undefined;
  attempt: number;
  /** Which "turn" this is (1-based, for display when the same step runs multiple times) */
  turn: number;
  /**
   * Key of the agent turn that dispatched this step. Tool steps are always
   * scheduled after the turn that decided them completes, so the open turn at
   * the moment a group is created is its caller.
   */
  parentTurnKey?: string | undefined;
  inputRef?: string | undefined;
  outputRef?: string | undefined;
  errorRef?: string | undefined;
  errorMessage?: string | undefined;
  userError?: UserFacingError | undefined;
  /** Variable changes from runtimeStatePatch */
  variableChanges?: Array<{ key: string; value?: unknown }>;
  /** AI usage cost/token info extracted from usage field or metadata.costJson */
  costInfo?: {
    provider?: string | undefined;
    model?: string | undefined;
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
    totalCostUsd?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    uncachedPromptTokens?: number | undefined;
    /** Tokens spent on internal reasoning (subset of completionTokens). */
    reasoningTokens?: number | undefined;
  };
  /** Present when this step was forwarded from a child/delegate session */
  delegateInfo?: {
    /** Parent step name that triggered the delegation (e.g. "run-procedure") */
    subflowStepName?: string | undefined;
    /** Child agent ID */
    sourceAgentId?: string | undefined;
    /** Child session ID */
    sourceRunId?: string | undefined;
    /** Resolved role label for badge display */
    role?: string | undefined;
    /** Workflow slug the child is executing (for parallel-runner disambiguation) */
    workflowSlug?: string | undefined;
    /** Human-readable task name within the workflow */
    taskName?: string | undefined;
    /** Stable per-child hue (0-359) derived from sourceRunId for visual clustering */
    accentHue?: number | undefined;
  };
}

/** Parsed subflow forwarded event for display */
export interface SubflowEntry {
  sourceRunId: string;
  sourceEventType: string;
  sourceStepId?: string | undefined;
  sourceAgentId?: string | undefined;
  subflowStepName?: string | undefined;
  /** Human-readable step name from the child event (e.g. "Execute Code") */
  stepName?: string | undefined;
  /** Operation ID from the child event (e.g. "compute.sandbox.exec") */
  operationId?: string | undefined;
  agentMessage?: string | undefined;
  timestamp: string | number;
  event: SessionEvent;
}

/** A timeline entry — flow-level event, step group, or subflow forwarded event */
export type TimelineEntry =
  | { kind: 'flow'; event: SessionEvent }
  | { kind: 'step'; group: StepGroup }
  | { kind: 'subflow'; entry: SubflowEntry };

export interface RunTimelineProps {
  events: SessionEvent[];
  /** If true, show compact view (no step grouping) */
  compact?: boolean | undefined;
  /**
   * When false, renders only the execution list (summary bar + step cards)
   * without wrapping in Execution/State tabs. The parent component is
   * responsible for providing its own tab structure including the StateViewer.
   * Defaults to true for backwards compatibility.
   */
  withTabs?: boolean | undefined;
  /**
   * History is still arriving. Distinguishes a session with nothing in it from
   * one whose events have not landed yet — identical on screen otherwise, and
   * only one of them means something is wrong.
   */
  loading?: boolean | undefined;
  /**
   * Rendered between the summary bar and the first event.
   *
   * Belongs there rather than above the whole timeline because it marks where
   * the EVENTS are cut, and the summary describes the run as a whole.
   */
  historyEdge?: ReactNode | undefined;
}
