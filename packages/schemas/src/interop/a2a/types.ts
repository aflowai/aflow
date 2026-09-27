// ============================================================================
// A2A Task States
// ============================================================================

export type A2ATaskState =
  'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

// ============================================================================
// A2A Message / Part
// ============================================================================

export interface A2ATextPart {
  type: 'text';
  text: string;
}

export interface A2AFilePart {
  type: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface A2ADataPart {
  type: 'data';
  data: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2AFilePart | A2ADataPart;

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// A2A Artifact
// ============================================================================

export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: A2APart[];
  index?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// A2A Task
// ============================================================================

export interface A2ATask {
  id: string;
  contextId?: string;
  status: {
    state: A2ATaskState;
    message?: A2AMessage;
    timestamp?: string;
  };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// A2A JSON-RPC
// ============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ============================================================================
// A2A Method params
// ============================================================================

export interface A2ASendMessageParams {
  message: A2AMessage;
  /** Phoenix extension: which flow to run */
  configuration?: {
    flowId?: string;
    spaceId?: string;
    [key: string]: unknown;
  };
}

export interface A2AGetTaskParams {
  id: string;
}

export interface A2ACancelTaskParams {
  id: string;
}

// ============================================================================
// A2A SSE event types (for SendStreamingMessage)
// ============================================================================

export interface A2ATaskStatusUpdateEvent {
  type: 'task-status-update';
  taskId: string;
  contextId?: string;
  status: A2ATask['status'];
  final: boolean;
}

export interface A2ATaskArtifactUpdateEvent {
  type: 'task-artifact-update';
  taskId: string;
  contextId?: string;
  artifact: A2AArtifact;
}

export type A2AStreamEvent = A2ATaskStatusUpdateEvent | A2ATaskArtifactUpdateEvent;
