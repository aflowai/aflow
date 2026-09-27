/**
 * The agent half of a simulated integration.
 *
 * A simulation is an environment, and an environment with nothing to talk to
 * can only be tested by whatever general-purpose agent the space happens to
 * have — which measures that agent, not the one being designed. So a bundle
 * ships a subject alongside its environment.
 *
 * It ships as a SEPARATE artifact rather than a field on the simulation.
 * `Simulation` describes the world; an agent is the thing under test, and the
 * moment the environment supplies the subject, a later evaluation is grading
 * something the ruler handed it.
 *
 * What varies between one desk and the next is a system prompt and which API
 * it may call. Everything else here is the same every time, which is why it is
 * written once: the step, the two state variables, the turn policy and the
 * output mapping are the shape a chat-mode agent has to have, and rebuilding
 * them by hand per space is how they drift.
 */

/** The narrow slice of a flow definition this template produces. */
export interface SimulationDeskAgent {
  flowId: string;
  name: string;
  description: string;
  tags: string[];
  definition: Record<string, unknown>;
}

export interface SimulationDeskAgentInput {
  /** Slug and flow id. Stable — a rewrite targets the same agent. */
  flowId: string;
  name: string;
  description: string;
  /**
   * The API whose endpoints become this agent's tools.
   *
   * `coreApis` yields ZERO tools, silently, for an id no definition in the
   * space carries — so this must be the `apiId` of a definition already
   * written, which is why a bundle installs the definition first.
   */
  apiId: string;
  /**
   * What this desk is, in its own domain's terms.
   *
   * Deliberately the only prose in the artifact. Anything a schema can state —
   * which statuses exist, what a field means, which reason a transfer takes,
   * how a section pages — belongs to the API definition, where it is versioned
   * with the contract and reaches the agent whether or not the prompt survives
   * a model change.
   */
  systemPrompt: string;
  tags?: string[];
  /**
   * The model this desk answers on, stated rather than inherited.
   *
   * Left unset, the step carries no model and the executor falls through to its
   * own default — so the agent runs on a model nobody chose, and a batch's
   * provenance cannot say which one answered. An eval subject whose model is
   * implicit is not comparable to anything.
   */
  model?: string;
  /** Low by default: a support desk reading records is not a creative task. */
  temperature?: number;
  maxToolCallsPerTurn?: number;
}

export function buildSimulationDeskAgent(input: SimulationDeskAgentInput): SimulationDeskAgent {
  const tags = input.tags ?? ['simulation'];
  return {
    flowId: input.flowId,
    name: input.name,
    description: input.description,
    tags,
    definition: {
      flowId: input.flowId,
      schemaVersion: 1,
      status: 'published',
      version: '1',
      systemRole: null,
      startStepId: 'converse',
      supportedModes: ['chat'],
      allowedOperations: [],
      metadata: {
        name: input.name,
        description: input.description,
        tags,
        custom: {},
        public: false,
        system: false,
      },
      stateVariables: [
        {
          variableId: 'message',
          name: 'Customer message',
          tags: [],
          required: true,
          immutable: false,
          inputRole: 'primary',
          sensitive: false,
          semanticType: 'text',
          typeSchema: { type: 'string' },
          lifecycle: { isInput: true, isOutput: false, updateCount: 0, persistOnPause: true },
        },
        {
          variableId: 'reply',
          name: 'Reply to the customer',
          tags: [],
          required: false,
          immutable: false,
          sensitive: false,
          semanticType: 'text',
          typeSchema: { type: 'string' },
          lifecycle: { isInput: false, isOutput: true, updateCount: 0, persistOnPause: true },
        },
      ],
      steps: [
        {
          stepId: 'converse',
          name: 'Answer the customer',
          stepType: 'ai',
          operation: 'ai.agent.turn',
          optional: false,
          tags: [],
          config: {
            prompt: '${state.message}',
            systemPrompt: input.systemPrompt,
            ...(input.model !== undefined ? { model: input.model } : {}),
            agentRole: 'assistant',
            // `format: 'none'` keeps discovery off the turn: the desk's tools
            // are the API's endpoints and nothing else, so the surface being
            // rehearsed is the surface that ships.
            catalog: { format: 'none', coreApis: [input.apiId] },
            turnPolicy: {
              allowComplete: true,
              allowParallel: false,
              maxToolCallsPerTurn: input.maxToolCallsPerTurn ?? 8,
            },
            temperature: input.temperature ?? 0.3,
            contextProfile: 'minimal',
          },
          outputMapping: { response: 'state.reply' },
          onSuccess: { next: [] },
          onFailure: { next: [] },
        },
      ],
    },
  };
}
