// ============================================================================
// AG-UI Event Type Enum
// ============================================================================

export const AguiEventType = {
  // Lifecycle
  RunStarted: 'RUN_STARTED',
  RunFinished: 'RUN_FINISHED',
  RunError: 'RUN_ERROR',
  // Steps
  StepStarted: 'STEP_STARTED',
  StepFinished: 'STEP_FINISHED',
  // Text messages
  TextMessageStart: 'TEXT_MESSAGE_START',
  TextMessageContent: 'TEXT_MESSAGE_CONTENT',
  TextMessageEnd: 'TEXT_MESSAGE_END',
  // Tool calls
  ToolCallStart: 'TOOL_CALL_START',
  ToolCallArgs: 'TOOL_CALL_ARGS',
  ToolCallEnd: 'TOOL_CALL_END',
  // State
  StateSnapshot: 'STATE_SNAPSHOT',
  StateDelta: 'STATE_DELTA',
  // Custom
  Custom: 'CUSTOM',
} as const;

export type AguiEventTypeValue = (typeof AguiEventType)[keyof typeof AguiEventType];

// ============================================================================
// AG-UI Event Interfaces
// ============================================================================

/** Base fields present on all AG-UI events */
export interface AguiEventBase {
  type: AguiEventTypeValue;
  timestamp?: number;
  rawEvent?: Record<string, unknown>;
}

// Lifecycle events
export interface AguiRunStarted extends AguiEventBase {
  type: typeof AguiEventType.RunStarted;
  threadId: string;
  runId: string;
}

export interface AguiRunFinished extends AguiEventBase {
  type: typeof AguiEventType.RunFinished;
  threadId: string;
  runId: string;
}

export interface AguiRunError extends AguiEventBase {
  type: typeof AguiEventType.RunError;
  message: string;
  code?: string;
}

// Step events
export interface AguiStepStarted extends AguiEventBase {
  type: typeof AguiEventType.StepStarted;
  stepName: string;
}

export interface AguiStepFinished extends AguiEventBase {
  type: typeof AguiEventType.StepFinished;
  stepName: string;
}

// Text message events
export interface AguiTextMessageStart extends AguiEventBase {
  type: typeof AguiEventType.TextMessageStart;
  messageId: string;
  role: 'assistant' | 'user';
}

export interface AguiTextMessageContent extends AguiEventBase {
  type: typeof AguiEventType.TextMessageContent;
  messageId: string;
  delta: string;
}

export interface AguiTextMessageEnd extends AguiEventBase {
  type: typeof AguiEventType.TextMessageEnd;
  messageId: string;
}

// Tool call events
export interface AguiToolCallStart extends AguiEventBase {
  type: typeof AguiEventType.ToolCallStart;
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface AguiToolCallArgs extends AguiEventBase {
  type: typeof AguiEventType.ToolCallArgs;
  toolCallId: string;
  delta: string;
}

export interface AguiToolCallEnd extends AguiEventBase {
  type: typeof AguiEventType.ToolCallEnd;
  toolCallId: string;
  result?: string;
}

// State events
export interface AguiStateSnapshot extends AguiEventBase {
  type: typeof AguiEventType.StateSnapshot;
  snapshot: Record<string, unknown>;
}

export interface AguiStateDelta extends AguiEventBase {
  type: typeof AguiEventType.StateDelta;
  delta: Array<{ op: string; path: string; value?: unknown }>;
}

// Custom events
export interface AguiCustom extends AguiEventBase {
  type: typeof AguiEventType.Custom;
  name: string;
  value: unknown;
}

// ============================================================================
// Union Type
// ============================================================================

export type AguiEvent =
  | AguiRunStarted
  | AguiRunFinished
  | AguiRunError
  | AguiStepStarted
  | AguiStepFinished
  | AguiTextMessageStart
  | AguiTextMessageContent
  | AguiTextMessageEnd
  | AguiToolCallStart
  | AguiToolCallArgs
  | AguiToolCallEnd
  | AguiStateSnapshot
  | AguiStateDelta
  | AguiCustom;
