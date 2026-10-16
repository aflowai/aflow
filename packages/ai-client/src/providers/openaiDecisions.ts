/**
 * OpenAI's Decisions API (`POST /v1/decisions`). One request answers up to
 * 200 independent questions about a shared input — text, or user messages
 * carrying text and images — and any question may be refused while the others
 * are answered.
 */
import type OpenAI from 'openai';
import { z } from 'zod';
import type { DecisionEntry, DecisionQuestion } from '@aflow/schemas';
import type { DecideRequest, DecideResponse, ProviderDecisionAnswer } from '../types.js';
import { AIClientError, normalizeOpenAIError } from '../errors.js';

/** The longest question list one request may carry. */
export const OPENAI_DECISION_QUESTIONS_PER_CALL = 200;

function entryText(entry: DecisionEntry | null | undefined): string | undefined {
  if (entry === null || entry === undefined) return undefined;
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

/**
 * Every question type requires instructions here, where the operation leaves
 * them optional; an absent one is stated from what the question does carry.
 */
export function toOpenAIQuestion(
  name: string,
  question: DecisionQuestion,
): Record<string, unknown> {
  const instructions = entryText(question.instructions);
  switch (question.type) {
    case 'choice':
      return {
        type: 'choice',
        name,
        instructions: instructions ?? 'Choose the option that best fits the input.',
        choices: Object.entries(question.options).map(([value, description]) => {
          const text = entryText(description);
          return text !== undefined ? { value, description: text } : { value };
        }),
      };
    case 'score':
      return {
        type: 'score',
        name,
        instructions: instructions ?? 'Rate the input against the levels, lowest first.',
        levels: question.levels.map((level, index) =>
          typeof level === 'string'
            ? { label: level }
            : level === null
              ? { label: `level ${String(index)}` }
              : { label: `level ${String(index)}`, description: JSON.stringify(level) },
        ),
      };
    case 'yes_no': {
      const whenTrue = entryText(question.criteria?.true);
      const whenFalse = entryText(question.criteria?.false);
      const criteria = [
        ...(whenTrue !== undefined ? [`True when: ${whenTrue}`] : []),
        ...(whenFalse !== undefined ? [`False when: ${whenFalse}`] : []),
      ];
      return {
        type: 'predicate',
        name,
        instructions: [instructions, ...criteria].filter((t) => t !== undefined).join('\n'),
      };
    }
  }
}

const probability = z.number().min(0).max(1);

const WireAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string().nullable(), probability }),
  z.object({
    type: z.literal('choice'),
    name: z.string().nullable(),
    choice: z.union([z.string(), z.boolean()]),
    confidence: probability,
    probabilities: z.array(z.object({ value: z.union([z.string(), z.boolean()]), probability })),
  }),
  z.object({
    type: z.literal('score'),
    name: z.string().nullable(),
    score: z.number(),
    confidence: probability,
    probabilities: z.array(z.object({ value: z.number(), label: z.string(), probability })),
  }),
  z.object({ type: z.literal('refusal'), name: z.string().nullable() }),
]);

const WireDecisionSchema = z.object({
  model: z.string(),
  answers: z.array(WireAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

function fromWireAnswer(answer: z.infer<typeof WireAnswerSchema>): ProviderDecisionAnswer {
  switch (answer.type) {
    case 'predicate':
      return { type: 'yes_no', probability: answer.probability };
    case 'choice':
      return {
        type: 'choice',
        choice: String(answer.choice),
        confidence: answer.confidence,
        probabilities: Object.fromEntries(
          answer.probabilities.map((p) => [String(p.value), p.probability]),
        ),
      };
    case 'score':
      return {
        type: 'score',
        score: answer.score,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(
          answer.probabilities.map((p) => [String(p.value), p.probability]),
        ),
      };
    case 'refusal':
      return { type: 'refusal' };
  }
}

export async function decideWithOpenAI(
  client: OpenAI,
  request: DecideRequest,
): Promise<Omit<DecideResponse, 'cost' | 'provider'>> {
  const text = typeof request.state === 'string' ? request.state : JSON.stringify(request.state);
  const images = request.images ?? [];
  const body = {
    model: request.model,
    input:
      images.length === 0
        ? text
        : [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text },
                ...images.map((image) => ({
                  type: 'input_image',
                  image_url: `data:${image.mimeType};base64,${image.data}`,
                })),
              ],
            },
          ],
    questions: Object.entries(request.questions).map(([name, question]) =>
      toOpenAIQuestion(name, question),
    ),
  };

  let raw: unknown;
  try {
    raw = await client.post('/decisions', {
      body,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs !== undefined ? { timeout: request.timeoutMs } : {}),
    });
  } catch (error) {
    throw normalizeOpenAIError(error);
  }

  const parsed = WireDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AIClientError(
      `OpenAI Decisions answered in an unexpected shape: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      'provider_error',
      'openai',
      false,
    );
  }

  // Answers come back in question order; the echoed name is the key, and the
  // position covers an answer whose name was not echoed.
  const names = Object.keys(request.questions);
  const answers: Record<string, ProviderDecisionAnswer> = {};
  parsed.data.answers.forEach((answer, index) => {
    const name = answer.name ?? names[index];
    if (name !== undefined) answers[name] = fromWireAnswer(answer);
  });

  const { input_tokens: promptTokens, output_tokens: completionTokens } = parsed.data.usage;
  return {
    model: parsed.data.model,
    answers,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
  };
}
