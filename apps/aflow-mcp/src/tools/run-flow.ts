/**
 * start_session tool — start an agent session or resume a paused conversation.
 *
 * Supports three start modes:
 * - agent_id: run an existing published agent
 * - agent_config: run an inline/ad-hoc agent definition (not persisted)
 * - conversation_id: resume a paused session (multi-turn agent conversations)
 *
 * Returns full execution trace including step details fetched from /debug.
 */

import { z } from 'zod';
import { SimulationRunInputSchema } from '@aflow/schemas';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionRunner } from '../client/FlowRunner.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { type SpaceGate, SpaceRequiredError } from '../middleware/spaceGate.js';
import { CREDENTIAL_GUIDANCE } from './auth.js';
import { successResponse, errorResponse } from '../util/envelope.js';
import { log } from '../util/logger.js';

type SessionResolver = () => Session;

const AgentConfigSchema = z.object({
  name: z.string().optional().describe('Optional name for the inline agent.'),
  startStepId: z.string().optional().describe('Start step ID (defaults to first step).'),
  steps: z
    .array(z.record(z.unknown()))
    .min(1)
    .describe('Array of step definitions. At least one required.'),
});

const StartSessionInputSchema = z.object({
  system_role: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Run a platform agent by systemRole (cybernetic-helmsman, cybernetic-runner, etc).'),
  agent_slug: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Run a custom (operator-authored) agent by its per-space slug.'),
  agent_config: AgentConfigSchema.optional().describe(
    'Run an inline/ad-hoc agent definition (not persisted). ' +
      'Provide steps directly. Use run_operation with agent.manage.create to persist an agent.',
  ),
  space_id: z.string().min(1).describe('Space ID (required). Call space_list to discover spaces.'),
  input: z
    .unknown()
    .optional()
    .describe(
      'Agent input. For conversational agents: just pass a string (the prompt). ' +
        "For structured agents: pass an object keyed to the agent's input variables. " +
        "The server auto-maps bare values to the agent's primary input.",
    ),
  config: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional config overrides keyed by variable ID. ' +
        'These override default values for config variables declared in the agent.',
    ),
  timeout_seconds: z
    .number()
    .min(1)
    .max(600)
    .optional()
    .describe('Max wait time in seconds (default: 120, max: 600).'),
  conversation_id: z
    .string()
    .optional()
    .describe(
      'Session ID to resume (for multi-turn agent conversations). ' +
        'Pass the conversation_id from a prior start_session response.',
    ),
  simulation_run_input: SimulationRunInputSchema.optional().describe(
    'Pins this run’s simulated worlds. Set by YOU, never by the agent being run — a subject that could choose its own persona, seed or model would be choosing the environment it is measured in. Use it to replay one scenario as different callers, against a fixed world, or through different models.',
  ),
});

export function registerRunFlowTool(
  server: McpServer,
  sessionRunner: SessionRunner,
  authManager: AuthManager,
  spaceGate: SpaceGate,
  getSession: SessionResolver,
  payloadMode: 'eager' | 'lazy' | 'auto' = 'eager',
): void {
  server.registerTool(
    'start_session',
    {
      title: 'start_session',
      description:
        'Start an agent session (multi-step, agent loops, etc.) or resume a paused conversation. ' +
        'Use agent_id for existing agents, agent_config for inline/ad-hoc definitions, or ' +
        'conversation_id to resume a paused session. Returns the execution trace with step details. ' +
        'For single operations, prefer run_operation instead.',
      // DO NOT use full schema: MCP SDK Zod v3/v4 compat → TS2589 + OOM. Use .shape as any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      inputSchema: StartSessionInputSchema.shape as any,
    },
    async (args: Record<string, unknown>) => {
      const session = getSession();

      try {
        if (!authManager.isAuthenticated(session)) {
          return errorResponse('AUTH_REQUIRED', 'Not authenticated.', CREDENTIAL_GUIDANCE);
        }

        const input = StartSessionInputSchema.parse(args);
        const isResume = !!input.conversation_id;
        const isInline = !!input.agent_config;

        if (!isResume && !input.system_role && !input.agent_slug && !input.agent_config) {
          return errorResponse(
            'INVALID_INPUT',
            'One of system_role, agent_slug, agent_config, or conversation_id is required.',
            'Use system_role for platform agents, agent_slug for custom agents, agent_config for inline definitions, or conversation_id to resume.',
          );
        }

        let spaceId: string | undefined;
        if (!isResume) {
          try {
            spaceId = spaceGate.resolve(input.space_id);
          } catch (err) {
            if (err instanceof SpaceRequiredError) {
              return errorResponse(err.code, err.message, err.hint);
            }
            throw err;
          }
        } else {
          spaceId = spaceGate.resolve(input.space_id);
        }

        log('info', 'tool_call', {
          tool: 'start_session',
          session: session.id,
          space_id: spaceId,
          system_role: input.system_role,
          agent_slug: input.agent_slug,
          is_inline: isInline,
          is_resume: isResume,
        });

        const startTime = Date.now();
        const timeoutMs = (input.timeout_seconds ?? 120) * 1000;

        // Build standard envelope { input: <value>, config?: {...} } for the coercion pipeline.
        const envelope: Record<string, unknown> = {};
        if (input.input !== undefined) {
          envelope['input'] = input.input;
        }
        if (input.config && Object.keys(input.config).length > 0) {
          envelope['config'] = input.config;
        }
        const mergedInput = Object.keys(envelope).length > 0 ? envelope : undefined;

        const result = await sessionRunner.run(session, {
          ...(input.simulation_run_input ? { simulationRunInput: input.simulation_run_input } : {}),
          spaceId,
          ...(input.system_role
            ? { systemRole: input.system_role }
            : input.agent_slug
              ? { agentSlug: input.agent_slug }
              : {}),
          agentConfig: input.agent_config as Record<string, unknown> | undefined,
          conversationId: input.conversation_id,
          input: mergedInput,
          timeoutMs,
          mode: 'mcp',
          resolvePayloads: payloadMode === 'eager' ? 'eager' : 'lazy',
        });

        const durationMs = Date.now() - startTime;

        log('info', 'tool_complete', {
          tool: 'start_session',
          session: session.id,
          session_id: result.sessionId,
          status: result.status,
          duration_ms: durationMs,
          step_count: result.steps?.length ?? 0,
        });

        const response: Record<string, unknown> = {
          session_id: result.sessionId,
          status: result.status,
          conversation_id: result.conversationId,
          total_duration_ms: durationMs,
        };

        if (result.output !== undefined) response['output'] = result.output;
        if (result.error) response['error'] = result.error;
        if (result.failure) response['failure'] = result.failure;
        if (result.steps) response['steps'] = result.steps;
        if (result.tokenUsage) response['token_usage'] = result.tokenUsage;
        if (result.timedOutWaiting) response['timed_out_waiting'] = true;
        if (result.continuation) response['continuation'] = result.continuation;
        if (result.note) response['note'] = result.note;

        if (result.requiredInput) {
          response['required_input'] = {
            step_execution_id: result.requiredInput.stepExecutionId,
            prompt: result.requiredInput.prompt,
            ...(result.requiredInput.inputSchema
              ? { input_schema: result.requiredInput.inputSchema }
              : {}),
            ...(result.requiredInput.responseOptions
              ? { response_options: result.requiredInput.responseOptions }
              : {}),
          };
        }

        if (result.status === 'PAUSED') {
          const respOpts = result.requiredInput?.responseOptions;
          let hint = 'Session is paused and awaiting input.';
          if (respOpts) {
            const labels = respOpts.options.map((o) => o.label ?? o.value);
            hint += ` Choose from: ${labels.join(', ')}. Or provide free-text.`;
          }
          hint += ` To continue the conversation, call start_session with conversation_id: "${result.conversationId}" and provide input.prompt with your response. You must also include space_id.`;
          return successResponse(response, hint);
        }

        return successResponse(response);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'tool_error', { tool: 'start_session', session: session.id, error: message });
        return errorResponse('SESSION_FAILED', message);
      }
    },
  );
}
