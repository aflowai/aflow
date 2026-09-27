import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionQuestions, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import { AIClientError } from '../errors.js';
import { createTypeSafeAdapter } from './typesafe.js';

const context = {
  tenantId: 'tenant' as TenantId,
  runId: 'run' as SessionId,
  stepExecutionId: 'step' as StepExecutionId,
};

const questions: DecisionQuestions = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this',
    options: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
    minConfidence: 0.7,
  },
  frustration: { type: 'score', levels: ['Calm', 'Frustrated', 'Very angry'] },
  urgent: {
    type: 'yes_no',
    instructions: 'The message conveys urgency',
    criteria: { true: 'Explicitly time-sensitive' },
  },
};

/** A response in the shape the provider's published SDK declares for POST /v1/systemone. */
const RECORDED_RESPONSE = {
  model: 'jev-1.13.0',
  answers: {
    team: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.91,
      probabilities: { billing: 0.91, technical: 0.09 },
    },
    frustration: {
      type: 'score',
      score: 1.2,
      confidence: 0.64,
      legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' },
      probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
    },
    urgent: { type: 'noul', noul: 0.18 },
  },
  usage: { input_tokens: 212, output_tokens: 0 },
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function rejection(promise: Promise<unknown>): Promise<AIClientError> {
  const error = await promise.then(
    () => {
      throw new Error('the call resolved instead of refusing');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AIClientError);
  return error as AIClientError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TypeSafe adapter', () => {
  const adapter = createTypeSafeAdapter({ apiKey: 'not-a-real-key' });
  const request = { model: 'jev-1.13.0', state: 'Charged twice.', questions, ...context };

  it('sends the provider’s names for each question type and never the thresholds', async () => {
    const fetchMock = respond(200, RECORDED_RESPONSE);
    await adapter.decide(request);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer not-a-real-key');
    expect(JSON.parse(init.body as string)).toEqual({
      state: 'Charged twice.',
      model: 'jev-1.13.0',
      questions: {
        team: {
          type: 'choice',
          instructions: 'Which team should handle this',
          criteria: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
        },
        frustration: { type: 'score', criteria: ['Calm', 'Frustrated', 'Very angry'] },
        urgent: {
          type: 'noul',
          instructions: 'The message conveys urgency',
          criteria: { true: 'Explicitly time-sensitive' },
        },
      },
    });
  });

  it('reads the answers back in the operation’s vocabulary', async () => {
    respond(200, RECORDED_RESPONSE, { 'x-typesafe-request-id': 'req_1' });
    const response = await adapter.decide(request);

    expect(response.answers['team']).toEqual({
      type: 'choice',
      choice: 'billing',
      confidence: 0.91,
      probabilities: { billing: 0.91, technical: 0.09 },
    });
    expect(response.answers['frustration']).toMatchObject({ type: 'score', score: 1.2 });
    expect(response.answers['urgent']).toEqual({ type: 'yes_no', probability: 0.18 });
    expect(response.usage).toEqual({ promptTokens: 212, completionTokens: 0, totalTokens: 212 });
    expect(response.providerRequestId).toBe('req_1');
  });

  it('classifies a rejected key as a non-retryable auth failure', async () => {
    respond(401, { detail: 'Invalid API key' });
    const error = await rejection(adapter.decide(request));
    expect(error.code).toBe('auth');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Invalid API key');
  });

  it('classifies a rate limit as retryable and carries the provider’s wait', async () => {
    respond(429, { detail: 'slow down' }, { 'retry-after': '2' });
    const error = await rejection(adapter.decide(request));
    expect(error.code).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(2000);
  });

  it('refuses a response that is missing a question’s answer', async () => {
    const { urgent: _urgent, ...partial } = RECORDED_RESPONSE.answers;
    respond(200, { ...RECORDED_RESPONSE, answers: partial });
    const error = await rejection(adapter.decide(request));
    expect(error.code).toBe('provider_error');
    expect(error.message).toContain('urgent');
  });

  it('refuses a response in an unexpected shape', async () => {
    respond(200, { model: 'jev-1.13.0', answers: { team: { type: 'choice' } }, usage: {} });
    const error = await rejection(adapter.decide(request));
    expect(error.code).toBe('provider_error');
  });

  it('refuses every text method', () => {
    expect(() => adapter.generateText({ model: 'jev-1.13.0', messages: [], ...context })).toThrow(
      /write no text/,
    );
  });
});
