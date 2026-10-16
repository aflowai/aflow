/**
 * Plan 323 P0 — feasibility gates for models served by a local Ollama.
 *
 * Each gate answers one question a P1 decision rests on, against the runtime
 * actually installed, and prints JSON so the answer can be reproduced and
 * compared across machines and runtime versions. Nothing here touches the
 * stack: it talks to the runtime and nothing else.
 *
 *   yarn models:local-gates <gate> [--model <tag>]... [--out <file>]
 *
 * Gates:
 *   overflow    G1 — what a prompt over `num_ctx` does, and how exact `prompt_eval_count` is
 *   locality    G2 — whether the runtime says where it sends inference
 *   lifecycle   G3 — pull joins, cancellation, resumption, refusal
 *   embeddings  G4 — dimensions, truncation, and retrieval at reduced dimensions (its built-in
 *               retrieval set is too easy to separate dimensions; it shows support, not quality)
 *   machine     G5 — footprint by context, load and switch time, throughput
 *
 * `lifecycle` and `embeddings` pull small models (about 1–3 GB) and delete
 * what they pulled. `machine` loads every model it is given, one at a time.
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const BASE = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';

interface ChatResult {
  promptEvalCount: number | null;
  evalCount: number | null;
  doneReason: string | null;
  content: string;
  toolCalls: unknown;
  loadS: number;
  promptS: number;
  evalS: number;
  wallS: number;
  error?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  images?: string[];
}

const describe = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : JSON.stringify(e);

const seconds = (ns: unknown): number => (typeof ns === 'number' ? Math.round(ns / 1e7) / 100 : 0);

async function api(path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
}

async function json<T>(path: string, body?: unknown): Promise<T> {
  const res = await api(path, body);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function chat(
  model: string,
  messages: ChatMessage[],
  options: { numCtx: number; numPredict?: number; tools?: unknown[]; think?: boolean },
): Promise<ChatResult> {
  const started = Date.now();
  const res = await api('/api/chat', {
    model,
    messages,
    stream: false,
    think: options.think ?? false,
    ...(options.tools ? { tools: options.tools } : {}),
    options: { num_ctx: options.numCtx, num_predict: options.numPredict ?? 40, temperature: 0 },
  });
  const wallS = Math.round((Date.now() - started) / 10) / 100;
  if (!res.ok) {
    return {
      promptEvalCount: null,
      evalCount: null,
      doneReason: null,
      content: '',
      toolCalls: null,
      loadS: 0,
      promptS: 0,
      evalS: 0,
      wallS,
      error: `${res.status} ${(await res.text()).slice(0, 400)}`,
    };
  }
  const d = (await res.json()) as Record<string, unknown>;
  const message = (d['message'] ?? {}) as Record<string, unknown>;
  return {
    promptEvalCount: typeof d['prompt_eval_count'] === 'number' ? d['prompt_eval_count'] : null,
    evalCount: typeof d['eval_count'] === 'number' ? d['eval_count'] : null,
    doneReason: typeof d['done_reason'] === 'string' ? d['done_reason'] : null,
    content: typeof message['content'] === 'string' ? message['content'] : '',
    toolCalls: message['tool_calls'] ?? null,
    loadS: seconds(d['load_duration']),
    promptS: seconds(d['prompt_eval_duration']),
    evalS: seconds(d['eval_duration']),
    wallS,
  };
}

async function unloadAll(): Promise<void> {
  const ps = await json<{ models: Array<{ name: string }> }>('/api/ps');
  for (const m of ps.models) await api('/api/generate', { model: m.name, keep_alive: 0 });
}

async function show(model: string): Promise<Record<string, unknown>> {
  return json('/api/show', { model });
}

async function pull(
  model: string,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ events: number; lastStatus: string; firstCompleted: number | null }> {
  const res = await api('/api/pull', { model, stream: true }, signal);
  if (!res.ok || !res.body) throw new Error(`pull ${model} → ${res.status} ${await res.text()}`);
  let events = 0;
  let lastStatus = '';
  let firstCompleted: number | null = null;
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line) as Record<string, unknown>;
      events++;
      if (typeof ev['error'] === 'string') throw new Error(`pull ${model}: ${ev['error']}`);
      if (typeof ev['status'] === 'string') lastStatus = ev['status'];
      if (
        firstCompleted === null &&
        typeof ev['completed'] === 'number' &&
        typeof ev['total'] === 'number' &&
        ev['total'] > 1e6
      ) {
        firstCompleted = ev['completed'];
      }
      if (onProgress && typeof ev['completed'] === 'number' && typeof ev['total'] === 'number') {
        onProgress(ev['completed'], ev['total']);
      }
    }
  }
  return { events, lastStatus, firstCompleted };
}

async function remove(model: string): Promise<void> {
  const res = await fetch(`${BASE}/api/delete`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(`delete ${model} → ${res.status} ${await res.text()}`);
}

async function installedTags(): Promise<Set<string>> {
  const tags = await json<{ models: Array<{ name: string }> }>('/api/tags');
  return new Set(tags.models.map((m) => m.name));
}

const SECRET_SYSTEM: ChatMessage = {
  role: 'system',
  content:
    'SECRET CODE: PELICAN-42. When asked for the code, reply with the code and nothing else.',
};
const filler = (items: number): string =>
  Array.from({ length: items }, (_, i) => `Item ${i} is a blue marble.`).join(' ');

const SAMPLES: Record<string, string> = {
  english:
    'The orchestrator schedules each tool call as its own step, records its result, and hands the result back to the next agent turn. '.repeat(
      40,
    ),
  german:
    'Der Orchestrator plant jeden Werkzeugaufruf als eigenen Schritt, speichert das Ergebnis und gibt es an den nächsten Agentenschritt weiter. '.repeat(
      40,
    ),
  chinese: '编排器将每次工具调用安排为独立的步骤，记录其结果，并将结果交给下一轮智能体。'.repeat(
    40,
  ),
  code: 'export function admit(limiter: Limiter, signal: AbortSignal): Promise<boolean> {\n  if (limiter.tryAcquire()) return Promise.resolve(false);\n  return limiter.acquire(signal).then(() => true);\n}\n'.repeat(
    25,
  ),
  json: JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({
      id: `step-${i}`,
      status: 'SUCCEEDED',
      output: { rows: i, ok: true },
    })),
  ),
};

const PROBE_TOOLS = Array.from({ length: 8 }, (_, i) => ({
  type: 'function',
  function: {
    name: `tool_${i}`,
    description: `Reads records of kind ${i} from the workspace and returns them as a list.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
    },
  },
}));

// 8×8 red PNG.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

async function gateOverflow(models: string[]): Promise<unknown> {
  const results: Record<string, unknown> = {};
  for (const model of models) {
    await unloadAll();
    const info = await show(model);
    const details = info['details'] as Record<string, unknown>;
    const ask: ChatMessage = { role: 'user', content: `${filler(650)} What is the secret code?` };
    const small = await chat(
      model,
      [SECRET_SYSTEM, { role: 'user', content: 'What is the secret code?' }],
      { numCtx: 4096 },
    );
    const over = await chat(model, [SECRET_SYSTEM, ask], { numCtx: 4096 });
    const fits = await chat(model, [SECRET_SYSTEM, ask], { numCtx: 16384 });
    const repeat = await chat(model, [SECRET_SYSTEM, { ...ask, content: `${ask.content} ` }], {
      numCtx: 16384,
    });

    const ratios: Record<
      string,
      { chars: number; tokens: number | null; charsPerToken: number | null }
    > = {};
    const base =
      (await chat(model, [{ role: 'user', content: 'x' }], { numCtx: 16384, numPredict: 1 }))
        .promptEvalCount ?? 0;
    for (const [kind, text] of Object.entries(SAMPLES)) {
      const r = await chat(model, [{ role: 'user', content: text }], {
        numCtx: 16384,
        numPredict: 1,
      });
      const tokens = r.promptEvalCount === null ? null : r.promptEvalCount - base;
      ratios[kind] = {
        chars: text.length,
        tokens,
        charsPerToken: tokens ? Math.round((text.length / tokens) * 100) / 100 : null,
      };
    }
    const plain = await chat(model, [{ role: 'user', content: 'Say ok.' }], {
      numCtx: 16384,
      numPredict: 1,
    });
    const withTools = await chat(model, [{ role: 'user', content: 'Say ok.' }], {
      numCtx: 16384,
      numPredict: 1,
      tools: PROBE_TOOLS,
    });
    const withImage = await chat(
      model,
      [{ role: 'user', content: 'Say ok.', images: [TINY_PNG] }],
      { numCtx: 16384, numPredict: 1 },
    );
    const thinkingText = 'Let me reason about the marbles carefully before answering. '.repeat(30);
    const noHistory = await chat(
      model,
      [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'Say ok.' },
      ],
      { numCtx: 16384, numPredict: 1 },
    );
    const withThinking = await chat(
      model,
      [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.', thinking: thinkingText },
        { role: 'user', content: 'Say ok.' },
      ],
      { numCtx: 16384, numPredict: 1 },
    );

    results[model] = {
      runner: details['runner'],
      format: details['format'],
      quantization: details['quantization_level'],
      digest: (
        await json<{ models: Array<{ name: string; digest: string }> }>('/api/tags')
      ).models.find((m) => m.name === model)?.digest,
      overflow: {
        small,
        overWindow: { ...over, recalledSecret: over.content.includes('PELICAN-42') },
        fitsWindow: { ...fits, recalledSecret: fits.content.includes('PELICAN-42') },
        repeatedPrefix: repeat,
        truncatedSilently:
          over.error === undefined && (over.promptEvalCount ?? 0) < (fits.promptEvalCount ?? 0),
      },
      charsPerToken: ratios,
      overheadTokens: {
        eightTools: (withTools.promptEvalCount ?? 0) - (plain.promptEvalCount ?? 0),
        oneTinyImage: withImage.error
          ? withImage.error
          : (withImage.promptEvalCount ?? 0) - (plain.promptEvalCount ?? 0),
        replayedThinking: (withThinking.promptEvalCount ?? 0) - (noHistory.promptEvalCount ?? 0),
        replayedThinkingChars: thinkingText.length,
      },
    };
  }
  return results;
}

async function gateLocality(): Promise<unknown> {
  const status = await api('/api/status');
  const tags = await json<{ models: Array<Record<string, unknown>> }>('/api/tags');
  return {
    status: status.ok ? await status.json() : `${status.status}`,
    remoteModels: tags.models
      .filter((m) => typeof m['remote_host'] === 'string')
      .map((m) => ({
        name: m['name'],
        remoteHost: m['remote_host'],
        remoteModel: m['remote_model'],
      })),
    localModels: tags.models
      .filter((m) => typeof m['remote_host'] !== 'string')
      .map((m) => m['name']),
  };
}

async function gateLifecycle(): Promise<unknown> {
  const tag = 'qwen3.5:0.8b-q8_0';
  const preinstalled = (await installedTags()).has(tag);
  if (preinstalled) await remove(tag);

  // Cancelled on the first partial progress of the large layer, not on a
  // timer: bytes already on disk from an earlier run finish a timed pull first.
  const ctl = new AbortController();
  let cancelledAtBytes: number | null = null;
  const afterCancel = await pull(tag, ctl.signal, (completed, total) => {
    if (cancelledAtBytes === null && total > 1e8 && completed > total / 10 && completed < total) {
      cancelledAtBytes = completed;
      ctl.abort();
    }
  }).then(
    (r) => ({ finished: true, ...r }),
    (e: unknown) => ({ finished: false, error: describe(e).slice(0, 200) }),
  );
  const installedAfterCancel = (await installedTags()).has(tag);

  const resumeStarted = Date.now();
  const [first, second] = await Promise.all([pull(tag), pull(tag)]);
  const concurrentS = Math.round((Date.now() - resumeStarted) / 100) / 10;

  const missing = await pull('aflow-gate/does-not-exist:latest').then(
    () => 'succeeded',
    (e: unknown) => describe(e).slice(0, 300),
  );

  if (!preinstalled) await remove(tag);
  return {
    tag,
    cancelMidPull:
      cancelledAtBytes === null
        ? 'not exercised: the layers were already on disk, so the pull finished without partial progress'
        : { ...afterCancel, cancelledAtBytes, installedAfterCancel },
    resumedAndConcurrent: {
      wallS: concurrentS,
      first,
      second,
      resumedFromPartial:
        cancelledAtBytes === null ? null : (first.firstCompleted ?? 0) >= cancelledAtBytes,
    },
    missingTag: missing,
    diskSpaceRefusal: 'not exercised: needs a full disk; P3 checks free space before pulling',
  };
}

const RETRIEVAL_PAIRS: Array<[string, string]> = [
  [
    'How do I reset my password?',
    'To change a forgotten password, open Settings, choose Security and follow the reset link we email you.',
  ],
  [
    'Which port does Postgres listen on locally?',
    'The local database is published on port 5433 rather than the default 5432.',
  ],
  [
    'What happens when a tool call fails five times in a row?',
    'After five consecutive tool failures the agent loop stops and the run is marked as failed.',
  ],
  [
    'Can I run models without a cloud key?',
    'Models served by a runtime on your own machine need no provider key.',
  ],
  [
    'How are large payloads stored?',
    'Anything large goes to the payload store and only a reference travels through the stream.',
  ],
  [
    'Where do approvals show up?',
    'Requests that need your consent appear as cards in the Action Center.',
  ],
  [
    'How do I pair my laptop?',
    'Run the pairing command on the machine, which writes its connection file under your home directory.',
  ],
  [
    'What does the judge do?',
    'The judge scores a finished run against the rubric of its evaluation suite.',
  ],
  [
    'Why is my local model slow?',
    'A model that does not fit in GPU memory runs partly on the CPU and decodes much more slowly.',
  ],
  [
    'Is browsing allowed on any site?',
    'Each browser profile has a posture and per-site rules that allow, ask or deny.',
  ],
  ['How often are titles generated?', 'A session gets its title once, after the first exchange.'],
  [
    'What is a skill?',
    'A skill bundles a workflow with its manifest, evaluation suite and activation rules.',
  ],
  [
    'How do I invite a teammate?',
    'Send an invitation from the members page; it expires after seven days.',
  ],
  [
    'What limits concurrent harness runs?',
    'The host executor runs only a bounded number of coding harness runs at once.',
  ],
  ['Does the platform keep my data in Europe?', 'The hosted service runs in a European region.'],
  [
    'How do I delete a model?',
    'Removing a downloaded model frees its disk space; it can be pulled again later.',
  ],
  [
    'What is the Helmsman?',
    'The Helmsman is the conversational agent that plans work and commissions other agents.',
  ],
  [
    'How are secrets stored?',
    'Credentials are encrypted with an envelope key before they are written.',
  ],
  [
    'Can a run be retried?',
    'A failed run can be retried from the session view, which starts it again.',
  ],
  [
    'What happens when memory search finds nothing?',
    'An empty search returns no results rather than guessing.',
  ],
];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(
  model: string,
  input: string[],
  extra: Record<string, unknown> = {},
): Promise<{ vectors: number[][] | null; promptEvalCount: number | null; error?: string }> {
  const res = await api('/api/embed', { model, input, ...extra });
  if (!res.ok)
    return {
      vectors: null,
      promptEvalCount: null,
      error: `${res.status} ${(await res.text()).slice(0, 300)}`,
    };
  const d = (await res.json()) as { embeddings: number[][]; prompt_eval_count?: number };
  return { vectors: d.embeddings, promptEvalCount: d.prompt_eval_count ?? null };
}

async function recallAt1(model: string, extra: Record<string, unknown>): Promise<number | string> {
  const q = await embed(
    model,
    RETRIEVAL_PAIRS.map(([query]) => query),
    extra,
  );
  const p = await embed(
    model,
    RETRIEVAL_PAIRS.map(([, passage]) => passage),
    extra,
  );
  if (!q.vectors || !p.vectors) return q.error ?? p.error ?? 'no vectors';
  let hits = 0;
  q.vectors.forEach((qv, i) => {
    let best = -1;
    let bestScore = -Infinity;
    p.vectors.forEach((pv, j) => {
      const s = cosine(qv, pv);
      if (s > bestScore) {
        bestScore = s;
        best = j;
      }
    });
    if (best === i) hits++;
  });
  return hits / RETRIEVAL_PAIRS.length;
}

async function gateEmbeddings(models: string[]): Promise<unknown> {
  const results: Record<string, unknown> = {};
  const before = await installedTags();
  const isInstalled = (model: string): boolean =>
    before.has(model) || before.has(`${model}:latest`);
  for (const model of models) {
    if (!isInstalled(model)) await pull(model);
    const native = await embed(model, ['dimension probe']);
    const nativeDims = native.vectors?.[0]?.length ?? null;
    const at1536 = await embed(model, ['dimension probe'], { dimensions: 1536 });
    const long = 'The orchestrator writes durable state. '.repeat(4000);
    const overWindowTruncateFalse = await embed(model, [long], { truncate: false });
    const overWindowDefault = await embed(model, [long]);
    results[model] = {
      nativeDims,
      requested1536: at1536.error ?? at1536.vectors?.[0]?.length ?? null,
      overWindow: {
        truncateFalse:
          overWindowTruncateFalse.error ??
          `accepted (${overWindowTruncateFalse.promptEvalCount} tokens)`,
        default:
          overWindowDefault.error ??
          `accepted silently (${overWindowDefault.promptEvalCount} tokens of ~${Math.round(long.length / 4)})`,
      },
      recallAt1: {
        native: await recallAt1(model, {}),
        ...(nativeDims && nativeDims > 1536
          ? { at1536: await recallAt1(model, { dimensions: 1536 }) }
          : {}),
        ...(nativeDims && nativeDims > 768
          ? { at768: await recallAt1(model, { dimensions: 768 }) }
          : {}),
      },
      retrievalSet: `${RETRIEVAL_PAIRS.length} pairs — indicative only`,
    };
    if (!isInstalled(model)) await remove(model);
  }
  return results;
}

function gpuWorkingSetBytes(): number | string {
  if (process.platform !== 'darwin') return 'not macOS';
  try {
    const out = execFileSync(
      'swift',
      ['-e', 'import Metal; print(MTLCreateSystemDefaultDevice()!.recommendedMaxWorkingSetSize)'],
      { encoding: 'utf8', timeout: 180_000 },
    );
    return Number(out.trim());
  } catch (e) {
    return `unavailable: ${describe(e).slice(0, 120)}`;
  }
}

async function gateMachine(models: string[]): Promise<unknown> {
  const results: Record<string, unknown> = {};
  let previous: string | null = null;
  for (const model of models) {
    await unloadAll();
    const coldStarted = Date.now();
    const cold = await chat(model, [{ role: 'user', content: 'Say ok.' }], {
      numCtx: 4096,
      numPredict: 1,
    });
    const coldWallS = Math.round((Date.now() - coldStarted) / 100) / 10;
    const footprint: Record<string, unknown> = {};
    for (const numCtx of [4096, 32768]) {
      await chat(model, [{ role: 'user', content: 'Say ok.' }], { numCtx, numPredict: 1 });
      const ps = await json<{ models: Array<Record<string, unknown>> }>('/api/ps');
      const m = ps.models.find((x) => x['name'] === model);
      footprint[`ctx${numCtx}`] = {
        size: m?.['size'],
        sizeVram: m?.['size_vram'],
        contextLength: m?.['context_length'],
      };
    }
    const prefill = await chat(model, [{ role: 'user', content: `${filler(1200)} Say ok.` }], {
      numCtx: 32768,
      numPredict: 1,
    });
    const decode = await chat(
      model,
      [{ role: 'user', content: 'Count from 1 to 200, separated by commas.' }],
      { numCtx: 32768, numPredict: 256 },
    );
    let switchFromPrevious: unknown = null;
    if (previous) {
      await chat(previous, [{ role: 'user', content: 'Say ok.' }], { numCtx: 4096, numPredict: 1 });
      const started = Date.now();
      await chat(model, [{ role: 'user', content: 'Say ok.' }], { numCtx: 4096, numPredict: 1 });
      switchFromPrevious = { from: previous, wallS: Math.round((Date.now() - started) / 100) / 10 };
    }
    results[model] = {
      coldLoad: { wallS: coldWallS, loadS: cold.loadS, firstPromptS: cold.promptS },
      footprint,
      prefillTokensPerS:
        prefill.promptEvalCount && prefill.promptS
          ? Math.round(prefill.promptEvalCount / prefill.promptS)
          : null,
      prefillTokens: prefill.promptEvalCount,
      decodeTokensPerS:
        decode.evalCount && decode.evalS ? Math.round(decode.evalCount / decode.evalS) : null,
      switchFromPrevious,
    };
    previous = model;
  }
  return {
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
    },
    gpuWorkingSetBytes: gpuWorkingSetBytes(),
    serverConditions:
      'KV cache type, flash attention and parallelism are server environment, not visible over the API; record them beside the result',
    models: results,
  };
}

async function main(): Promise<void> {
  const [gate, ...rest] = process.argv.slice(2);
  const models: string[] = [];
  let out: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--model' && rest[i + 1]) models.push(rest[++i]);
    else if (rest[i] === '--out' && rest[i + 1]) out = rest[++i]!;
  }
  const version = await json<{ version: string }>('/api/version');
  const run: Record<string, () => Promise<unknown>> = {
    overflow: () => gateOverflow(models),
    locality: () => gateLocality(),
    lifecycle: () => gateLifecycle(),
    embeddings: () =>
      gateEmbeddings(models.length ? models : ['embeddinggemma', 'qwen3-embedding:4b']),
    machine: () => gateMachine(models),
  };
  const fn = gate ? run[gate] : undefined;
  if (!fn) {
    console.error(
      `usage: local-model-gates.ts <${Object.keys(run).join('|')}> [--model <tag>]... [--out <file>]`,
    );
    process.exit(2);
  }
  const result = {
    gate,
    runtime: { url: BASE, version: version.version },
    measuredAt: new Date().toISOString(),
    result: await fn(),
  };
  const text = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, `${text}\n`);
  console.log(text);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
