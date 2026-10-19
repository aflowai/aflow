/**
 * Plan 316 §7 — how well the loop's own decisions can be made without a
 * reasoning model, measured on the loop's own history before Publish Local
 * Changes makes them for itself.
 *
 *   yarn decisions:measure-loop collect --space <spaceId> [--repo aflowai/aflow] [--prs 91-124]
 *   yarn decisions:measure-loop measure [--labels <file>] [--target 0.9]
 *
 * `collect` reads every Publish Local Changes and Review Local Changes run of
 * the space through the stack's API (the API key in AFLOW_API_KEY, the stack
 * at API_URL or http://localhost:3000) and every failing CI job of the pull
 * requests named through `gh api`, and writes the labelled set to
 * `.debug/decisions/cases.json`: each failed check with what the next
 * publication of its branch did, each review finding with whether a later
 * publication closed it, each review with whether a fix round followed, each
 * failing job's log end with the remedy that followed. A label the records
 * cannot give is left out rather than guessed; `--labels` names a file of the
 * operator's own (`{ "<caseId>": "<label>" }`), which overrides an inference
 * and supplies what none could.
 *
 * `measure` asks every labelled case, as the skill asks it, of every decision
 * model the catalog offers — each through the client call `ai.decision.decide`
 * makes, so a decider a space can resolve the step to is measured on the same
 * cases as the one its bar was set on — and of a critique-then-verdict JSON
 * call on gpt-6-luna and on claude-opus-5-5, the agent baselines. Keys are read
 * from TYPESAFE_API_KEY, OPENAI_API_KEY and ANTHROPIC_API_KEY; a decider without
 * its provider's key is skipped and the report says so. It writes every answer
 * to `results.json` and the tables Plan 316 §7 carries to `report.md`:
 * agreement with the operator's decision, abstention at the bar chosen for each
 * decider (the lowest that reaches `--target` agreement), latency and cost per
 * decision, and every decision model's whole sweep.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createAIClient, createDefaultModelCatalog, type AIClient } from '@aflow/ai-client';
import {
  AFTER_CHECK_QUESTION,
  AFTER_CHECK_QUESTION_NAME,
  AFTER_REVIEW_QUESTION,
  AFTER_REVIEW_QUESTION_NAME,
} from '@aflow/platform-artifacts';
import { decodeInlinePayloadRef } from '@aflow/payload-store';
import type { DecisionQuestion, SessionId, StepExecutionId, TenantId } from '@aflow/schemas';
import {
  CI_REMEDY_QUESTION,
  CI_REMEDY_QUESTION_NAME,
  FINDING_QUESTION,
  RATE_LIMIT_ATTEMPTS,
  applyOperatorLabels,
  checkFailureCases,
  chooseMinConfidence,
  ciFailureCases,
  isGhNotFound,
  renderReport,
  retryDelayMs,
  reviewCases,
  score,
  sweep,
} from './loop-decision-set.mjs';

/** The key each provider a decider runs on is read from. */
const PROVIDER_KEYS: Readonly<Record<string, string>> = {
  typesafe: 'TYPESAFE_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/**
 * Every decision model in the catalog, as the step's own resolution reads it:
 * whichever of these a space resolves `ai.decision.decide` to is measured.
 */
const DECISION_MODELS = createDefaultModelCatalog()
  .listModels()
  .filter((m) => m.capabilities.decision === true && m.decision !== undefined);

const LUNA = 'gpt-6-luna';
const OPUS = 'claude-opus-5-5';
const OUT_DIR = '.debug/decisions';
/** What usage accounting is told a measurement call belongs to: no tenant's run. */
const USAGE = {
  tenantId: 'decisions-measure-loop' as TenantId,
  runId: 'decisions-measure-loop' as SessionId,
  stepExecutionId: 'decisions-measure-loop' as StepExecutionId,
};
/** Where a decider that reaches no bar is reported: the skill's own provisional one. */
const FALLBACK_BAR = 0.8;

interface Case {
  id: string;
  kind: 'after_check' | 'finding' | 'after_review' | 'ci_remedy';
  state: unknown;
  label: string | boolean | null;
  labelSource: 'inferred' | 'operator' | 'none';
}

interface Result {
  caseId: string;
  value?: string | boolean;
  confidence?: number;
  latencyMs?: number;
  costUsd?: number | null;
  critique?: string;
  error?: string;
}

const QUESTIONS: Record<Case['kind'], { name: string; question: DecisionQuestion }> = {
  after_check: { name: AFTER_CHECK_QUESTION_NAME, question: AFTER_CHECK_QUESTION },
  finding: { name: 'defect', question: FINDING_QUESTION as DecisionQuestion },
  after_review: { name: AFTER_REVIEW_QUESTION_NAME, question: AFTER_REVIEW_QUESTION },
  ci_remedy: { name: CI_REMEDY_QUESTION_NAME, question: CI_REMEDY_QUESTION as DecisionQuestion },
};

const TITLES: Record<Case['kind'], string> = {
  after_check:
    'After a failed check (recheck_on_timeout / fix_commission / operator_install_mismatch)',
  finding:
    "Each review finding: names a defect in the change's behaviour, established by evidence shown",
  after_review:
    'After a review that did not approve, or found a minor or worse (fix_before_merge / publish_as_is)',
  ci_remedy: 'A failing CI job of PRs (rerun / code_fix / resolutions_bump / merge_round)',
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// ── collect ────────────────────────────────────────────────────────────────

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`HTTP ${String(status)} for ${path}`);
  }
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function api(path: string): Promise<unknown> {
  const key = process.env['AFLOW_API_KEY'];
  if (key === undefined || key === '') {
    throw new Error('AFLOW_API_KEY is not set: collect reads the runs through the stack’s API.');
  }
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API_URL}/v1${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return res.json();
    // A collection reads hundreds of runs and payloads; the stack's read
    // limit answers 429 well before that, and waiting is all it asks.
    if (res.status === 429 && attempt + 1 < RATE_LIMIT_ATTEMPTS) {
      await sleep(retryDelayMs(attempt, res.headers.get('retry-after')));
      continue;
    }
    throw new HttpError(res.status, path);
  }
}

/**
 * A run's stored payload, or undefined where there is none to read: no ref,
 * or one the store no longer holds, which leaves that case out. An inline ref
 * carries its value, and is never sent: one the size of a payload is longer
 * than any request line the stack takes.
 */
async function payload(ref: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (ref === undefined) return undefined;
  if (ref.startsWith('inline:')) {
    return decodeInlinePayloadRef(ref) as Record<string, unknown>;
  }
  let body: Record<string, unknown>;
  try {
    body = (await api(`/payloads?ref=${encodeURIComponent(ref)}`)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
  if (typeof body['downloadUrl'] === 'string') {
    const res = await fetch(body['downloadUrl']);
    return (await res.json()) as Record<string, unknown>;
  }
  return body;
}

interface TaskRow {
  taskId: string;
  status: string;
  inputRef?: string;
  outputRef?: string;
  failureReason?: string;
}

async function runsOf(
  space: string,
  slug: string,
): Promise<Array<{ runId: string; startedAt: string }>> {
  const runs: Array<{ runId: string; startedAt: string }> = [];
  let cursor: string | null = null;
  do {
    const page = (await api(
      `/spaces/${space}/workflows/${slug}/runs?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    )) as { runs: Array<{ runId: string; startedAt: string }>; nextCursor: string | null };
    runs.push(...page.runs);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return runs;
}

async function tasksOf(space: string, runId: string): Promise<Map<string, TaskRow>> {
  const detail = (await api(`/spaces/${space}/workflow-runs/${runId}`)) as { tasks: TaskRow[] };
  return new Map(detail.tasks.map((t) => [t.taskId, t]));
}

const path = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>(
    (at, key) =>
      at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined,
    value,
  );

async function publications(space: string) {
  const out = [];
  for (const run of await runsOf(space, 'publish-local-changes')) {
    const tasks = await tasksOf(space, run.runId);
    const commit = tasks.get('commit');
    const input = await payload(commit?.inputRef);
    const output = await payload(commit?.outputRef);
    const branch = path(input, 'commit', 'branch');
    const headSha = path(output, 'commit', 'sha');
    if (typeof branch !== 'string' || typeof headSha !== 'string') continue;
    const check = tasks.get('check-commit');
    const checkOutput = check?.status === 'succeeded' ? await payload(check.outputRef) : undefined;
    const checkFailed = check?.status === 'failed' || checkOutput?.['passed'] === false;
    const describe = await payload(tasks.get('describe-pr')?.inputRef);
    out.push({
      runId: run.runId,
      startedAt: run.startedAt,
      branch,
      headSha,
      carriedChange:
        input?.['patchRef'] !== undefined ||
        input?.['patch'] !== undefined ||
        path(input, 'commit', 'mergeFrom') !== undefined,
      checkFailed,
      checkAccount:
        check?.failureReason ??
        [checkOutput?.['summary'], checkOutput?.['tail']]
          .filter((part): part is string => typeof part === 'string' && part !== '')
          .join('\n'),
      findings: Array.isArray(describe?.['findings']) ? describe['findings'] : [],
    });
  }
  return out;
}

async function reviews(space: string, branchOfSha: Map<string, string>) {
  const out = [];
  for (const run of await runsOf(space, 'review-local-changes')) {
    const review = (await tasksOf(space, run.runId)).get('review');
    if (review?.status !== 'succeeded') continue;
    const input = await payload(review.inputRef);
    const output = await payload(review.outputRef);
    const range = path(input, 'inputs', 'range');
    const head = typeof range === 'string' ? range.split('..').pop() : undefined;
    const branch = head === undefined ? undefined : branchOfSha.get(head);
    const findings = path(output, 'result', 'findings');
    const verdict = path(output, 'result', 'verdict');
    if (branch === undefined || !Array.isArray(findings)) continue;
    out.push({ runId: run.runId, startedAt: run.startedAt, branch, verdict, findings });
  }
  return out;
}

function gh(path: string, paginate = false): unknown {
  const args = ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path];
  const text = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(text);
}

/** A job's log as text: `gh` strips the escape sequences a log carries unless asked not to. */
function ghText(path: string): string {
  return execFileSync('gh', ['api', '--allow-escape-sequences', path], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function ciPullRequest(repo: string, number: number) {
  const commits = (
    gh(`repos/${repo}/pulls/${String(number)}/commits?per_page=100`, true) as Array<
      Array<{ sha: string; parents: Array<{ sha: string }> }>
    >
  ).flat();
  const withFiles = commits.map((c) => {
    const detail = gh(`repos/${repo}/commits/${c.sha}`) as {
      files?: Array<{ filename: string; patch?: string }>;
    };
    return { sha: c.sha, parents: c.parents.map((p) => p.sha), files: detail.files ?? [] };
  });
  const failures = [];
  const attempts = [];
  for (const commit of commits) {
    const runs = (
      gh(`repos/${repo}/actions/runs?head_sha=${commit.sha}&per_page=100`) as {
        workflow_runs: Array<{ id: number; run_attempt: number }>;
      }
    ).workflow_runs;
    for (const run of runs) {
      for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
        attempts.push({ runId: run.id, attempt, headSha: commit.sha });
        const jobs = (
          gh(
            `repos/${repo}/actions/runs/${String(run.id)}/attempts/${String(attempt)}/jobs?per_page=100`,
          ) as { jobs: Array<{ id: number; conclusion: string | null }> }
        ).jobs;
        for (const job of jobs.filter((j) => j.conclusion === 'failure')) {
          failures.push({
            jobId: job.id,
            runId: run.id,
            attempt,
            headSha: commit.sha,
            log: ghText(`repos/${repo}/actions/jobs/${String(job.id)}/logs`),
          });
        }
      }
    }
  }
  return { number, commits: withFiles, failures, attempts };
}

async function collect(): Promise<void> {
  const space = arg('space');
  if (space === undefined) throw new Error('collect needs --space <spaceId>.');
  const repo = arg('repo') ?? 'aflowai/aflow';
  const [from, to] = (arg('prs') ?? '91-124').split('-').map(Number);
  const pubs = await publications(space);
  const branchOfSha = new Map(pubs.map((p) => [p.headSha, p.branch]));
  const cases: Case[] = [
    ...checkFailureCases(pubs),
    ...reviewCases(await reviews(space, branchOfSha), pubs),
  ];
  for (let n = from ?? 91; n <= (to ?? 124); n += 1) {
    process.stdout.write(`PR #${String(n)}… `);
    try {
      cases.push(...ciFailureCases(ciPullRequest(repo, n)));
    } catch (error) {
      // A number in the range can be an issue, not a pull request.
      if (!isGhNotFound(error)) throw error;
      process.stdout.write('(no pull request) ');
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'cases.json'), JSON.stringify(cases, null, 2));
  const labelled = cases.filter((c) => c.label !== null).length;
  console.log(
    `\n${String(cases.length)} cases, ${String(labelled)} labelled → ${OUT_DIR}/cases.json`,
  );
}

// ── measure ────────────────────────────────────────────────────────────────

function withoutBar(question: DecisionQuestion): DecisionQuestion {
  const { minConfidence: _bar, ...rest } = question;
  return rest as DecisionQuestion;
}

function stateOf(c: Case): unknown {
  return c.kind === 'after_check' ? { summary: c.state } : c.state;
}

async function askDecisionModel(client: AIClient, model: string, c: Case): Promise<Result> {
  const { name, question } = QUESTIONS[c.kind];
  const started = Date.now();
  const response = await client.decide({
    ...USAGE,
    model,
    state: stateOf(c) as string,
    questions: { [name]: withoutBar(question) },
  });
  const answer = response.answers[name];
  if (answer === undefined) throw new Error(`no answer for ${name}`);
  const base = {
    caseId: c.id,
    latencyMs: Date.now() - started,
    costUsd: response.cost?.totalCost ?? null,
  };
  if (answer.type === 'yes_no') {
    const p = answer.probability;
    return { ...base, value: p >= 0.5, confidence: Math.max(p, 1 - p) };
  }
  if (answer.type === 'choice')
    return { ...base, value: answer.choice, confidence: answer.confidence };
  throw new Error(`a ${answer.type} answer to a ${question.type} question`);
}

const CRITIQUE_SYSTEM =
  'You make one decision for an automated loop that publishes code changes. Read the state, write a short critique of what it shows and what it does not, then give your verdict and the probability that your verdict is the right one.';

async function askModel(client: AIClient, model: string, c: Case): Promise<Result> {
  const { question } = QUESTIONS[c.kind];
  const verdict =
    question.type === 'choice'
      ? z.enum(Object.keys(question.options) as [string, ...string[]])
      : z.boolean();
  const schema = z.object({
    critique: z.string(),
    verdict,
    confidence: z.number().min(0).max(1),
  });
  const started = Date.now();
  const response = await client.generateJson({
    ...USAGE,
    model,
    schema,
    schemaName: 'decision',
    messages: [
      { role: 'system', content: CRITIQUE_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({ question: withoutBar(question), state: stateOf(c) }, null, 2),
      },
    ],
  });
  return {
    caseId: c.id,
    value: response.data.verdict,
    confidence: response.data.confidence,
    critique: response.data.critique,
    latencyMs: Date.now() - started,
    costUsd: response.cost?.totalCost ?? null,
  };
}

async function eachCase(
  cases: Case[],
  ask: (c: Case) => Promise<Result>,
  label: string,
): Promise<Result[]> {
  const results: Result[] = [];
  for (const c of cases) {
    try {
      results.push(await ask(c));
    } catch (error) {
      results.push({ caseId: c.id, error: error instanceof Error ? error.message : String(error) });
    }
    process.stdout.write(`\r${label}: ${String(results.length)}/${String(cases.length)}`);
  }
  process.stdout.write('\n');
  return results;
}

async function measure(): Promise<void> {
  const labelsFile = arg('labels');
  const target = Number(arg('target') ?? '0.9');
  const raw = JSON.parse(readFileSync(join(OUT_DIR, 'cases.json'), 'utf8')) as Case[];
  const labels =
    labelsFile === undefined ? {} : (JSON.parse(readFileSync(labelsFile, 'utf8')) as object);
  const cases = applyOperatorLabels(raw, labels) as Case[];
  const labelled = cases.filter((c) => c.label !== null);

  const client = createAIClient({
    providers: {
      typesafe: { apiKey: process.env['TYPESAFE_API_KEY'] ?? '' },
      openai: { apiKey: process.env['OPENAI_API_KEY'] ?? '' },
      anthropic: { apiKey: process.env['ANTHROPIC_API_KEY'] ?? '' },
    },
  });
  const deciders: Array<{ name: string; key: string; ask: (c: Case) => Promise<Result> }> = [
    ...DECISION_MODELS.map((m) => ({
      name: m.id,
      key: PROVIDER_KEYS[m.provider] ?? `a key for ${m.provider}`,
      ask: (c: Case) => askDecisionModel(client, m.id, c),
    })),
    {
      name: `${LUNA} (critique, then verdict)`,
      key: 'OPENAI_API_KEY',
      ask: (c) => askModel(client, LUNA, c),
    },
    {
      name: `${OPUS} (critique, then verdict) — agent baseline`,
      key: 'ANTHROPIC_API_KEY',
      ask: (c) => askModel(client, OPUS, c),
    },
  ];

  const results: Record<string, Result[]> = {};
  for (const d of deciders) {
    if ((process.env[d.key] ?? '') === '') {
      console.log(`${d.name}: skipped — ${d.key} is not set.`);
      continue;
    }
    results[d.name] = await eachCase(labelled, d.ask, d.name);
  }

  const kinds = (Object.keys(QUESTIONS) as Array<Case['kind']>).map((kind) => {
    const ofKind = cases.filter((c) => c.kind === kind);
    const ids = new Set(ofKind.map((c) => c.id));
    const rows = Object.entries(results).map(([decider, all]) => {
      const mine = all.filter((r) => ids.has(r.caseId));
      const bar = chooseMinConfidence(ofKind, mine, target) ?? FALLBACK_BAR;
      return { decider, score: score(ofKind, mine, bar), sweep: sweep(ofKind, mine) };
    });
    return { kind, title: TITLES[kind], cases: ofKind, rows };
  });

  const generatedAt = new Date().toISOString();
  let report = renderReport({ generatedAt, kinds });
  report += `\nEach decider's bar is the lowest that reaches ${String(target * 100)}% agreement among what it decides; where none does, ${String(FALLBACK_BAR)}.\n`;
  // A bar is read off a decision model's sweep, so each one measured prints its own.
  const decisionModelIds = new Set(DECISION_MODELS.map((m) => m.id));
  for (const kind of kinds) {
    for (const row of kind.rows.filter((r) => decisionModelIds.has(r.decider))) {
      report += `\n${row.decider} sweep — ${kind.title}: ${row.sweep
        .map(
          (s: { minConfidence: number; agreement: number | null; abstention: number | null }) =>
            `${s.minConfidence.toFixed(2)} → ${s.agreement === null ? '—' : (s.agreement * 100).toFixed(1)}% / ${s.abstention === null ? '—' : (s.abstention * 100).toFixed(1)}% abstain`,
        )
        .join('; ')}\n`;
    }
  }
  writeFileSync(
    join(OUT_DIR, 'results.json'),
    JSON.stringify({ generatedAt, target, results }, null, 2),
  );
  writeFileSync(join(OUT_DIR, 'report.md'), report);
  console.log(report);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'collect') return collect();
  if (command === 'measure') return measure();
  console.error(
    'Usage: yarn decisions:measure-loop collect --space <spaceId> | measure [--labels <file>]',
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
