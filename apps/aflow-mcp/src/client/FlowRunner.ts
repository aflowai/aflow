/**
 * SessionRunner — executes agents via the Platform API.
 *
 * Supports three modes:
 * 1. Operation mode: run a single operation through the mcp-runner system agent
 * 2. Agent mode: start/resume named agents by agentId
 * 3. Inline mode: run an ad-hoc agent from an inline definition (agentConfig)
 *
 * All modes poll for completion and optionally fetch the /debug endpoint
 * for a full step execution trace.
 */

import type { ApiClient } from './ApiClient.js';
import type { Session } from '../auth/SessionStore.js';
import { resolvePayloadRef, type PayloadResolveMode } from './payloads.js';
import { resolveSessionFailure, type SessionFailure } from './sessionFailure.js';
import {
  buildStepSummaries,
  type SessionDebugResponse,
  type SessionRunStatusView as RunStatus,
  type StepSummary,
} from './sessionViews.js';
import { MAX_WATCH_TIMEOUT_SECONDS, type ToolContinuation } from './Watcher.js';
import { log } from '../util/logger.js';

// ---------------------------------------------------------------------------
// Public request/result types
// ---------------------------------------------------------------------------

/** Start a new session — one of systemRole, agentSlug, agentConfig, or operationId required. */
export interface SessionRunRequest {
  spaceId: string;
  systemRole?: string | undefined;
  agentSlug?: string | undefined;
  /** Run an inline (ad-hoc) agent definition — not persisted. */
  agentConfig?: Record<string, unknown> | undefined;
  /** Shorthand: run a single operation via the mcp-runner system agent. */
  operationId?: string | undefined;
  /** Operation-specific input (merged into agent input). */
  input?: Record<string, unknown> | undefined;
  /** Resume a paused session instead of starting a new one. */
  conversationId?: string | undefined;
  /** Max wait time in ms (default 120 000). */
  timeoutMs?: number | undefined;
  /** Run mode sent to the API (default "mcp"). */
  mode?: 'chat' | 'api' | 'mcp' | undefined;
  /**
   * What this run pins its simulated worlds to — persona, baseline, seed,
   * caller disclosure and generation model, each keyed by simulation.
   *
   * Set by the CALLER, never by the agent under test: a subject choosing its
   * own persona or model is choosing the environment it is measured in.
   */
  simulationRunInput?: Record<string, unknown> | undefined;
  /**
   * How to handle non-inline payload refs in outputs and errors.
   * - "eager": resolve via API, return actual data (default for run_operation/catalog)
   * - "lazy": return ref handles, agent fetches on demand via fetch_payload
   */
  resolvePayloads?: PayloadResolveMode | undefined;
}

export interface SessionRunResult {
  sessionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PAUSED' | 'RUNNING';
  output?: unknown;
  error?: string | undefined;
  /** Why it failed, read from the stored error, when the session ended FAILED. */
  failure?: SessionFailure | undefined;
  durationMs: number;
  steps?: StepSummary[] | undefined;
  /** If PAUSED — info needed to resume. */
  requiredInput?:
    | {
        stepExecutionId: string;
        prompt?: string | undefined;
        inputSchema?: Record<string, unknown> | undefined;
        responseOptions?: {
          type: string;
          options: Array<{ value: string; label?: string }>;
        };
      }
    | undefined;
  conversationId: string;
  tokenUsage?: { prompt: number; completion: number; total: number } | undefined;
  /** Set when the wait deadline elapsed before the run reached a terminal state: the run is still going server-side, NOT failed. */
  timedOutWaiting?: boolean | undefined;
  /** Machine-actionable next call (watch_session / watch_run) when timedOutWaiting. */
  continuation?: ToolContinuation | undefined;
  /** Human-readable guidance (e.g. how to continue when timedOutWaiting). */
  note?: string | undefined;
}

// ---------------------------------------------------------------------------
// Internal API response shapes
// ---------------------------------------------------------------------------

interface StartSessionResponse {
  sessionId: string;
  status: string;
  eventsUrl: string;
  outputRef?: string;
  error?: { code: string; message: string };
}

type SessionDebugView = SessionDebugResponse & {
  runtimeState?:
    | {
        variables?: Record<string, { ref?: string; summary?: string }> | undefined;
      }
    | undefined;
  tokenUsage?: { prompt: number; completion: number; total: number } | undefined;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MCP_RUNNER_FLOW_ID = 'mcp-runner';

// ---------------------------------------------------------------------------
// SessionRunner
// ---------------------------------------------------------------------------

export class SessionRunner {
  constructor(private readonly client: ApiClient) {}

  /**
   * Execute an agent session and wait for a terminal state.
   * Returns a structured result with optional step trace.
   */
  async run(session: Session, request: SessionRunRequest): Promise<SessionRunResult> {
    const startTime = Date.now();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sq = `spaceId=${encodeURIComponent(request.spaceId)}`;

    let runId: string;
    let isResume = false;

    if (request.conversationId) {
      runId = await this.resumeSession(session, request, sq);
      isResume = true;
    } else {
      runId = await this.startSession(session, request, sq);
    }

    log('info', 'session_started', {
      sessionId: runId,
      systemRole: request.systemRole,
      agentSlug: request.agentSlug,
      operationId: request.operationId,
    });

    const resolveMode = request.resolvePayloads ?? 'eager';
    const result = await this.waitForResult(
      session,
      runId,
      request.spaceId,
      timeoutMs,
      isResume,
      resolveMode,
    );
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ---- Start / Resume ----------------------------------------------------

  private async startSession(
    session: Session,
    request: SessionRunRequest,
    sq: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      mode: request.mode ?? 'mcp',
    };
    if (request.simulationRunInput) body['simulationRunInput'] = request.simulationRunInput;

    if (request.operationId) {
      // MCP_RUNNER_FLOW_ID is the platform-role systemRole for the mcp-runner.
      body['target'] = { kind: 'platform-role', systemRole: MCP_RUNNER_FLOW_ID };
      body['input'] = {
        input: {},
        config: {
          operationId: request.operationId,
          inputs: request.input ?? {},
        },
      };
    } else if (request.agentConfig) {
      body['agentConfig'] = request.agentConfig;
      if (request.input) body['input'] = request.input;
    } else if (request.systemRole) {
      body['target'] = { kind: 'platform-role', systemRole: request.systemRole };
      if (request.input) body['input'] = request.input;
    } else if (request.agentSlug) {
      body['targetRef'] = { agentSlug: request.agentSlug };
      if (request.input) body['input'] = request.input;
    } else {
      throw new Error('One of systemRole, agentSlug, agentConfig, or operationId is required');
    }

    const result = await this.client.post<StartSessionResponse>(
      session,
      `/v1/sessions?${sq}`,
      body,
    );

    if (result.error) {
      throw new Error(result.error.message);
    }

    return result.sessionId;
  }

  private async resumeSession(
    session: Session,
    request: SessionRunRequest,
    sq: string,
  ): Promise<string> {
    const convId = request.conversationId!;
    const run = await this.client.get<RunStatus>(session, `/v1/sessions/${convId}?${sq}`);

    if (run.status !== 'PAUSED' || !run.requiredInput) {
      throw new Error(
        `Cannot resume: session is in status ${run.status}, expected PAUSED. If you just sent a ` +
          `approve/resume, it most likely already landed (the session advanced past the pause) — ` +
          `this is not your action failing. Check the session with inspect_session before retrying.`,
      );
    }

    const rawInput = request.input ?? {};
    const resumeInput = this.mapResumeInput(rawInput, run.requiredInput.missingVariables);

    await this.client.post(session, `/v1/sessions/${convId}/resume?${sq}`, {
      stepExecutionId: run.requiredInput.stepExecutionId,
      input: resumeInput,
    });

    return convId;
  }

  /**
   * Map MCP-friendly input fields to the orchestrator's expected variable IDs.
   *
   * When an agent session pauses for chat input, the missingVariables contain
   * entries like `ai.agent.chatInput.ai-1`. The MCP user sends `{ prompt: "..." }`.
   * This bridges the two by detecting chatInput variables and mapping `prompt` to them.
   */
  private mapResumeInput(
    input: Record<string, unknown>,
    missingVariables?: Array<{ variableId: string; name?: string; description?: string }>,
  ): Record<string, unknown> {
    if (!missingVariables || missingVariables.length === 0) {
      return input;
    }

    const chatInputVar = missingVariables.find((v) =>
      v.variableId.startsWith('ai.agent.chatInput.'),
    );

    if (chatInputVar && 'prompt' in input && !(chatInputVar.variableId in input)) {
      const mapped: Record<string, unknown> = { ...input };
      mapped[chatInputVar.variableId] = mapped['prompt'];
      delete mapped['prompt'];
      return mapped;
    }

    return input;
  }

  // ---- Poll for result ---------------------------------------------------

  private async waitForResult(
    session: Session,
    runId: string,
    spaceId: string,
    timeoutMs: number,
    afterResume = false,
    resolveMode: PayloadResolveMode = 'eager',
  ): Promise<SessionRunResult> {
    const deadline = Date.now() + timeoutMs;
    const sq = `spaceId=${encodeURIComponent(spaceId)}`;

    // After resume, the session is still PAUSED in Redis until the orchestrator
    // processes the control message. We must wait for the status to leave PAUSED
    // (→ RUNNING) before treating a subsequent PAUSED as a new terminal state.
    let seenNonPaused = !afterResume;
    let lastRun: RunStatus | undefined;

    while (Date.now() < deadline) {
      try {
        const run = await this.client.get<RunStatus>(session, `/v1/sessions/${runId}?${sq}`);
        lastRun = run;
        const upper = run.status.toUpperCase();

        // WAITING_ON_CHILD is the first-class status; a PAUSED session that is
        // blocked on a workflow run or child session is also still "running" a
        const isSubflowWaiting =
          upper === 'WAITING_ON_CHILD' ||
          (upper === 'PAUSED' &&
            (run.blockedOn?.kind === 'workflow_run' || run.blockedOn?.kind === 'child_session'));

        if (upper !== 'PAUSED' || isSubflowWaiting) {
          seenNonPaused = true;
        }

        const isHardTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(upper);
        const isNewPause = upper === 'PAUSED' && seenNonPaused && !isSubflowWaiting;

        if (isHardTerminal || isNewPause) {
          log('info', 'session_complete', { sessionId: runId, status: run.status });
          return await this.buildResult(session, runId, run, spaceId, resolveMode);
        }

        await this.sleep(afterResume && !seenNonPaused ? 500 : 2000);
      } catch (err) {
        log('warn', 'session_poll_error', { sessionId: runId, error: String(err) });
        await this.sleep(3000);
      }
    }

    log('warn', 'session_timeout', { sessionId: runId });
    const waitSeconds = Math.round(timeoutMs / 1000);
    const watchTimeoutSeconds = Math.min(Math.max(waitSeconds, 1), MAX_WATCH_TIMEOUT_SECONDS);
    const continuation: ToolContinuation =
      lastRun?.blockedOn?.kind === 'workflow_run'
        ? {
            tool: 'watch_run',
            args: {
              run_id: lastRun.blockedOn.runId,
              space_id: spaceId,
              until: 'pause',
              timeout_seconds: watchTimeoutSeconds,
            },
          }
        : {
            tool: 'watch_session',
            args: {
              session_id: runId,
              space_id: spaceId,
              until: 'terminal',
              timeout_seconds: watchTimeoutSeconds,
            },
          };
    return {
      sessionId: runId,
      status: 'RUNNING',
      durationMs: timeoutMs,
      conversationId: runId,
      timedOutWaiting: true,
      continuation,
      note:
        `Still running after the ${String(waitSeconds)}s wait — this did NOT fail; the run continues server-side. ` +
        `Call the \`continuation\` tool with its args verbatim to keep following, or check progress now with ` +
        `inspect_session (session_id "${runId}", same space_id).`,
    };
  }

  // ---- Build result with optional debug trace ----------------------------

  private async buildResult(
    session: Session,
    runId: string,
    run: RunStatus,
    spaceId: string,
    resolveMode: PayloadResolveMode = 'eager',
  ): Promise<SessionRunResult> {
    const status = run.status.toUpperCase() as SessionRunResult['status'];
    const sq = `spaceId=${encodeURIComponent(spaceId)}`;

    const result: SessionRunResult = {
      sessionId: runId,
      status,
      conversationId: runId,
      durationMs: 0,
    };

    if (status === 'PAUSED' && run.requiredInput) {
      const mv = run.requiredInput.missingVariables?.[0];
      const respOpts = mv?.responseOptions;
      result.requiredInput = {
        stepExecutionId: run.requiredInput.stepExecutionId,
        prompt: run.requiredInput.prompt,
        ...(respOpts ? { responseOptions: respOpts } : {}),
      };
    }

    // Resolve output from the session's outputRef
    if (run.outputRef) {
      result.output = await resolvePayloadRef(
        this.client,
        session,
        run.outputRef,
        spaceId,
        resolveMode,
      );
    }

    // Fetch debug view for step traces and the failure
    let debugAgentId: string | undefined;
    let debug: SessionDebugView | undefined;
    try {
      debug = await this.client.get<SessionDebugView>(session, `/v1/sessions/${runId}/debug?${sq}`);
      const target = debug.session.target;
      if (target?.kind === 'platform-role') debugAgentId = target.systemRole;
      else if (target?.kind === 'custom-agent') debugAgentId = target.agentId;

      result.tokenUsage = debug.tokenUsage;

      // If we didn't get output from session status, try the debug view
      if (result.output === undefined && debug.session.outputRef) {
        result.output = await resolvePayloadRef(
          this.client,
          session,
          debug.session.outputRef,
          spaceId,
          resolveMode,
        );
      }

      // Extract output from runtimeState.variables.result if still missing
      if (result.output === undefined && debug.runtimeState?.variables) {
        const resultVar = debug.runtimeState.variables['result'];
        if (resultVar?.ref) {
          result.output = await resolvePayloadRef(
            this.client,
            session,
            resultVar.ref,
            spaceId,
            resolveMode,
          );
        }
      }

      const steps = buildStepSummaries(debug);
      if (steps.length > 0) result.steps = steps;
    } catch (err) {
      log('debug', 'session_debug_fetch_failed', { sessionId: runId, error: String(err) });
    }

    if (status === 'FAILED') {
      result.failure = await resolveSessionFailure(
        this.client,
        session,
        spaceId,
        debug ?? {
          session: {
            sessionId: runId,
            status,
            ...(run.errorRef !== undefined ? { errorRef: run.errorRef } : {}),
          },
        },
      );
      result.error = result.failure.message;
    }

    // Enrich failed sessions with expected agent input variables when failure was quick
    // (suggests a startup/input validation error rather than a mid-session failure)
    if (status === 'FAILED' && result.error && result.durationMs < 5000 && debugAgentId) {
      const hint = await this.fetchAgentInputHint(session, debugAgentId, sq);
      if (hint) {
        result.error = `${result.error}\n\nExpected input variables: ${hint}`;
      }
    }

    return result;
  }

  /**
   * Resolve a payload ref via the API. Used by the fetch_payload MCP tool.
   */
  async fetchPayload(session: Session, ref: string, spaceId: string): Promise<unknown> {
    return resolvePayloadRef(this.client, session, ref, spaceId, 'eager');
  }

  // ---- Agent input discovery -----------------------------------------------

  /**
   * Fetch an agent's input variable names to help agents self-correct on missing input.
   * Returns a formatted string like `prompt (string), context (string)` or null.
   */
  private async fetchAgentInputHint(
    session: Session,
    agentId: string,
    sq: string,
  ): Promise<string | null> {
    try {
      const agent = await this.client.get<{
        definition?: {
          stateVariables?: Array<{
            variableId: string;
            name?: string;
            typeSchema?: { type?: string };
            lifecycle?: { isInput?: boolean };
          }>;
        };
      }>(session, `/v1/agents/${agentId}?${sq}`);

      const vars = agent.definition?.stateVariables;
      if (!vars || vars.length === 0) return null;

      const inputs = vars.filter((v) => v.lifecycle?.isInput === true);
      if (inputs.length === 0) return null;

      return inputs
        .map((v) => {
          const typePart = v.typeSchema?.type ? ` (${v.typeSchema.type})` : '';
          return `${v.variableId}${typePart}`;
        })
        .join(', ');
    } catch {
      // Agent fetch failed — don't block error reporting
      return null;
    }
  }

  // ---- Helpers -----------------------------------------------------------

  private isTerminal(status: string): boolean {
    return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED'].includes(status.toUpperCase());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
