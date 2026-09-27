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
import type { SessionRunStatusView as RunStatus } from './sessionViews.js';
import { MAX_WATCH_TIMEOUT_SECONDS, type ToolContinuation } from './Watcher.js';
import { log } from '../util/logger.js';

// ---------------------------------------------------------------------------
// Public request/result types
// ---------------------------------------------------------------------------

/** How the SessionRunner resolves non-inline payload refs in the result. */
export type PayloadResolveMode = 'eager' | 'lazy';

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

export interface StepTrace {
  step_id: string;
  step_execution_id?: string;
  operation?: string;
  name?: string;
  status: string;
  output_summary?: string | undefined;
  error?: string | undefined;
  duration_ms?: number | undefined;
}

export interface SessionRunResult {
  sessionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PAUSED' | 'RUNNING';
  output?: unknown;
  error?: string | undefined;
  durationMs: number;
  steps?: StepTrace[] | undefined;
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

interface DebugStepEntry {
  stepExecutionId?: string | undefined;
  stepId?: string | undefined;
  operation?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  error?: { message?: string } | undefined;
  output?: unknown;
  outputRef?: string | undefined;
  durationMs?: number | undefined;
  parentStepExecutionId?: string | undefined;
}

interface SessionDebugView {
  session: {
    sessionId: string;
    status: string;
    agentId?: string | undefined;
    durationMs?: number | undefined;
    outputRef?: string | undefined;
    errorRef?: string | undefined;
  };
  recentEvents?:
    | Array<{
        eventType?: string | undefined;
        data?:
          | {
              errorRef?: string | undefined;
              payloadRef?: string | undefined;
              [key: string]: unknown;
            }
          | undefined;
        metadata?: Record<string, unknown> | undefined;
      }>
    | undefined;
  currentStep?: DebugStepEntry | undefined;
  dynamicSteps?: DebugStepEntry[] | undefined;
  runtimeState?:
    | {
        variables?: Record<string, { ref?: string; summary?: string }> | undefined;
      }
    | undefined;
  tokenUsage?: { prompt: number; completion: number; total: number } | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MCP_RUNNER_FLOW_ID = 'mcp-runner';
const OUTPUT_SUMMARY_MAX = 2000;

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

    if (status === 'FAILED') {
      result.error = run.error?.message ?? run.error?.title;
      // Errors always resolve eagerly — they're small and critical
      if (!result.error && run.errorRef) {
        const decoded = await this.resolvePayloadRef(session, run.errorRef, sq, 'eager');
        if (decoded && typeof decoded === 'object') {
          const errObj = decoded as Record<string, unknown>;
          const msg = errObj['message'];
          const code = errObj['code'];
          result.error =
            (typeof msg === 'string' ? msg : undefined) ??
            (typeof code === 'string' ? code : undefined);
        }
      }
    }

    // Resolve output from the session's outputRef
    if (run.outputRef) {
      result.output = await this.resolvePayloadRef(session, run.outputRef, sq, resolveMode);
    }

    // Fetch debug view for step traces and richer error info
    let debugAgentId: string | undefined;
    try {
      const debug = await this.client.get<SessionDebugView>(
        session,
        `/v1/sessions/${runId}/debug?${sq}`,
      );
      const target = (
        debug.session as { target?: { kind: string; systemRole?: string; agentId?: string } }
      ).target;
      if (target?.kind === 'platform-role') debugAgentId = target.systemRole;
      else if (target?.kind === 'custom-agent') debugAgentId = target.agentId;

      result.tokenUsage = debug.tokenUsage;

      // If we didn't get output from session status, try the debug view
      if (result.output === undefined && debug.session.outputRef) {
        result.output = await this.resolvePayloadRef(
          session,
          debug.session.outputRef,
          sq,
          resolveMode,
        );
      }

      // Extract output from runtimeState.variables.result if still missing
      if (result.output === undefined && debug.runtimeState?.variables) {
        const resultVar = debug.runtimeState.variables['result'];
        if (resultVar?.ref) {
          result.output = await this.resolvePayloadRef(session, resultVar.ref, sq, resolveMode);
        }
      }

      // Step traces from dynamicSteps (agent.control.run_step creates dynamic steps)
      const steps = debug.dynamicSteps;
      if (steps && steps.length > 0) {
        result.steps = steps.map((s) => this.mapDebugStep(s));
      }

      // If error is still unknown, extract from failed steps in the debug trace
      if (status === 'FAILED' && !result.error && steps) {
        const failedStep = steps.find((s) => s.status === 'FAILED' || s.status === 'failed');
        if (failedStep?.error?.message) {
          result.error = failedStep.error.message;
        }
      }

      // Try currentStep errorRef
      if (status === 'FAILED' && !result.error && debug.currentStep?.error?.message) {
        result.error = debug.currentStep.error.message;
      }

      // Error refs always resolve eagerly
      if (status === 'FAILED' && !result.error && debug.recentEvents) {
        for (const evt of [...debug.recentEvents].reverse()) {
          if (evt.eventType === 'FlowRunFailed' || evt.eventType === 'StepFailed') {
            const errorRef = evt.data?.errorRef;
            if (errorRef) {
              const decoded = await this.resolvePayloadRef(session, errorRef, sq, 'eager');
              if (decoded && typeof decoded === 'object') {
                const errObj = decoded as Record<string, unknown>;
                const msg =
                  (errObj['message'] as string | undefined) ??
                  (errObj['title'] as string | undefined) ??
                  (errObj['error'] as string | undefined);
                if (msg) {
                  result.error = msg;
                  break;
                }
              }
            }
          }
        }
      }

      // Try the session's errorRef from debug view
      if (status === 'FAILED' && !result.error && debug.session.errorRef) {
        const decoded = await this.resolvePayloadRef(session, debug.session.errorRef, sq, 'eager');
        if (decoded && typeof decoded === 'object') {
          const errObj = decoded as Record<string, unknown>;
          result.error =
            (errObj['message'] as string | undefined) ?? (errObj['title'] as string | undefined);
        }
      }
    } catch (err) {
      log('debug', 'session_debug_fetch_failed', { sessionId: runId, error: String(err) });
    }

    // Final fallback
    if (status === 'FAILED' && !result.error) {
      result.error = 'Session failed — check the session detail in the web UI for diagnostics.';
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

  private mapDebugStep(s: DebugStepEntry): StepTrace {
    const trace: StepTrace = {
      step_id: s.stepId ?? 'unknown',
      status: s.status ?? 'unknown',
    };

    if (s.stepExecutionId) trace.step_execution_id = s.stepExecutionId;
    if (s.operation) trace.operation = s.operation;
    if (s.name) trace.name = s.name;
    if (s.durationMs !== undefined) trace.duration_ms = s.durationMs;

    if (s.error?.message) {
      trace.error = s.error.message;
    }

    if (s.output !== undefined) {
      trace.output_summary = this.summarize(s.output);
    }

    return trace;
  }

  // ---- Payload resolution -------------------------------------------------

  /**
   * Resolve a PayloadRef to its decoded value.
   *
   * - inline:base64 → decode locally (no API call)
   * - gs:// / redis:// in eager mode → call GET /v1/payloads?ref= to fetch
   * - gs:// / redis:// in lazy mode → return a handle object
   *
   * Errors are never resolved lazily — always eager (error messages are small
   * and critical for the agent to understand failures).
   */
  private async resolvePayloadRef(
    session: Session,
    ref: string,
    sq: string,
    mode: PayloadResolveMode,
  ): Promise<unknown> {
    if (ref.startsWith('inline:')) {
      try {
        const b64 = ref.slice(7);
        const json = Buffer.from(b64, 'base64').toString('utf-8');
        return JSON.parse(json) as unknown;
      } catch (err) {
        log('warn', 'payload_decode_error', { ref: ref.slice(0, 50), error: String(err) });
        return undefined;
      }
    }

    if (mode === 'lazy') {
      return { _ref: ref, _hint: 'Call fetch_payload with this ref to get the content.' };
    }

    try {
      const data = await this.client.get<unknown>(
        session,
        `/v1/payloads?ref=${encodeURIComponent(ref)}&${sq}`,
      );
      return data;
    } catch (err) {
      log('warn', 'payload_fetch_error', { ref: ref.slice(0, 80), error: String(err) });
      return { _ref: ref, _hint: 'Payload fetch failed. Call fetch_payload to retry.' };
    }
  }

  /**
   * Resolve a payload ref via the API. Used by the fetch_payload MCP tool.
   */
  async fetchPayload(session: Session, ref: string, spaceId: string): Promise<unknown> {
    const sq = `spaceId=${encodeURIComponent(spaceId)}`;
    return this.resolvePayloadRef(session, ref, sq, 'eager');
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

  private summarize(value: unknown): string {
    const json = JSON.stringify(value);
    if (json.length <= OUTPUT_SUMMARY_MAX) return json;
    return json.slice(0, OUTPUT_SUMMARY_MAX) + '…[truncated]';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
