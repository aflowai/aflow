import { describe, expect, it } from 'vitest';
import { TaskGraphDraftSchema } from '@aflow/schemas';

// Per-kind constraints are now Zod superRefines (Plan 206 folded the JSON
// mirror into the single authority). safeParse is the enforcement the runner's
// submit_output runs via the compose.task-graph-draft validatorRef.
const validate = (draft: unknown): boolean => TaskGraphDraftSchema.safeParse(draft).success;

function baseDraft(tasks: unknown[]): Record<string, unknown> {
  return {
    slug: 'sample',
    name: 'Sample',
    description: 'Sample.',
    goal: 'Goal.',
    outcomes: [
      {
        id: 'done',
        name: 'Done',
        evaluator: { type: 'manual', instruction: 'Manual.' },
      },
    ],
    tasks,
  };
}

type IntegrationFixture = {
  sourceKind: 'api' | 'mcp';
  integrationId: string;
  bindingId: string;
  toolNames: string[];
};

function agentTask(opts: {
  taskId: string;
  kind: 'fetcher' | 'transformer' | 'writeback' | 'judge' | 'researcher';
  integrations?: IntegrationFixture[];
  operations?: string[];
  produces?: Array<{
    key: string;
    shape: unknown;
    semantics?: string;
    providesPurposeId?: string;
  }>;
  consumes?: Array<{ taskId: string; outputKey: string; bindAs: string }>;
}): Record<string, unknown> {
  return {
    type: 'agent',
    kind: opts.kind,
    taskId: opts.taskId,
    goal: `Do work for ${opts.taskId}.`,
    dependsOn: [],
    consumes: opts.consumes ?? [],
    produces: opts.produces ?? [],
    context: {
      capabilities: {
        integrations: opts.integrations ?? [],
        operations: opts.operations ?? [],
      },
    },
  };
}

describe('TaskGraphDraft per-kind capability constraints (Zod)', () => {
  // ── fetcher ──────────────────────────────────────────────────────────
  describe('fetcher', () => {
    it('passes when an api grant with non-empty endpoints is present', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'fetch',
          kind: 'fetcher',
          integrations: [
            {
              sourceKind: 'api' as const,
              integrationId: 'kaggle',
              bindingId: 'kaggle-default',
              toolNames: ['get_data'],
            },
          ],
        }),
      ]);
      expect(validate(draft)).toBe(true);
    });

    it('rejects fetcher with no callable api/mcp grant', () => {
      const draft = baseDraft([agentTask({ taskId: 'fetch', kind: 'fetcher' })]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects fetcher with compute.sandbox.exec grant (escape hatch closed)', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'fetch',
          kind: 'fetcher',
          integrations: [
            {
              sourceKind: 'api' as const,
              integrationId: 'kaggle',
              bindingId: 'kaggle-default',
              toolNames: ['get_data'],
            },
          ],
          operations: ['compute.sandbox.exec'],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });
  });

  // ── transformer ──────────────────────────────────────────────────────
  describe('transformer', () => {
    it('passes with compute and no api grants', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'transform',
          kind: 'transformer',
          operations: ['compute.sandbox.exec'],
        }),
      ]);
      expect(validate(draft)).toBe(true);
    });

    it('rejects transformer with api grants', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'transform',
          kind: 'transformer',
          integrations: [
            { sourceKind: 'api' as const, integrationId: 'x', bindingId: 'x-d', toolNames: ['e'] },
          ],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects transformer with mcp grants', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'transform',
          kind: 'transformer',
          integrations: [
            { sourceKind: 'mcp' as const, integrationId: 'x', bindingId: 'x-d', toolNames: ['t'] },
          ],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });
  });

  // ── writeback ────────────────────────────────────────────────────────
  describe('writeback', () => {
    it('passes with api grant and no providesPurposeId', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'writeback',
          kind: 'writeback',
          integrations: [
            {
              sourceKind: 'api' as const,
              integrationId: 'x',
              bindingId: 'x-d',
              toolNames: ['post'],
            },
          ],
          produces: [{ key: 'receipt', shape: { type: 'object' } }],
        }),
      ]);
      expect(validate(draft)).toBe(true);
    });

    it('rejects writeback with no callable grant', () => {
      const draft = baseDraft([agentTask({ taskId: 'writeback', kind: 'writeback' })]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects writeback with compute.sandbox.exec', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'writeback',
          kind: 'writeback',
          integrations: [
            {
              sourceKind: 'api' as const,
              integrationId: 'x',
              bindingId: 'x-d',
              toolNames: ['post'],
            },
          ],
          operations: ['compute.sandbox.exec'],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects writeback that labels providesPurposeId (writebacks do not produce real source data)', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'writeback',
          kind: 'writeback',
          integrations: [
            {
              sourceKind: 'api' as const,
              integrationId: 'x',
              bindingId: 'x-d',
              toolNames: ['post'],
            },
          ],
          produces: [
            { key: 'receipt', shape: { type: 'object' }, providesPurposeId: 'should-not-be-here' },
          ],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });
  });

  // ── judge ────────────────────────────────────────────────────────────
  describe('judge', () => {
    it('passes with no api/mcp grants', () => {
      const draft = baseDraft([agentTask({ taskId: 'judge', kind: 'judge' })]);
      expect(validate(draft)).toBe(true);
    });

    it('rejects judge with api grants', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'judge',
          kind: 'judge',
          integrations: [
            { sourceKind: 'api' as const, integrationId: 'x', bindingId: 'x-d', toolNames: ['e'] },
          ],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });
  });

  // ── researcher ───────────────────────────────────────────────────────
  describe('researcher', () => {
    it('passes with broad grants (exploration mode — no per-tool structural constraints)', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'research',
          kind: 'researcher',
          integrations: [
            { sourceKind: 'api' as const, integrationId: 'x', bindingId: 'x-d', toolNames: ['e'] },
          ],
          operations: ['compute.sandbox.exec'],
        }),
      ]);
      expect(validate(draft)).toBe(true);
    });

    it('rejects researcher that labels providesPurposeId (escape-hatch closed — researcher cannot satisfy real-source data requirements)', () => {
      const draft = baseDraft([
        agentTask({
          taskId: 'research',
          kind: 'researcher',
          integrations: [
            { sourceKind: 'api' as const, integrationId: 'x', bindingId: 'x-d', toolNames: ['e'] },
          ],
          produces: [
            { key: 'records', shape: { type: 'object' }, providesPurposeId: 'should-not-be-here' },
          ],
        }),
      ]);
      expect(validate(draft)).toBe(false);
    });
  });

  // ── omitted-context defenses ────────────────────────────────────────
  describe('omitted nested fields are not vacuously satisfied', () => {
    function bareAgentTask(kind: string, taskId: string): Record<string, unknown> {
      // Deliberately omits `context`/`capabilities` — Zod defaults them to
      // empty grants, so a fetcher/writeback still fails for lack of a
      // callable grant (the rule is not vacuously satisfied by omission).
      return {
        type: 'agent',
        kind,
        taskId,
        goal: `Do work for ${taskId}.`,
        produces: [],
        consumes: [],
        dependsOn: [],
      };
    }

    it('rejects fetcher with no context.capabilities at all', () => {
      const draft = baseDraft([bareAgentTask('fetcher', 'fetch')]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects writeback with no context.capabilities at all', () => {
      const draft = baseDraft([bareAgentTask('writeback', 'wb')]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects fetcher with context but no capabilities subobject', () => {
      const draft = baseDraft([
        {
          ...bareAgentTask('fetcher', 'fetch'),
          context: {},
        },
      ]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects fetcher with capabilities but no apis/mcpServers arrays', () => {
      const draft = baseDraft([
        {
          ...bareAgentTask('fetcher', 'fetch'),
          context: { capabilities: {} },
        },
      ]);
      expect(validate(draft)).toBe(false);
    });

    it('rejects fetcher with empty apis array', () => {
      const draft = baseDraft([
        {
          ...bareAgentTask('fetcher', 'fetch'),
          context: { capabilities: { integrations: [], operations: [] } },
        },
      ]);
      expect(validate(draft)).toBe(false);
    });
  });

  // ── kind required ───────────────────────────────────────────────────
  it('rejects an agent task with no kind field', () => {
    const draft = baseDraft([
      {
        type: 'agent',
        // no kind
        taskId: 'no-kind',
        goal: 'g',
        dependsOn: [],
        consumes: [],
        produces: [],
        context: { capabilities: { integrations: [], operations: [] } },
      },
    ]);
    expect(validate(draft)).toBe(false);
  });
});
