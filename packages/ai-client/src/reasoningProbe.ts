/**
 * The one reasoning-ladder probe: which efforts a model's provider accepts,
 * measured against the live API, and how that compares to the catalog.
 *
 * `ai.model.probe_reasoning` (with the space's stored credential) and
 * `yarn models:verify-reasoning` (with the operator's environment) both run
 * this, so the two cannot disagree about what a rung's outcome means.
 *
 * The probe talks to the provider adapter directly, never through the client:
 * the client clamps every effort to the catalog's `supported` set, which would
 * make the probe measure the catalog instead of the provider.
 */
import type {
  ReasoningDriftReport,
  ReasoningProbeError,
  ReasoningProbeInconclusiveReason,
  ReasoningProbeRequest,
  ReasoningProbeResult,
  ReasoningProbeRung,
  ReasoningProbeUsage,
  ReasoningProfileShape,
} from '@aflow/schemas';
import type { AIProviderAdapter } from './adapter.js';
import { createDefaultModelCatalog, type ModelCatalog } from './catalog.js';
import { AIClientError } from './errors.js';
import {
  REASONING_EFFORT_LADDER,
  type AIRequestOptions,
  type ModelDefinition,
  type ModelReasoningProfile,
  type ReasoningEffort,
  type TokenUsage,
  type ToolDefinition,
} from './types.js';

/**
 * Enough room for a high-effort rung to think and still call the tool on the
 * models measured so far; a rung that runs out anyway was still accepted.
 */
export const REASONING_PROBE_MAX_TOKENS = 1024;

const PROBE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'record_answer',
    description: 'Record the final answer.',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
};

const PROBE_PROMPT = 'Call record_answer with the answer "ok". Nothing else.';

const ERROR_MESSAGE_LIMIT = 2000;

export type ReasoningProbeAdapter = Pick<AIProviderAdapter, 'generateTextStream'>;

export interface ReasoningProbeOptions {
  model: ModelDefinition;
  /**
   * Called inside each rung's guard: building an adapter for a provider with
   * no key throws, and that has to read as an inconclusive rung rather than
   * abort the probe.
   */
  getAdapter: () => Promise<ReasoningProbeAdapter>;
  /** Who the requests are billed to in usage records: the step running the probe, or the script. */
  attribution: Pick<AIRequestOptions, 'tenantId' | 'runId' | 'stepExecutionId' | 'attempt'>;
  now?: () => Date;
}

/** A model the probe can measure: a chat model that declares reasoning. */
export function isReasoningProbeable(model: ModelDefinition): boolean {
  return model.capabilities.chat && model.capabilities.reasoning === true;
}

export type ReasoningProbeTarget =
  | { ok: true; model: ModelDefinition }
  | { ok: false; reason: 'unknown_model' | 'not_reasoning'; message: string };

function catalogSpelling(model: ModelDefinition): string {
  const aliases = model.aliases?.length ? ` (${model.aliases.join(', ')})` : '';
  return `${model.id}${aliases}`;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      const left = row[j - 1] ?? 0;
      row[j] = Math.min(above + 1, left + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

function leadingSegment(ref: string): string {
  return ref.toLowerCase().split(/[-/.]/)[0] ?? '';
}

function closestProbeable(ref: string, probeable: ModelDefinition[]): string[] {
  const wanted = ref.toLowerCase();
  const family = leadingSegment(wanted);
  return probeable
    .map((model) => {
      const spellings = [model.id, ...(model.aliases ?? [])];
      const distance = Math.min(...spellings.map((s) => editDistance(wanted, s.toLowerCase())));
      const sameFamily = family.length > 0 && leadingSegment(model.id) === family;
      return { id: model.id, distance, sameFamily };
    })
    .filter((m) => m.sameFamily || m.distance <= 3)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5)
    .map((m) => m.id);
}

/**
 * The catalog model a probe measures, or a refusal that teaches how a catalog
 * id is spelled. A ref the catalog does not carry is refused rather than
 * guessed at: the probe's verdict is against a catalog entry, and there is none.
 */
export function resolveReasoningProbeTarget(
  ref: string,
  catalog: ModelCatalog = createDefaultModelCatalog(),
): ReasoningProbeTarget {
  const probeable = catalog
    .listModels()
    .filter((m) => isReasoningProbeable(m) && !m.deprecated)
    .sort((a, b) => a.id.localeCompare(b.id));
  const listing = probeable.map(catalogSpelling).join(', ');
  const model = catalog.getModel(ref.trim());

  if (!model) {
    const closest = closestProbeable(ref.trim(), probeable);
    return {
      ok: false,
      reason: 'unknown_model',
      message:
        `No model "${ref}" in the model catalog, so there is no catalog entry to measure against. ` +
        'Name a catalog id or alias exactly as packages/ai-client/src/catalogModels.ts spells it: lowercase, ' +
        'hyphen-separated vendor, family and version, with dots only inside a version number ' +
        '("gpt-6.1-sol", "claude-sonnet-5-5", "gemini-3.8-flash"), or an alias such as "luna"; an OpenRouter id is ' +
        '"vendor/model" and a Fireworks id "accounts/fireworks/models/<name>". A model not in the catalog yet has to be added there before it can be measured. ' +
        (closest.length > 0 ? `Closest catalog ids: ${closest.join(', ')}. ` : '') +
        `Reasoning models the probe can measure: ${listing}.`,
    };
  }

  if (!isReasoningProbeable(model)) {
    return {
      ok: false,
      reason: 'not_reasoning',
      message:
        `"${ref}" is the catalog model ${model.id}, which is not a reasoning chat model, so it has no reasoning ` +
        `ladder to measure. Reasoning models the probe can measure: ${listing}.`,
    };
  }

  return { ok: true, model };
}

function probeError(err: unknown): ReasoningProbeError {
  if (err instanceof AIClientError) {
    return {
      code: err.code,
      message: err.message.slice(0, ERROR_MESSAGE_LIMIT),
      ...(err.providerErrorCode !== undefined ? { providerErrorCode: err.providerErrorCode } : {}),
      retryable: err.retryable,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'unknown', message: message.slice(0, ERROR_MESSAGE_LIMIT), retryable: false };
}

/**
 * A provider that cannot authenticate says nothing about its models. Read from
 * the message as well as the code: some providers answer a bad key with a 400,
 * and building an adapter with no key throws a plain error.
 */
const CREDENTIAL_FAILURE =
  /api[ _-]?key|unauthori[sz]ed|forbidden|user not found|credential|not configured|authenticat/i;

const TRANSIENT_CODES = new Set(['rate_limit', 'timeout', 'network', 'network_error']);

type RungClassification =
  | { kind: 'accepted_truncated' }
  | { kind: 'rejected'; error: ReasoningProbeError }
  | { kind: 'inconclusive'; reason: ReasoningProbeInconclusiveReason; error: ReasoningProbeError };

/**
 * Only a refusal of the request itself is evidence that a rung is rejected.
 * A rung that ran out of output budget was accepted; a refused key, a rate
 * limit, a filtered answer or an unserved model id say nothing either way.
 */
export function classifyReasoningProbeFailure(err: unknown): RungClassification {
  const error = probeError(err);
  if (error.code === 'output_truncated') return { kind: 'accepted_truncated' };
  if (error.code === 'auth' || CREDENTIAL_FAILURE.test(error.message)) {
    return { kind: 'inconclusive', reason: 'credential', error };
  }
  if (error.code === 'budget_exceeded' || TRANSIENT_CODES.has(error.code)) {
    return { kind: 'inconclusive', reason: 'transient', error };
  }
  if (error.code === 'provider_error' && error.retryable) {
    return { kind: 'inconclusive', reason: 'transient', error };
  }
  if (error.code === 'content_filter') {
    return { kind: 'inconclusive', reason: 'content_filter', error };
  }
  if (error.code === 'model_not_found') {
    return { kind: 'inconclusive', reason: 'model_unavailable', error };
  }
  return { kind: 'rejected', error };
}

function probeUsage(usage: TokenUsage): ReasoningProbeUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

async function probeRung(
  options: ReasoningProbeOptions,
  effort: ReasoningEffort,
): Promise<ReasoningProbeRung> {
  const { model } = options;
  const request: ReasoningProbeRequest = {
    providerModelId: model.providerModelId ?? model.id,
    effort,
    maxTokens: REASONING_PROBE_MAX_TOKENS,
    toolChoice: 'auto',
    tools: [PROBE_TOOL.function.name],
  };

  try {
    const adapter = await options.getAdapter();
    const { stream, response } = adapter.generateTextStream({
      model: request.providerModelId,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      tools: [PROBE_TOOL],
      toolChoice: 'auto',
      maxTokens: REASONING_PROBE_MAX_TOKENS,
      reasoning: { effort },
      maxRetries: 0,
      ...options.attribution,
      ...(model.openRouterProvider ? { openRouterProvider: model.openRouterProvider } : {}),
    });
    // The stream and the response reject together; settle the response first
    // so its rejection is never unhandled while the stream is drained.
    const settled = response.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    for await (const _chunk of stream) {
      /* drain */
    }
    const outcome = await settled;
    if (!outcome.ok) throw outcome.error;

    const { finishReason, usage } = outcome.value;
    if (finishReason === 'content_filter' || finishReason === 'error') {
      return {
        effort,
        outcome: 'inconclusive',
        request,
        reason: finishReason === 'content_filter' ? 'content_filter' : 'transient',
        error: {
          code: finishReason,
          message: `The provider ended the response with finish reason "${finishReason}".`,
          retryable: finishReason === 'error',
        },
      };
    }
    return {
      effort,
      outcome: 'accepted',
      request,
      finishReason,
      usage: probeUsage(usage),
      ...(finishReason === 'length' ? { truncated: true } : {}),
    };
  } catch (err) {
    const classified = classifyReasoningProbeFailure(err);
    if (classified.kind === 'accepted_truncated') {
      return { effort, outcome: 'accepted', request, finishReason: 'length', truncated: true };
    }
    if (classified.kind === 'rejected') {
      return { effort, outcome: 'rejected', request, error: classified.error };
    }
    return {
      effort,
      outcome: 'inconclusive',
      request,
      reason: classified.reason,
      error: classified.error,
    };
  }
}

function inLadderOrder(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(efforts);
  return REASONING_EFFORT_LADDER.filter((e) => set.has(e));
}

function list(efforts: readonly ReasoningEffort[]): string {
  return `[${efforts.join(', ')}]`;
}

/**
 * The measured rungs against the catalog's profile. Membership, not order:
 * `supported` is a set, and nothing requires the catalog to list it in ladder
 * order.
 */
export function buildReasoningDriftReport(
  declaredProfile: ModelReasoningProfile | undefined,
  rungs: readonly ReasoningProbeRung[],
): ReasoningDriftReport {
  const declared: ReasoningProfileShape = {
    supported: inLadderOrder(declaredProfile?.supported ?? []),
    ...(declaredProfile?.default !== undefined ? { default: declaredProfile.default } : {}),
  };
  const measured = inLadderOrder(
    rungs.filter((r) => r.outcome === 'accepted').map((r) => r.effort),
  );
  const rejected = inLadderOrder(
    rungs.filter((r) => r.outcome === 'rejected').map((r) => r.effort),
  );
  const inconclusiveRungs = rungs.filter(
    (r): r is Extract<ReasoningProbeRung, { outcome: 'inconclusive' }> =>
      r.outcome === 'inconclusive',
  );
  const inconclusive = inLadderOrder(inconclusiveRungs.map((r) => r.effort));

  const withheld = measured.filter((e) => !declared.supported.includes(e));
  const rejectedButDeclared = declared.supported.filter((e) => rejected.includes(e));
  const defaultRejected = declared.default !== undefined && rejected.includes(declared.default);

  const base = { declared, measured, withheld, rejectedButDeclared, defaultRejected, inconclusive };

  if (inconclusive.length > 0) {
    const reasons = [...new Set(inconclusiveRungs.map((r) => r.reason))].join(', ');
    return {
      ...base,
      verdict: 'inconclusive',
      summary:
        `Inconclusive: ${list(inconclusive)} gave no evidence (${reasons}), so the accepted set cannot be stated. ` +
        `Accepted so far ${list(measured)}, rejected ${list(rejected)}. ` +
        'Measure again once the cause is cleared; do not write the catalog from this result.',
    };
  }

  const matches =
    withheld.length === 0 && measured.length === declared.supported.length && !defaultRejected;
  if (matches) {
    return {
      ...base,
      verdict: 'match',
      summary: `The provider accepted exactly the catalog's rungs ${list(measured)} and rejected ${list(rejected)}. The catalog entry is right.`,
    };
  }

  const parts: string[] = [];
  if (withheld.length > 0) {
    parts.push(
      `The provider accepts ${list(withheld)}, which the catalog withholds: requests for them are clamped to another rung, capping quality with no error anywhere.`,
    );
  }
  if (rejectedButDeclared.length > 0) {
    parts.push(
      `The catalog offers ${list(rejectedButDeclared)}, which the provider rejects: runs that ask for them fail.`,
    );
  }
  if (defaultRejected) {
    parts.push(`The catalog default "${String(declared.default)}" is rejected by the provider.`);
  }
  if (measured.length === 0) {
    parts.push(
      'The provider accepted no rung at all: a reasoning profile needs at least one, so check the model id and whether it takes a reasoning effort before changing the catalog.',
    );
    return { ...base, verdict: 'drift', summary: parts.join(' ') };
  }
  const keptDefault =
    declared.default !== undefined && measured.includes(declared.default)
      ? declared.default
      : undefined;
  const suggestedProfile: ReasoningProfileShape = {
    supported: measured,
    ...(keptDefault !== undefined ? { default: keptDefault } : {}),
  };
  parts.push(
    `Write reasoning.supported = ${list(measured)} into catalogModels.ts` +
      (declared.default !== undefined && keptDefault === undefined
        ? ', and choose a default from it.'
        : '.'),
  );
  return { ...base, verdict: 'drift', suggestedProfile, summary: parts.join(' ') };
}

/**
 * Probe every rung of the effort ladder for one model, one minimal request
 * per rung, in ladder order. Spends real tokens.
 */
export async function probeReasoningLadder(
  options: ReasoningProbeOptions,
): Promise<ReasoningProbeResult> {
  const { model } = options;
  const rungs: ReasoningProbeRung[] = [];
  for (const effort of REASONING_EFFORT_LADDER) {
    rungs.push(await probeRung(options, effort));
  }
  return {
    modelId: model.id,
    provider: model.provider,
    providerModelId: model.providerModelId ?? model.id,
    probedAt: (options.now?.() ?? new Date()).toISOString(),
    rungs,
    accepted: rungs.filter((r) => r.outcome === 'accepted').map((r) => r.effort),
    rejected: rungs.filter((r) => r.outcome === 'rejected').map((r) => r.effort),
    drift: buildReasoningDriftReport(model.reasoning, rungs),
  };
}

/** What the probe spent, summed over the rungs the provider answered. */
export function reasoningProbeUsage(result: ReasoningProbeResult): TokenUsage | undefined {
  const answered = result.rungs.flatMap((r) =>
    r.outcome === 'accepted' && r.usage ? [r.usage] : [],
  );
  if (answered.length === 0) return undefined;
  return answered.reduce<TokenUsage>(
    (sum, u) => ({
      promptTokens: sum.promptTokens + u.promptTokens,
      completionTokens: sum.completionTokens + u.completionTokens,
      totalTokens: sum.totalTokens + u.totalTokens,
      reasoningTokens: (sum.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 },
  );
}

/** Whether a probe measured nothing because every rung's credential was refused. */
export function reasoningProbeLackedCredentials(result: ReasoningProbeResult): boolean {
  return result.rungs.every((r) => r.outcome === 'inconclusive' && r.reason === 'credential');
}
