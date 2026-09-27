// Re-export everything the chat / flow UI needs from the package.
import type {
  DisplayContent,
  MediaItem,
  Message,
  RequiredInput,
  OutputVariable,
  StateValueRef,
  RunErrorDetail,
  MessageItem,
  RunSeparatorItem,
  WorkflowRunSurfaceItem,
  ConversationItem,
  WorkflowSurfaceTaskStatus,
  WorkflowSurfaceRunStatus,
  WorkflowSurfaceTaskState,
  WorkflowSurfaceTaskWhen,
  WorkflowSurfaceGraph,
  WorkflowSurfaceGraphFidelity,
  WorkflowRunSurfaceState,
  WorkflowSurfaceItemEntry,
  SessionEvent,
  UserFacingError,
  MissingVariableInfo,
} from '@aflow/run-view';
import type { SessionBlockedOn, SessionMetadata } from '@aflow/schemas';
export type { SessionBlockedOn, SessionMetadata };

export type {
  DisplayContent,
  MediaItem,
  Message,
  RequiredInput,
  OutputVariable,
  StateValueRef,
  RunErrorDetail,
  MessageItem,
  RunSeparatorItem,
  WorkflowRunSurfaceItem,
  ConversationItem,
  WorkflowSurfaceTaskStatus,
  WorkflowSurfaceRunStatus,
  WorkflowSurfaceTaskState,
  WorkflowSurfaceTaskWhen,
  WorkflowSurfaceGraph,
  WorkflowSurfaceGraphFidelity,
  WorkflowRunSurfaceState,
  WorkflowSurfaceItemEntry,
  SessionEvent,
  UserFacingError,
  MissingVariableInfo,
};

// ---------------------------------------------------------------------------
// Web-only UI DTOs (not consumed by the reducer)
// ---------------------------------------------------------------------------

/** Metadata for a declared input/output variable on a flow (UI-only DTO). */
export interface StateVariableInfo {
  variableId: string;
  name?: string;
  description?: string;
  typeSchema?: Record<string, unknown>;
  semanticType?: string;
  required?: boolean;
  lifecycle?: {
    isInput?: boolean;
    isOutput?: boolean;
  };
  uiHints?: {
    placeholder?: string;
    helpText?: string;
    label?: string;
  };
}

export interface Flow {
  agentId: string;
  slug?: string;
  name: string;
  description?: string;
  /** Platform flow seeded by db:seed (read-only, visible in all spaces). */
  system?: boolean;
  /** The space this flow belongs to. */
  spaceId?: string;
  latestVersion: string;
  /** From flows list API */
  status?: 'active' | 'deprecated' | 'draft';
  createdAt?: string;
  updatedAt?: string;
  /** Input variables derived from flow definition stateVariables where isInput=true */
  inputVariables?: StateVariableInfo[];
  systemRole?:
    'mcp-runner' | 'cybernetic-helmsman' | 'cybernetic-runner' | 'cybernetic-coach' | null;
}

export interface Session {
  sessionId: string;
  agentId: string;
  agentVersion: string;
  status: string;
  createdAt: string;
  /** When the execution state last moved — tool results and all. */
  updatedAt?: string;
  /** When someone last spoke here. What a conversation list sorts on. */
  lastActivityAt?: string;
  /** Who opened it — shown so a shared space's conversations are tellable apart. */
  createdBy?: string;
  /** Name and synopsis, resolved server-side. */
  metadata?: SessionMetadata;
  requiredInput?: RequiredInput;
  currentStepId?: string;
  blockedOn?: SessionBlockedOn | null;
}

export type SessionSeed = Pick<Session, 'sessionId' | 'agentId' | 'agentVersion' | 'createdAt'>;
