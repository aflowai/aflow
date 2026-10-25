/**
 * Check catalog `reasoning.supported` sets against the live providers, with the
 * provider keys in the operator's environment.
 *
 * A thin runner over `probeReasoningLadder` in `@aflow/ai-client` — the same
 * probe `ai.model.probe_reasoning` runs with a space's stored credential, so
 * the two cannot disagree. An agent measures through that operation; this is
 * for an operator checking the whole catalog at once.
 *
 * Spends real tokens — one tiny tool-calling request per model per rung.
 *
 *   yarn models:verify-reasoning                 # every reasoning model
 *   yarn models:verify-reasoning gemini-3.8-flash # one or more named models
 *
 * Exits non-zero on drift, and on a model whose measurement was inconclusive
 * for any reason but a missing or refused key — an absent key is not evidence
 * about a model, so those are SKIPPED.
 */
import {
  createAIClient,
  createDefaultModelCatalog,
  isReasoningProbeable,
  probeReasoningLadder,
  reasoningProbeLackedCredentials,
  resolveReasoningProbeTarget,
} from '@aflow/ai-client';
import type { ModelDefinition, ReasoningProbeOptions } from '@aflow/ai-client';

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

const attribution = {
  tenantId: 'models-verify-reasoning',
  runId: 'models-verify-reasoning',
  stepExecutionId: 'models-verify-reasoning',
} as ReasoningProbeOptions['attribution'];

function targets(refs: string[]): ModelDefinition[] {
  if (refs.length === 0) {
    return catalog.listModels().filter((m) => isReasoningProbeable(m) && !m.deprecated);
  }
  return refs.map((ref) => {
    const target = resolveReasoningProbeTarget(ref, catalog);
    if (!target.ok) {
      console.error(target.message);
      process.exit(2);
    }
    return target.model;
  });
}

async function main(): Promise<void> {
  const models = targets(process.argv.slice(2));
  let drifted = 0;
  let inconclusive = 0;
  let skipped = 0;

  for (const model of models) {
    const result = await probeReasoningLadder({
      model,
      getAdapter: () => client.getAdapter(model.id, model.provider),
      attribution,
    });
    const { drift } = result;

    if (reasoningProbeLackedCredentials(result)) {
      skipped += 1;
      console.log(
        `SKIPPED       ${model.id} [${model.provider}] — provider credentials missing or rejected`,
      );
      continue;
    }
    if (drift.verdict === 'match') {
      console.log(`OK            ${model.id} [${drift.measured.join(', ')}]`);
      continue;
    }

    if (drift.verdict === 'drift') drifted += 1;
    else inconclusive += 1;
    console.log(
      `${drift.verdict === 'drift' ? 'MISMATCH    ' : 'INCONCLUSIVE'}  ${model.id} [${model.provider}]`,
    );
    console.log(`              declared: [${drift.declared.supported.join(', ') || 'none'}]`);
    console.log(`              measured: [${drift.measured.join(', ') || 'none'}]`);
    for (const rung of result.rungs) {
      if (rung.outcome === 'accepted') continue;
      const label = rung.outcome === 'rejected' ? 'rejected' : `no evidence (${rung.reason})`;
      console.log(
        `              ${rung.effort}: ${label} — ${rung.error.message.slice(0, 160).replace(/\s+/g, ' ')}`,
      );
    }
    console.log(`              ${drift.summary}`);
  }

  console.log(
    `\n${String(models.length - skipped)} checked, ${String(drifted)} mismatched, ${String(inconclusive)} inconclusive, ${String(skipped)} skipped`,
  );
  if (drifted > 0 || inconclusive > 0) process.exitCode = 1;
}

void main();
