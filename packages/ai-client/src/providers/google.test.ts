import { describe, it, expect } from 'vitest';
import type { ChatMessage, EditImageRequest } from '../types.js';
import { MAX_IMAGE_REFERENCES_PER_ROLE } from '@aflow/schemas';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { createDefaultModelCatalog } from '../catalog.js';
import { builtInModels } from '../catalogModels.js';
import { AIClientError } from '../errors.js';
import {
  createGoogleAdapter,
  toGeminiContents,
  sanitizeJsonSchemaForGemini,
  normalizeGoogleError,
  toReferenceConditionedContents,
  noImageReturned,
} from './google.js';
import {
  checkGeminiContentsWireValidity,
  TRUNCATED_HISTORY_USER_BRIDGE_TEXT,
} from './wireIntegrity.js';

describe('toGeminiContents', () => {
  // =========================================================================

  describe('system instruction concatenation', () => {
    it('preserves a single system message as-is', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful agent.' },
        { role: 'user', content: 'Hello' },
      ];
      const { systemInstruction, contents } = toGeminiContents(messages);
      expect(systemInstruction).toBe('You are a helpful agent.');
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
    });

    it('concatenates two system messages with \\n\\n separator', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Main agent instructions with tools and format.' },
        { role: 'system', content: '## Context\n### DiscoverableTools\n...' },
        { role: 'user', content: 'Search for X' },
      ];
      const { systemInstruction, contents } = toGeminiContents(messages);
      expect(systemInstruction).toBe(
        'Main agent instructions with tools and format.\n\n## Context\n### DiscoverableTools\n...',
      );
      expect(contents).toHaveLength(1);
    });

    it('concatenates three system messages in order', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Part 1' },
        { role: 'system', content: 'Part 2' },
        { role: 'system', content: 'Part 3' },
        { role: 'user', content: 'Hello' },
      ];
      const { systemInstruction } = toGeminiContents(messages);
      expect(systemInstruction).toBe('Part 1\n\nPart 2\n\nPart 3');
    });

    it('handles system messages interleaved with other roles', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Instructions' },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'Context block' },
      ];
      const { systemInstruction, contents } = toGeminiContents(messages);
      expect(systemInstruction).toBe('Instructions\n\nContext block');
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
    });

    it('returns undefined systemInstruction when no system messages exist', () => {
      const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
      const { systemInstruction } = toGeminiContents(messages);
      expect(systemInstruction).toBeUndefined();
    });
  });

  // =========================================================================
  // Default mode (nativeFunctionCalling=false): text-based tool rendering
  // This is what generateJson uses — no tools declared, so functionCall/
  // functionResponse parts would cause Gemini to reject the request.
  // =========================================================================

  describe('default mode (text-based tool rendering)', () => {
    it('renders assistant toolCalls as text descriptions', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: 'Let me search',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"test"}' },
            },
          ],
        },
      ];
      const { contents } = toGeminiContents(messages);
      // Model-first history gets a neutral user bridge prepended (wire rule).
      expect(contents).toHaveLength(2);
      expect(contents[0]!.role).toBe('user');
      expect(contents[1]!.role).toBe('model');
      const parts = contents[1]!.parts;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ text: 'Let me search' });
      // Tool call rendered as text, NOT as functionCall
      expect(parts[1]).toHaveProperty('text');
      expect((parts[1] as { text?: string }).text).toContain('search');
      expect((parts[1] as { text?: string }).text).toContain('query');
      expect(parts[1]).not.toHaveProperty('functionCall');
    });

    it('renders tool messages as plain user text', () => {
      const messages: ChatMessage[] = [
        { role: 'tool', toolCallId: 'call_1', name: 'search', content: '{"results":[]}' },
      ];
      const { contents } = toGeminiContents(messages);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
      expect(contents[0]!.parts).toHaveLength(1);
      // Plain text, NOT functionResponse
      expect(contents[0]!.parts[0]).toHaveProperty('text');
      expect((contents[0]!.parts[0] as { text?: string }).text).toContain('search');
      expect((contents[0]!.parts[0] as { text?: string }).text).toContain('{"results":[]}');
      expect(contents[0]!.parts[0]).not.toHaveProperty('functionResponse');
    });

    it('batches consecutive tool messages into one user text Content', () => {
      const messages: ChatMessage[] = [
        { role: 'tool', toolCallId: 'c1', name: 'search', content: 'r1' },
        { role: 'tool', toolCallId: 'c2', name: 'analyze', content: 'r2' },
      ];
      const { contents } = toGeminiContents(messages);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
      const text = (contents[0]!.parts[0] as { text?: string }).text ?? '';
      expect(text).toContain('search');
      expect(text).toContain('analyze');
      expect(text).toContain('r1');
      expect(text).toContain('r2');
    });

    it('produces correct structure for full agent turn cycle (generateJson path)', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Agent instructions' },
        { role: 'system', content: '## Context\nOperations list' },
        { role: 'user', content: 'Find info about X' },
        {
          role: 'assistant',
          content: 'I will search for X',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"X"}' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          name: 'search',
          content: '{"results":["found X"]}',
        },
      ];

      const { systemInstruction, contents } = toGeminiContents(messages);

      expect(systemInstruction).toBe('Agent instructions\n\n## Context\nOperations list');

      // user → model(text + text-toolcall) → user(text-toolresult)
      expect(contents).toHaveLength(3);
      expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);

      // No functionCall or functionResponse parts
      for (const content of contents) {
        for (const part of content.parts ?? []) {
          expect(part).not.toHaveProperty('functionCall');
          expect(part).not.toHaveProperty('functionResponse');
        }
      }
    });
  });

  // =========================================================================
  // Native function calling mode (nativeFunctionCalling=true)
  // This is what generateText uses when tools are declared.
  // =========================================================================

  describe('native function calling mode', () => {
    const opts = { nativeFunctionCalling: true };

    it('converts assistant toolCalls to functionCall parts', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: 'Let me search',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"test"}' },
            },
          ],
        },
      ];
      const { contents } = toGeminiContents(messages, opts);
      // Model-first history gets a neutral user bridge prepended (wire rule).
      expect(contents).toHaveLength(2);
      expect(contents[0]!.role).toBe('user');
      const parts = contents[1]!.parts;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ text: 'Let me search' });
      expect(parts[1]).toHaveProperty('functionCall');
      const fc = (parts[1] as { functionCall?: { name: string; args?: unknown } }).functionCall;
      expect(fc.name).toBe('search');
      expect(fc.args).toEqual({ query: 'test' });
    });

    it('converts tool messages to functionResponse parts', () => {
      const messages: ChatMessage[] = [
        { role: 'tool', toolCallId: 'call_123', name: 'search', content: '{"results": []}' },
      ];
      const { contents } = toGeminiContents(messages, opts);
      expect(contents).toHaveLength(1);
      expect(contents[0]!.role).toBe('user');
      expect(contents[0]!.parts[0]).toHaveProperty('functionResponse');
      const fr = (
        contents[0]!.parts[0] as {
          functionResponse?: { id: string; name?: string; response?: { result?: string } };
        }
      ).functionResponse;
      expect(fr?.id).toBe('call_123');
      expect(fr?.name).toBe('search');
      expect(fr?.response?.result).toBe('{"results": []}');
    });

    it('batches consecutive tool messages into a single user Content', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Do both' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'analyze', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', name: 'search', content: 'result 1' },
        { role: 'tool', toolCallId: 'call_2', name: 'analyze', content: 'result 2' },
      ];
      const { contents } = toGeminiContents(messages, opts);
      expect(contents).toHaveLength(3);
      const toolContent = contents[2]!;
      expect(toolContent.parts).toHaveLength(2);
      expect(
        (toolContent.parts[0] as { functionResponse?: { id: string } }).functionResponse?.id,
      ).toBe('call_1');
      expect(
        (toolContent.parts[1] as { functionResponse?: { id: string } }).functionResponse?.id,
      ).toBe('call_2');
    });

    it('uses toolCallId as fallback name when name is missing', () => {
      const messages: ChatMessage[] = [{ role: 'tool', toolCallId: 'call_abc', content: 'result' }];
      const { contents } = toGeminiContents(messages, opts);
      const fr = (contents[0]!.parts[0] as { functionResponse?: { id: string; name?: string } })
        .functionResponse;
      expect(fr?.name).toBe('call_abc');
    });

    it('handles assistant with toolCalls but no text', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
      ];
      const { contents } = toGeminiContents(messages, opts);
      // Model-first history gets a neutral user bridge prepended (wire rule).
      expect(contents).toHaveLength(2);
      expect(contents[1]!.parts).toHaveLength(1);
      expect(contents[1]!.parts[0]).toHaveProperty('functionCall');
    });
  });

  // =========================================================================
  // Assistant messages (shared behavior)
  // =========================================================================

  describe('assistant messages → model Content', () => {
    it('converts assistant text to model Content with text part', () => {
      const messages: ChatMessage[] = [
        { role: 'assistant', content: 'Hello there', toolCalls: undefined },
      ];
      const { contents } = toGeminiContents(messages);
      // Model-first history gets a neutral user bridge prepended (wire rule).
      expect(contents).toHaveLength(2);
      expect(contents[1]!.role).toBe('model');
      expect(contents[1]!.parts).toEqual([{ text: 'Hello there' }]);
    });

    it('skips assistant message with no content and no toolCalls', () => {
      const messages: ChatMessage[] = [{ role: 'assistant', content: null, toolCalls: undefined }];
      const { contents } = toGeminiContents(messages);
      expect(contents).toHaveLength(0);
    });
  });

  // =========================================================================
  // Role alternation (Gemini §5.2) — applies to both modes
  // =========================================================================

  describe('role alternation', () => {
    it('merges consecutive user Contents in native FC mode', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Search for X' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'search', content: 'found it' },
        { role: 'user', content: 'Great, now analyze' },
      ];

      const { contents } = toGeminiContents(messages, { nativeFunctionCalling: true });

      // user → model → user(functionResponse) → model(bridge) → user(text)
      // functionResponse must NOT be merged with text parts (Gemini constraint).
      // A synthetic empty model turn bridges the two user turns for strict alternation.
      expect(contents).toHaveLength(5);
      expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
      expect(contents[2]!.parts[0]).toHaveProperty('functionResponse');
      expect(contents[3]!.parts).toEqual([{ text: '[Processed tool results]' }]); // bridge turn
      expect(contents[4]!.parts).toEqual([{ text: 'Great, now analyze' }]);
    });

    it('merges consecutive user Contents in default mode', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Search for X' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'search', content: 'found it' },
        { role: 'user', content: 'Great, now analyze' },
      ];

      const { contents } = toGeminiContents(messages);

      // user → model → user (merged: tool-result text + user text)
      expect(contents).toHaveLength(3);
      expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    });

    it('merges consecutive model Contents', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Part 1' },
        { role: 'assistant', content: 'Part 2' },
      ];
      const { contents } = toGeminiContents(messages);
      expect(contents).toHaveLength(2);
      expect(contents[1]!.parts).toHaveLength(2);
    });

    it('ensures strictly alternating roles with complex history (native FC)', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Do three things' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'a', content: 'r1' },
        { role: 'tool', toolCallId: 'c2', name: 'b', content: 'r2' },
        { role: 'user', content: 'Continue' },
      ];
      const { contents } = toGeminiContents(messages, { nativeFunctionCalling: true });

      for (let i = 1; i < contents.length; i++) {
        expect(contents[i]!.role).not.toBe(contents[i - 1]!.role);
      }
    });

    it('ensures strictly alternating roles with complex history (default mode)', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Do three things' },
        {
          role: 'assistant',
          content: 'Running tools',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'a', content: 'r1' },
        { role: 'tool', toolCallId: 'c2', name: 'b', content: 'r2' },
        { role: 'user', content: 'Continue' },
      ];
      const { contents } = toGeminiContents(messages);

      for (let i = 1; i < contents.length; i++) {
        expect(contents[i]!.role).not.toBe(contents[i - 1]!.role);
      }
    });
  });

  // =========================================================================

  describe('model-first history bridging (run e4c5061e regression)', () => {
    const opts = { nativeFunctionCalling: true };

    /** One assistant functionCall exchange with its result, compact-id style. */
    function exchange(id: string, name: string): ChatMessage[] {
      return [
        {
          role: 'assistant',
          content: `{"action":"invoke_step","toolId":"${name}"}`,
          toolCalls: [{ id, type: 'function', function: { name, arguments: '{"mode":"list"}' } }],
        },
        {
          role: 'tool',
          toolCallId: id,
          name,
          content: `{"kind":"tool_result","toolCallId":"${id}"}`,
        },
      ];
    }

    it('prepends a user bridge when the history opens on a functionCall turn', () => {
      const messages: ChatMessage[] = [...exchange('a_0', 'memory.store.query')];
      const { contents } = toGeminiContents(messages, opts);
      expect(contents[0]).toEqual({
        role: 'user',
        parts: [{ text: TRUNCATED_HISTORY_USER_BRIDGE_TEXT }],
      });
      expect(checkGeminiContentsWireValidity(contents).issues).toEqual([]);
    });

    it('replayed wire shape of the failed run is valid after bridging', () => {
      // Shape replayed from the persisted conversation state that fed the
      // failing turn (session 7ca3fb1e, feeder step 7c34df93): leading user
      // atom evicted, exchanges interleaved with mid-history cleared_summary
      // system atoms, trailing assistant call answered by a fresh result.
      const messages: ChatMessage[] = [
        { role: 'system', content: 'agent instructions' },
        ...exchange('e3a31370bf114f7e8a742b1256fe19b2_0', 'memory.store.query'),
        ...exchange('b89ea4c448c84200924963b9e5857301_0', 'memory.store.query'),
        { role: 'system', content: '[Cleared exchange — 1 tool call] • compute.sandbox.exec(...)' },
        { role: 'system', content: '[Cleared exchange — 1 tool call] • memory.store.query(...)' },
        ...exchange('8a39e96f11d54874be7b503d6428b0d4_0', 'memory.store.get'),
        ...exchange('d5160c84448b47d380a86ac0c8719e25_0', 'compute.sandbox.exec'),
      ];

      const { systemInstruction, contents } = toGeminiContents(messages, opts);

      // Without the bridge, contents[0] is the first exchange's model FC turn —
      // the exact shape Gemini rejected with the live 400.
      expect(contents[0]!.role).toBe('user');
      expect(contents[0]!.parts).toEqual([{ text: TRUNCATED_HISTORY_USER_BRIDGE_TEXT }]);
      expect(contents[1]!.role).toBe('model');
      expect(contents[1]!.parts?.some((p) => 'functionCall' in p && p.functionCall)).toBe(true);
      expect(systemInstruction).toContain('Cleared exchange');
      expect(checkGeminiContentsWireValidity(contents).issues).toEqual([]);
    });

    it('bridges a model-first text-only history in default mode', () => {
      const messages: ChatMessage[] = [
        { role: 'assistant', content: 'Earlier reply' },
        { role: 'user', content: 'Continue' },
      ];
      const { contents } = toGeminiContents(messages);
      expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
      expect(checkGeminiContentsWireValidity(contents).issues).toEqual([]);
    });

    it('does not prepend a bridge when the history already opens with a user turn', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'go' },
        ...exchange('a_0', 'memory.store.query'),
      ];
      const { contents } = toGeminiContents(messages, opts);
      expect(contents[0]!.parts).toEqual([{ text: 'go' }]);
      expect(checkGeminiContentsWireValidity(contents).issues).toEqual([]);
    });
  });
});

describe('sanitizeJsonSchemaForGemini', () => {
  it('normalizes oneOf → anyOf (Gemini accepts anyOf, not oneOf)', () => {
    const schema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'string or number',
        },
      },
    };
    const result = sanitizeJsonSchemaForGemini(schema);
    const props = result['properties'] as Record<string, unknown>;
    const value = props['value'] as Record<string, unknown>;
    expect(value).not.toHaveProperty('oneOf');
    expect(value['anyOf']).toEqual([{ type: 'string' }, { type: 'number' }]);
    expect(value).toHaveProperty('description', 'string or number');
  });

  it('strips unsupported keywords and keeps array-type → anyOf alongside oneOf normalization', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      oneOf: [{ type: 'string' }, { type: 'null' }],
    };
    const result = sanitizeJsonSchemaForGemini(schema);
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('oneOf');
    expect(result['anyOf']).toEqual([{ type: 'string' }, { type: 'null' }]);
  });
});

describe('normalizeGoogleError', () => {
  it('classifies fetch AbortError as retryable timeout', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    const normalized = normalizeGoogleError(err);
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('classifies aborted messages as retryable timeout', () => {
    const normalized = normalizeGoogleError(new Error('Request was aborted.'));
    expect(normalized.code).toBe('timeout');
    expect(normalized.retryable).toBe(true);
  });

  it('keeps auth errors non-retryable', () => {
    const err = new Error('API key not valid. Please pass a valid API key.');
    const normalized = normalizeGoogleError(err);
    expect(normalized.code).toBe('auth');
    expect(normalized.retryable).toBe(false);
  });

  it('keeps auth classification when the message also mentions abort', () => {
    const err = new Error('Request aborted: API key not valid.');
    const normalized = normalizeGoogleError(err);
    expect(normalized.code).toBe('auth');
    expect(normalized.retryable).toBe(false);
  });

  it('keeps status-based classification for HTTP errors that mention abort', () => {
    const err = new Error(
      '{"error":{"code":409,"message":"The operation was aborted","status":"ABORTED"}}',
    );
    (err as unknown as Record<string, unknown>)['status'] = 409;
    const normalized = normalizeGoogleError(err);
    expect(normalized.code).toBe('provider_error');
    expect(normalized.retryable).toBe(false);
  });
});

describe('toReferenceConditionedContents', () => {
  it('sends the bare prompt when no references are supplied', () => {
    const contents = toReferenceConditionedContents({
      model: 'gemini-3-pro-image',
      prompt: 'A sunset over mountains',
    });
    expect(contents).toBe('A sunset over mountains');
  });

  it('announces each reference by role and label before its bytes, prompt last', () => {
    const contents = toReferenceConditionedContents({
      model: 'gemini-3-pro-image',
      prompt: 'Ada at the workbench',
      references: [
        { data: 'AAAA', mimeType: 'image/png', role: 'character', label: 'Ada' },
        { data: 'BBBB', mimeType: 'image/jpeg', role: 'style' },
      ],
    });

    expect(contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'character reference — Ada:' },
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
          { text: 'style reference:' },
          { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } },
          { text: 'Ada at the workbench' },
        ],
      },
    ]);
  });

  it('refuses references for a Google image model that declares none', () => {
    expect(() =>
      toReferenceConditionedContents({
        model: 'gemini-3.1-flash-image',
        prompt: 'Ada at the workbench',
        references: [{ data: 'AAAA', mimeType: 'image/png', role: 'character' }],
      }),
    ).toThrow(AIClientError);
  });

  it('refuses references for a model the catalog does not know', () => {
    let thrown: unknown;
    try {
      toReferenceConditionedContents({
        model: 'gemini-9-imaginary',
        prompt: 'Ada at the workbench',
        references: [{ data: 'AAAA', mimeType: 'image/png', role: 'style' }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AIClientError);
    expect((thrown as AIClientError).code).toBe('invalid_request');
  });

  it('accepts references addressed by an alias of the reference-capable model', () => {
    expect(
      toReferenceConditionedContents({
        model: 'nano-banana-pro',
        prompt: 'Ada at the workbench',
        references: [{ data: 'AAAA', mimeType: 'image/png', role: 'character' }],
      }),
    ).not.toBe('Ada at the workbench');
  });
});

describe('reference-capable image model catalog', () => {
  // The literals are the provider's published per-role ceilings. Asserting them
  // against the imported constant alone compares it with itself, so a silent
  // edit to either side would stay green.
  it('carries the published per-role ceilings on the model that accepts references', () => {
    // Scoped to the image lane: a video route declaring its own references says
    // nothing about what an image model reads, and the ceiling each medium
    // validates against is derived from that medium's routes alone.
    const referenceCapable = builtInModels.filter(
      (model) =>
        model.capabilities.imageReferences !== undefined && model.traits?.outputType === 'image',
    );
    expect(referenceCapable.map((model) => model.id)).toEqual(['gemini-3-pro-image']);
    for (const model of referenceCapable) {
      expect(model.capabilities.imageReferences).toEqual({ character: 5, style: 3 });
      expect(model.capabilities.imageReferences).toEqual(MAX_IMAGE_REFERENCES_PER_ROLE);
    }
  });
});

describe('Gemini image editing refuses reference images', () => {
  // The reference-capable model: refusing here is a property of the edit
  // surface, not of the model.
  const REFERENCE_CAPABLE = 'gemini-3-pro-image';

  const adapter = createGoogleAdapter({ apiKey: 'not-a-real-key', timeoutMs: 250 });

  const edit: EditImageRequest = {
    model: REFERENCE_CAPABLE,
    prompt: 'put Ada at the workbench',
    imageData: 'BBBB',
    imageMimeType: 'image/png',
    references: [{ data: 'AAAA', mimeType: 'image/png', role: 'character', label: 'Ada' }],
    tenantId: 'tenant' as TenantId,
    runId: 'run' as SessionId,
    stepExecutionId: 'step' as StepExecutionId,
  };

  it('refuses even on the model whose generation surface accepts them', async () => {
    expect(
      createDefaultModelCatalog().getModel(REFERENCE_CAPABLE)?.capabilities.imageReferences,
    ).toBeDefined();

    const error = await adapter.editImage!(edit).then(
      () => {
        throw new Error('the edit resolved instead of refusing the references');
      },
      (thrown: unknown) => thrown,
    );
    // Refused before the request is built, so nothing reaches the provider.
    expect(error).toBeInstanceOf(AIClientError);
    expect((error as AIClientError).code).toBe('invalid_request');
    expect((error as AIClientError).retryable).toBe(false);
  });
});

describe('an image turn that produced no image', () => {
  const refusal = (finishReason: string | undefined, revisedPrompt?: string) =>
    noImageReturned({
      response: { candidates: finishReason === undefined ? [{}] : [{ finishReason }] },
      revisedPrompt,
      surface: 'image generation',
    });

  it('carries the reason the provider gave, and what the model said about it', () => {
    const error = refusal('IMAGE_OTHER', 'I can not generate that image.');
    expect(error.message).toContain('finishReason IMAGE_OTHER');
    expect(error.message).toContain('I can not generate that image.');
  });

  it('is retryable when nothing was named that a retry could not clear', () => {
    // The same request has been observed succeeding on a later attempt, so a
    // terminal classification here fails a run the provider would have served.
    expect(refusal('IMAGE_OTHER').retryable).toBe(true);
    expect(refusal(undefined).retryable).toBe(true);
  });

  it('is terminal when the provider judged the content itself', () => {
    for (const reason of ['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'RECITATION']) {
      expect(refusal(reason).retryable).toBe(false);
    }
  });

  it('says which surface refused, because generation and editing fail differently', () => {
    expect(refusal('IMAGE_SAFETY').message).toContain('image generation');
    expect(
      noImageReturned({
        response: { candidates: [{}] },
        revisedPrompt: undefined,
        surface: 'image editing',
      }).message,
    ).toContain('image editing');
  });
});
