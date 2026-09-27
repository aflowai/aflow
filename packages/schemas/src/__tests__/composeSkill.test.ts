import { describe, it, expect } from 'vitest';
import {
  ComposeIntentSchema,
  DesignSurfaceSchema,
  PrepareDesignSurfaceInputSchema,
  PrepareDesignSurfaceOutputSchema,
  ProvenanceSchema,
  TaskGraphDraftSchema,
  WorkflowAssemblyInputSchema,
  isUsableJsonSchema,
} from '../cybernetic/composeSkill.js';

describe('ComposeIntentSchema', () => {
  it('parses a minimal intent and applies array defaults', () => {
    const parsed = ComposeIntentSchema.parse({
      intent: 'Submit a Kaggle notebook',
      iterationModel: 'optimization',
    });
    expect(parsed.authoringIntent).toBe('create_new_skill');
    expect(parsed.requiredCapabilities).toEqual([]);
    expect(parsed.requiredDataSources).toEqual([]);
    expect(parsed.taskShapeHints).toEqual([]);
    expect(parsed.pauseForUser).toEqual({ needed: false });
  });

  it('parses a fully specified intent', () => {
    const parsed = ComposeIntentSchema.parse({
      intent: 'Submit a Kaggle notebook for the Titanic competition',
      iterationModel: 'optimization',
      requiredCapabilities: [
        {
          kind: 'api',
          identifier: 'kaggle-rest-api',
          rationale: 'user explicitly named Kaggle as the submission target',
        },
      ],
      requiredDataSources: [
        { purposeId: 'titanic-train', sourceKind: 'api', sourceId: 'kaggle-rest-api' },
      ],
      taskShapeHints: [{ purpose: 'submission-csv', suggestedKind: 'agent' }],
      pauseForUser: { needed: true, when: 'before submission' },
    });
    expect(parsed.requiredCapabilities[0]?.identifier).toBe('kaggle-rest-api');
    expect(parsed.pauseForUser.needed).toBe(true);
  });

  it('accepts explicit existing-skill modification intent', () => {
    const parsed = ComposeIntentSchema.parse({
      authoringIntent: 'modify_existing_skill',
      intent: 'Fix the existing kaggle-optimizer skill dependency edge.',
      iterationModel: 'optimization',
    });
    expect(parsed.authoringIntent).toBe('modify_existing_skill');
  });

  it('rejects unknown iterationModel values (no `graph`)', () => {
    const result = ComposeIntentSchema.safeParse({
      intent: 'x',
      iterationModel: 'graph',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty intent string', () => {
    const result = ComposeIntentSchema.safeParse({ intent: '', iterationModel: 'process' });
    expect(result.success).toBe(false);
  });
});

describe('DesignSurfaceSchema', () => {
  it('parses a minimal feasible surface', () => {
    const parsed = DesignSurfaceSchema.parse({
      integrations: [],
      operations: [],
      policies: { compute: false },
      bindableButUnbound: [],
    });
    expect(parsed.policies['compute']).toBe(false);
  });

  it('captures bound API + MCP integrations with toolNames (Plan 155 §10)', () => {
    const parsed = DesignSurfaceSchema.parse({
      integrations: [
        {
          sourceKind: 'api',
          integrationId: 'kaggle-rest-api',
          bindingId: 'kaggle-prod',
          toolNames: ['submit', 'list'],
        },
        {
          sourceKind: 'mcp',
          integrationId: 'kaggle',
          bindingId: 'kaggle-mcp',
          toolNames: ['fetch_dataset'],
        },
      ],
      operations: ['memory.store.put', 'workflow.manage.list'],
      policies: { compute: true },
    });
    const api = parsed.integrations.find((i) => i.sourceKind === 'api');
    const mcp = parsed.integrations.find((i) => i.sourceKind === 'mcp');
    expect(api?.toolNames).toEqual(['submit', 'list']);
    expect(mcp?.toolNames).toEqual(['fetch_dataset']);
    expect(parsed.bindableButUnbound).toEqual([]);
  });
});

describe('PrepareDesignSurfaceInputSchema', () => {
  it('parses { intent: ComposeIntent }', () => {
    const parsed = PrepareDesignSurfaceInputSchema.parse({
      intent: { intent: 'do x', iterationModel: 'process' },
    });
    expect(parsed.intent.intent).toBe('do x');
  });

  it('rejects a bare ComposeIntent at the root (no wrapper)', () => {
    const result = PrepareDesignSurfaceInputSchema.safeParse({
      intent: 'do x',
      iterationModel: 'process',
    });
    expect(result.success).toBe(false);
  });
});

describe('PrepareDesignSurfaceOutputSchema', () => {
  it('parses the feasible branch', () => {
    const parsed = PrepareDesignSurfaceOutputSchema.parse({
      status: 'feasible',
      designSurface: {
        integrations: [],
        operations: [],
        policies: { compute: false },
        bindableButUnbound: [],
      },
    });
    expect(parsed.status).toBe('feasible');
  });

  it('parses the blocked branch with handoff', () => {
    const parsed = PrepareDesignSurfaceOutputSchema.parse({
      status: 'blocked',
      reason: 'needs_binding',
      missing: [{ kind: 'api', identifier: 'kaggle-rest-api' }],
      handoff: {
        skillSlug: 'bind-capability',
        prefill: { apiNames: ['kaggle-rest-api'] },
      },
    });
    if (parsed.status !== 'blocked') throw new Error('expected blocked');
    expect(parsed.handoff.skillSlug).toBe('bind-capability');
  });

  it('parses the unsupported branch', () => {
    const parsed = PrepareDesignSurfaceOutputSchema.parse({
      status: 'unsupported',
      missing: [{ kind: 'api', identifier: 'made-up-api' }],
    });
    expect(parsed.status).toBe('unsupported');
  });

  it('rejects blocked branch with empty missing list', () => {
    const result = PrepareDesignSurfaceOutputSchema.safeParse({
      status: 'blocked',
      reason: 'needs_binding',
      missing: [],
      handoff: { skillSlug: 'bind-capability', prefill: {} },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown status', () => {
    const result = PrepareDesignSurfaceOutputSchema.safeParse({
      status: 'maybe',
      missing: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('ProvenanceSchema (deprecated stub)', () => {
  // Provenance gates removed 2026-05-06 — see assembleWorkflow.ts top-of-
  // file note. The schema is retained as an empty `.passthrough()` stub
  // for callers in the middle of migration; it no longer enforces
  // `synthetic: false`. Future fabrication detection moves to Coach
  it('accepts arbitrary objects (the schema is now an empty passthrough)', () => {
    const parsed = ProvenanceSchema.parse({
      sourceKind: 'api',
      sourceId: 'kaggle-rest-api',
      synthetic: false,
    });
    expect((parsed as { sourceKind: string }).sourceKind).toBe('api');
  });
});

describe('TaskGraphDraftSchema', () => {
  // Minimal naming + outcomes block reused across the per-task assertions —
  // the draft is now the full LLM authoring surface (§5.3), not just `tasks`.
  const namingHeader = {
    slug: 'fetch-data',
    name: 'Fetch Data',
    description: 'Fetch some data.',
    goal: 'Get the data',
    outcomes: [
      {
        id: 'done',
        name: 'Done',
        evaluator: { type: 'manual' as const, instruction: 'It worked.' },
      },
    ],
  };

  it('parses a minimal agent-only draft', () => {
    // transformer needs no capability grant — a minimal valid agent task.
    const parsed = TaskGraphDraftSchema.parse({
      ...namingHeader,
      tasks: [{ type: 'agent', kind: 'transformer', taskId: 'transform', goal: 'Transform data' }],
    });
    expect(parsed.slug).toBe('fetch-data');
    expect(parsed.tasks[0]?.type).toBe('agent');
  });

  it('parses an operation task with operationId required', () => {
    const parsed = TaskGraphDraftSchema.parse({
      ...namingHeader,
      tasks: [{ type: 'operation', taskId: 'store', operationId: 'memory.store.put' }],
    });
    expect(parsed.tasks[0]?.type).toBe('operation');
  });

  it('rejects an operation task without operationId', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...namingHeader,
      tasks: [{ type: 'operation', taskId: 'store' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a human task without pauseInstruction', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...namingHeader,
      tasks: [{ type: 'human', taskId: 'approve' }],
    });
    expect(result.success).toBe(false);
  });

  describe('HumanTask intent — Plan 156 §7B', () => {
    it("defaults intent to 'collect' when the draft omits it", () => {
      const parsed = TaskGraphDraftSchema.parse({
        ...namingHeader,
        tasks: [
          {
            type: 'human',
            taskId: 'ask',
            pauseInstruction: 'Which dataset should I use?',
          },
        ],
      });
      const task = parsed.tasks[0]!;
      // Narrow without an `as` cast; the union discriminator is `type`.
      if (task.type !== 'human') throw new Error('expected human task');
      expect(task.intent).toBe('collect');
    });

    it("accepts intent: 'approve' verbatim", () => {
      const parsed = TaskGraphDraftSchema.parse({
        ...namingHeader,
        tasks: [
          {
            type: 'human',
            taskId: 'approve-submission',
            pauseInstruction: 'Approve the predictions before submission?',
            intent: 'approve',
          },
        ],
      });
      const task = parsed.tasks[0]!;
      if (task.type !== 'human') throw new Error('expected human task');
      expect(task.intent).toBe('approve');
    });

    it('rejects an unrecognised intent value', () => {
      const result = TaskGraphDraftSchema.safeParse({
        ...namingHeader,
        tasks: [
          {
            type: 'human',
            taskId: 'ask',
            pauseInstruction: 'q',
            intent: 'observe',
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  it('rejects a draft without workflow naming + outcomes', () => {
    const result = TaskGraphDraftSchema.safeParse({
      tasks: [{ type: 'agent', kind: 'fetcher', taskId: 'fetch', goal: 'Fetch' }],
    });
    expect(result.success).toBe(false);
  });

  describe('produces[].shape — Plan 129 tightening', () => {
    function draftWithShape(shape: unknown) {
      // transformer: this block tests the shape rule only, so use a kind that
      // needs no capability grant (fetcher would also fail for lack of one).
      return {
        ...namingHeader,
        tasks: [
          {
            type: 'agent' as const,
            kind: 'transformer' as const,
            taskId: 'transform',
            goal: 'Transform data',
            produces: [{ key: 'data', shape }],
          },
        ],
      };
    }

    it('accepts a real JSON Schema with a `type` keyword', () => {
      const result = TaskGraphDraftSchema.safeParse(
        draftWithShape({ type: 'object', properties: { x: { type: 'number' } } }),
      );
      expect(result.success).toBe(true);
    });

    it.each([
      ['$ref', { $ref: '#/$defs/Thing' }],
      ['oneOf', { oneOf: [{ type: 'string' }, { type: 'number' }] }],
      ['anyOf', { anyOf: [{ type: 'string' }] }],
      ['allOf', { allOf: [{ type: 'object' }] }],
      ['enum', { enum: ['a', 'b'] }],
      ['const', { const: 42 }],
    ])('accepts a shape using %s', (_label, shape) => {
      const result = TaskGraphDraftSchema.safeParse(draftWithShape(shape));
      expect(result.success).toBe(true);
    });

    it('rejects an empty `{}` (no structural keyword)', () => {
      const result = TaskGraphDraftSchema.safeParse(draftWithShape({}));
      expect(result.success).toBe(false);
    });

    it('rejects an object that has properties but no `type`', () => {
      // The LLM might emit `{ properties: {...} }` thinking that's a schema.
      // It's not — Ajv would treat it as accept-everything. Reject it.
      const result = TaskGraphDraftSchema.safeParse(
        draftWithShape({ properties: { x: { type: 'number' } } }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects a prose string', () => {
      const result = TaskGraphDraftSchema.safeParse(draftWithShape('an object with x: number'));
      expect(result.success).toBe(false);
    });

    it('rejects an array', () => {
      const result = TaskGraphDraftSchema.safeParse(draftWithShape([{ type: 'number' }]));
      expect(result.success).toBe(false);
    });

    it('rejects null', () => {
      const result = TaskGraphDraftSchema.safeParse(draftWithShape(null));
      expect(result.success).toBe(false);
    });
  });
});

describe('TaskGraphDraftSchema — optimization archetype (Plan 203)', () => {
  // Optimization-mode drafts omit `outcomes` — the assembler derives the
  // threshold outcome from optimization.goalMetric.
  const header = {
    slug: 'opt-skill',
    name: 'Opt Skill',
    description: 'Optimize a metric.',
    goal: 'Reach the target.',
  };
  const observeTask = {
    type: 'operation' as const,
    taskId: 'observe',
    operationId: 'api.http.call',
    consumes: [{ campaignField: 'slug', bindAs: 'slug' }],
    poll: {
      intervalMs: 60000,
      maxCycles: 5,
      until: { expression: "output.status == 'done'" },
    },
    outputProjection: { score: { path: 'data.score', parse: ['number' as const] } },
    produces: [{ key: 'score', shape: { type: 'number' }, semantics: 'metric' as const }],
  };
  const optimization = {
    goalMetric: {
      producedBy: { taskId: 'observe', outputKey: 'score' },
      direction: 'maximize' as const,
    },
    campaign: {
      fields: { slug: { schema: { type: 'string' }, identity: true, label: 'Slug' } },
    },
    target: { $campaign: 'targetScore' },
  };

  it('parses a valid optimization draft (poll + outputProjection + campaign consume + spec)', () => {
    const parsed = TaskGraphDraftSchema.safeParse({
      ...header,
      iterationModel: 'optimization',
      tasks: [observeTask],
      optimization,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a goalMetric pointing at a non-metric port', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...header,
      tasks: [
        {
          ...observeTask,
          produces: [{ key: 'score', shape: { type: 'number' }, semantics: 'data' }],
        },
      ],
      optimization,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a campaign_field consume that names an undeclared campaign field', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...header,
      tasks: [{ ...observeTask, consumes: [{ campaignField: 'nope', bindAs: 'x' }] }],
      optimization,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a campaign_field consume when there is no optimization spec', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...header,
      tasks: [
        {
          type: 'agent',
          kind: 'transformer',
          taskId: 'main',
          goal: 'do',
          consumes: [{ campaignField: 'slug', bindAs: 'slug' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an optimization draft that authors outcomes (they are derived)', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...header,
      tasks: [observeTask],
      optimization,
      outcomes: [{ id: 'p', name: 'P', evaluator: { type: 'manual', instruction: 'x' } }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('outcomes'))).toBe(true);
  });

  it('rejects a non-optimization draft with no outcomes', () => {
    const result = TaskGraphDraftSchema.safeParse({
      ...header,
      tasks: [{ type: 'agent', kind: 'transformer', taskId: 'main', goal: 'do' }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('outcomes'))).toBe(true);
  });
});

describe('isUsableJsonSchema', () => {
  it('accepts shapes with at least one structural keyword', () => {
    expect(isUsableJsonSchema({ type: 'object' })).toBe(true);
    expect(isUsableJsonSchema({ $ref: '#/foo' })).toBe(true);
    expect(isUsableJsonSchema({ oneOf: [] })).toBe(true);
    expect(isUsableJsonSchema({ enum: ['x'] })).toBe(true);
    expect(isUsableJsonSchema({ const: null })).toBe(true);
  });

  it('rejects everything that is not a usable schema', () => {
    expect(isUsableJsonSchema({})).toBe(false);
    expect(isUsableJsonSchema({ properties: {} })).toBe(false);
    expect(isUsableJsonSchema({ description: 'just docs' })).toBe(false);
    expect(isUsableJsonSchema(null)).toBe(false);
    expect(isUsableJsonSchema(undefined)).toBe(false);
    expect(isUsableJsonSchema('a string')).toBe(false);
    expect(isUsableJsonSchema([])).toBe(false);
    expect(isUsableJsonSchema(42)).toBe(false);
  });
});

describe('TaskGraphDraftSchema — enforces produces[].shape rule', () => {
  // The shape rule (and every per-kind constraint) is now a Zod superRefine —
  // the single authority the runner's submit_output validatorRef runs.
  const validate = (d: unknown): boolean => TaskGraphDraftSchema.safeParse(d).success;

  const baseDraft = {
    slug: 'fetch-data',
    name: 'Fetch Data',
    description: 'Fetch some data.',
    goal: 'Get the data',
    outcomes: [
      {
        id: 'done',
        name: 'Done',
        evaluator: { type: 'manual', instruction: 'It worked.' },
      },
    ],
  };

  function draft(produces: Array<Record<string, unknown>>) {
    return {
      ...baseDraft,
      tasks: [
        {
          type: 'agent',
          kind: 'transformer',
          taskId: 'fetch',
          goal: 'Fetch data',
          produces,
        },
      ],
    };
  }

  it('rejects shape: {} (empty fragment is not a usable schema)', () => {
    const ok = validate(draft([{ key: 'rows', shape: {}, semantics: 'data' }]));
    expect(ok).toBe(false);
  });

  it('rejects shape with only properties (no type)', () => {
    const ok = validate(
      draft([
        {
          key: 'rows',
          shape: { properties: { x: { type: 'number' } } },
          semantics: 'data',
        },
      ]),
    );
    expect(ok).toBe(false);
  });

  it('accepts shape with type', () => {
    const ok = validate(
      draft([
        {
          key: 'rows',
          shape: { type: 'object', properties: { x: { type: 'number' } } },
          semantics: 'data',
        },
      ]),
    );
    expect(ok).toBe(true);
  });

  it.each([
    ['$ref', { $ref: '#/$defs/Thing' }],
    ['oneOf', { oneOf: [{ type: 'string' }] }],
    ['anyOf', { anyOf: [{ type: 'string' }] }],
    ['allOf', { allOf: [{ type: 'object' }] }],
    ['enum', { enum: ['a', 'b'] }],
    ['const', { const: 42 }],
  ])('accepts shape using %s', (_label, shape) => {
    const ok = validate(draft([{ key: 'k', shape, semantics: 'data' }]));
    expect(ok).toBe(true);
  });

  it('reports a useful error path on rejection', () => {
    const result = TaskGraphDraftSchema.safeParse(
      draft([{ key: 'k', shape: {}, semantics: 'data' }]),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('shape'))).toBe(true);
  });
});

describe('WorkflowAssemblyInputSchema', () => {
  it('composes ComposeIntent + DesignSurface + TaskGraphDraft', () => {
    const parsed = WorkflowAssemblyInputSchema.parse({
      intent: { intent: 'x', iterationModel: 'process' },
      surface: {
        integrations: [],
        operations: [],
        policies: { compute: false },
      },
      draft: {
        slug: 'fetch-data',
        name: 'Fetch Data',
        description: '',
        goal: 'g',
        outcomes: [
          {
            id: 'done',
            name: 'Done',
            evaluator: { type: 'manual', instruction: 'ok' },
          },
        ],
        tasks: [{ type: 'agent', kind: 'transformer', taskId: 't1', goal: 'g' }],
      },
    });
    expect(parsed.draft.tasks).toHaveLength(1);
  });
});
