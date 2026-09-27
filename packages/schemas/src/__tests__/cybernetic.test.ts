import { describe, it, expect } from 'vitest';
import AjvModule from 'ajv';
import {
  // Directives (102d)
  EntityDirectivesSchema,
  StagedChangeKindSchema,
  DirectiveLearningPolicySchema,
  // Identity (102d)
  EntitySelfModelSchema,
  // Episodic (102d)
  EpisodicEntrySchema,
  // Relationship (102d)
  UserRelationshipSchema,
  // Entity Events (102e)
  EntityEventEnvelopeSchema,
  EntityEventTypeSchema,
  EntityMetricsBucketSchema,
  // Eval (102f)
  EvalCriterionSchema,
  CyberneticEvalSuiteSchema,
  EvalResultSchema,
  EvalBaselineSchema,
  FaultLayerSchema,
  // Bootstrap & display (102h)
  AgentSystemRoleSchema,
  AgentDefinitionSchema,
  resolveEntityDisplayName,
  // Skill compose + capability binding (104f/g)
  SkillComposeBundleSchema,
  StagedChangeOpSchema,
  ApiDefinitionDraftSchema,
  toJsonSchemaSync,
} from '../index.js';

// CommonJS / ESM interop shim — same pattern as composeSkill.test.ts:28.
const AjvCtor = (AjvModule as unknown as { default: typeof AjvModule }).default ?? AjvModule;

// ============================================================================
// 102d — Directives
// ============================================================================

describe('EntityDirectivesSchema', () => {
  it('accepts minimal valid directives', () => {
    const result = EntityDirectivesSchema.safeParse({
      version: 1,
      responsibility: 'ML optimization agent for Kaggle competitions',
    });
    expect(result.success).toBe(true);
  });

  it('applies defaults for optional sections', () => {
    const result = EntityDirectivesSchema.parse({
      version: 1,
      responsibility: 'Test agent',
    });
    expect(result.learningPolicy.enabled).toBe(true);
    expect(result.learningPolicy.learnerActivation).toBe('codified_only');
    expect(result.learningPolicy.decayMode).toBe('flag');
    expect(result.resourceBudget.maxConcurrentWorkers).toBe(3);
  });

  it('rejects invalid version', () => {
    const result = EntityDirectivesSchema.safeParse({
      version: 2,
      responsibility: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('validates StagedChangeKind references in alwaysRequireOperator', () => {
    const result = EntityDirectivesSchema.safeParse({
      version: 1,
      responsibility: 'Test',
      learningPolicy: {
        alwaysRequireOperator: ['workflow_block', 'directive_amendment'],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('StagedChangeKindSchema', () => {
  it('accepts all valid kinds including 104f/g + Plan 158 §6 additions', () => {
    const kinds = [
      'workflow_refinement',
      'workflow_block',
      'context_strategy',
      'learning_merge',
      'pattern_flag',
      'directive_amendment',
      'eval_criterion_change',
      'platform_issue',
      'skill_compose',
      'capability_binding',
      'artifact_update',
    ];
    for (const kind of kinds) {
      expect(StagedChangeKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects new_workflow (principle 11)', () => {
    expect(StagedChangeKindSchema.safeParse('new_workflow').success).toBe(false);
  });
});

describe('StagedChangeOpSchema — update_artifact (Plan 158 §6)', () => {
  it('accepts a well-formed update_artifact op', () => {
    const result = StagedChangeOpSchema.safeParse({
      op: 'update_artifact',
      artifactId: '00000000-0000-0000-0000-000000000001',
      draftId: '00000000-0000-0000-0000-000000000002',
      diffSummary: 'Switched chart x-axis to time-series.',
      triggeringRunId: '00000000-0000-0000-0000-000000000003',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an op without the optional triggeringRunId', () => {
    const result = StagedChangeOpSchema.safeParse({
      op: 'update_artifact',
      artifactId: '00000000-0000-0000-0000-000000000001',
      draftId: '00000000-0000-0000-0000-000000000002',
      diffSummary: 'minor copy edit',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid artifactId (resolver downstream would fail loud anyway)', () => {
    const result = StagedChangeOpSchema.safeParse({
      op: 'update_artifact',
      artifactId: 'not-a-uuid',
      draftId: '00000000-0000-0000-0000-000000000002',
      diffSummary: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty diffSummary (rationale is required for operator review)', () => {
    const result = StagedChangeOpSchema.safeParse({
      op: 'update_artifact',
      artifactId: '00000000-0000-0000-0000-000000000001',
      draftId: '00000000-0000-0000-0000-000000000002',
      diffSummary: '',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// 102d — Identity
// ============================================================================

describe('EntitySelfModelSchema', () => {
  it('accepts minimal self-model (no role field)', () => {
    const result = EntitySelfModelSchema.safeParse({
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUpdatedBy: 'system',
    });
    expect(result.success).toBe(true);
  });

  it('accepts self-model with behavioral patterns', () => {
    const result = EntitySelfModelSchema.parse({
      version: 1,
      behavioralPatterns: [{ pattern: 'Prefers concise responses', confidence: 'established' }],
      expertiseAreas: [{ domain: 'ML optimization', evidence: ['kaggle-workflow'] }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUpdatedBy: 'coach',
    });
    expect(result.behavioralPatterns).toHaveLength(1);
    expect(result.expertiseAreas).toHaveLength(1);
  });
});

// ============================================================================
// 102d — Episodic Memory
// ============================================================================

describe('EpisodicEntrySchema', () => {
  it('accepts a valid episodic entry', () => {
    const result = EpisodicEntrySchema.safeParse({
      id: '11111111-1111-1111-1111-111111111111',
      summary: 'User asked about model performance. Executive ran daily-metrics procedure.',
      decisions: ['Activated daily-metrics procedure instead of ad-hoc exploration'],
      topics: ['ML', 'metrics'],
      modesUsed: ['conversational', 'procedural'],
      sessionIds: ['11111111-1111-1111-1111-111111111111'],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// 102e — Entity Events
// ============================================================================

describe('EntityEventEnvelopeSchema', () => {
  it('accepts a valid entity event with traceId and preserves it', () => {
    const result = EntityEventEnvelopeSchema.parse({
      eventId: '22222222-2222-2222-2222-222222222222',
      eventType: 'entity.trigger.received',
      spaceId: '33333333-3333-3333-3333-333333333333',
      tenantId: 'test-tenant',
      timestamp: Date.now(),
      traceId: 'abc123def456',
      payload: { type: 'user_message' },
      summary: 'User sent a message',
    });
    expect(result.traceId).toBe('abc123def456');
  });

  it('accepts all 50 event types (includes 102h + 104b + 104c + 104e + 104g + 111 + 163 + 170 + 183a/183b follow-up events, and the conversation descriptor)', () => {
    const types = EntityEventTypeSchema.options;
    expect(types.length).toBe(50);
    expect(types).toContain('entity.schedule.armed');
    expect(types).toContain('entity.coach.withdrawn');
    expect(types).toContain('entity.eval.completed');
    expect(types).toContain('entity.runner.reflection');
    expect(types).toContain('entity.skill.maturity_transition');
    expect(types).toContain('entity.coach.preview_failed');
    expect(types).toContain('entity.coach.apply_failed');
    expect(types).toContain('entity.coach.enrichment_suppressed');
    expect(types).toContain('entity.coach.sampling_adjusted');
    expect(types).toContain('entity.coach.completed');
    expect(types).toContain('entity.eval.regression');
    expect(types).toContain('entity.trigger.received');
    expect(types).toContain('entity.coach.promotion');
    expect(types).toContain('entity.space.bootstrapped');
    expect(types).toContain('entity.directives.updated');
    expect(types).toContain('entity.skill.authored');
    expect(types).toContain('entity.binding.ratified');
    expect(types).toContain('entity.binding.removed');
    expect(types).toContain('entity.interaction.phase');
    expect(types).toContain('entity.hook.failed');
    expect(types).toContain('entity.budget.exceeded');
    expect(types).toContain('entity.scarcity.dormant');
    expect(types).toContain('entity.coach.context_pressure');
    // Coach surface acknowledgments / ratification outcomes
    expect(types).toContain('entity.coach.platform_issue_acknowledged');
    expect(types).toContain('entity.coach.anomaly_acknowledged');
    expect(types).toContain('entity.coach.ratification_failed');
  });

  it('accepts an entity.space.bootstrapped event with resolved agent payload', () => {
    const result = EntityEventEnvelopeSchema.parse({
      eventId: '22222222-2222-2222-2222-222222222222',
      eventType: 'entity.space.bootstrapped',
      spaceId: '33333333-3333-3333-3333-333333333333',
      tenantId: 'test-tenant',
      timestamp: Date.now(),
      payload: {
        createdArtifacts: ['dir:/identity', 'doc:/identity/self-model.json'],
        durationMs: 142,
        resolvedAgents: {
          helmsman: 'cybernetic-helmsman',
          runner: 'cybernetic-runner',
          coach: 'cybernetic-coach',
        },
      },
      summary: 'Entity activated (13 artifacts, helmsman=cybernetic-helmsman)',
    });
    expect(result.eventType).toBe('entity.space.bootstrapped');
    expect(result.payload).toHaveProperty('resolvedAgents');
  });

  it('accepts an entity.directives.updated event with changedKeys payload', () => {
    const result = EntityEventEnvelopeSchema.parse({
      eventId: '22222222-2222-2222-2222-222222222222',
      eventType: 'entity.directives.updated',
      spaceId: '33333333-3333-3333-3333-333333333333',
      tenantId: 'test-tenant',
      timestamp: Date.now(),
      payload: {
        changedKeys: ['style', 'training'],
        durationMs: 8,
        resolvedAgents: {
          helmsman: 'cybernetic-helmsman',
          runner: 'cybernetic-runner',
          coach: 'cybernetic-coach',
        },
      },
      summary: 'Directives updated (2 keys changed)',
    });
    expect(result.eventType).toBe('entity.directives.updated');
  });

  it('carries causal linkage fields', () => {
    const result = EntityEventEnvelopeSchema.parse({
      eventId: '22222222-2222-2222-2222-222222222222',
      eventType: 'entity.coach.proposal',
      spaceId: '33333333-3333-3333-3333-333333333333',
      tenantId: 'test-tenant',
      timestamp: Date.now(),
      causedBySessionId: '44444444-4444-4444-4444-444444444444',
      causedByEntityEventId: '55555555-5555-5555-5555-555555555555',
      payload: {},
      summary: 'Coach proposed context strategy change',
    });
    expect(result.causedBySessionId).toBeDefined();
    expect(result.causedByEntityEventId).toBeDefined();
  });
});

// ============================================================================
// 102f — Eval Schemas
// ============================================================================

describe('EvalCriterionSchema', () => {
  it('accepts a threshold criterion (Tier 1)', () => {
    const result = EvalCriterionSchema.safeParse({
      type: 'threshold',
      name: 'LB score below target',
      metric: 'lb_score',
      operator: 'lt',
      target: 0.125,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a trace_bound criterion (Tier 2)', () => {
    const result = EvalCriterionSchema.safeParse({
      type: 'trace_bound',
      name: 'Max step count',
      metric: 'step_count',
      maxValue: 20,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a judge criterion with decomposed rubric (Tier 3)', () => {
    const result = EvalCriterionSchema.safeParse({
      type: 'judge',
      name: 'Response quality',
      rubric: [
        { criterion: 'Accuracy', scale: 'binary', description: 'Facts are correct' },
        { criterion: 'Completeness', scale: 'binary', description: 'All aspects addressed' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-binary judge scale', () => {
    const result = EvalCriterionSchema.safeParse({
      type: 'judge',
      name: 'Response quality',
      rubric: [{ criterion: 'Accuracy', scale: 'three_point', description: 'Facts are correct' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects the removed human_review criterion type', () => {
    const result = EvalCriterionSchema.safeParse({
      type: 'human_review',
      name: 'Operator spot check',
      instruction: 'Verify the model selection rationale',
    });
    expect(result.success).toBe(false);
  });
});

describe('FaultLayerSchema', () => {
  it('accepts all four fault layers', () => {
    for (const layer of ['platform', 'configuration', 'agent', 'environment']) {
      expect(FaultLayerSchema.safeParse(layer).success).toBe(true);
    }
  });
});

describe('EvalBaselineSchema', () => {
  it('applies regression detection defaults', () => {
    const result = EvalBaselineSchema.parse({
      baselineScores: { goalScore: 0.9, taskScore: 0.85, trajectoryScore: 0.8, overall: 0.85 },
      sampleSize: 10,
      updatedAt: new Date().toISOString(),
    });
    expect(result.regressionThreshold).toBe(0.15);
    expect(result.consecutiveBreachesRequired).toBe(3);
    expect(result.currentBreachCount).toBe(0);
  });
});

// ============================================================================
// 102h — Bootstrap: systemRole + display name helper
// ============================================================================

describe('AgentSystemRoleSchema (102h)', () => {
  it('accepts the cybernetic ensemble roles', () => {
    for (const role of ['cybernetic-helmsman', 'cybernetic-runner', 'cybernetic-coach']) {
      expect(AgentSystemRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it('accepts the surviving capability flow role', () => {
    expect(AgentSystemRoleSchema.safeParse('mcp-runner').success).toBe(true);
  });

  // The pre-cybernetic specialists. Helmsman is the operator's single entry
  // point now and holds what they held, so a session could only reach one of
  // these by naming a role nothing resolves.
  it('rejects the retired capability roles', () => {
    for (const role of ['orchestrator', 'agent-builder', 'api-configurator', 'media-creator']) {
      expect(AgentSystemRoleSchema.safeParse(role).success).toBe(false);
    }
  });

  it('rejects arbitrary strings', () => {
    expect(AgentSystemRoleSchema.safeParse('rogue-agent').success).toBe(false);
  });

  it('rejects cybernetic-driver (deleted in Plan 132v2 §Phase 6)', () => {
    expect(AgentSystemRoleSchema.safeParse('cybernetic-driver').success).toBe(false);
  });
});

describe('AgentDefinitionSchema.systemRole (102h)', () => {
  const baseAgent = {
    flowId: 'my-agent',
    version: '1',
    metadata: { name: 'My Agent' },
    steps: [{ stepId: 'start', stepType: 'ai', operation: 'ai.generate' }],
    startStepId: 'start',
  };

  it('defaults systemRole to null when the field is missing', () => {
    const result = AgentDefinitionSchema.parse(baseAgent);
    expect(result.systemRole).toBeNull();
  });

  it('accepts explicit null for user-created agents', () => {
    const result = AgentDefinitionSchema.parse({ ...baseAgent, systemRole: null });
    expect(result.systemRole).toBeNull();
  });

  it('accepts a valid cybernetic role', () => {
    const result = AgentDefinitionSchema.parse({
      ...baseAgent,
      systemRole: 'cybernetic-helmsman',
    });
    expect(result.systemRole).toBe('cybernetic-helmsman');
  });

  it('rejects an unknown systemRole value', () => {
    const result = AgentDefinitionSchema.safeParse({ ...baseAgent, systemRole: 'bogus' });
    expect(result.success).toBe(false);
  });
});

describe('resolveEntityDisplayName (102h)', () => {
  const helmsman = {
    systemRole: 'cybernetic-helmsman' as const,
    metadata: { name: 'Workspace Agent' },
  };

  const runner = {
    systemRole: 'cybernetic-runner' as const,
    metadata: { name: 'Workspace Runner' },
  };

  const userAgent = {
    systemRole: null,
    metadata: { name: 'My Side Task Agent' },
  };

  it('renders "<space.name> Agent" for the Helmsman in a cybernetic space', () => {
    const name = resolveEntityDisplayName(
      { name: 'ML Optimizer Lab', directives: { version: 1 } },
      helmsman,
    );
    expect(name).toBe('ML Optimizer Lab Agent');
  });

  it('falls back to metadata.name when the space has no directives', () => {
    const name = resolveEntityDisplayName({ name: 'General', directives: null }, helmsman);
    expect(name).toBe('Workspace Agent');
  });

  it('does not rename Runner or Coach even in a cybernetic space', () => {
    const name = resolveEntityDisplayName(
      { name: 'ML Optimizer Lab', directives: { version: 1 } },
      runner,
    );
    expect(name).toBe('Workspace Runner');
  });

  it('leaves user-created agents untouched', () => {
    const name = resolveEntityDisplayName(
      { name: 'ML Optimizer Lab', directives: { version: 1 } },
      userAgent,
    );
    expect(name).toBe('My Side Task Agent');
  });

  it('handles whitespace-only space names gracefully', () => {
    const name = resolveEntityDisplayName({ name: '   ', directives: { version: 1 } }, helmsman);
    expect(name).toBe('Workspace Agent');
  });
});

// ============================================================================
// 104f — SkillComposeBundleSchema
// ============================================================================

describe('SkillComposeBundleSchema (104f)', () => {
  const validBundle = {
    workflow: {
      slug: 'csv-analyzer',
      name: 'CSV Analyzer',
      goal: 'Analyze CSV data files and produce summary reports.',
      outcomes: [
        {
          id: 'report-generated',
          name: 'Report Generated',
          evaluator: { type: 'manual', instruction: 'A report was produced' },
        },
      ],
      mode: 'process' as const,
      tasks: [
        {
          taskId: 'parse-csv',
          name: 'Parse CSV',
          goal: 'Parse the uploaded CSV file.',
          type: 'agent' as const,
        },
        {
          taskId: 'summarize',
          name: 'Summarize',
          goal: 'Produce a summary report.',
          dependsOn: ['parse-csv'],
          type: 'agent' as const,
        },
      ],
    },
    manifest: {
      skillId: 'csv-analyzer',
      name: 'CSV Analyzer',
      goal: 'Analyze CSV data files and produce summary reports.',
      mode: 'process' as const,
    },
    evalSuite: {
      version: 1 as const,
      goalCriteria: [
        { name: 'report-exists', type: 'contains' as const, inField: 'output', pattern: 'report' },
      ],
      taskCriteria: {},
      trajectoryCriteria: [],
      weights: { goal: 0.4, task: 0.4, trajectory: 0.2 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: 'compose-skill',
    },
    rationale: 'User requested a skill to analyze CSV data files.',
  };

  it('accepts a valid bundle', () => {
    const result = SkillComposeBundleSchema.safeParse(validBundle);
    expect(result.success).toBe(true);
  });

  it('rejects when workflow.slug !== manifest.skillId', () => {
    const bad = {
      ...validBundle,
      manifest: { ...validBundle.manifest, skillId: 'wrong-slug' },
    };
    const result = SkillComposeBundleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects when eval suite has zero criteria', () => {
    const bad = {
      ...validBundle,
      evalSuite: {
        ...validBundle.evalSuite,
        goalCriteria: [],
        taskCriteria: {},
        trajectoryCriteria: [],
      },
    };
    const result = SkillComposeBundleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('parses as a skill_compose StagedChangeOp', () => {
    const op = {
      op: 'skill_compose',
      bundle: validBundle,
      authoredBySkillId: 'compose-skill',
    };
    const result = StagedChangeOpSchema.safeParse(op);
    expect(result.success).toBe(true);
  });

  it('parses capability.definition.upsert StagedChangeOp', () => {
    const op = {
      op: 'capability.definition.upsert',
      kind: 'api',
      apiId: 'stripe',
      definition: {
        name: 'Stripe API',
        baseUrl: 'https://api.stripe.com/v1',
        authKind: 'bearer',
        endpoints: [{ path: '/charges', method: 'POST', summary: 'Create a charge' }],
      },
      rationale: 'Need Stripe for payment processing.',
    };
    const result = StagedChangeOpSchema.safeParse(op);
    expect(result.success).toBe(true);
  });

  it('parses capability.binding.remove StagedChangeOp', () => {
    const op = {
      op: 'capability.binding.remove',
      bindingId: 'stripe-binding-123',
      rationale: 'No longer needed.',
    };
    const result = StagedChangeOpSchema.safeParse(op);
    expect(result.success).toBe(true);
  });

  it('parses eval.criterion.add with task target scope', () => {
    const op = {
      op: 'eval.criterion.add',
      skillSlug: 'kaggle-titanic',
      targetScope: 'task',
      taskId: 'model-train',
      criterion: {
        type: 'threshold',
        name: 'train-accuracy',
        metric: 'accuracy',
        operator: 'gte',
        target: 0.8,
      },
      rationale: 'Track task-local quality.',
    };
    const result = StagedChangeOpSchema.safeParse(op);
    expect(result.success).toBe(true);
  });

  it('ApiDefinitionDraftSchema rejects empty name', () => {
    const result = ApiDefinitionDraftSchema.safeParse({
      name: '',
      baseUrl: 'https://api.example.com',
    });
    expect(result.success).toBe(false);
  });

  // ============================================================================

  it('ApiDefinitionDraftSchema accepts queryParams[] on endpoints', () => {
    const result = ApiDefinitionDraftSchema.safeParse({
      name: 'Alpaca News',
      baseUrl: 'https://data.alpaca.markets',
      endpoints: [
        {
          path: '/v1beta1/news',
          method: 'GET',
          summary: 'Fetch news for one or more symbols',
          queryParams: [
            {
              name: 'symbols',
              required: true,
              description: 'Comma-separated tickers',
              exampleValue: 'AAPL,MSFT',
            },
            { name: 'limit' },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const ep = result.data.endpoints[0]!;
      expect(ep.queryParams).toHaveLength(2);
      expect(ep.queryParams?.[0]!.name).toBe('symbols');
      expect(ep.queryParams?.[0]!.required).toBe(true);
      expect(ep.queryParams?.[0]!.exampleValue).toBe('AAPL,MSFT');
      expect(ep.queryParams?.[1]!.required).toBeUndefined();
    }
  });

  it('ApiDefinitionDraftSchema rejects queryParams entries with empty name', () => {
    const result = ApiDefinitionDraftSchema.safeParse({
      name: 'X',
      baseUrl: 'https://api.example.com',
      endpoints: [
        {
          path: '/items',
          method: 'GET',
          queryParams: [{ name: '' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('ApiDefinitionDraftSchema rejects more than 50 queryParams entries', () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ name: `p${String(i)}` }));
    const result = ApiDefinitionDraftSchema.safeParse({
      name: 'X',
      baseUrl: 'https://api.example.com',
      endpoints: [{ path: '/items', method: 'GET', queryParams: tooMany }],
    });
    expect(result.success).toBe(false);
  });

  it("ApiDefinitionDraftSchema rejects endpoint path containing '?'", () => {
    const result = ApiDefinitionDraftSchema.safeParse({
      name: 'Alpaca News',
      baseUrl: 'https://data.alpaca.markets',
      endpoints: [
        // Smuggled query string — the §3 regex should reject this and
        // direct the author to `queryParams[]`.
        { path: '/v1beta1/news?symbols=AAPL', method: 'GET' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error message should point the author at queryParams[].
      const joined = result.error.issues.map((i) => i.message).join(' | ');
      expect(joined).toMatch(/queryParams/);
    }
  });

  it('ApiDefinitionDraftSchema rejects duplicate queryParams names within an endpoint', () => {
    const result = ApiDefinitionDraftSchema.safeParse({
      name: 'X',
      baseUrl: 'https://api.example.com',
      endpoints: [
        {
          path: '/items',
          method: 'GET',
          queryParams: [{ name: 'tag' }, { name: 'tag' }],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const joined = result.error.issues.map((i) => i.message).join(' | ');
      expect(joined).toMatch(/unique/i);
    }
  });

  it('ApiDefinitionDraftSchema encodes the no-question-mark rule as JSON Schema pattern', () => {
    // Why this test: the runner's submit_output validates against the
    // JSON Schema derived from this Zod schema. `.refine()` predicates
    // are silently dropped by zod-to-json-schema; `.regex()` is encoded
    // as `pattern`. This test fails if a future refactor swaps `.regex()`
    // back to `.refine()` (or anything else that loses the pattern), so
    // the comment claim — that the runner's submit_output enforces the
    // rule — stays honest.
    //
    // Stringify-based check (not a property walk) so a future
    // zod-to-json-schema bump that wraps `endpoints` in `$ref` / `allOf`
    // doesn't break the test with a noisy `TypeError`. Same regression
    // coverage; survives layout refactors.
    const jsonSchema = toJsonSchemaSync(ApiDefinitionDraftSchema);
    const serialized = JSON.stringify(jsonSchema);
    expect(serialized).toContain('"pattern":"^[^?]+$"');
  });

  it('Ajv enforces the no-question-mark rule against the derived JSON Schema', () => {
    // Round-trip the schema through real Ajv (the validator the runner's
    // submit_output uses). Confirms the rule is actually enforced
    // on-the-wire — not just that the source Zod schema says it should be.
    // If a future zod-to-json-schema bug drops the pattern silently, the
    // serialized check above still passes (the source map says
    // "pattern" exists) but this test fails (Ajv accepts a '?' path).
    const ajv = new AjvCtor({ strict: false });
    const jsonSchema = toJsonSchemaSync(ApiDefinitionDraftSchema);
    const validate = ajv.compile(jsonSchema);

    const goodDraft = {
      name: 'X',
      baseUrl: 'https://api.example.com',
      authKind: 'none',
      endpoints: [{ path: '/v1beta1/news', method: 'GET' }],
    };
    expect(validate(goodDraft)).toBe(true);

    const badDraft = {
      name: 'X',
      baseUrl: 'https://api.example.com',
      authKind: 'none',
      endpoints: [{ path: '/v1beta1/news?symbols=AAPL', method: 'GET' }],
    };
    expect(validate(badDraft)).toBe(false);
    // Sanity: the Ajv error is specifically about the `pattern` keyword on
    // `path`. If a future change moves the constraint elsewhere, this
    // assertion alerts us rather than silently masking the regression.
    const errors = validate.errors ?? [];
    expect(errors.some((e) => e.keyword === 'pattern' && e.instancePath.includes('path'))).toBe(
      true,
    );
  });

  it('ApiDefinitionDraftSchema is behaviour-preserving when queryParams omitted', () => {
    // Regression-safety for the Kaggle / path-param-only corpus.
    const result = ApiDefinitionDraftSchema.safeParse({
      name: 'Kaggle',
      baseUrl: 'https://www.kaggle.com',
      endpoints: [
        { path: '/competitions/{id}/data/download/{fileName}', method: 'GET' },
        { path: '/competitions/submissions', method: 'POST' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      for (const ep of result.data.endpoints) {
        expect(ep.queryParams).toBeUndefined();
      }
    }
  });

  it('rejects when taskCriteria references non-existent taskId', () => {
    const bad = {
      ...validBundle,
      evalSuite: {
        ...validBundle.evalSuite,
        taskCriteria: {
          'nonexistent-task': [
            { name: 'check', type: 'contains' as const, inField: 'out', pattern: 'ok' },
          ],
        },
      },
    };
    const result = SkillComposeBundleSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
