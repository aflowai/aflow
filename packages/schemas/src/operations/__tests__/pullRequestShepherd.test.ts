/**
 * Contract: what the Local PR Shepherd reads and writes is defined once —
 * the handoff record it reads back is the one it wrote, the folder's origin
 * names a GitHub repository or nothing, the run list it reads in-flight work
 * with is one bounded page that counts a paused run as in flight, the
 * operations the shepherd adds run only as its workflow's tasks, and a
 * bundle's agent starts only one of the bundle's own skills.
 */
import { describe, expect, it } from 'vitest';
import {
  getOperation,
  grantDecisionForOperation,
  parseGitHubRemote,
  type RunAccessGrant,
  parseShepherdHandoff,
  decodeRequiredChecks,
  encodeRequiredChecks,
  SHEPHERD_HANDOFF_CLOSE,
  SHEPHERD_HANDOFF_FIELDS,
  SHEPHERD_HANDOFF_OPEN,
  SHEPHERD_MERGE_OUTCOMES,
  SkillBundleSchema,
  WORKFLOW_RUN_LIST_LIMIT_MAX,
  WorkflowRunDecideInputSchema,
  WorkflowRunListInputSchema,
} from '../../index.js';

describe('the shepherd handoff record', () => {
  const body = [
    SHEPHERD_HANDOFF_OPEN,
    'attemptCount: 2',
    'checkRunId: 556',
    'headSha: cccc',
    'decision: fix',
    'classification: code_defect',
    'publicationRunId: ',
    SHEPHERD_HANDOFF_CLOSE,
    '**Local PR Shepherd** — this pass: `fix`. CI failed.',
  ].join('\n');

  it('reads back what a pass wrote, an empty field as absent', () => {
    expect(parseShepherdHandoff(body)).toEqual({
      attemptCount: 2,
      checkRunId: '556',
      headSha: 'cccc',
      decision: 'fix',
      classification: 'code_defect',
    });
  });

  it('is no record in a comment that does not open with the marker', () => {
    expect(parseShepherdHandoff(`A person's comment.\n${body}`)).toBeNull();
  });

  it('reads a count it cannot read as none acted on, rather than refusing the pull request', () => {
    expect(parseShepherdHandoff(`${SHEPHERD_HANDOFF_OPEN}\nattemptCount: many\n-->`)).toEqual({
      attemptCount: 0,
    });
  });

  it('files this pass’s merge outcome under its field, over one carried forward', () => {
    const record = parseShepherdHandoff(
      [
        SHEPHERD_HANDOFF_OPEN,
        'attemptCount: 1',
        `headSha: ${'c'.repeat(40)}`,
        `mergeDeclinedSha: ${'d'.repeat(40)}`,
        `mergeRefusedSha: ${'e'.repeat(40)}`,
        'mergeCommitSha: ',
        `mergeOutcome: merge_refused ${'c'.repeat(40)}`,
        SHEPHERD_HANDOFF_CLOSE,
        'Prose.',
      ].join('\n'),
    );
    expect(record).toEqual({
      attemptCount: 1,
      headSha: 'c'.repeat(40),
      mergeDeclinedSha: 'd'.repeat(40),
      mergeRefusedSha: 'c'.repeat(40),
    });
  });

  it('reads no merge outcome it does not know', () => {
    for (const line of ['mergeOutcome: approved abc', 'mergeOutcome: merged', 'mergeOutcome: ']) {
      expect(
        parseShepherdHandoff(`${SHEPHERD_HANDOFF_OPEN}\n${line}\n${SHEPHERD_HANDOFF_CLOSE}`),
      ).toEqual({ attemptCount: 0 });
    }
  });

  it('names one field for each merge outcome, each a field of the record', () => {
    expect(Object.keys(SHEPHERD_MERGE_OUTCOMES).sort()).toEqual([
      'merge_declined',
      'merge_refused',
      'merged',
    ]);
    for (const field of Object.values(SHEPHERD_MERGE_OUTCOMES)) {
      expect(SHEPHERD_HANDOFF_FIELDS).toContain(field);
    }
  });
});

describe('the required checks as text', () => {
  it('round-trips any name, the separator among them, and the empty set as the empty string', () => {
    const names = ['Test', 'a,b', 'c:d', 'e%2Cf', 'ünïcode'];
    expect(decodeRequiredChecks(encodeRequiredChecks(names))).toEqual([...names].sort());
    expect(encodeRequiredChecks([])).toBe('');
    expect(decodeRequiredChecks('')).toEqual([]);
    expect(() => decodeRequiredChecks('a,,b')).toThrow();
  });
});

describe("the folder's GitHub origin", () => {
  it.each([
    'https://github.com/aflowai/aflow.git',
    'https://github.com/aflowai/aflow',
    'git@github.com:aflowai/aflow.git',
    'ssh://git@github.com/aflowai/aflow.git',
    'https://token@github.com/aflowai/aflow.git',
  ])('names the repository %s points at', (url) => {
    expect(parseGitHubRemote(url)).toEqual({ owner: 'aflowai', repo: 'aflow' });
  });

  it.each([
    'https://gitlab.com/aflowai/aflow.git',
    'git@github.example.com:aflowai/aflow.git',
    'https://github.com/aflowai',
    'https://github.com/aflowai/aflow/tree/main',
    'https://github.com/aflowai/..',
    '/srv/git/aflow.git',
  ])('names nothing for %s', (url) => {
    expect(parseGitHubRemote(url)).toBeUndefined();
  });
});

describe('workflow.run.list', () => {
  const query = { slug: 'publish-local-changes', input: { field: 'branch', equals: 'aflow/x' } };

  it('lists the runs in flight by default — paused among them — one page of 25', () => {
    expect(WorkflowRunListInputSchema.parse(query)).toEqual({
      ...query,
      status: ['running', 'paused'],
      limit: 25,
    });
  });

  it('reads at most one page of 100', () => {
    expect(WorkflowRunListInputSchema.safeParse({ ...query, limit: 100 }).success).toBe(true);
    expect(
      WorkflowRunListInputSchema.safeParse({ ...query, limit: WORKFLOW_RUN_LIST_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it('takes one input field, named as a run input is', () => {
    expect(
      WorkflowRunListInputSchema.safeParse({ ...query, input: { field: 'a.b', equals: 'x' } })
        .success,
    ).toBe(false);
    expect(WorkflowRunListInputSchema.safeParse({ slug: 'x' }).success).toBe(false);
  });
});

describe('workflow.run.decide', () => {
  it('takes ordered rules and a default, each a lowercase decision with its reason', () => {
    const input = {
      state: {},
      rules: [{ when: { expression: 'state.a == 1' }, decision: 'wait', reason: 'Because.' }],
      otherwise: { decision: 'fix', reason: 'Otherwise.' },
    };
    expect(WorkflowRunDecideInputSchema.safeParse(input).success).toBe(true);
    expect(
      WorkflowRunDecideInputSchema.safeParse({
        ...input,
        otherwise: { decision: 'Fix!', reason: 'x' },
      }).success,
    ).toBe(false);
  });
});

describe('the shepherd’s own operations', () => {
  const workflowRunReader: RunAccessGrant = {
    spaceId: '00000000-0000-0000-0000-000000000001',
    accessLevel: 'write',
    grantedToUserId: '00000000-0000-0000-0000-000000000002',
    tenantRole: 'member',
    spaceRole: 'editor',
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    capabilities: {
      allowedCapabilities: [{ capabilityGroupId: 'workflow.run', accessMode: 'read' }],
      deniedCapabilities: [],
      allowedRiskModifiers: [],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    grantReason: 'start',
    resourceScopes: [],
  };

  it.each(['workflow.run.list', 'workflow.run.decide'])(
    '%s runs only as a workflow task: an agent calling it is refused under the grant that lets the task run',
    (operationId) => {
      expect(getOperation(operationId)?.opTaskOnly).toBe(true);
      expect(
        grantDecisionForOperation(workflowRunReader, operationId, { kind: 'op_task' }).allowed,
      ).toBe(true);
      expect(
        grantDecisionForOperation(workflowRunReader, operationId, { kind: 'agent' }).allowed,
      ).toBe(false);
    },
  );
});

describe('a bundled agent', () => {
  const bundle = {
    bundleId: 'b',
    version: 1,
    name: 'B',
    tagline: 't',
    description: 'd',
    skillCatalogIds: ['local-pr-shepherd'],
  };
  const agent = {
    kind: 'skill_starter',
    skillCatalogId: 'local-pr-shepherd',
    name: 'A',
    description: 'Starts it.',
    folderInput: 'bindingId',
  };

  it('starts one of the bundle’s own skills', () => {
    expect(SkillBundleSchema.safeParse({ ...bundle, agents: [agent] }).success).toBe(true);
    expect(
      SkillBundleSchema.safeParse({ ...bundle, agents: [{ ...agent, skillCatalogId: 'other' }] })
        .success,
    ).toBe(false);
  });

  it('leaves a bundle without agents as it was, with no field written in', () => {
    expect(SkillBundleSchema.parse(bundle)).not.toHaveProperty('agents');
  });
});
