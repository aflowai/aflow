/**
 * Check every catalog decision profile against the live providers.
 *
 * A profile decides how the client splits a request and whether a decision may
 * carry images, and a wrong one fails silently in one direction: a limit set
 * too low splits requests for nothing, and a capability wrongly withheld
 * refuses steps the model could run. So the profile is written from the API,
 * and this re-reads it.
 *
 * Spends real tokens — a few small requests per model, and one request at the
 * per-call limit. Re-run it after adding a decision model or bumping a version.
 *
 *   NODE_OPTIONS='--conditions=ts-source' npx tsx scripts/verify-decision-profiles.ts
 *
 * Exits non-zero on any mismatch. A model whose provider key is missing or
 * rejected is reported as SKIPPED: an absent key is not evidence about a model.
 * Calibration is not probed here — it is measured against labelled sets by an
 * eval batch, which a handful of calls cannot stand in for.
 */
import { createAIClient, createDefaultModelCatalog } from '@aflow/ai-client';
import type { DecisionQuestions, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';

/** A 1×1 transparent PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const context = {
  tenantId: 'verify' as TenantId,
  runId: 'verify' as SessionId,
  stepExecutionId: 'verify' as StepExecutionId,
};

const client = createAIClient({
  providers: {
    openai: { apiKey: process.env['OPENAI_API_KEY'] ?? '' },
    typesafe: { apiKey: process.env['TYPESAFE_API_KEY'] ?? '' },
  },
});

function isCredentialFailure(message: string): boolean {
  return /auth|api key|unauthor|forbidden|credential|not configured|required/i.test(message);
}

function yesNo(count: number): DecisionQuestions {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `q_${String(i)}`,
      { type: 'yes_no' as const, instructions: `The message mentions the number ${String(i)}.` },
    ]),
  );
}

const ALL_TYPES: DecisionQuestions = {
  team: {
    type: 'choice',
    instructions: 'Which team owns this message',
    options: { billing: 'Payments and refunds', technical: 'Bugs and outages' },
  },
  severity: { type: 'score', instructions: 'How severe is it', levels: ['minor', 'major'] },
  urgent: { type: 'yes_no', instructions: 'The message is time-sensitive' },
};

let failures = 0;
const report = (line: string, ok: boolean) => {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${line}`);
};

for (const model of createDefaultModelCatalog().listModels()) {
  const profile = model.decision;
  if (!profile) continue;
  const ref = model.aliases?.[0] ?? model.id;
  console.log(`\n${ref} (${model.provider})`);

  const adapter = await client.getAdapter(model.id, model.provider).catch(() => undefined);
  if (!adapter?.decide) {
    console.log('  SKIPPED — no adapter');
    continue;
  }
  const decide = (
    questions: DecisionQuestions,
    images?: Array<{ data: string; mimeType: string }>,
  ) =>
    adapter.decide!({
      model: model.providerModelId ?? model.id,
      state: 'Help! I was charged twice for order 7 and the app crashes. Fix it today.',
      questions,
      ...(images ? { images } : {}),
      ...context,
    });

  try {
    const response = await decide(ALL_TYPES);
    const types = Object.entries(response.answers).map(([name, a]) => `${name}:${a.type}`);
    report(
      `answers choice, score and yes_no in one call (${types.join(', ')})`,
      response.answers['team']?.type === 'choice' &&
        response.answers['severity']?.type === 'score' &&
        response.answers['urgent']?.type === 'yes_no',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isCredentialFailure(message)) {
      console.log(`  SKIPPED — ${message}`);
      continue;
    }
    report(`answers choice, score and yes_no in one call — ${message}`, false);
    continue;
  }

  if (profile.questionsPerCall !== undefined) {
    const limit = profile.questionsPerCall;
    const atLimit = await decide(yesNo(limit)).then(
      (r) => Object.keys(r.answers).length === limit,
      () => false,
    );
    report(`accepts ${String(limit)} questions in one call`, atLimit);
    const overLimit = await decide(yesNo(limit + 1)).then(
      () => false,
      () => true,
    );
    report(`refuses ${String(limit + 1)} questions in one call`, overLimit);
  }

  if (profile.imageContext) {
    const readsImage = await decide(
      { urgent: { type: 'yes_no', instructions: 'The image is entirely transparent.' } },
      [{ data: PIXEL, mimeType: 'image/png' }],
    ).then(
      () => true,
      (error: unknown) => {
        console.log(`        ${error instanceof Error ? error.message : JSON.stringify(error)}`);
        return false;
      },
    );
    report('reads an image with the state', readsImage);
  } else {
    console.log('  --   reads no images (the adapter sends none; nothing to probe)');
  }
}

console.log(
  failures === 0 ? '\nAll decision profiles match.' : `\n${String(failures)} mismatch(es).`,
);
process.exit(failures === 0 ? 0 : 1);
