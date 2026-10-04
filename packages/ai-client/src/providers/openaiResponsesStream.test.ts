import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createOpenAIAdapter } from './openai.js';
import { createXaiAdapter } from './xai.js';
import { AIClientError } from '../errors.js';
import type { GenerateTextRequest, TextStreamChunk } from '../types.js';

/**
 * Pins the streaming path to `/v1/responses`.
 *
 * Chat Completions rejects function tools alongside a reasoning effort on the
 * GPT-6 family — and rejects them even when no effort is sent, because those
 * models default to one. Since every agent turn streams with tools, that made
 * Chat Completions structurally the wrong endpoint for this adapter, and a unit
 * test over the param mapping could not see it. This test watches the wire.
 *
 * @module-tag listener
 */

interface Capture {
  path: string;
  body: Record<string, unknown>;
}

const captured: Capture[] = [];
let server: Server | undefined;

const STREAM_EVENTS = [
  { type: 'response.created', response: { id: 'resp_123' } },
  { type: 'response.output_text.delta', delta: 'Hel' },
  { type: 'response.output_text.delta', delta: 'lo' },
  {
    type: 'response.output_item.added',
    item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' },
  },
  { type: 'response.function_call_arguments.delta', delta: '{"q":' },
  { type: 'response.function_call_arguments.delta', delta: '"phoenix"}' },
  {
    type: 'response.completed',
    response: {
      id: 'resp_123',
      model: 'gpt-6.1-sol',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"phoenix"}',
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 12 },
      },
    },
  },
];

async function startServer(events: unknown[] = STREAM_EVENTS): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      captured.push({
        path: req.url ?? '',
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for (const event of events as Array<{ type: string }>) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/v1`;
}

async function drain(stream: AsyncGenerator<TextStreamChunk>): Promise<TextStreamChunk[]> {
  const chunks: TextStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const REQUEST: GenerateTextRequest = {
  model: 'gpt-6.1-sol',
  messages: [{ role: 'user', content: 'hi' }],
  reasoning: { effort: 'high' },
  tools: [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'look something up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    },
  ],
};

describe('OpenAI streaming rides the Responses API', () => {
  afterEach(() => {
    captured.length = 0;
    server?.close();
    server = undefined;
  });

  it('streams tools and a reasoning effort to /v1/responses', async () => {
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream(REQUEST);
    const chunks = await drain(stream);
    const result = await response;

    // The combination Chat Completions refuses, on the endpoint that accepts it.
    expect(captured[0]?.path).toBe('/v1/responses');
    expect(captured[0]?.body['reasoning']).toEqual({ effort: 'high' });
    expect(captured[0]?.body['tools']).toHaveLength(1);

    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => c.delta)).toEqual([
      'Hel',
      'lo',
    ]);
    expect(result.content).toBe('Hello');
    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"phoenix"}' },
      },
    ]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('carries the cache and reasoning token breakdown through', async () => {
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream(REQUEST);
    await drain(stream);
    const result = await response;

    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 40,
      uncachedPromptTokens: 60,
      reasoningTokens: 12,
    });
  });

  it('surfaces the tool call id and name before the arguments stream', async () => {
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream(REQUEST);
    const chunks = await drain(stream);
    await response;

    const toolDeltas = chunks.filter((c) => c.type === 'tool_call_delta');
    expect(toolDeltas[0]).toMatchObject({ toolCallId: 'call_1', toolCallName: 'lookup' });
    expect(toolDeltas.slice(1).map((c) => c.toolCallArguments)).toEqual(['{"q":', '"phoenix"}']);
  });

  it('carries every system block into instructions, not just the last', async () => {
    // An agent turn sends instructions, then context, then any cleared-history
    // summary. Keeping only the last dropped the agent's own instructions.
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream({
      ...REQUEST,
      messages: [
        { role: 'system', content: 'agent instructions' },
        { role: 'system', content: '## Context\nstable block' },
        { role: 'user', content: 'go' },
      ],
    });
    await drain(stream);
    await response;

    expect(captured[0]?.body['instructions']).toBe(
      'agent instructions\n\n## Context\nstable block',
    );
  });

  it('does not ask for strict function schemas', async () => {
    // Agent tool schemas come from operation inputs and legitimately carry
    // optional fields, which strict mode rejects at request time.
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream(REQUEST);
    await drain(stream);
    await response;

    const tools = captured[0]?.body['tools'] as Array<{ strict?: boolean }>;
    expect(tools[0]?.strict).toBe(false);
  });

  it('withholds the tool calls of a truncated response, not just relabels it', async () => {
    // A response cut off by max_output_tokens can still carry a half-written
    // function_call item. Labelling that `tool_calls` hands the caller
    // truncated arguments as though they were a finished decision.
    const truncated = STREAM_EVENTS.map((e) =>
      e.type === 'response.completed'
        ? { ...e, type: 'response.incomplete', response: { ...e.response, status: 'incomplete' } }
        : e,
    );
    const baseUrl = await startServer(truncated);
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream(REQUEST);
    await drain(stream);
    const result = await response;

    expect(result.finishReason).toBe('length');
    // The label alone is not enough: the agent's truncation retry only fires
    // when no calls came back, so a half-written call would be executed.
    expect(result.toolCalls).toBeUndefined();
  });

  it('refuses stopSequences rather than dropping them silently', async () => {
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream({
      ...REQUEST,
      stopSequences: ['STOP'],
    });
    // Both halves reject; settle the response promise so the failure is not
    // reported as an unhandled rejection instead of an assertion.
    const settled = response.catch((error: unknown) => error);

    await expect(drain(stream)).rejects.toThrow(/stopSequences/);
    await expect(settled).resolves.toBeInstanceOf(AIClientError);
    expect(captured).toHaveLength(0);
  });

  it('replays xAI reasoning items unchanged and captures the next turn', async () => {
    const encrypted = 'enc-do-not-decode';
    const prior = {
      type: 'reasoning',
      id: 'rs_prior',
      encrypted_content: encrypted,
    };
    const events = STREAM_EVENTS.map((event) =>
      event.type === 'response.completed'
        ? {
            ...event,
            response: {
              ...event.response,
              model: 'grok-4.7',
              output: [
                { type: 'reasoning', id: 'rs_next', encrypted_content: 'enc-next' },
                ...event.response.output,
              ],
            },
          }
        : event,
    );
    const baseUrl = await startServer(events);
    const adapter = createOpenAIAdapter(
      { apiKey: 'test', baseUrl, maxRetries: 0 },
      { retainResponsesReasoning: 'xai' },
    );

    const { stream, response } = adapter.generateTextStream({
      ...REQUEST,
      model: 'grok-4.7',
      messages: [
        { role: 'user', content: 'look this up' },
        {
          role: 'assistant',
          content: 'checking',
          toolCalls: [
            { id: 'call_prev', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
          providerReasoning: {
            provider: 'xai',
            model: 'grok-4.7',
            blocks: [prior, { type: 'note' }],
          },
        },
        { role: 'tool', toolCallId: 'call_prev', content: 'found' },
      ],
    });
    await drain(stream);
    const result = await response;

    const input = captured[0]?.body['input'] as Array<{
      type?: string;
      role?: string;
      encrypted_content?: string;
    }>;
    const reasoningAt = input.findIndex((item) => item.type === 'reasoning');
    const assistantAt = input.findIndex(
      (item) => item.type === 'message' && item.role === 'assistant',
    );
    const callAt = input.findIndex((item) => item.type === 'function_call');
    expect(reasoningAt).toBeGreaterThanOrEqual(0);
    expect(reasoningAt).toBeLessThan(assistantAt);
    expect(assistantAt).toBeLessThan(callAt);
    expect(input[reasoningAt]).toEqual(prior);
    expect(input.filter((item) => item.type === 'reasoning')).toHaveLength(1);
    expect(result.providerReasoning).toEqual({
      provider: 'xai',
      model: 'grok-4.7',
      blocks: [{ type: 'reasoning', id: 'rs_next', encrypted_content: 'enc-next' }],
    });
  });

  it('leaves reasoning off the wire for OpenAI even when an artifact is attached', async () => {
    const baseUrl = await startServer();
    const adapter = createOpenAIAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });

    const { stream, response } = adapter.generateTextStream({
      ...REQUEST,
      messages: [
        {
          role: 'assistant',
          content: 'prior',
          providerReasoning: {
            provider: 'xai',
            model: 'grok-4.7',
            blocks: [{ type: 'reasoning', encrypted_content: 'enc' }],
          },
        },
        { role: 'user', content: 'hi' },
      ],
    });
    await drain(stream);
    const result = await response;

    const input = captured[0]?.body['input'] as Array<{ type?: string }>;
    expect(input.some((item) => item.type === 'reasoning')).toBe(false);
    expect(result.providerReasoning).toBeUndefined();
  });

  it('labels a failure while reading the xAI stream as xAI', async () => {
    const baseUrl = await startServer([
      {
        type: 'response.failed',
        response: { id: 'resp_x', error: { message: 'upstream refused' } },
      },
    ]);
    const adapter = createXaiAdapter({ apiKey: 'test', baseUrl, maxRetries: 0 });
    const { stream, response } = adapter.generateTextStream(REQUEST);
    const settled = response.catch((error: unknown) => error);

    await expect(drain(stream)).rejects.toMatchObject({ provider: 'xai' });
    await expect(settled).resolves.toMatchObject({ provider: 'xai' });
  });
});
