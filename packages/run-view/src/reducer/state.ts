import type { HarnessActivityLine, LiveDeltaChannel, SessionBlockedOn } from '@aflow/schemas';
import type { SessionEvent } from '../types.js';
import type {
  InlineAppletItem,
  InlineArtifactItem,
  InlineSurfaceItem,
  McpElicitationEntry,
  Message,
  RequiredInput,
  RunErrorDetail,
  StateValueRef,
  UserFacingError,
  WorkflowRunSurfaceState,
  WorkflowSurfaceItemEntry,
} from '../types.js';

/**
 * The activity feed of one harness step, as far as it has been read.
 *
 * `consumedBytes` is the position in the step's live buffer this entry accounts
 * for, so a frame resending bytes already folded adds only its tail. `partial`
 * is the last line the buffer has not finished writing.
 */
export interface HarnessActivityState {
  lines: HarnessActivityLine[];
  partial: string;
  consumedBytes: number;
  /**
   * When this feed last moved, on the reader's own clock.
   *
   * A line's own `at` counts milliseconds since the harness started, so it
   * cannot answer "was that recent?" without a second fact. The frame's
   * timestamp can, and it puts the reader's clock on both sides of the
   * comparison — which is what lets a surface judging silence (the task row's
   * `Stalled` label) count a feed that is plainly streaming.
   */
  lastActivityAtMs: number;
  /**
   * The step's terminal event has been folded. The feed is kept — the result
   * card folds it above the result — but nothing is running under it any more.
   */
  settled: boolean;
}

export interface RunViewState {
  status: string | null;
  messages: Message[];
  requiredInput: RequiredInput | null;
  blockedOn: SessionBlockedOn | null;
  outputVariables: Array<{ key: string; name?: string; value?: StateValueRef }>;
  /** Error details from the last failure, if any */
  errorMessage: string | null;
  /** Step-level context for the error (step name, code, operation) */
  errorDetail: RunErrorDetail | null;
  userError: UserFacingError | null;
  streamingStepExecutionId: string | null;
  /**
   * Per-step harness feeds, keyed by `stepExecutionId`. Under the step and
   * never in `messages`: these lines are what a step is doing, and the
   * conversation is what the run is saying.
   */
  harnessActivity: Record<string, HarnessActivityState>;
  /**
   * Steps whose terminal event folded while no feed was held for them. A
   * snapshot is folded without feeds, so this is how it tells hydration that a
   * feed the client is still holding belongs to a step that has ended.
   */
  endedSteps: Record<string, true>;
  workflowRuns: Record<string, WorkflowRunSurfaceState>;
  workflowSurfaceItems: WorkflowSurfaceItemEntry[];
  _stepDetailCache: Record<string, string>;
  mcpElicitations: Record<string, McpElicitationEntry>;
  inlineItems: Record<string, InlineArtifactItem | InlineSurfaceItem | InlineAppletItem>;
  /**
   * Bindings this run has been answered by a simulation for, in first-seen
   * order. Non-empty is the run banner's condition: once any fact in the room
   * is fabricated, the whole room is a rehearsal and stays one.
   */
  simulatedBindings: string[];
}

/**
 * A frame of the step in flight — an increment to append to the message that
 * channel is building, not an event. It has no `eventId` because it names
 * nothing durable: the step's terminal event supersedes everything the channel
 * accumulated.
 */
export interface LiveDeltaAction {
  type: 'LIVE_DELTA';
  stepExecutionId: string;
  channel: LiveDeltaChannel;
  /**
   * Byte position in the step's output where `delta` begins. Zero means the
   * frame carries the whole partial — the case on a mid-step reconnect, where
   * appending would show the text twice.
   */
  offset: number;
  delta: string;
  /** Supplied by the dispatcher so the fold stays a pure function of its input. */
  timestamp: string;
  senderName?: string;
}

export type RunViewAction =
  | { type: 'RESET' }
  | { type: 'SSE_EVENT'; event: SessionEvent; flowName?: string }
  | LiveDeltaAction
  | {
      type: 'USER_MESSAGE';
      content: string;
      id: string;
      timestamp: string;
      deliveryState?: 'queued' | 'delivering';
    }
  | {
      type: 'SET_MESSAGE_DELIVERY';
      id: string;
      deliveryState: 'queued' | 'delivering' | null;
    }
  | {
      type: 'REMOVE_MESSAGE';
      id: string;
    }
  | { type: 'SUBMIT_ERROR'; error: string; id: string; timestamp: string }
  | {
      type: 'LOCAL_RUN_STATE';
      status: string;
      requiredInput?: RequiredInput | null;
      clearError?: boolean;
    }
  | {
      type: 'HYDRATE_WORKFLOW_RUN';
      state: WorkflowRunSurfaceState;
    }
  | {
      type: 'MARK_WORKFLOW_RUN_NEEDS_HYDRATION';
      runId: string;
    }
  | {
      type: 'HYDRATE_SNAPSHOT';
      snapshot: RunViewState;
    }
  | {
      type: 'INLINE_PROPOSAL_FOCUS';
      itemId: string;
      reason?: string;
      timestamp: string;
    };

export const INITIAL_STATE: RunViewState = {
  status: null,
  messages: [],
  requiredInput: null,
  blockedOn: null,
  outputVariables: [],
  errorMessage: null,
  errorDetail: null,
  userError: null,
  streamingStepExecutionId: null,
  harnessActivity: {},
  endedSteps: {},
  workflowRuns: {},
  workflowSurfaceItems: [],
  _stepDetailCache: {},
  mcpElicitations: {},
  inlineItems: {},
  simulatedBindings: [],
};
