/**
 * Check every catalog `reasoning.supported` set against the live providers.
 *
 * The sets decide which efforts the client will send and which ones the
 * operator UI offers, and both failure directions are silent: a rung the
 * provider rejects fails runs mid-flight, and a rung wrongly withheld caps
 * quality with no error anywhere. Vendor docs and community reports disagreed
 * with the live APIs on three models when these sets were first written, so the
 * only trustworthy source is the API itself.
 *
 * Spends real tokens — one tiny tool-calling request per model per rung.
 * Re-run it after adding a model or bumping a version.
 *
 *   NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/verify-reasoning-profiles.ts
 *
 * Exits non-zero on any mismatch. Models whose provider key is missing or
 * rejected are reported as SKIPPED and do not fail the run — an absent key is
 * not evidence about a model.
 */
import { createAIClient, createDefaultModelCatalog } from '@aflow/ai-client';
import type { ReasoningEffort } from '@aflow/ai-client';

const EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

const PROBE_TOOL = {
  type: 'function' as const,
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

/** A provider that cannot authenticate tells us nothing about its models. */
function isCredentialFailure(message: string): boolean {
  return /auth|api key|unauthor|forbidden|user not found|credential|not configured/i.test(message);
}

const client = createAIClient({
  providers: {
    openai: { apiKey: process.env['OPENAI_API_KEY'] ?? '' },
    anthropic: { apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' },
    google: { apiKey: process.env['GEMINI_API_KEY'] ?? '' },
    fireworks: { apiKey: process.env['FIREWORKS_API_KEY'] ?? '' },
    openrouter: { apiKey: process.env['OPENROUTER_API_KEY'] ?? '' },
    xai: { apiKey: process.env['XAI_API_KEY'] ?? '' },
  },
});

const catalog = createDefaultModelCatalog();

async function acceptedEfforts(
  model: ReturnType<typeof catalog.listModels>[number],
): Promise<{ accepted: ReasoningEffort[]; rejections: string[]; credentialsFailed: boolean }> {
  const accepted: ReasoningEffort[] = [];
  const rejections: string[] = [];
  let credentialsFailed = false;

  for (const effort of EFFORTS) {
    try {
      // Inside the guard: building an adapter for a provider with no key throws
      // immediately, and that has to read as SKIPPED like any other credential
      // failure rather than abort the whole run.
      const adapter = await client.getAdapter(model.id, model.provider);
      const { stream, response } = adapter.generateTextStream({
        model: model.providerModelId ?? model.id,
        messages: [
          { role: 'user', content: 'Call record_answer with the answer "ok". Nothing else.' },
        ],
        tools: [PROBE_TOOL],
        toolChoice: 'auto',
        maxTokens: 1024,
        reasoning: { effort },
        maxRetries: 0,
        ...(model.openRouterProvider ? { openRouterProvider: model.openRouterProvider } : {}),
      });
      // Settle both halves: the stream and the response promise reject together.
      const settled = response.catch((e: unknown) => e);
      for await (const _chunk of stream) {
        /* drain */
      }
      const outcome = await settled;
      if (outcome instanceof Error) throw outcome;
      accepted.push(effort);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCredentialFailure(message)) credentialsFailed = true;
      rejections.push(`${effort}: ${message.slice(0, 100).replace(/\s+/g, ' ')}`);
    }
  }

  return { accepted, rejections, credentialsFailed };
}

async function main(): Promise<void> {
  const targets = catalog
    .listModels()
    .filter((m) => m.capabilities.chat && m.capabilities.reasoning === true && !m.deprecated);

  let mismatches = 0;
  let skipped = 0;

  for (const model of targets) {
    const { accepted, rejections, credentialsFailed } = await acceptedEfforts(model);
    const declared = model.reasoning?.supported ?? [];

    if (credentialsFailed) {
      skipped += 1;
      console.log(`SKIPPED   ${model.id} [${model.provider}] — provider credentials rejected`);
      continue;
    }

    // Membership, not order: `supported` is a set, and nothing requires the
    // catalog to list its rungs in ladder order.
    const matches =
      declared.length === accepted.length && declared.every((e) => accepted.includes(e));
    if (matches) {
      console.log(`OK        ${model.id} [${accepted.join(', ')}]`);
      continue;
    }

    mismatches += 1;
    console.log(`MISMATCH  ${model.id} [${model.provider}]`);
    console.log(`            declared: [${declared.join(', ') || 'none'}]`);
    console.log(`            measured: [${accepted.join(', ') || 'none'}]`);
    for (const r of rejections) console.log(`            rejected  ${r}`);
  }

  console.log(
    `\n${String(targets.length - skipped)} checked, ${String(mismatches)} mismatched, ${String(skipped)} skipped`,
  );
  if (mismatches > 0) process.exitCode = 1;
}

void main();
