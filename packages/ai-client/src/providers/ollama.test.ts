import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { createAIClient } from '../client.js';
import { AIClientError } from '../errors.js';
import { createOllamaAdapter } from './ollama.js';

const context = {
  tenantId: 'tenant' as TenantId,
  runId: 'run' as SessionId,
  stepExecutionId: 'step' as StepExecutionId,
};

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

/** Answers each request with the next responder's result and records what was sent. */
function runtime(...responders: Array<(body: Record<string, unknown>) => Response>) {
  const sent: Sent[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ url: String(url), method: init?.method ?? 'GET', body });
    const next = responders[Math.min(sent.length - 1, responders.length - 1)];
    if (!next) throw new Error('no responder');
    return next(body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return sent;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const done = (message: Record<string, unknown>, counts: { prompt: number; eval: number }) => () =>
  json({
    model: 'gemma4:26b',
    message: { role: 'assistant', ...message },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: counts.prompt,
    eval_count: counts.eval,
  });

async function rejection(promise: Promise<unknown>): Promise<AIClientError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AIClientError);
  return error as AIClientError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the context window', () => {
  it('is the smaller of the connection and the catalog, and is sent on every request', async () => {
    const sent = runtime(done({ content: 'ok' }, { prompt: 12, eval: 1 }));
    const client = createAIClient({
      providers: { ollama: { contextTokens: 16_384 } },
      defaultProvider: 'ollama',
    });

    expect(client.contextWindowFor('ollama-gemma4-26b')).toBe(16_384);
    await client.generateText({
      ...context,
      model: 'ollama-gemma4-26b',
      messages: [{ role: 'user', content: 'Say ok.' }],
    });

    expect(sent[0]?.body['model']).toBe('gemma4:26b');
    expect((sent[0]?.body['options'] as Record<string, unknown>)['num_ctx']).toBe(16_384);
  });

  it('refuses a prompt that cannot fit before sending it, naming its size and the window', async () => {
    const big = 'The orchestrator writes durable state. '.repeat(1000);
    const sent = runtime(done({ content: '' }, { prompt: 9_000, eval: 1 }));
    const adapter = createOllamaAdapter({ contextTokens: 8192 });

    const error = await rejection(
      adapter.generateText({
        ...context,
        model: 'gemma4:26b',
        messages: [{ role: 'user', content: big }],
      }),
    );

    expect(error.code).toBe('context_length');
    expect(error.message).toContain('9000 prompt tokens');
    expect(error.message).toContain('8192-token window');
    // Only the one-token count went out; the request itself was never sent.
    expect(sent).toHaveLength(1);
    expect((sent[0]?.body['options'] as Record<string, unknown>)['num_predict']).toBe(1);
  });

  it('gives the answer what the window has left once the prompt is counted exactly', async () => {
    const prompt = 'Plain English prose for the model to read. '.repeat(400);
    const sent = runtime(
      done({ content: '' }, { prompt: 3_600, eval: 1 }),
      done({ content: 'ok' }, { prompt: 3_600, eval: 2 }),
    );
    const adapter = createOllamaAdapter({ contextTokens: 8192 });

    await adapter.generateText({
      ...context,
      model: 'gemma4:26b',
      maxTokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    expect(sent).toHaveLength(2);
    expect((sent[1]?.body['options'] as Record<string, unknown>)['num_predict']).toBe(8192 - 3_600);
  });

  it('fails a response whose runtime evaluated less than the prompt can hold', async () => {
    // The llama.cpp runner cuts an over-long prompt from the front and says
    // nothing; what it reports evaluating is the only trace.
    const prompt = 'A sentence the model has to read in full. '.repeat(200);
    runtime(done({ content: 'answer about marbles' }, { prompt: 40, eval: 4 }));
    const adapter = createOllamaAdapter({ contextTokens: 32_768 });

    const error = await rejection(
      adapter.generateText({
        ...context,
        model: 'qwen3.5:4b-q4_K_M',
        messages: [{ role: 'user', content: prompt }],
      }),
    );

    expect(error.code).toBe('context_length');
    expect(error.message).toContain('Ollama read 40 tokens');
  });

  it('counts a prompt carrying an image exactly, since characters cannot size one', async () => {
    const sent = runtime(
      done({ content: '' }, { prompt: 540, eval: 1 }),
      done({ content: 'a red square' }, { prompt: 540, eval: 3 }),
    );
    const adapter = createOllamaAdapter({ contextTokens: 32_768 });

    await adapter.generateText({
      ...context,
      model: 'gemma4:26b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
            },
          ],
        },
      ],
    });

    expect(sent).toHaveLength(2);
    expect((sent[0]?.body['options'] as Record<string, unknown>)['num_predict']).toBe(1);
    expect((sent[1]?.body['messages'] as Array<Record<string, unknown>>)[0]?.['images']).toEqual([
      'iVBORw0KGgo=',
    ]);
  });
});

describe('tool calls', () => {
  it('carries arguments as JSON text out and as objects in, keeping each call id', async () => {
    const sent = runtime(
      done(
        {
          content: '',
          tool_calls: [
            { id: 'call_a', function: { name: 'get_weather', arguments: { city: 'Berlin' } } },
            { id: 'call_b', function: { name: 'get_weather', arguments: { city: 'Paris' } } },
          ],
        },
        { prompt: 71, eval: 28 },
      ),
    );
    const adapter = createOllamaAdapter({});

    const response = await adapter.generateText({
      ...context,
      model: 'gemma4:26b',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'prev',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: 'tool', toolCallId: 'prev', name: 'get_weather', content: 'sunny' },
      ],
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
      ],
    });

    expect(response.finishReason).toBe('tool_calls');
    expect(response.toolCalls?.map((c) => [c.id, c.function.arguments])).toEqual([
      ['call_a', '{"city":"Berlin"}'],
      ['call_b', '{"city":"Paris"}'],
    ]);
    const messages = sent[0]?.body['messages'] as Array<Record<string, unknown>>;
    expect(messages[1]?.['tool_calls']).toEqual([
      { function: { name: 'get_weather', arguments: { city: 'Rome' } } },
    ]);
    expect(messages[2]).toMatchObject({ role: 'tool', tool_name: 'get_weather', content: 'sunny' });
  });
});

describe('streaming', () => {
  it('yields deltas as they arrive and resolves with the final counts', async () => {
    const lines = [
      { message: { thinking: 'Let me see. ' }, done: false },
      { message: { content: 'Hello' }, done: false },
      { message: { content: ' world' }, done: false },
      {
        message: { content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 20,
        eval_count: 3,
      },
    ];
    runtime(
      () =>
        new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    const adapter = createOllamaAdapter({});
    const progress = vi.fn();

    const { stream, response } = adapter.generateTextStream({
      ...context,
      model: 'gemma4:26b',
      messages: [{ role: 'user', content: 'Hi' }],
      onStreamProgress: progress,
    });
    const deltas: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta' && chunk.delta) deltas.push(chunk.delta);
    }

    expect(deltas).toEqual(['Hello', ' world']);
    const final = await response;
    expect(final.content).toBe('Hello world');
    expect(final.thinking).toBe('Let me see. ');
    expect(final.usage).toEqual({ promptTokens: 20, completionTokens: 3, totalTokens: 23 });
    expect(progress).toHaveBeenCalledTimes(4);
  });
});

describe('structured output', () => {
  const schema = z.object({ answer: z.number() });

  it('rides a tool when the runner refuses `format`, and stops asking for it', async () => {
    const sent = runtime(
      () => json({ error: 'structured output is unavailable' }, 501),
      done(
        {
          content: '',
          tool_calls: [{ function: { name: 'response', arguments: { answer: 391 } } }],
        },
        { prompt: 160, eval: 8 },
      ),
      done(
        { content: '', tool_calls: [{ function: { name: 'response', arguments: { answer: 7 } } }] },
        { prompt: 160, eval: 8 },
      ),
    );
    const adapter = createOllamaAdapter({});
    const ask = {
      ...context,
      model: 'gemma4:26b',
      schema,
      messages: [{ role: 'user' as const, content: '17*23?' }],
    };

    const first = await adapter.generateJson(ask);
    const second = await adapter.generateJson(ask);

    expect(first.data).toEqual({ answer: 391 });
    expect(second.data).toEqual({ answer: 7 });
    expect(sent[0]?.body['format']).toBeDefined();
    expect(sent[1]?.body['format']).toBeUndefined();
    expect(sent[1]?.body['tools']).toBeDefined();
    expect(sent[2]?.body['format']).toBeUndefined();
  });

  it('uses `format` where the runner supports it', async () => {
    const sent = runtime(done({ content: '{"answer": 391}' }, { prompt: 30, eval: 8 }));
    const adapter = createOllamaAdapter({});

    const result = await adapter.generateJson({
      ...context,
      model: 'qwen3.5:4b-q4_K_M',
      schema,
      messages: [{ role: 'user', content: '17*23?' }],
    });

    expect(result.data).toEqual({ answer: 391 });
    expect(sent[0]?.body['format']).toMatchObject({ type: 'object' });
  });
});

describe('reasoning', () => {
  it('turns thinking off for `off` and passes any other effort as the level', async () => {
    const sent = runtime(done({ content: 'ok' }, { prompt: 5, eval: 1 }));
    const adapter = createOllamaAdapter({});

    await adapter.generateText({
      ...context,
      model: 'm',
      reasoning: { effort: 'off' },
      messages: [{ role: 'user', content: 'x' }],
    });
    await adapter.generateText({
      ...context,
      model: 'm',
      reasoning: { effort: 'high' },
      messages: [{ role: 'user', content: 'x' }],
    });
    await adapter.generateText({
      ...context,
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(sent.map((s) => s.body['think'])).toEqual([false, 'high', undefined]);
  });
});

describe('embeddings', () => {
  it('refuses to have an over-long input cut silently', async () => {
    const sent = runtime(() =>
      json({ model: 'qwen3-embedding:4b', embeddings: [[0.1, 0.2]], prompt_eval_count: 4 }),
    );
    const adapter = createOllamaAdapter({});

    const result = await adapter.generateEmbedding({
      ...context,
      model: 'qwen3-embedding:4b',
      input: 'hello',
      dimensions: 1536,
    });

    expect(sent[0]?.url).toBe('http://127.0.0.1:11434/api/embed');
    expect(sent[0]?.body).toMatchObject({ truncate: false, dimensions: 1536 });
    expect(result.dimensions).toBe(2);
  });
});

describe('failures', () => {
  it('names the URL when the runtime is not answering', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const adapter = createOllamaAdapter({ baseUrl: 'http://127.0.0.1:11434/' });

    const error = await rejection(
      adapter.generateText({ ...context, model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    );

    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('http://127.0.0.1:11434');
  });

  it('tells the operator how to download a model the runtime does not have', async () => {
    runtime(() => json({ error: "model 'gemma4:26b' not found" }, 404));
    const adapter = createOllamaAdapter({});

    const error = await rejection(
      adapter.generateText({
        ...context,
        model: 'gemma4:26b',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );

    expect(error.code).toBe('model_not_found');
    expect(error.message).toContain('ollama pull gemma4:26b');
  });

  it('sends the proxy token only when the connection has one', async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return done({ content: 'ok' }, { prompt: 5, eval: 1 })();
      }),
    );

    await createOllamaAdapter({ apiKey: '' }).generateText({
      ...context,
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    await createOllamaAdapter({ apiKey: 'secret' }).generateText({
      ...context,
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(seen[0]?.['authorization']).toBeUndefined();
    expect(seen[1]?.['authorization']).toBe('Bearer secret');
  });
});
