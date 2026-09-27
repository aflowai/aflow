import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findUnpinnedGithubApiTasks,
  deriveRequiredCapabilities,
  resolveConnectionGrantsToBinding,
} from '@aflow/cybernetic-runtime';
import type { IntegrationCapabilityGrant, WorkflowTask } from '@aflow/schemas';
import { getSkillCatalogEntry, SKILL_CATALOG } from '../skillCatalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_CATALOG_DIR = join(HERE, '..', 'skillCatalog');
const CODING_SLUGS = ['open-pr-from-request', 'pr-shepherd', 'review-pull-request'] as const;

function allFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...allFilesUnder(full));
    else out.push(full);
  }
  return out;
}

function codingTasks(slug: string): WorkflowTask[] {
  const entry = getSkillCatalogEntry(slug);
  if (!entry) throw new Error(`skill catalog entry "${slug}" not found`);
  return entry.bundle.workflow.tasks as unknown as WorkflowTask[];
}

describe('coding skills — GitHub connection guards (Plan 222 P3d)', () => {
  // (a) The fixed `github-default` account must never be hard-coded by a skill —
  // it would scope-resolve at dispatch and silently call an arbitrary account.
  it('no file under skillCatalog/ contains the literal "github-default"', () => {
    const offenders: string[] = [];
    for (const file of allFilesUnder(SKILL_CATALOG_DIR)) {
      if (readFileSync(file, 'utf8').includes('github-default')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  // (b) Exhaustive conversion: EVERY github `api.http.call` task in the shipped
  // coding skills pins the connection. A single missed task (op-task with
  // inputTemplate.apiId==='github' and no connection_binding pin) fails here.
  it('every github api.http.call task in the coding skills pins the connection', () => {
    for (const slug of CODING_SLUGS) {
      const unpinned = findUnpinnedGithubApiTasks(codingTasks(slug));
      expect(unpinned, slug).toEqual([]);
    }
  });

  // (b′) The conversion is non-trivial: each skill DOES have github api.http.call
  // tasks (so the guard above is not vacuously green on a skill with none).
  it('the coding skills actually contain github api.http.call tasks', () => {
    const counts = CODING_SLUGS.map(
      (slug) =>
        codingTasks(slug).filter(
          (t) =>
            t.operation === 'api.http.call' &&
            (t.inputTemplate as { apiId?: string } | undefined)?.apiId === 'github',
        ).length,
    );
    // open-pr (2) · pr-shepherd (3) · review (4).
    expect(counts).toEqual([2, 3, 4]);
  });

  // (d) The derived required-capabilities must be SATISFIABLE by a designated github
  // connection — no unsatisfiable placeholder capability that would permanently block
  // run-start/resume. The rehydrate agent grant's capabilityId is the integration id
  // (`github`), NOT the connection-placeholder binding. Plan 222 P3d BLOCKER regression.
  it('every coding skill derives only satisfiable required capabilities (no connection placeholder)', () => {
    for (const slug of CODING_SLUGS) {
      const entry = getSkillCatalogEntry(slug);
      if (!entry) throw new Error(`skill catalog entry "${slug}" not found`);
      const required = deriveRequiredCapabilities(
        entry.bundle as unknown as Parameters<typeof deriveRequiredCapabilities>[0],
      );
      expect(required, slug).not.toContain('github-connection');
      // Space-independent satisfiable tokens only: `github` (any designated github
      // connection) + `code_repo` (any ready repo) + `code_model:zai` (the pinned
      // coding-lane backend credential) + `code` (the space's coding-lane policy
      // switch). The specific connection binding is pinned at dispatch, never a
      // static required capability.
      expect([...required].sort(), slug).toEqual(['code', 'code_model:zai', 'code_repo', 'github']);
    }
  });

  // (c) The drift detector flags an UNCONVERTED github task and clears a CONVERTED
  // one — the exact predicate the run-start frozen-skill guard fails closed on.
  it('the drift detector flags an unconverted github task and passes a converted one', () => {
    const unconverted = [
      {
        taskId: 'merge',
        type: 'operation',
        operation: 'api.http.call',
        inputTemplate: { apiId: 'github', endpointId: 'mergePullRequest', params: {} },
      },
    ] as unknown as WorkflowTask[];
    expect(findUnpinnedGithubApiTasks(unconverted)).toEqual(['merge']);

    const converted = [
      {
        taskId: 'merge',
        type: 'operation',
        operation: 'api.http.call',
        inputBindings: { githubConnection: { kind: 'connection_binding' } },
        inputTemplate: {
          apiId: 'github',
          endpointId: 'mergePullRequest',
          bindingId: { $bind: 'githubConnection' },
          params: {},
        },
      },
    ] as unknown as WorkflowTask[];
    expect(findUnpinnedGithubApiTasks(converted)).toEqual([]);

    // A non-github api task is never an offender (only the github account drift matters).
    const otherApi = [
      {
        taskId: 'kaggle',
        type: 'operation',
        operation: 'api.http.call',
        inputTemplate: { apiId: 'kaggle', endpointId: 'submit', params: {} },
      },
    ] as unknown as WorkflowTask[];
    expect(findUnpinnedGithubApiTasks(otherApi)).toEqual([]);
  });

  // (e) A connection-deferred grant resolves at dispatch to the run's pinned
  // connection, which only a repo-pin producer (`code.*` op task) sets. Until a
  // general pin producer exists, a `{kind:'connection'}` grant may appear ONLY on
  // skills that carry such a producer — otherwise it would reach dispatch unpinned
  // and (fail-closed) silently withhold its tools forever.
  it('every {kind:connection} grant appears only on a skill carrying a repo-pin producer', () => {
    const hasConnectionGrant = (tasks: WorkflowTask[]): boolean =>
      tasks.some((t) =>
        (t.context?.capabilities?.integrations ?? []).some((g) => g.binding.kind === 'connection'),
      );
    const hasRepoPinProducer = (tasks: WorkflowTask[]): boolean =>
      tasks.some((t) => typeof t.operation === 'string' && t.operation.startsWith('code.'));

    for (const entry of SKILL_CATALOG) {
      const tasks = entry.bundle.workflow.tasks as unknown as WorkflowTask[];
      if (hasConnectionGrant(tasks)) {
        expect(hasRepoPinProducer(tasks), entry.catalogId).toBe(true);
      }
    }
  });

  // (f) The cut from a placeholder bindingId to a typed `{kind:'connection'}` grant
  // does NOT change the resolved tool surface: capabilityId stays `github`, and once
  // pinned the grant resolves to the connection binding with the same read endpoints.
  it('the resolved github read tool surface is unchanged after the connection cut', () => {
    const integrations = (codingTasks('pr-shepherd').find((t) => t.taskId === 'rehydrate')?.context
      ?.capabilities?.integrations ?? []) as IntegrationCapabilityGrant[];
    const resolved = resolveConnectionGrantsToBinding(integrations, 'conn-xyz');
    const github = resolved.find((g) => g.integrationId === 'github');
    expect(github?.capabilityId).toBe('github');
    expect(github?.binding).toEqual({ kind: 'binding', bindingId: 'conn-xyz' });
    expect(github?.toolNames.map((t) => t.toolName).sort()).toEqual([
      'getPullRequest',
      'listCheckRuns',
      'listIssueComments',
      'listPullRequestReviews',
      'listReviewComments',
    ]);
  });
});
