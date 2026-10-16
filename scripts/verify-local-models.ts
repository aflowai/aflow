/**
 * Measure what a model served by the local Ollama can do, and check the
 * catalog entry that names it (Plan 323 D9, compatibility tier).
 *
 * The catalog's flags for a local model are the runtime's own answers for one
 * build: a tag pulled again can be another digest, and a runtime upgrade can
 * add or remove a feature (the MLX runner refuses `format` outright). So each
 * flag here comes from a request, never from a model card, and the result is
 * tied to the digest, runner, quantisation and runtime version it was measured
 * on.
 *
 *   yarn models:verify-local [<tag>...]
 *
 * With no tags it checks every local entry in the catalog. Exits non-zero when
 * a catalog entry disagrees with what was measured, printing the entry the
 * measurement supports. Tags not installed are reported as SKIPPED.
 */
import {
  createDefaultModelCatalog,
  type LocalModelBuild,
  type ModelDefinition,
} from '@aflow/ai-client';
import { OLLAMA_DEFAULT_BASE_URL } from '@aflow/schemas';

const BASE = (process.env['OLLAMA_URL'] ?? OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, '');
/** Bumped whenever a probe below changes what it measures. */
const PROBE_VERSION = 1;

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for one city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

interface Measured {
  build: LocalModelBuild;
  capabilities: {
    vision: boolean;
    functionCalling: boolean;
    parallelToolCalls: boolean;
    streamedToolCalls: boolean;
    structuredOutputs: boolean;
    reasoning: boolean;
  };
  reasoningSupported: string[];
  contextWindow: number | null;
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text.split('\n').filter(Boolean).at(-1) ?? '{}') as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function chat(tag: string, extra: Record<string, unknown>) {
  return post('/api/chat', {
    model: tag,
    stream: false,
    think: false,
    options: { num_ctx: 4096, num_predict: 256, temperature: 0 },
    ...extra,
  });
}

function toolCalls(
  json: Record<string, unknown>,
): Array<{ function?: { name?: string; arguments?: unknown } }> {
  const message = json['message'] as
    { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> } | undefined;
  return message?.tool_calls ?? [];
}

async function streamedToolCall(tag: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: tag,
      stream: true,
      think: false,
      tools: [WEATHER_TOOL],
      options: { num_ctx: 4096, num_predict: 256, temperature: 0 },
      messages: [{ role: 'user', content: 'What is the weather in Berlin? Use the tool.' }],
    }),
  });
  const lines = (await res.text()).split('\n').filter(Boolean);
  return lines.some((line) => {
    const chunk = JSON.parse(line) as Record<string, unknown>;
    return toolCalls(chunk).some((c) => c.function?.name === 'get_weather');
  });
}

async function measure(tag: string): Promise<Measured | null> {
  const tags = (await (await fetch(`${BASE}/api/tags`)).json()) as {
    models: Array<{ name: string; digest: string; remote_host?: string }>;
  };
  const installed = tags.models.find((m) => m.name === tag || m.name === `${tag}:latest`);
  if (!installed) return null;
  if (installed.remote_host)
    throw new Error(`${tag} is served by ${installed.remote_host}, not this computer`);
  const version = (await (await fetch(`${BASE}/api/version`)).json()) as { version: string };
  const show = (await post('/api/show', { model: tag })).json;
  const details = (show['details'] ?? {}) as Record<string, string>;
  const caps = new Set((show['capabilities'] as string[] | undefined) ?? []);
  const modelInfo = (show['model_info'] ?? {}) as Record<string, unknown>;
  const contextKey = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));

  const single = await chat(tag, {
    tools: [WEATHER_TOOL],
    messages: [{ role: 'user', content: 'What is the weather in Berlin? Use the tool.' }],
  });
  const parallel = await chat(tag, {
    tools: [WEATHER_TOOL],
    messages: [
      {
        role: 'user',
        content: 'What is the weather in Berlin and in Paris? Call the tool once per city.',
      },
    ],
  });
  const format = await chat(tag, {
    format: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] },
    messages: [{ role: 'user', content: '17 * 23 = ? Reply as JSON.' }],
  });
  const thinking = show['thinking'] as { values?: unknown[] } | undefined;
  const levels = (thinking?.values ?? []).filter((v): v is string => typeof v === 'string');
  const reasoningSupported =
    thinking?.values === undefined
      ? []
      : levels.length > 0
        ? ['off', ...levels.filter((l) => ['low', 'medium', 'high'].includes(l))]
        : ['off', 'high'];

  return {
    build: {
      runtimeTag: tag,
      digest: installed.digest,
      runner: details['runner'] ?? 'unknown',
      quantization: (details['quantization_level'] ?? 'unknown').toLowerCase(),
      runtimeVersion: version.version,
      probeVersion: PROBE_VERSION,
      measuredAt: new Date().toISOString().slice(0, 10),
    },
    capabilities: {
      vision: caps.has('vision'),
      functionCalling: toolCalls(single.json).some((c) => c.function?.name === 'get_weather'),
      parallelToolCalls: toolCalls(parallel.json).length >= 2,
      streamedToolCalls: await streamedToolCall(tag),
      structuredOutputs: format.status === 200,
      reasoning: caps.has('thinking'),
    },
    reasoningSupported,
    contextWindow:
      typeof modelInfo[contextKey ?? ''] === 'number'
        ? (modelInfo[contextKey ?? ''] as number)
        : null,
  };
}

function drift(entry: ModelDefinition, m: Measured): string[] {
  const found: string[] = [];
  const expect = (label: string, catalog: unknown, measured: unknown) => {
    if (JSON.stringify(catalog) !== JSON.stringify(measured)) {
      found.push(
        `${label}: catalog ${JSON.stringify(catalog)}, measured ${JSON.stringify(measured)}`,
      );
    }
  };
  expect('capabilities.vision', entry.capabilities.vision, m.capabilities.vision);
  expect(
    'capabilities.functionCalling',
    entry.capabilities.functionCalling,
    m.capabilities.functionCalling,
  );
  expect(
    'capabilities.structuredOutputs',
    entry.capabilities.structuredOutputs === true,
    m.capabilities.structuredOutputs,
  );
  expect('capabilities.reasoning', entry.capabilities.reasoning === true, m.capabilities.reasoning);
  expect('reasoning.supported', [...(entry.reasoning?.supported ?? [])], m.reasoningSupported);
  if (m.contextWindow !== null) expect('contextWindow', entry.contextWindow, m.contextWindow);
  expect('local.digest', entry.local?.digest, m.build.digest);
  expect('local.runner', entry.local?.runner, m.build.runner);
  expect('local.quantization', entry.local?.quantization, m.build.quantization);
  expect('local.runtimeVersion', entry.local?.runtimeVersion, m.build.runtimeVersion);
  expect('local.probeVersion', entry.local?.probeVersion, m.build.probeVersion);
  return found;
}

async function main(): Promise<void> {
  const catalog = createDefaultModelCatalog();
  const entries = catalog.listModels('ollama');
  const requested = process.argv.slice(2);
  const tags = requested.length > 0 ? requested : entries.map((e) => e.providerModelId ?? e.id);
  let failed = false;
  for (const tag of tags) {
    const measured = await measure(tag);
    if (!measured) {
      console.log(`SKIPPED ${tag}: not installed (ollama pull ${tag})`);
      continue;
    }
    const entry = entries.find((e) => (e.providerModelId ?? e.id) === tag);
    console.log(`\n${tag}`);
    console.log(JSON.stringify(measured, null, 2));
    if (!entry) {
      console.log(`NO ENTRY ${tag}: measured above; add a catalog entry from it.`);
      continue;
    }
    const differences = drift(entry, measured);
    if (differences.length === 0) {
      console.log(`OK ${entry.id}`);
    } else {
      failed = true;
      console.log(`DRIFT ${entry.id}`);
      for (const d of differences) console.log(`  ${d}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
