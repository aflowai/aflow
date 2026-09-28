/**
 * TypeSafe — decision models. One endpoint takes a state and named questions
 * and answers every question in a single pass with a probability distribution.
 * There is no text lane: the model cannot generate.
 */
import { z } from 'zod';
import type { DecisionQuestion, DecisionQuestions } from '@aflow/schemas';
import type {
  DecideRequest,
  DecideResponse,
  ProviderConfig,
  ProviderDecisionAnswer,
} from '../types.js';
import type { AIProviderAdapter } from '../adapter.js';
import { AIClientError } from '../errors.js';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_TIMEOUT_MS = 30_000;
const REQUEST_ID_HEADER = 'x-typesafe-request-id';

function noTextLane(method: string): never {
  throw new AIClientError(
    `TypeSafe serves decision models, which write no text, so ${method} has nothing to call`,
    'model_not_found',
    'typesafe',
    false,
  );
}

/**
 * The provider's names for the three question types. The operation's
 * vocabulary is its own so that a skill never names a vendor; this is the one
 * place the two meet.
 */
export function toWireQuestion(question: DecisionQuestion): Record<string, unknown> {
  const instructions =
    question.instructions !== undefined ? { instructions: question.instructions } : {};
  switch (question.type) {
    case 'choice':
      return { type: 'choice', ...instructions, criteria: question.options };
    case 'score':
      return { type: 'score', ...instructions, criteria: question.levels };
    case 'yes_no':
      return {
        type: 'noul',
        ...instructions,
        ...(question.criteria !== undefined ? { criteria: question.criteria } : {}),
      };
  }
}

function toWireQuestions(questions: DecisionQuestions): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(questions).map(([name, question]) => [name, toWireQuestion(question)]),
  );
}

const probabilitySchema = z.number().min(0).max(1);

const WireAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: probabilitySchema,
    probabilities: z.record(z.string(), probabilitySchema),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    confidence: probabilitySchema,
    probabilities: z.record(z.string(), probabilitySchema),
  }),
  z.object({ type: z.literal('noul'), noul: probabilitySchema }),
]);

const WireResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), WireAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

function fromWireAnswer(answer: z.infer<typeof WireAnswerSchema>): ProviderDecisionAnswer {
  switch (answer.type) {
    case 'choice':
      return answer;
    case 'score':
      return answer;
    case 'noul':
      return { type: 'yes_no', probability: answer.noul };
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function classify(status: number): 'auth' | 'rate_limit' | 'invalid_request' | 'provider_error' {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'provider_error';
}

/** `retry-after-ms` when present, else `retry-after` in seconds. */
function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}

/** The provider's own explanation of a refusal, whichever field it arrived in. */
function refusalMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const detail = parsed['detail'] ?? parsed['message'] ?? parsed['error'];
    if (typeof detail === 'string' && detail !== '') return detail;
    const nested =
      detail !== null && typeof detail === 'object'
        ? (detail as Record<string, unknown>)['message']
        : undefined;
    if (typeof nested === 'string' && nested !== '') return nested;
    if (detail !== undefined) return JSON.stringify(detail);
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body.trim() !== '' ? body.trim() : `TypeSafe answered HTTP ${String(status)}`;
}

async function callSystemOne(
  request: DecideRequest,
  config: ProviderConfig,
): Promise<Omit<DecideResponse, 'cost' | 'provider'>> {
  const apiKey = config.apiKey;
  if (apiKey === undefined || apiKey === '') {
    throw new AIClientError('TypeSafe API key is required', 'auth', 'typesafe', false);
  }
  const callerAborted = (): boolean => request.signal?.aborted === true;
  if (callerAborted()) {
    throw new AIClientError(
      'The run was cancelled before TypeSafe was called',
      'timeout',
      'typesafe',
      false,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => {
      controller.abort();
    },
    request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const abort = () => {
    controller.abort();
  };
  request.signal?.addEventListener('abort', abort);

  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: request.state,
        questions: toWireQuestions(request.questions),
        model: request.model,
      }),
      signal: controller.signal,
    });
    // Read under the same guard as the request, so a body that stalls after
    // its headers is still bounded by the timeout and the caller's signal.
    text = await response.text();
  } catch (error) {
    const timedOut = controller.signal.aborted && !callerAborted();
    throw new AIClientError(
      timedOut
        ? 'TypeSafe did not answer within the timeout'
        : `TypeSafe could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      timedOut ? 'timeout' : 'network',
      'typesafe',
      !callerAborted(),
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
  }

  const providerRequestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
  if (!response.ok) {
    const wait = response.status === 429 ? retryAfterMs(response.headers) : undefined;
    throw new AIClientError(
      refusalMessage(text, response.status),
      classify(response.status),
      'typesafe',
      isRetryableStatus(response.status),
      {
        providerErrorCode: String(response.status),
        ...(providerRequestId !== undefined ? { providerRequestId } : {}),
        ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AIClientError(
      'TypeSafe answered with a body that is not JSON',
      'provider_error',
      'typesafe',
      true,
      providerRequestId !== undefined ? { providerRequestId } : undefined,
    );
  }
  const parsed = WireResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AIClientError(
      `TypeSafe answered in an unexpected shape: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      'provider_error',
      'typesafe',
      false,
      providerRequestId !== undefined ? { providerRequestId } : undefined,
    );
  }

  const missing = Object.keys(request.questions).filter(
    (name) => parsed.data.answers[name] === undefined,
  );
  if (missing.length > 0) {
    throw new AIClientError(
      `TypeSafe returned no answer for ${missing.join(', ')}`,
      'provider_error',
      'typesafe',
      false,
      providerRequestId !== undefined ? { providerRequestId } : undefined,
    );
  }

  const { input_tokens: promptTokens, output_tokens: completionTokens } = parsed.data.usage;
  return {
    model: parsed.data.model,
    answers: Object.fromEntries(
      Object.entries(parsed.data.answers).map(([name, answer]) => [name, fromWireAnswer(answer)]),
    ),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
  };
}

export function createTypeSafeAdapter(
  config: ProviderConfig,
): AIProviderAdapter & Required<Pick<AIProviderAdapter, 'decide'>> {
  return {
    provider: 'typesafe',
    generateText: () => noTextLane('generateText'),
    generateTextStream: () => noTextLane('generateTextStream'),
    generateJson: () => noTextLane('generateJson'),
    generateEmbedding: () => noTextLane('generateEmbedding'),
    decide: (request) => callSystemOne(request, config),
  };
}
