import { z } from 'zod';
import type { AgentDefinition } from '../../artifact/flowDefinition.js';

// ============================================================================
// A2A Agent Card Schema (Zod)
// ============================================================================

/**
 * A2A Agent Card skill — a capability offered by the agent.
 */
export const AgentCardSkillSchema = z.object({
  /** Unique skill identifier */
  id: z.string(),
  /** Human-readable skill name */
  name: z.string(),
  /** Skill description */
  description: z.string().optional(),
  /** Tags for categorization */
  tags: z.array(z.string()).optional(),
  /** Example prompts/inputs for this skill */
  examples: z.array(z.string()).optional(),
  /** Input modes accepted (e.g., "text", "image") */
  inputModes: z.array(z.string()).optional(),
  /** Output modes produced */
  outputModes: z.array(z.string()).optional(),
});
export type AgentCardSkill = z.infer<typeof AgentCardSkillSchema>;

/**
 * A2A Agent Card capabilities.
 */
export const AgentCardCapabilitiesSchema = z.object({
  /** Whether the agent supports SSE streaming */
  streaming: z.boolean().default(true),
  /** Whether the agent supports push notifications */
  pushNotifications: z.boolean().default(false),
  /** Whether the agent exposes task state transition history */
  stateTransitionHistory: z.boolean().default(false),
});
export type AgentCardCapabilities = z.infer<typeof AgentCardCapabilitiesSchema>;

/**
 * A2A Agent Card provider info.
 */
export const AgentCardProviderSchema = z.object({
  /** Provider organization name */
  organization: z.string(),
  /** Provider URL */
  url: z.string().url().optional(),
});
export type AgentCardProvider = z.infer<typeof AgentCardProviderSchema>;

/**
 * A2A Agent Card — the discovery document for an A2A-compatible agent.
 */
export const AgentCardSchema = z.object({
  /** Agent name */
  name: z.string(),
  /** Agent description */
  description: z.string().optional(),
  /** A2A service endpoint URL */
  url: z.string().url(),
  /** Provider information */
  provider: AgentCardProviderSchema.optional(),
  /** Agent version */
  version: z.string().optional(),
  /** Documentation URL */
  documentationUrl: z.string().url().optional(),
  /** Agent capabilities */
  capabilities: AgentCardCapabilitiesSchema,
  /** Default input modes (e.g., ["text"]) */
  defaultInputModes: z.array(z.string()).default(['text']),
  /** Default output modes (e.g., ["text"]) */
  defaultOutputModes: z.array(z.string()).default(['text']),
  /** Skills offered by the agent */
  skills: z.array(AgentCardSkillSchema).default([]),
  /** Security schemes for authentication */
  securitySchemes: z.record(z.unknown()).optional(),
  /** Authentication requirements */
  security: z.array(z.record(z.array(z.string()))).optional(),
  /** Supported A2A protocol version */
  protocolVersion: z.string().optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

// ============================================================================
// Agent Card Generation
// ============================================================================

/**
 * Options for generating an Agent Card from a flow.
 */
export interface GenerateAgentCardOptions {
  /** Base URL for the A2A service endpoint (e.g., "https://api.aflow.ai") */
  baseUrl: string;
  /** Provider organization name */
  providerName?: string;
  /** Provider URL */
  providerUrl?: string;
  /** Flow version override */
  version?: string;
}

/**
 * Generate an A2A-compatible Agent Card from a Phoenix AgentDefinition.
 *
 * Derives all fields from the flow definition and its steps — no additional
 * artifacts needed. This is a pure function with no side effects.
 */
export function generateAgentCard(
  flow: AgentDefinition,
  options: GenerateAgentCardOptions,
): AgentCard {
  const skills = deriveSkills(flow);
  const inputModes = deriveInputModes(flow);
  const outputModes = deriveOutputModes(flow);

  const card: AgentCard = {
    name: flow.metadata.name,
    url: `${options.baseUrl}/v1/a2a`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills,
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Phoenix API Key (Bearer phx_...). Create keys at aflow.ai → Settings → API Keys.',
      },
      oauth2: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Auth0 JWT token (OAuth 2.0 / OIDC)',
      },
    },
    security: [{ apiKey: [] }, { oauth2: [] }],
    protocolVersion: '0.3',
  };

  // Only set optional fields if they have values (exactOptionalPropertyTypes)
  if (flow.metadata.description) {
    card.description = flow.metadata.description;
  }
  if (options.version ?? flow.version) {
    card.version = options.version ?? flow.version;
  }
  if (options.providerName) {
    const provider: AgentCardProvider = { organization: options.providerName };
    if (options.providerUrl) {
      provider.url = options.providerUrl;
    }
    card.provider = provider;
  }

  return card;
}

// ============================================================================
// Skill Derivation Helpers
// ============================================================================

/**
 * Operation ID prefix → skill mapping.
 * Used to derive Agent Card skills from the operations used in a flow.
 */
const OPERATION_SKILL_MAP: ReadonlyArray<{
  prefix: string;
  skillId: string;
  name: string;
  description: string;
  tags: string[];
}> = [
  {
    prefix: 'ai.agent.',
    skillId: 'conversational-agent',
    name: 'Conversational Agent',
    description: 'Engages in multi-turn conversations with tool use',
    tags: ['ai', 'agent', 'conversation'],
  },
  {
    prefix: 'ai.text.',
    skillId: 'text-generation',
    name: 'Text Generation',
    description: 'Generates text content using AI models',
    tags: ['ai', 'text', 'generation'],
  },
  {
    prefix: 'ai.image.',
    skillId: 'image-processing',
    name: 'Image Processing',
    description: 'Generates or analyzes images',
    tags: ['ai', 'image'],
  },
  {
    prefix: 'memory.',
    skillId: 'knowledge-retrieval',
    name: 'Knowledge Retrieval',
    description: 'Stores, queries, and retrieves knowledge from memory',
    tags: ['memory', 'knowledge', 'retrieval'],
  },
  {
    prefix: 'api.http.',
    skillId: 'external-api',
    name: 'External API Integration',
    description: 'Calls external HTTP APIs',
    tags: ['api', 'http', 'integration'],
  },
  {
    prefix: 'user.',
    skillId: 'human-in-the-loop',
    name: 'Human-in-the-Loop',
    description: 'Requests user input or approval during execution',
    tags: ['user', 'hitl', 'approval'],
  },
  {
    prefix: 'agent.manage.',
    skillId: 'agent-orchestration',
    name: 'Agent Orchestration',
    description: 'Manages sub-agents and complex execution patterns',
    tags: ['agent', 'orchestration', 'delegation'],
  },
  {
    prefix: 'eval.',
    skillId: 'evaluation',
    name: 'Evaluation',
    description: 'Evaluates and grades outputs',
    tags: ['eval', 'quality'],
  },
  {
    prefix: 'guardrail.',
    skillId: 'guardrails',
    name: 'Guardrails',
    description: 'Applies safety and policy guardrails',
    tags: ['guardrail', 'safety', 'policy'],
  },
];

/**
 * Derive Agent Card skills from the operations used in a flow's steps.
 */
function deriveSkills(flow: AgentDefinition): AgentCardSkill[] {
  const seenSkillIds = new Set<string>();
  const skills: AgentCardSkill[] = [];

  for (const step of flow.steps) {
    const operationId = step.operation;

    for (const mapping of OPERATION_SKILL_MAP) {
      if (operationId.startsWith(mapping.prefix) && !seenSkillIds.has(mapping.skillId)) {
        seenSkillIds.add(mapping.skillId);
        skills.push({
          id: mapping.skillId,
          name: mapping.name,
          description: mapping.description,
          tags: mapping.tags,
        });
      }
    }
  }

  // If no skills were derived, create a generic one from the flow metadata
  if (skills.length === 0) {
    skills.push({
      id: 'flow-execution',
      name: flow.metadata.name,
      description: flow.metadata.description ?? 'Executes a workflow',
      tags: flow.metadata.tags,
    });
  }

  return skills;
}

/**
 * Derive supported input modes from a flow.
 * Most Phoenix flows accept text. Flows with image operations also accept images.
 */
function deriveInputModes(flow: AgentDefinition): string[] {
  const modes = new Set<string>(['text']);

  for (const step of flow.steps) {
    if (step.operation.startsWith('ai.image.')) {
      modes.add('image');
    }
  }

  return [...modes];
}

/**
 * Derive supported output modes from a flow.
 */
function deriveOutputModes(flow: AgentDefinition): string[] {
  const modes = new Set<string>(['text']);

  for (const step of flow.steps) {
    if (step.operation.startsWith('ai.image.')) {
      modes.add('image');
    }
    if (step.operation.startsWith('ui.')) {
      modes.add('html');
    }
  }

  return [...modes];
}

// ============================================================================
// Platform-Level Agent Card
// ============================================================================

/**
 * Generate a platform-level Agent Card (not flow-specific).
 * Advertises the Phoenix platform as an A2A-compatible agent service.
 */
export function generatePlatformAgentCard(options: {
  baseUrl: string;
  providerName?: string;
  providerUrl?: string;
}): AgentCard {
  return {
    name: 'Phoenix Aflow Platform',
    description: 'Agentic flow execution platform — run AI agent workflows with full observability',
    url: `${options.baseUrl}/v1/a2a`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'flow-execution',
        name: 'Flow Execution',
        description: 'Execute agentic workflows with multi-step orchestration',
        tags: ['flow', 'agent', 'orchestration'],
      },
    ],
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Phoenix API Key (Bearer phx_...). Create keys at aflow.ai → Settings → API Keys.',
      },
      oauth2: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Auth0 JWT token (OAuth 2.0 / OIDC)',
      },
    },
    security: [{ apiKey: [] }, { oauth2: [] }],
    protocolVersion: '0.3',
    ...(options.providerName
      ? {
          provider: {
            organization: options.providerName,
            ...(options.providerUrl ? { url: options.providerUrl } : {}),
          },
        }
      : {}),
  };
}
