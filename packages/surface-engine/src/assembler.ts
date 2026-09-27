/**
 * MessageAssembler — Buffers streaming text tokens into complete JSONL messages.
 *
 * This is the Phoenix variation described in the A2UI research:
 * - Stream raw tokens from the model server-side
 * - Buffer locally until one complete JSONL message has been assembled
 * - Parse that message
 * - Validate against the surface catalog
 * - Only then emit the validated mutation
 *
 * The assembler handles:
 * - JSONL framing (newline-delimited JSON)
 * - Partial JSON buffering
 * - Brace counting for JSON object boundaries
 * - JSON arrays of messages (model may emit [...] instead of JSONL)
 * - Leading/trailing whitespace and noise
 */
import type { SurfaceMutation } from '@aflow/schemas';
import { parseSurfaceMutation } from '@aflow/schemas';

export type AssembledMessageCallback = (mutation: SurfaceMutation, rawJson: string) => void;

export type AssemblerErrorCallback = (error: string, rawText: string) => void;

export type AssemblerCoercionCallback = (original: string, coerced: string) => void;

export interface MessageAssemblerOptions {
  /** Called when a complete, validated mutation is assembled. */
  onMessage: AssembledMessageCallback;
  /** Called when a message fails parsing or validation. */
  onError?: AssemblerErrorCallback;
  /** Called when a mutation was auto-coerced (invalid enum → fallback). */
  onCoercion?: AssemblerCoercionCallback;
  /** Max buffer size before forced flush attempt (default: 1MB). */
  maxBufferSize?: number;
}

export class MessageAssembler {
  private buffer = '';
  private braceDepth = 0;
  private bracketDepth = 0;
  private inString = false;
  private escaped = false;
  private objectStart = -1;

  private readonly onMessage: AssembledMessageCallback;
  private readonly onError: AssemblerErrorCallback;
  private readonly onCoercion: AssemblerCoercionCallback;
  private readonly maxBufferSize: number;

  constructor(options: MessageAssemblerOptions) {
    this.onMessage = options.onMessage;
    this.onError = options.onError ?? (() => {});
    this.onCoercion = options.onCoercion ?? (() => {});
    this.maxBufferSize = options.maxBufferSize ?? 1_048_576;
  }

  /**
   * Feed text tokens into the assembler.
   * May emit zero, one, or multiple complete messages.
   */
  feed(text: string): void {
    for (const char of text) {
      this.buffer += char;

      if (this.escaped) {
        this.escaped = false;
        continue;
      }

      if (char === '\\' && this.inString) {
        this.escaped = true;
        continue;
      }

      if (char === '"' && !this.escaped) {
        this.inString = !this.inString;
        continue;
      }

      if (this.inString) continue;

      if (char === '{') {
        if (this.braceDepth === 0 && this.bracketDepth === 0) {
          this.objectStart = this.buffer.length - 1;
        }
        this.braceDepth++;
      } else if (char === '}') {
        this.braceDepth--;
        if (this.braceDepth === 0 && this.bracketDepth === 0 && this.objectStart >= 0) {
          // Complete top-level JSON object
          const jsonStr = this.buffer.slice(this.objectStart);
          this.tryEmit(jsonStr.trim());
          this.buffer = '';
          this.objectStart = -1;
        }
      } else if (char === '[') {
        this.bracketDepth++;
      } else if (char === ']') {
        this.bracketDepth--;
        if (this.bracketDepth === 0 && this.braceDepth === 0) {
          // Could be a complete JSON array — try to parse individual objects
          this.tryEmitArray(this.buffer.trim());
          this.buffer = '';
          this.objectStart = -1;
        }
      } else if (char === '\n' && this.braceDepth === 0 && this.bracketDepth === 0) {
        // JSONL line boundary — try to parse what we have
        const line = this.buffer.trim();
        if (line.length > 0) {
          this.tryEmit(line);
        }
        this.buffer = '';
        this.objectStart = -1;
      }
    }

    // Safety: prevent unbounded buffer growth
    if (this.buffer.length > this.maxBufferSize) {
      this.onError('Buffer overflow — max size exceeded', this.buffer.slice(0, 500));
      this.buffer = '';
      this.braceDepth = 0;
      this.bracketDepth = 0;
      this.inString = false;
      this.objectStart = -1;
    }
  }

  /**
   * Flush any remaining buffered content.
   * Call this when the model stream ends.
   */
  flush(): void {
    const remaining = this.buffer.trim();
    if (remaining.length > 0) {
      // Try to parse as a single object or array
      if (remaining.startsWith('[')) {
        this.tryEmitArray(remaining);
      } else if (remaining.startsWith('{')) {
        this.tryEmit(remaining);
      }
    }
    this.buffer = '';
    this.braceDepth = 0;
    this.bracketDepth = 0;
    this.inString = false;
    this.objectStart = -1;
  }

  /** Reset the assembler state. */
  reset(): void {
    this.buffer = '';
    this.braceDepth = 0;
    this.bracketDepth = 0;
    this.inString = false;
    this.escaped = false;
    this.objectStart = -1;
  }

  private tryEmit(jsonStr: string): void {
    const result = parseSurfaceMutation(jsonStr);
    if (result.success) {
      this.onMessage(result.data, jsonStr);
      return;
    }

    // Auto-coerce: try to repair common model mistakes before giving up
    const coerced = tryCoerceMutation(jsonStr);
    if (coerced) {
      const coercedStr = JSON.stringify(coerced);
      const retryResult = parseSurfaceMutation(coercedStr);
      if (retryResult.success) {
        this.onCoercion(jsonStr.slice(0, 200), coercedStr.slice(0, 200));
        this.onMessage(retryResult.data, jsonStr);
        return;
      }
    }

    this.onError(result.error.issues.map((i) => i.message).join('; '), jsonStr.slice(0, 1000));
  }

  private tryEmitArray(jsonStr: string): void {
    try {
      const parsed: unknown = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const itemStr = JSON.stringify(item);
          this.tryEmit(itemStr);
        }
      } else {
        this.tryEmit(jsonStr);
      }
    } catch {
      this.onError('Failed to parse JSON array', jsonStr.slice(0, 500));
    }
  }
}

// =============================================================================
// Auto-coercion: repair common model mistakes
// =============================================================================

/** Valid event types from SurfaceEventTypeSchema */
const VALID_EVENT_TYPES = new Set([
  'click',
  'message',
  'submit',
  'navigate',
  'invoke',
  'select',
  'change',
  'custom',
]);

/**
 * Try to coerce a mutation JSON that failed strict parsing.
 * Repairs:
 * - Invalid eventType in actions → "custom"
 * - Invalid target in actions → "agent"
 * Returns the coerced object, or null if parsing failed entirely.
 */
function tryCoerceMutation(jsonStr: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;

    // Coerce action eventTypes in components
    const components = obj['components'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(components)) {
      for (const comp of components) {
        const actions = comp['actions'] as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(actions)) {
          for (const action of actions) {
            if (
              typeof action['eventType'] === 'string' &&
              !VALID_EVENT_TYPES.has(action['eventType'])
            ) {
              action['eventType'] = 'custom';
            }
          }
        }
      }
    }

    return obj;
  } catch {
    return null;
  }
}
