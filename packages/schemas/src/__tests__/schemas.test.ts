/**
 * Tests for core schema validation.
 */
import { describe, it, expect } from 'vitest';
import {
  AgentDefinitionSchema,
  StepDefinitionSchema,
  OperationDefinitionSchema,
  EventEnvelopeSchema,
  StepJobMessageSchema,
  StepResultMessageSchema,
  TenantIdSchema,
  AgentIdSchema,
  AgentSlugSchema,
  OperationIdSchema,
  PayloadRefSchema,
  RetryPolicySchema,
  AflowErrorSchema,
  StateVariableSchema,
  validateAgentConsistency,
  validateStateVariables,
  calculateRetryDelay,
  buildTransitionGraph,
  getTerminalSteps,
  getReachableSteps,
  resolveNextStep,
  deriveInputSchema,
  deriveOutputSchema,
  AiGenerateInputSchema,
  AiGenerateJsonInputSchema,
  AiGenerateStreamInputSchema,
  AgentTurnInputSchema,
  AiImageGenerateInputSchema,
  AiImageEditInputSchema,
  AiVideoGenerateInputSchema,
  AiVideoFromImageInputSchema,
  UiArtifactGenerateInputSchema,
  UiArtifactGenerateOutputSchema,
  UiArtifactPublishInputSchema,
  UiArtifactGetInputSchema,
  UiArtifactRenderInputSchema,
} from '../index.js';

describe('ID Schemas', () => {
  describe('TenantIdSchema', () => {
    it('should accept valid UUID v4', () => {
      const result = TenantIdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID', () => {
      const result = TenantIdSchema.safeParse('not-a-uuid');
      expect(result.success).toBe(false);
    });
  });

  describe('AgentIdSchema (Plan 160 — UUID identity)', () => {
    it('accepts a valid UUID', () => {
      const result = AgentIdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
      expect(result.success).toBe(true);
    });

    it('rejects a slug-shaped string', () => {
      const result = AgentIdSchema.safeParse('my-agent-123');
      expect(result.success).toBe(false);
    });

    it('rejects a non-UUID arbitrary string', () => {
      const result = AgentIdSchema.safeParse('not-a-uuid');
      expect(result.success).toBe(false);
    });
  });

  describe('AgentSlugSchema (Plan 160 — per-space human handle)', () => {
    it('accepts a clean kebab-case slug', () => {
      expect(AgentSlugSchema.safeParse('research-bot').success).toBe(true);
      expect(AgentSlugSchema.safeParse('agent42').success).toBe(true);
      expect(AgentSlugSchema.safeParse('a-b-c-1-2-3').success).toBe(true);
    });

    it('rejects underscores', () => {
      expect(AgentSlugSchema.safeParse('my_agent').success).toBe(false);
    });

    it('rejects uppercase letters', () => {
      expect(AgentSlugSchema.safeParse('MyAgent').success).toBe(false);
    });

    it('rejects leading or trailing hyphen', () => {
      expect(AgentSlugSchema.safeParse('-agent').success).toBe(false);
      expect(AgentSlugSchema.safeParse('agent-').success).toBe(false);
    });

    it('rejects consecutive hyphens', () => {
      expect(AgentSlugSchema.safeParse('my--agent').success).toBe(false);
    });

    it('rejects UUID-shaped strings (so the router never confuses a slug for an id)', () => {
      expect(AgentSlugSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(false);
    });

    it('rejects empty and over-length strings', () => {
      expect(AgentSlugSchema.safeParse('').success).toBe(false);
      expect(AgentSlugSchema.safeParse('a'.repeat(65)).success).toBe(false);
    });
  });

  describe('OperationIdSchema', () => {
    it('should accept valid operation ID', () => {
      const result = OperationIdSchema.safeParse('ai.generate');
      expect(result.success).toBe(true);
    });

    it('should reject single-part ID', () => {
      const result = OperationIdSchema.safeParse('generate');
      expect(result.success).toBe(false);
    });
  });
});

describe('PayloadRefSchema', () => {
  it('should accept valid GCS URI', () => {
    const result = PayloadRefSchema.safeParse('gs://my-bucket/path/to/file.json');
    expect(result.success).toBe(true);
  });

  it('should reject non-GCS URI', () => {
    const result = PayloadRefSchema.safeParse('https://example.com/file.json');
    expect(result.success).toBe(false);
  });

  it('should reject malformed GCS URI', () => {
    const result = PayloadRefSchema.safeParse('gs://');
    expect(result.success).toBe(false);
  });
});

describe('AI prompt validation', () => {
  const promptSchemas = [
    { name: 'AiGenerateInputSchema', schema: AiGenerateInputSchema, valid: { prompt: 'Hello' } },
    {
      name: 'AiGenerateJsonInputSchema',
      schema: AiGenerateJsonInputSchema,
      valid: { prompt: 'Hello', outputSchema: { type: 'object' } },
    },
    {
      name: 'AiGenerateStreamInputSchema',
      schema: AiGenerateStreamInputSchema,
      valid: { prompt: 'Hello' },
    },
    {
      name: 'AgentTurnInputSchema',
      schema: AgentTurnInputSchema,
      valid: { prompt: 'Hello', availableTools: [] },
    },
    {
      name: 'AiImageGenerateInputSchema',
      schema: AiImageGenerateInputSchema,
      valid: { prompt: 'Draw a cat' },
    },
    {
      name: 'AiImageEditInputSchema',
      schema: AiImageEditInputSchema,
      valid: { prompt: 'Draw a cat', imageRef: 'gs://bucket/image.png' },
    },
    {
      name: 'AiVideoGenerateInputSchema',
      schema: AiVideoGenerateInputSchema,
      valid: { prompt: 'Animate a sunset' },
    },
    {
      name: 'AiVideoFromImageInputSchema',
      schema: AiVideoFromImageInputSchema,
      valid: { prompt: 'Animate a sunset', imageRef: 'gs://bucket/image.png' },
    },
  ] as const;

  for (const { name, schema, valid } of promptSchemas) {
    it(`${name} rejects empty and whitespace-only prompts`, () => {
      expect(schema.safeParse({ ...valid, prompt: '' }).success).toBe(false);
      expect(schema.safeParse({ ...valid, prompt: '   ' }).success).toBe(false);
      expect(schema.safeParse(valid).success).toBe(true);
    });
  }

  it('AiGenerateInputSchema still allows message-only inputs', () => {
    const result = AiGenerateInputSchema.safeParse({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('UI artifact ID validation', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('UiArtifactGenerateInputSchema rejects non-UUID artifactId', () => {
    expect(
      UiArtifactGenerateInputSchema.safeParse({
        prompt: 'Create a chart',
        artifactId: 'goog-price-performance-chart',
      }).success,
    ).toBe(false);
  });

  it('UiArtifactPublishInputSchema requires UUID draftId and optional artifactId', () => {
    expect(
      UiArtifactPublishInputSchema.safeParse({
        draftId: 'draft_abc123',
      }).success,
    ).toBe(false);

    expect(
      UiArtifactPublishInputSchema.safeParse({
        draftId: validUuid,
        artifactId: validUuid,
      }).success,
    ).toBe(true);
  });

  it('UiArtifactGetInputSchema and UiArtifactRenderInputSchema reject slug-style IDs', () => {
    expect(
      UiArtifactGetInputSchema.safeParse({
        artifactId: 'art_abc123',
      }).success,
    ).toBe(false);

    expect(
      UiArtifactRenderInputSchema.safeParse({
        draftId: 'draft_abc123',
        data: {},
      }).success,
    ).toBe(false);
  });

  it('ui artifact op inputs have no caller-suppliable scope — space boundary invariant', () => {
    // spaceId is system-carried from the originating
    // session (ExecutorContext.spaceId), never an operation input. A stale
    // caller passing scope gets it STRIPPED (inert) — it cannot influence
    // which space the operation executes in.
    const parsed = UiArtifactRenderInputSchema.safeParse({
      artifactId: '550e8400-e29b-41d4-a716-446655440000',
      data: {},
      scope: { spaceId: 'f0000000-0000-0000-0000-00000000000f' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('scope' in parsed.data).toBe(false);
    }
    expect('scope' in UiArtifactRenderInputSchema.shape).toBe(false);
    expect('scope' in UiArtifactGetInputSchema.shape).toBe(false);
    expect('scope' in UiArtifactGenerateInputSchema.shape).toBe(false);
  });

  it('UiArtifactGenerateInputSchema accepts real preview data', () => {
    expect(
      UiArtifactGenerateInputSchema.safeParse({
        prompt: 'Create a chart',
        data: {
          points: [{ close: 123.45, date: '2026-03-12' }],
        },
      }).success,
    ).toBe(true);
  });

  it('UiArtifactGenerateInputSchema accepts real preview data without a dataSchema', () => {
    const result = UiArtifactGenerateInputSchema.safeParse({
      prompt: 'Create a line chart',
      data: {
        ticker: 'GOOG',
        results: [{ t: 1770872400000, c: 309.37 }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('still accepts dataSchema-only generation requests', () => {
    const result = UiArtifactGenerateInputSchema.safeParse({
      prompt: 'Create a line chart',
      dataSchema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('UiArtifactGenerateOutputSchema shape includes preview fields via schema validation', () => {
    const result = UiArtifactGenerateOutputSchema.safeParse({
      draft: {
        draftId: validUuid,
        scope: {},
        kind: 'react_tsx',
        prompt: 'Create a chart',
        dataSchema: { type: 'object' },
        catalogId: 'phoenix-design-system',
        catalogVersion: '1.0.0',
        catalogHash: 'abc123',
        allowedLibraries: ['phoenix-design-system'],
        sourceRef: 'inline:abc',
        warnings: [],
        errors: [],
        createdAt: new Date().toISOString(),
        status: 'draft',
      },
      validationReport: {
        valid: true,
        diagnostics: [],
        checkedAt: new Date().toISOString(),
      },
      previewValidation: {
        valid: true,
        diagnostics: [],
        checkedAt: new Date().toISOString(),
      },
      dataSchema: { type: 'object' },
      previewData: { points: [] },
      previewDataSource: 'input',
      html: '<html></html>',
      source: 'export default function Artifact() { return null; }',
      diagnostics: [],
      rendererMetadata: {
        draftId: validUuid,
        kind: 'react_tsx',
        catalogVersion: '1.0.0',
        dataSchemaValid: true,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('RetryPolicySchema', () => {
  it('should accept valid retry policy', () => {
    const result = RetryPolicySchema.safeParse({
      maxAttempts: 3,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      backoffStrategy: 'exponential',
    });
    expect(result.success).toBe(true);
  });

  it('should use defaults for missing fields', () => {
    const result = RetryPolicySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxAttempts).toBe(3);
      expect(result.data.backoffStrategy).toBe('exponential');
    }
  });

  describe('calculateRetryDelay', () => {
    it('should calculate fixed delay', () => {
      const policy = RetryPolicySchema.parse({
        backoffStrategy: 'fixed',
        initialDelayMs: 1000,
        jitterFraction: 0,
      });
      expect(calculateRetryDelay(policy, 1)).toBe(1000);
      expect(calculateRetryDelay(policy, 3)).toBe(1000);
    });

    it('should calculate exponential delay', () => {
      const policy = RetryPolicySchema.parse({
        backoffStrategy: 'exponential',
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        jitterFraction: 0,
      });
      expect(calculateRetryDelay(policy, 1)).toBe(1000);
      expect(calculateRetryDelay(policy, 2)).toBe(2000);
      expect(calculateRetryDelay(policy, 3)).toBe(4000);
    });

    it('should cap at maxDelayMs', () => {
      const policy = RetryPolicySchema.parse({
        backoffStrategy: 'exponential',
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
        jitterFraction: 0,
      });
      expect(calculateRetryDelay(policy, 10)).toBe(5000);
    });
  });
});

describe('AflowErrorSchema', () => {
  it('should accept valid error', () => {
    const result = AflowErrorSchema.safeParse({
      code: 'VALIDATION_FAILED',
      message: 'Invalid input',
      classification: 'validation',
      retryable: false,
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-SCREAMING_SNAKE_CASE code', () => {
    const result = AflowErrorSchema.safeParse({
      code: 'validationFailed',
      message: 'Invalid input',
      classification: 'validation',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe('StepDefinitionSchema', () => {
  it('should accept valid step definition', () => {
    const result = StepDefinitionSchema.safeParse({
      stepId: 'generate-text',
      stepType: 'ai',
      operation: 'ai.generate',
      name: 'Generate Text',
    });
    expect(result.success).toBe(true);
  });
});

describe('AgentDefinitionSchema', () => {
  it('should accept valid flow definition', () => {
    const flow = {
      flowId: 'my-flow',
      version: '1.0.0',
      metadata: {
        name: 'My Flow',
        description: 'A test flow',
      },
      steps: [
        {
          stepId: 'start',
          stepType: 'ai',
          operation: 'ai.generate',
        },
      ],
      startStepId: 'start',
    };
    const result = AgentDefinitionSchema.safeParse(flow);
    expect(result.success).toBe(true);
  });

  it('should require at least one step', () => {
    const flow = {
      flowId: 'my-flow',
      version: '1.0.0',
      metadata: { name: 'My Flow' },
      steps: [],
      startStepId: 'start',
    };
    const result = AgentDefinitionSchema.safeParse(flow);
    expect(result.success).toBe(false);
  });

  describe('validateAgentConsistency', () => {
    it('should validate consistent flow with embedded transitions', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [
          {
            stepId: 'step-a',
            stepType: 'ai',
            operation: 'ai.generate',
            onSuccess: { next: [{ stepId: 'step-b' }] },
          },
          {
            stepId: 'step-b',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] }, // Terminal step
          },
        ],
        startStepId: 'step-a',
      });
      const result = validateAgentConsistency(flow);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should detect missing start step', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [{ stepId: 'step-a', stepType: 'ai', operation: 'ai.generate' }],
        startStepId: 'nonexistent',
      });
      const result = validateAgentConsistency(flow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Start step 'nonexistent' not found in steps");
    });

    it('should detect invalid onSuccess transition references', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [
          {
            stepId: 'step-a',
            stepType: 'ai',
            operation: 'ai.generate',
            onSuccess: { next: [{ stepId: 'nonexistent' }] },
          },
        ],
        startStepId: 'step-a',
      });
      const result = validateAgentConsistency(flow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Step 'step-a' onSuccess references unknown step 'nonexistent'",
      );
    });

    it('should detect invalid onFailure transition references', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [
          {
            stepId: 'step-a',
            stepType: 'ai',
            operation: 'ai.generate',
            onFailure: { next: [{ stepId: 'error-handler' }] },
          },
        ],
        startStepId: 'step-a',
      });
      const result = validateAgentConsistency(flow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Step 'step-a' onFailure references unknown step 'error-handler'",
      );
    });
  });

  describe('buildTransitionGraph', () => {
    it('should build graph from embedded transitions', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [
          {
            stepId: 'step-a',
            stepType: 'ai',
            operation: 'ai.generate',
            onSuccess: {
              next: [
                { stepId: 'step-b', when: 'output.score > 0.8', description: 'High score' },
                { stepId: 'step-c', description: 'Default' },
              ],
            },
            onFailure: { next: [{ stepId: 'error-handler' }] },
          },
          {
            stepId: 'step-b',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] },
          },
          {
            stepId: 'step-c',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] },
          },
          {
            stepId: 'error-handler',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] },
          },
        ],
        startStepId: 'step-a',
      });

      const graph = buildTransitionGraph(flow);

      expect(graph).toHaveLength(3);
      expect(graph.filter((e) => e.from === 'step-a')).toHaveLength(3);
      expect(graph.filter((e) => e.trigger === 'success')).toHaveLength(2);
      expect(graph.filter((e) => e.trigger === 'failure')).toHaveLength(1);
    });
  });

  describe('getTerminalSteps', () => {
    it('should identify terminal steps', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [
          {
            stepId: 'step-a',
            stepType: 'ai',
            operation: 'ai.generate',
            onSuccess: { next: [{ stepId: 'step-b' }] },
          },
          {
            stepId: 'step-b',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] }, // Terminal
          },
        ],
        startStepId: 'step-a',
      });

      const terminals = getTerminalSteps(flow);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toBe('step-b');
    });
  });

  describe('getReachableSteps', () => {
    it('should find all reachable steps', () => {
      const flow = AgentDefinitionSchema.parse({
        flowId: 'my-flow',
        version: '1.0.0',
        metadata: { name: 'My Flow' },
        steps: [
          {
            stepId: 'step-a',
            stepType: 'ai',
            operation: 'ai.generate',
            onSuccess: { next: [{ stepId: 'step-b' }] },
          },
          {
            stepId: 'step-b',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] },
          },
          {
            stepId: 'orphan',
            stepType: 'api',
            operation: 'api.http.call',
            onSuccess: { next: [] },
          },
        ],
        startStepId: 'step-a',
      });

      const reachable = getReachableSteps(flow);
      expect(reachable.size).toBe(2);
      expect(reachable.has('step-a' as never)).toBe(true);
      expect(reachable.has('step-b' as never)).toBe(true);
      expect(reachable.has('orphan' as never)).toBe(false);
    });
  });

  describe('resolveNextStep', () => {
    it('should resolve default next step on success', () => {
      const step = StepDefinitionSchema.parse({
        stepId: 'my-step',
        stepType: 'ai',
        operation: 'ai.generate',
        onSuccess: {
          next: [
            { stepId: 'conditional-step', when: 'output.flag === true' },
            { stepId: 'default-step' },
          ],
        },
      });

      // Without condition evaluation, should return default
      const nextStep = resolveNextStep(step, 'success');
      expect(nextStep).toBe('default-step');
    });

    it('should return null for terminal step', () => {
      const step = StepDefinitionSchema.parse({
        stepId: 'my-step',
        stepType: 'ai',
        operation: 'ai.generate',
        onSuccess: { next: [] },
      });

      const nextStep = resolveNextStep(step, 'success');
      expect(nextStep).toBeNull();
    });

    it('should resolve failure path', () => {
      const step = StepDefinitionSchema.parse({
        stepId: 'my-step',
        stepType: 'ai',
        operation: 'ai.generate',
        onFailure: { next: [{ stepId: 'error-handler' }] },
      });

      const nextStep = resolveNextStep(step, 'failure');
      expect(nextStep).toBe('error-handler');
    });
  });
});

describe('EventEnvelopeSchema', () => {
  it('should accept valid event envelope', () => {
    const result = EventEnvelopeSchema.safeParse({
      eventId: '550e8400-e29b-41d4-a716-446655440000',
      eventType: 'StepSucceeded',
      tenantId: '550e8400-e29b-41d4-a716-446655440001',
      sessionId: '550e8400-e29b-41d4-a716-446655440002',
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440003',
      attempt: 1,
      timestamp: new Date().toISOString(),
      idempotencyKey: 'key-123',
    });
    expect(result.success).toBe(true);
  });
});

describe('StepJobMessageSchema', () => {
  it('should accept valid job message', () => {
    const result = StepJobMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'generate-text',
      stepType: 'ai',
      operationId: 'ai.generate',
      attempt: 1,
      idempotencyKey: 'key-123',
      inputRef: 'gs://bucket/input.json',
      traceId: 'trace-123',
      scheduledAtMs: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept job with workflowExecution and no sessionId (workflow-task)', () => {
    const result = StepJobMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      workflowExecution: {
        runId: 'run-abc',
        taskId: 'task-1',
        attempt: 1,
        dispatchAttemptToken: 'dispatch:run-abc:task-1:1',
      },
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'task-1',
      stepType: 'compute',
      operationId: 'compute.sandbox.exec',
      attempt: 1,
      idempotencyKey: 'dispatch:run-abc:task-1:1',
      inputRef: 'gs://bucket/input.json',
      traceId: 'trace-123',
      scheduledAtMs: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject job with both sessionId AND workflowExecution', () => {
    const result = StepJobMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      workflowExecution: {
        runId: 'run-abc',
        taskId: 'task-1',
        attempt: 1,
        dispatchAttemptToken: 'dispatch:run-abc:task-1:1',
      },
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'task-1',
      stepType: 'ai',
      operationId: 'ai.generate',
      attempt: 1,
      idempotencyKey: 'key-123',
      inputRef: 'gs://bucket/input.json',
      traceId: 'trace-123',
      scheduledAtMs: Date.now(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('exactly one');
    }
  });

  it('should reject job with neither sessionId NOR workflowExecution', () => {
    const result = StepJobMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'task-1',
      stepType: 'ai',
      operationId: 'ai.generate',
      attempt: 1,
      idempotencyKey: 'key-123',
      inputRef: 'gs://bucket/input.json',
      traceId: 'trace-123',
      scheduledAtMs: Date.now(),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('exactly one');
    }
  });
});

describe('StepResultMessageSchema', () => {
  it('should accept valid result message', () => {
    const result = StepResultMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'generate-text',
      stepType: 'ai',
      operationId: 'ai.generate',
      attempt: 1,
      idempotencyKey: 'key-123',
      status: 'SUCCEEDED',
      outputRef: 'gs://bucket/output.json',
      traceId: 'trace-123',
      finishedAtMs: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept PAUSED with requestedInputRef', () => {
    const result = StepResultMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'request-input',
      stepType: 'user',
      operationId: 'user.interaction.ask',
      attempt: 1,
      idempotencyKey: 'key-123',
      status: 'PAUSED',
      requestedInputRef: 'gs://bucket/requested.json',
      traceId: 'trace-123',
      finishedAtMs: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept result with workflowExecution and no sessionId', () => {
    const result = StepResultMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      workflowExecution: {
        runId: 'run-abc',
        taskId: 'task-1',
        attempt: 1,
        dispatchAttemptToken: 'dispatch:run-abc:task-1:1',
      },
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'task-1',
      stepType: 'compute',
      operationId: 'compute.sandbox.exec',
      attempt: 1,
      idempotencyKey: 'dispatch:run-abc:task-1:1',
      status: 'SUCCEEDED',
      outputRef: 'gs://bucket/output.json',
      traceId: 'trace-123',
      finishedAtMs: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject result with both sessionId AND workflowExecution', () => {
    const result = StepResultMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      sessionId: '550e8400-e29b-41d4-a716-446655440001',
      workflowExecution: {
        runId: 'run-abc',
        taskId: 'task-1',
        attempt: 1,
        dispatchAttemptToken: 'dispatch:run-abc:task-1:1',
      },
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'task-1',
      stepType: 'ai',
      operationId: 'ai.generate',
      attempt: 1,
      idempotencyKey: 'key-123',
      status: 'SUCCEEDED',
      traceId: 'trace-123',
      finishedAtMs: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject result with neither sessionId NOR workflowExecution', () => {
    const result = StepResultMessageSchema.safeParse({
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      stepExecutionId: '550e8400-e29b-41d4-a716-446655440002',
      stepId: 'task-1',
      stepType: 'ai',
      operationId: 'ai.generate',
      attempt: 1,
      idempotencyKey: 'key-123',
      status: 'SUCCEEDED',
      traceId: 'trace-123',
      finishedAtMs: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});

describe('OperationDefinitionSchema', () => {
  it('should accept valid operation definition', () => {
    const result = OperationDefinitionSchema.safeParse({
      operationId: 'ai.generate',
      stepType: 'ai',
      name: 'Generate Text',
      semanticDescription: 'Generate text using a language model based on the provided prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
        },
        required: ['prompt'],
      },
      sideEffects: {
        classification: 'NONE',
        idempotent: true,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('StateVariableSchema', () => {
  it('should accept valid state variable', () => {
    const result = StateVariableSchema.safeParse({
      variableId: 'customer_analysis',
      name: 'Customer Analysis Result',
      description: 'AI-generated analysis of customer data',
      typeSchema: { type: 'object' },
      semanticType: 'json',
      lifecycle: {
        isInput: false,
        isOutput: true,
      },
      uiHints: {
        priority: 100,
        showInSummary: true,
      },
      tags: ['analytics', 'customer'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept chart semantic type with config', () => {
    const result = StateVariableSchema.safeParse({
      variableId: 'revenue_chart',
      name: 'Revenue Trend',
      typeSchema: { type: 'object' },
      semanticType: 'chart',
      uiHints: {
        chartConfig: {
          type: 'line',
          xAxis: 'date',
          yAxis: 'revenue',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid variable ID', () => {
    const result = StateVariableSchema.safeParse({
      variableId: '123-invalid',
      name: 'Test',
      typeSchema: { type: 'string' },
    });
    expect(result.success).toBe(false);
  });

  it('should mark sensitive variables', () => {
    const result = StateVariableSchema.parse({
      variableId: 'api_key',
      name: 'API Key',
      typeSchema: { type: 'string' },
      sensitive: true,
    });
    expect(result.sensitive).toBe(true);
  });
});

describe('validateStateVariables', () => {
  it('should detect duplicate variable IDs', () => {
    const variables = [
      StateVariableSchema.parse({
        variableId: 'duplicate_var',
        name: 'First',
        typeSchema: { type: 'string' },
      }),
      StateVariableSchema.parse({
        variableId: 'duplicate_var',
        name: 'Second',
        typeSchema: { type: 'string' },
      }),
    ];

    const result = validateStateVariables(variables);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Duplicate');
    expect(result.errors[0]).toContain('duplicate_var');
  });

  it('should detect immutable output conflict', () => {
    const variables = [
      StateVariableSchema.parse({
        variableId: 'bad_var',
        name: 'Bad Variable',
        typeSchema: { type: 'string' },
        immutable: true,
        lifecycle: { isOutput: true },
      }),
    ];

    const result = validateStateVariables(variables);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('immutable');
    expect(result.errors[0]).toContain('output');
  });

  it('should accept valid variable definitions', () => {
    const variables = [
      StateVariableSchema.parse({
        variableId: 'input_var',
        name: 'Input Variable',
        typeSchema: { type: 'string' },
        lifecycle: { isInput: true },
      }),
      StateVariableSchema.parse({
        variableId: 'output_var',
        name: 'Output Variable',
        typeSchema: { type: 'object' },
        lifecycle: { isOutput: true },
      }),
    ];

    const result = validateStateVariables(variables);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('deriveInputSchema', () => {
  it('should derive input schema from state variables', () => {
    const flow = AgentDefinitionSchema.parse({
      flowId: 'my-flow',
      version: '1.0.0',
      metadata: { name: 'My Flow' },
      steps: [{ stepId: 'step-a', stepType: 'ai', operation: 'ai.generate' }],
      startStepId: 'step-a',
      stateVariables: [
        {
          variableId: 'customer_id',
          name: 'Customer ID',
          typeSchema: { type: 'string', format: 'uuid' },
          lifecycle: { isInput: true },
          required: true,
        },
        {
          variableId: 'options',
          name: 'Options',
          typeSchema: { type: 'object' },
          lifecycle: { isInput: true },
          required: false,
        },
        {
          variableId: 'result',
          name: 'Result',
          typeSchema: { type: 'object' },
          lifecycle: { isOutput: true },
        },
      ],
    });

    const inputSchema = deriveInputSchema(flow);

    expect(inputSchema).toHaveProperty('type', 'object');
    expect(inputSchema).toHaveProperty('properties');
    const props = inputSchema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('customer_id');
    expect(props).toHaveProperty('options');
    expect(props).not.toHaveProperty('result');
    expect(inputSchema).toHaveProperty('required', ['customer_id']);
  });
});

describe('deriveOutputSchema', () => {
  it('should derive output schema from state variables', () => {
    const flow = AgentDefinitionSchema.parse({
      flowId: 'my-flow',
      version: '1.0.0',
      metadata: { name: 'My Flow' },
      steps: [{ stepId: 'step-a', stepType: 'ai', operation: 'ai.generate' }],
      startStepId: 'step-a',
      stateVariables: [
        {
          variableId: 'customer_id',
          name: 'Customer ID',
          typeSchema: { type: 'string' },
          lifecycle: { isInput: true },
        },
        {
          variableId: 'analysis_result',
          name: 'Analysis Result',
          typeSchema: { type: 'object' },
          lifecycle: { isOutput: true },
        },
      ],
    });

    const outputSchema = deriveOutputSchema(flow);

    expect(outputSchema).toHaveProperty('type', 'object');
    const props = outputSchema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('analysis_result');
    expect(props).not.toHaveProperty('customer_id');
  });
});
