import { describe, it, expect } from 'vitest';
import {
  // A2A Agent Card
  generateAgentCard,
  generatePlatformAgentCard,
  AgentCardSchema,
  // Agent Spec
  validateAgentSpec,
  isComponentRef,
  AGENT_SPEC_COMPONENT_TYPES,
  isAgentComponent,
  isFlowComponent,
  importAgentSpec,
  exportToAgentSpec,
  // A2A Task Mapping
  mapTaskStateFromRunStatus,
  mapRunEventsToMessages,
  mapRunToTask,
  projectRunEventToA2A,
  // AG-UI
  projectRunEventToAgui,
  AguiEventType,
  // Typed interrupts
  PauseTypeSchema,
  PauseMetadataSchema,
  ResumeSchemaDescriptorSchema,
  // Flow definition (for agent card test fixtures)
  type AgentDefinition,
  // Agent Spec types (for import/export tests)
  type AgentSpecComponent,
  type AgentSpecAgent,
  type AgentSpecFlow,
  type AgentSpecNode,
} from '@aflow/schemas';

// ============================================================================
// Test Fixtures
// ============================================================================

const sampleFlow: AgentDefinition = {
  schemaVersion: 1,
  flowId: 'flow-123',
  systemRole: null,
  version: '1.0.0',
  metadata: {
    name: 'Research Agent',
    description: 'Fetches data from APIs and answers questions',
    tags: ['research', 'api'],
    public: true,
    system: false,
    custom: {},
  },
  stateVariables: [],
  steps: [
    {
      stepId: 'agent',
      name: 'Research Agent',
      stepType: 'ai',
      operation: 'ai.agent.turn',
      config: {},
      onSuccess: { next: [{ stepId: 'tool-fetch', priority: 50 }] },
      onFailure: { next: [] },
    },
    {
      stepId: 'tool-fetch',
      name: 'API Fetch',
      stepType: 'api',
      operation: 'api.http.call',
      config: {},
      onSuccess: { next: [{ stepId: 'agent', priority: 50 }] },
      onFailure: { next: [{ stepId: 'agent', priority: 50 }] },
    },
  ],
  startStepId: 'agent',
  allowedOperations: [],
  supportedModes: ['api', 'chat'],
  status: 'published',
};

const sampleAgentSpec = {
  component_type: 'Agent',
  agentspec_version: '26.1.0',
  id: 'agent.calc.v1',
  name: 'Calculator agent',
  description: 'Answers arithmetic questions using a subtraction tool.',
  system_prompt: 'Use tools when needed. Be concise.',
  llm_config: {
    component_type: 'OpenAiCompatibleConfig',
    id: 'llm.openai.compat',
    name: 'openai-compatible',
    model_id: 'gpt-4o-mini',
    api_key: { $component_ref: 'llm.openai.compat.api_key' },
  },
  tools: [
    {
      component_type: 'ServerTool',
      id: 'tool.subtraction',
      name: 'subtraction-tool',
      description: 'Subtract two numbers.',
      inputs: [
        { title: 'a', type: 'number', description: 'Minuend' },
        { title: 'b', type: 'number', description: 'Subtrahend' },
      ],
      outputs: [{ title: 'difference', type: 'number', description: 'a - b' }],
    },
  ],
};

// ============================================================================
// A2A Agent Card Tests
// ============================================================================

describe('A2A Agent Card', () => {
  it('generates a valid agent card from a flow definition', () => {
    const card = generateAgentCard(sampleFlow, {
      baseUrl: 'https://api.aflow.ai',
      providerName: 'Phoenix Aflow',
      providerUrl: 'https://aflow.ai',
    });

    expect(card.name).toBe('Research Agent');
    expect(card.description).toBe('Fetches data from APIs and answers questions');
    expect(card.url).toBe('https://api.aflow.ai/v1/a2a');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.protocolVersion).toBe('0.3');
    expect(card.provider?.organization).toBe('Phoenix Aflow');
    expect(card.provider?.url).toBe('https://aflow.ai');

    // Should derive skills from operations
    expect(card.skills.length).toBeGreaterThan(0);
    const skillIds = card.skills.map((s) => s.id);
    expect(skillIds).toContain('conversational-agent');
    expect(skillIds).toContain('external-api');

    // Should validate against the card schema
    const parseResult = AgentCardSchema.safeParse(card);
    expect(parseResult.success).toBe(true);
  });

  it('generates a platform-level agent card', () => {
    const card = generatePlatformAgentCard({
      baseUrl: 'https://api.aflow.ai',
      providerName: 'Phoenix Aflow',
    });

    expect(card.name).toBe('Phoenix Aflow Platform');
    expect(card.url).toBe('https://api.aflow.ai/v1/a2a');
    expect(card.skills.length).toBeGreaterThan(0);

    const parseResult = AgentCardSchema.safeParse(card);
    expect(parseResult.success).toBe(true);
  });

  it('handles flow with no matching operations gracefully', () => {
    const minimalFlow: AgentDefinition = {
      ...sampleFlow,
      steps: [
        {
          stepId: 'custom',
          name: 'Custom Step',
          stepType: 'custom',
          operation: 'custom.unknown.op',
          config: {},
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
      startStepId: 'custom',
    };

    const card = generateAgentCard(minimalFlow, { baseUrl: 'https://api.aflow.ai' });
    // Should fall back to a generic skill
    expect(card.skills.length).toBe(1);
    expect(card.skills[0]!.id).toBe('flow-execution');
  });
});

// ============================================================================
// Agent Spec Validation Tests
// ============================================================================

describe('Agent Spec Validation', () => {
  it('validates a well-formed Agent component', () => {
    const result = validateAgentSpec(sampleAgentSpec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.component_type).toBe('Agent');
      expect(result.value.name).toBe('Calculator agent');
    }
  });

  it('rejects missing component_type', () => {
    const result = validateAgentSpec({ id: 'test', name: 'test' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes('component_type'))).toBe(true);
    }
  });

  it('rejects missing id', () => {
    const result = validateAgentSpec({ component_type: 'Agent', name: 'test' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes('id'))).toBe(true);
    }
  });

  it('rejects missing name', () => {
    const result = validateAgentSpec({ component_type: 'Agent', id: 'test' });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown component_type', () => {
    const result = validateAgentSpec({
      component_type: 'UnknownType',
      id: 'test',
      name: 'test',
    });
    expect(result.ok).toBe(false);
  });

  it('validates a Flow component', () => {
    const flow = {
      component_type: 'Flow',
      id: 'flow.test',
      name: 'Test Flow',
      nodes: [
        { component_type: 'StartNode', id: 'start', name: 'Start' },
        { component_type: 'EndNode', id: 'end', name: 'End' },
      ],
      edges: [{ component_type: 'ControlFlowEdge', source_node: 'start', target_node: 'end' }],
    };
    const result = validateAgentSpec(flow);
    expect(result.ok).toBe(true);
  });

  it('rejects Flow without nodes', () => {
    const flow = {
      component_type: 'Flow',
      id: 'flow.test',
      name: 'Test Flow',
      edges: [],
    };
    const result = validateAgentSpec(flow);
    expect(result.ok).toBe(false);
  });

  it('detects $component_ref values', () => {
    expect(isComponentRef({ $component_ref: 'secret.key' })).toBe(true);
    expect(isComponentRef({ other: 'value' })).toBe(false);
    expect(isComponentRef('string')).toBe(false);
    expect(isComponentRef(null)).toBe(false);
  });

  it('provides type guards for Agent and Flow', () => {
    const agentResult = validateAgentSpec(sampleAgentSpec);
    expect(agentResult.ok).toBe(true);
    if (agentResult.ok) {
      expect(isAgentComponent(agentResult.value)).toBe(true);
      expect(isFlowComponent(agentResult.value)).toBe(false);
    }
  });

  it('knows all expected component types', () => {
    expect(AGENT_SPEC_COMPONENT_TYPES).toContain('Agent');
    expect(AGENT_SPEC_COMPONENT_TYPES).toContain('Flow');
    expect(AGENT_SPEC_COMPONENT_TYPES).toContain('ServerTool');
    expect(AGENT_SPEC_COMPONENT_TYPES).toContain('StartNode');
    expect(AGENT_SPEC_COMPONENT_TYPES).toContain('ControlFlowEdge');
    expect(AGENT_SPEC_COMPONENT_TYPES).toContain('DataFlowEdge');
  });
});

// ============================================================================
// AG-UI Projection Tests
// ============================================================================

describe('AG-UI Projection', () => {
  it('maps FlowRunStarted to RunStarted', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-1',
      eventType: 'FlowRunStarted',
      timestamp: 1000,
      runId: 'run-123',
    });
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    const evt = result as { type: string; runId: string };
    expect(evt.type).toBe(AguiEventType.RunStarted);
    expect(evt.runId).toBe('run-123');
  });

  it('maps FlowRunSucceeded to RunFinished', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-2',
      eventType: 'FlowRunSucceeded',
      timestamp: 2000,
      runId: 'run-123',
    });
    expect(result).not.toBeNull();
    const evt = result as { type: string };
    expect(evt.type).toBe(AguiEventType.RunFinished);
  });

  it('maps FlowRunFailed to RunError', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-3',
      eventType: 'FlowRunFailed',
      timestamp: 3000,
      runId: 'run-123',
      metadata: { errorMessage: 'Something broke', errorCode: 'ERR_001' },
    });
    expect(result).not.toBeNull();
    const evt = result as { type: string; message: string; code: string };
    expect(evt.type).toBe(AguiEventType.RunError);
    expect(evt.message).toBe('Something broke');
    expect(evt.code).toBe('ERR_001');
  });

  it('maps StepScheduled without parent to StepStarted', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-4',
      eventType: 'StepScheduled',
      timestamp: 4000,
      runId: 'run-123',
      stepId: 'step-1',
      metadata: { stepName: 'My Step' },
    });
    expect(result).not.toBeNull();
    const evt = result as { type: string; stepName: string };
    expect(evt.type).toBe(AguiEventType.StepStarted);
    expect(evt.stepName).toBe('My Step');
  });

  it('maps StepScheduled with parent to ToolCallStart', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-5',
      eventType: 'StepScheduled',
      timestamp: 5000,
      runId: 'run-123',
      stepId: 'tool-step',
      stepExecutionId: 'exec-456',
      metadata: { parentStepExecutionId: 'parent-exec', stepName: 'api-fetch' },
    });
    expect(result).not.toBeNull();
    const evt = result as { type: string; toolCallId: string; toolCallName: string };
    expect(evt.type).toBe(AguiEventType.ToolCallStart);
    expect(evt.toolCallId).toBe('exec-456');
    expect(evt.toolCallName).toBe('api-fetch');
  });

  it('maps StepSucceeded with agentMessage to multiple events', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-6',
      eventType: 'StepSucceeded',
      timestamp: 6000,
      runId: 'run-123',
      stepId: 'agent',
      metadata: { stepName: 'Agent', agentMessage: 'Here is your answer.' },
    });
    expect(Array.isArray(result)).toBe(true);
    const events = result as Array<{ type: string }>;
    // StepFinished + TextMessageStart + TextMessageContent + TextMessageEnd
    expect(events.length).toBe(4);
    expect(events[0]!.type).toBe(AguiEventType.StepFinished);
    expect(events[1]!.type).toBe(AguiEventType.TextMessageStart);
    expect(events[2]!.type).toBe(AguiEventType.TextMessageContent);
    expect(events[3]!.type).toBe(AguiEventType.TextMessageEnd);
  });

  it('maps FlowRunPaused to text message + Custom input_required', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-7',
      eventType: 'FlowRunPaused',
      timestamp: 7000,
      runId: 'run-123',
      metadata: {
        agentResponse: 'What would you like to do next?',
        pauseType: 'user_input',
      },
    });
    expect(Array.isArray(result)).toBe(true);
    const events = result as Array<{ type: string; name?: string }>;
    // TextMessageStart + TextMessageContent + TextMessageEnd + Custom
    expect(events.length).toBe(4);
    expect(events[3]!.type).toBe(AguiEventType.Custom);
    expect(events[3]!.name).toBe('input_required');
  });

  it('returns null for Phoenix-specific events', () => {
    expect(
      projectRunEventToAgui({
        eventId: 'evt-8',
        eventType: 'FlowRunQueued',
        timestamp: 8000,
        runId: 'run-123',
      }),
    ).toBeNull();

    expect(
      projectRunEventToAgui({
        eventId: 'evt-9',
        eventType: 'FlowRunResumed',
        timestamp: 9000,
        runId: 'run-123',
      }),
    ).toBeNull();
  });

  it('maps runtimeStatePatch to StateDelta', () => {
    const result = projectRunEventToAgui({
      eventId: 'evt-10',
      eventType: 'StepStarted',
      timestamp: 10000,
      runId: 'run-123',
      runtimeStatePatch: {
        version: 3,
        changed: [{ key: 'myVar', value: 'hello' }],
      },
    });
    expect(result).not.toBeNull();
    const evt = result as { type: string; delta: Array<{ op: string; path: string }> };
    expect(evt.type).toBe(AguiEventType.StateDelta);
    expect(evt.delta.length).toBe(1);
    expect(evt.delta[0]!.path).toBe('/myVar');
  });
});

// ============================================================================
// Typed Interrupts Tests
// ============================================================================

describe('Typed Interrupts (Plan 55, L3)', () => {
  it('PauseTypeSchema validates all pause types', () => {
    expect(PauseTypeSchema.safeParse('user_input').success).toBe(true);
    expect(PauseTypeSchema.safeParse('approval').success).toBe(true);
    expect(PauseTypeSchema.safeParse('external_dependency').success).toBe(true);
    expect(PauseTypeSchema.safeParse('budget_exceeded').success).toBe(true);
    expect(PauseTypeSchema.safeParse('subflow_waiting').success).toBe(true);
    expect(PauseTypeSchema.safeParse('guardrail_escalation').success).toBe(true);
    expect(PauseTypeSchema.safeParse('invalid_type').success).toBe(false);
  });

  it('PauseMetadataSchema validates structured metadata', () => {
    const metadata = {
      pauseType: 'budget_exceeded' as const,
      resumeSchema: {
        schema: { type: 'object', properties: { message: { type: 'string' } } },
        description: 'Provide a message to continue',
      },
      context: {
        budgetExceededReason: 'Turn limit reached (5/5)',
      },
    };

    const result = PauseMetadataSchema.safeParse(metadata);
    expect(result.success).toBe(true);
  });

  it('PauseMetadataSchema allows minimal metadata', () => {
    const result = PauseMetadataSchema.safeParse({ pauseType: 'user_input' });
    expect(result.success).toBe(true);
  });

  it('ResumeSchemaDescriptorSchema validates resume schema', () => {
    const descriptor = {
      schema: { type: 'string' },
      description: 'Your reply to the agent',
    };
    const result = ResumeSchemaDescriptorSchema.safeParse(descriptor);
    expect(result.success).toBe(true);
  });

  it('ResumeSchemaDescriptorSchema requires schema field', () => {
    const result = ResumeSchemaDescriptorSchema.safeParse({ description: 'test' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Agent Spec Import Tests
// ============================================================================

describe('Agent Spec Import', () => {
  it('imports an Agent component to a AgentDefinition', () => {
    const result = importAgentSpec(sampleAgentSpec as AgentSpecComponent);
    expect(result.flow).toBeDefined();
    expect(result.flow.metadata.name).toBe('Calculator agent');
    expect(result.flow.steps.length).toBe(2); // agent + 1 tool
    expect(result.flow.steps[0]!.operation).toBe('ai.agent.turn');
    expect(result.flow.steps[0]!.config!['model']).toBe('gpt-4o-mini');
    expect(result.flow.steps[0]!.config!['systemPrompt']).toBe(
      'Use tools when needed. Be concise.',
    );
    // Tool step
    expect(result.flow.steps[1]!.name).toBe('subtraction-tool');
    expect(result.flow.steps[1]!.config!['inputSchema']).toBeDefined();
    // Unresolved secret from $component_ref
    expect(result.unresolvedSecrets).toContain('llm.openai.compat.api_key');
  });

  it('imports a Flow component with nodes and edges', () => {
    const flowSpec = {
      component_type: 'Flow',
      id: 'flow.pipeline',
      name: 'Data Pipeline',
      description: 'A simple two-step pipeline',
      nodes: [
        { component_type: 'StartNode', id: 'start', name: 'Start' },
        {
          component_type: 'LlmNode',
          id: 'summarize',
          name: 'Summarize',
          llm_config: {
            component_type: 'OpenAiCompatibleConfig',
            id: 'llm.1',
            name: 'llm',
            model_id: 'gpt-4o',
          },
          prompt: 'Summarize the following text: ${input}',
        },
        {
          component_type: 'ApiNode',
          id: 'post-result',
          name: 'Post Result',
          url: 'https://api.example.com/results',
          method: 'POST',
        },
        { component_type: 'EndNode', id: 'end', name: 'End' },
      ],
      edges: [
        { component_type: 'ControlFlowEdge', source_node: 'start', target_node: 'summarize' },
        { component_type: 'ControlFlowEdge', source_node: 'summarize', target_node: 'post-result' },
        { component_type: 'ControlFlowEdge', source_node: 'post-result', target_node: 'end' },
      ],
    };

    const result = importAgentSpec(flowSpec as AgentSpecComponent);
    expect(result.flow.metadata.name).toBe('Data Pipeline');
    expect(result.flow.steps.length).toBe(2); // LlmNode + ApiNode (Start/End excluded)

    const summarizeStep = result.flow.steps.find((s) => s.name === 'Summarize');
    expect(summarizeStep).toBeDefined();
    expect(summarizeStep!.operation).toBe('ai.text.generate');
    expect(summarizeStep!.config!['model']).toBe('gpt-4o');

    const apiStep = result.flow.steps.find((s) => s.name === 'Post Result');
    expect(apiStep).toBeDefined();
    expect(apiStep!.operation).toBe('api.http.call');
    expect(apiStep!.config!['url']).toBe('https://api.example.com/results');

    // Edge: summarize → post-result
    expect(summarizeStep!.onSuccess.next.length).toBe(1);
    expect(summarizeStep!.onSuccess.next[0]!.stepId).toBe(apiStep!.stepId);
  });

  it('handles Agent with no tools', () => {
    const minimalAgent = {
      component_type: 'Agent',
      id: 'agent.minimal',
      name: 'Minimal Agent',
    };
    const result = importAgentSpec(minimalAgent as AgentSpecComponent);
    expect(result.flow.steps.length).toBe(1);
    expect(result.flow.steps[0]!.operation).toBe('ai.agent.turn');
    expect(result.warnings.length).toBe(0);
  });
});

// ============================================================================
// Agent Spec Export Tests
// ============================================================================

describe('Agent Spec Export', () => {
  it('exports an agent-pattern flow as an Agent component', () => {
    const result = exportToAgentSpec(sampleFlow);
    expect(result.component.component_type).toBe('Agent');
    expect(result.component.name).toBe('Research Agent');
    expect(result.component.id).toBe('flow-123');

    const agent = result.component as AgentSpecAgent;
    expect(agent.tools).toBeDefined();
    expect(agent.tools.length).toBe(1);
    expect(agent.tools[0].name).toBe('API Fetch');
  });

  it('exports a multi-step flow as a Flow component', () => {
    const multiStepFlow: AgentDefinition = {
      ...sampleFlow,
      steps: [
        {
          stepId: 'step-a',
          name: 'Generate Text',
          stepType: 'ai',
          operation: 'ai.text.generate',
          config: { model: 'gpt-4o' },
          onSuccess: { next: [{ stepId: 'step-b', priority: 50 }] },
          onFailure: { next: [] },
        },
        {
          stepId: 'step-b',
          name: 'Call API',
          stepType: 'api',
          operation: 'api.http.call',
          config: { url: 'https://api.example.com' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
      startStepId: 'step-a',
    };

    const result = exportToAgentSpec(multiStepFlow);
    expect(result.component.component_type).toBe('Flow');

    const flow = result.component as AgentSpecFlow;
    expect(flow.nodes.length).toBeGreaterThan(2); // steps + Start + End
    expect(flow.edges.length).toBeGreaterThan(0);

    // Verify node types
    const nodeTypes = flow.nodes.map((n: AgentSpecNode) => n.component_type);
    expect(nodeTypes).toContain('StartNode');
    expect(nodeTypes).toContain('EndNode');
    expect(nodeTypes).toContain('LlmNode');
    expect(nodeTypes).toContain('ApiNode');
  });

  it('includes _phoenix metadata by default', () => {
    const result = exportToAgentSpec(sampleFlow);
    const agent = result.component as AgentSpecAgent;
    expect(agent.metadata._phoenix).toBeDefined();
    expect(agent.metadata._phoenix.flowId).toBe('flow-123');
  });

  it('omits _phoenix metadata when opted out', () => {
    const result = exportToAgentSpec(sampleFlow, { includePhoenixMetadata: false });
    const agent = result.component as AgentSpecAgent;
    expect(agent.metadata._phoenix).toBeUndefined();
  });
});

// ============================================================================
// Import → Export Round-Trip Tests
// ============================================================================

describe('Agent Spec Round-Trip', () => {
  it('Agent import → export preserves core semantics', () => {
    // Import
    const imported = importAgentSpec(sampleAgentSpec as AgentSpecComponent);
    expect(imported.flow).toBeDefined();

    // Export back
    const exported = exportToAgentSpec(imported.flow, { includePhoenixMetadata: false });
    expect(exported.component.component_type).toBe('Agent');

    const agent = exported.component as AgentSpecAgent;
    expect(agent.name).toBe('Calculator agent');
    expect(agent.description).toBe('Answers arithmetic questions using a subtraction tool.');
    // Model should round-trip
    expect(agent.llm_config?.model_id).toBe('gpt-4o-mini');
    // System prompt should round-trip
    expect(agent.system_prompt).toBe('Use tools when needed. Be concise.');
    // Tool should round-trip
    expect(agent.tools?.length).toBe(1);
    expect(agent.tools[0].name).toBe('subtraction-tool');
  });

  it('export → import preserves flow structure', () => {
    // Export the sample Phoenix flow
    const exported = exportToAgentSpec(sampleFlow);

    // Validate the exported component
    const validation = validateAgentSpec(exported.component);
    expect(validation.ok).toBe(true);

    // Import it back
    if (validation.ok) {
      const reimported = importAgentSpec(validation.value);
      expect(reimported.flow.metadata.name).toBe('Research Agent');
      // Agent pattern should produce an agent step
      const agentStep = reimported.flow.steps.find((s) => s.operation === 'ai.agent.turn');
      expect(agentStep).toBeDefined();
    }
  });
});

// ============================================================================
// A2A Task Mapping Tests
// ============================================================================

describe('A2A Task Mapping', () => {
  it('maps Phoenix run statuses to A2A task states', () => {
    expect(mapTaskStateFromRunStatus('QUEUED')).toBe('submitted');
    expect(mapTaskStateFromRunStatus('RUNNING')).toBe('working');
    expect(mapTaskStateFromRunStatus('SUCCEEDED')).toBe('completed');
    expect(mapTaskStateFromRunStatus('FAILED')).toBe('failed');
    expect(mapTaskStateFromRunStatus('PAUSED')).toBe('input-required');
    expect(mapTaskStateFromRunStatus('CANCELLED')).toBe('canceled');
    expect(mapTaskStateFromRunStatus('CANCELLING')).toBe('working');
    expect(mapTaskStateFromRunStatus('STALLED')).toBe('failed');
    expect(mapTaskStateFromRunStatus('UNKNOWN')).toBe('working');
  });

  it('extracts messages from run events', () => {
    const events = [
      { eventType: 'FlowRunStarted', metadata: { userMessage: 'Hello agent' } },
      {
        eventType: 'StepSucceeded',
        metadata: { agentMessage: 'I found the answer.' },
      },
      {
        eventType: 'FlowRunPaused',
        metadata: { agentResponse: 'What else would you like?' },
      },
      { eventType: 'FlowRunResumed', metadata: { resumeInput: 'More details please' } },
      { eventType: 'FlowRunSucceeded', metadata: { output: 'Final result here' } },
    ];

    const messages = mapRunEventsToMessages(events);
    expect(messages.length).toBe(5);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.parts[0]!).toEqual({ type: 'text', text: 'Hello agent' });
    expect(messages[1]!.role).toBe('agent');
    expect(messages[2]!.role).toBe('agent');
    expect(messages[3]!.role).toBe('user');
    expect(messages[4]!.role).toBe('agent');
  });

  it('builds an A2A task from run summary', () => {
    const events = [
      { eventType: 'FlowRunStarted', metadata: { userMessage: 'Hi' } },
      { eventType: 'StepSucceeded', metadata: { agentMessage: 'Hello!' } },
    ];

    const task = mapRunToTask(
      { runId: 'run-abc', status: 'RUNNING', createdAt: '2026-01-01T00:00:00Z' },
      events,
    );

    expect(task.id).toBe('run-abc');
    expect(task.status.state).toBe('working');
    expect(task.status.message?.role).toBe('agent');
    expect(task.history?.length).toBe(2);
  });

  it('projects FlowRunSucceeded to A2A task-status-update', () => {
    const event = projectRunEventToA2A('task-1', {
      eventType: 'FlowRunSucceeded',
      metadata: { output: 'Done!' },
    });

    expect(event).not.toBeNull();
    expect(event!.type).toBe('task-status-update');
    const statusEvent = event as {
      status: { state: string; message?: { parts: Array<{ text: string }> } };
      final: boolean;
    };
    expect(statusEvent.status.state).toBe('completed');
    expect(statusEvent.final).toBe(true);
    expect(statusEvent.status.message?.parts[0]?.text).toBe('Done!');
  });

  it('projects FlowRunPaused to input-required', () => {
    const event = projectRunEventToA2A('task-2', {
      eventType: 'FlowRunPaused',
      metadata: { agentResponse: 'Need more info' },
    });

    expect(event).not.toBeNull();
    const statusEvent = event as { status: { state: string } };
    expect(statusEvent.status.state).toBe('input-required');
  });

  it('returns null for unmapped events', () => {
    expect(projectRunEventToA2A('task-3', { eventType: 'StepScheduled' })).toBeNull();
    expect(projectRunEventToA2A('task-3', { eventType: 'FlowRunQueued' })).toBeNull();
  });
});
