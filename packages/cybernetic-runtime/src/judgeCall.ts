/**
 * The single low-level Judge LLM call (Plan 269 D8): one
 * `generateJson` round-trip at temperature 0, shared by the production
 * suite path (`evaluateJudgeCriterion`) and the batch rubric stage so the
 * two judges can never drift apart in prompt, schema, or sampling.
 */
import { randomUUID } from 'node:crypto';
import type { AIClient } from '@aflow/ai-client';
import type {
  JudgeCriterion,
  JudgeVerdict,
  SessionId,
  StepExecutionId,
  TenantId,
} from '@aflow/schemas';
import {
  JUDGE_CRITERION_MAX_CHARS,
  JUDGE_ENTRY_RATIONALE_MAX_CHARS,
  JUDGE_MAX_RUBRIC_ENTRIES,
  JudgeVerdictSchema,
} from '@aflow/schemas';
import {
  buildJudgeUserMessage,
  getJudgeSystemPrompt,
  type JudgeMessageContext,
} from './prompts/judge.js';

/**
 * Derived from the schema, and deliberately pessimistic.
 *
 * The budget has to hold the worst response the schema ALLOWS, counting every
 * field of every entry — an earlier version summed the rationale alone and ran
 * short of the echoed criterion, which truncates into unparseable JSON and
 * surfaces as a dispatch failure rather than as the budget it is.
 *
 * One token per character, not the usual four: four is an average for ordinary
 * English, and a criterion may hold code, punctuation or Arabic, which tokenize
 * near or above one token per character. This is a CEILING, not a reservation —
 * the call is billed for what it generates — so the cost of being generous is
 * nothing and the cost of being tight is a discarded judgement.
 */
const JUDGE_ENTRY_STRUCTURE_CHARS = 120;
const JUDGE_VERDICT_CHARS = 'fail'.length;
const WORST_CASE_CHARS_PER_TOKEN = 1;
const JUDGE_VERDICT_MAX_TOKENS =
  JUDGE_MAX_RUBRIC_ENTRIES *
  (JUDGE_ENTRY_RATIONALE_MAX_CHARS +
    JUDGE_CRITERION_MAX_CHARS +
    JUDGE_VERDICT_CHARS +
    JUDGE_ENTRY_STRUCTURE_CHARS) *
  WORST_CASE_CHARS_PER_TOKEN;

export type JudgeEvidence = Omit<JudgeMessageContext, 'criterion'>;

export interface JudgeCallParams {
  client: AIClient;
  model: string;
  criterion: JudgeCriterion;
  evidence: JudgeEvidence;
  tenantId: string;
  /** Attribution id for usage accounting (the run/session being judged). */
  attributionId: string;
}

export interface JudgeCallResult {
  verdict: JudgeVerdict;
  /**
   * The call's own LLM spend in fractional cents (0 when the catalog cannot
   * price the model) — callers that meter against a cost ceiling round once
   * at their accounting boundary.
   */
  costCents: number;
}

/** Throws on any dispatch/parse failure — callers own the typed-error contract. */
export async function callJudgeModel(params: JudgeCallParams): Promise<JudgeCallResult> {
  const { client, model, criterion, evidence, tenantId, attributionId } = params;
  const userMessage = buildJudgeUserMessage({ criterion, ...evidence });

  const result = await client.generateJson<JudgeVerdict>({
    model,
    messages: [
      { role: 'system', content: getJudgeSystemPrompt() },
      { role: 'user', content: userMessage },
    ],
    schema: JudgeVerdictSchema,
    schemaName: 'JudgeVerdict',
    schemaDescription:
      'One entry per rubric criterion: echo the criterion, give the critique that drove your ' +
      'answer, then the binary verdict. The overall result is derived from the entries — do ' +
      'not return a top-level verdict or score.',
    temperature: 0,
    // A judge's reasoning belongs in its rationale, which the verdict schema
    // already demands before the verdict and which an operator can audit and
    // calibrate against. Hidden thinking is neither readable nor reproducible,
    // and it competes with the verdict for the same tokens. Models that cannot
    // turn it off clamp to their nearest rung.
    reasoning: { effort: 'off' },
    maxTokens: JUDGE_VERDICT_MAX_TOKENS,
    tenantId: tenantId as TenantId,
    runId: attributionId as SessionId,
    stepExecutionId: randomUUID() as StepExecutionId,
  });

  return { verdict: result.data, costCents: (result.cost?.totalCost ?? 0) * 100 };
}
