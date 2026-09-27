import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env['RECOVERY_EVENTS_ENABLED'] = 'false';

const mockGetSessionState = vi.fn();
const mockGetStepState = vi.fn();
const mockAddStepResult = vi.fn();
const mockRemoveWaitingChild = vi.fn();
const mockAppendSessionEvent = vi.fn();
const mockMarkSessionDirty = vi.fn();
const mockUpdateStepState = vi.fn();
const mockUpdateSessionState = vi.fn();

const mockWaitForInput = vi.fn();
const mockReconcileParentDelegationForChild = vi.fn();

vi.mock('@aflow/redis', () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  getStepState: (...args: unknown[]) => mockGetStepState(...args),
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  removeWaitingChild: (...args: unknown[]) => mockRemoveWaitingChild(...args),
  appendSessionEvent: (...args: unknown[]) => mockAppendSessionEvent(...args),
  markSessionDirty: (...args: unknown[]) => mockMarkSessionDirty(...args),
  updateStepState: (...args: unknown[]) => mockUpdateStepState(...args),
  updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  upsertPendingDelegationCompletion: vi.fn().mockResolvedValue(true),
  getSessionState_unused: vi.fn(),
}));

vi.mock('../../../StepService/index.js', () => ({
  waitForInput: (...args: unknown[]) => mockWaitForInput(...args),
}));

vi.mock('../reconcileParentDelegation.js', () => ({
  reconcileParentDelegationForChild: (...args: unknown[]) =>
    mockReconcileParentDelegationForChild(...args),
}));

vi.mock('../helpers/delegationState.js', () => ({
  leaveChildWaitToRunning: vi.fn(),
}));

const mockSurfaceWorkflowResumeContract = vi.fn();
vi.mock('@aflow/cybernetic-runtime', () => ({
  surfaceWorkflowResumeContract: (...args: unknown[]) => mockSurfaceWorkflowResumeContract(...args),
}));
vi.mock('@aflow/database', () => ({
  getDatabase: () => ({}),
}));

vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  logOrchestratorError: vi.fn(),
}));

import { bubbleChildPauseToParent } from '../bubbleChildPause.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001';

const agentDefLoader = vi.fn().mockResolvedValue({
  flowId: 'cybernetic-helmsman',
  steps: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  agentDefLoader.mockClear();
  agentDefLoader.mockResolvedValue({ flowId: 'cybernetic-helmsman', steps: [] });
});

describe('bubbleChildPauseToParent — fall-through pause cascade', () => {
  it('cascades reconcile to the grandparent after pausing an intermediate parent', async () => {
    // Runner (child) just paused via signal_blocked.
    // The intermediate parent delegated to Runner with default wait
    // (delegationWaitMode=undefined). It has a grandparent — that's the
    // level we want cascaded to.
    mockGetSessionState
      .mockResolvedValueOnce({
        // Runner
        sessionId: 'runner-1',
        parentSessionId: 'parent-1',
        parentStepExecutionId: 'parent-step-1',
        status: 'PAUSED',
        currentStepExecutionId: 'runner-step-1',
        requestedInputRef: `inline:${Buffer.from(
          JSON.stringify({ prompt: 'Need creds', missingVariables: [] }),
        ).toString('base64')}`,
      })
      .mockResolvedValueOnce({
        // Intermediate parent
        sessionId: 'parent-1',
        parentSessionId: 'helmsman-1',
        parentStepExecutionId: 'helmsman-step-1',
        agentId: 'cybernetic-runner',
        agentVersion: '1',
        traceId: 'trace-1',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['runner-1'],
        delegationPauseSource: 'child_running',
        delegationWaitMode: undefined,
      });
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'wf_task_acquire_data',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      'runner-1',
      agentDefLoader,
    );

    expect(mockWaitForInput).toHaveBeenCalledTimes(1);
    expect(mockWaitForInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'parent-1' }),
      expect.any(Array),
      expect.objectContaining({
        runStateUpdates: expect.objectContaining({ delegationPauseSource: 'child_input' }),
      }),
    );

    expect(mockReconcileParentDelegationForChild).toHaveBeenCalledTimes(1);
    expect(mockReconcileParentDelegationForChild).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        childRunId: 'parent-1',
        reason: 'bubbleChildPause:cascade',
      }),
    );
  });

  it('does not cascade when the paused parent has no parent of its own', async () => {
    // Runner → top-level parent (no Helmsman above). Cascade must not fire.
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        parentStepExecutionId: 'parent-step-1',
        status: 'PAUSED',
        currentStepExecutionId: 'child-step-1',
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-1',
        // no parentSessionId — top-level
        agentId: 'parent-agent',
        agentVersion: '1',
        traceId: 'trace-1',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['child-1'],
      });
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'delegate-step',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      'child-1',
      agentDefLoader,
    );

    expect(mockWaitForInput).toHaveBeenCalledTimes(1);
    expect(mockReconcileParentDelegationForChild).not.toHaveBeenCalled();
  });
});

describe('bubbleChildPauseToParent — until_pause structured handoff propagation (Plan 120)', () => {
  // Pins the fix for the user-observed "child pauses without bubbling
  // structure to parent" symptom. When the parent uses
  // wait='until_pause' (Helmsman's start-workflow config), the child's
  // structured handoff payload (kind, reason, missing, handoff.skillSlug,
  // etc.) MUST be forwarded to the parent in the SUCCEEDED tool result so
  // Helmsman can branch on it instead of pausing for prose.

  it('forwards full handoffPayload to the parent when child paused with a compose-skill-handoff', async () => {
    const handoffPause = {
      prompt: 'compose-skill cannot proceed — missing capabilities:\n- Bindable: api:kaggle-api',
      blockingReason: 'compose-skill cannot proceed',
      blockingCategory: 'capability_unavailable',
      kind: 'compose-skill-handoff',
      status: 'blocked',
      reason: 'needs_binding',
      missing: [{ kind: 'api', identifier: 'kaggle-api' }],
      handoff: {
        skillSlug: 'bind-capability',
        prefill: { apiNames: ['kaggle-api'], integrations: [] },
      },
    };

    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-1',
        parentSessionId: 'helmsman-1',
        parentStepExecutionId: 'helmsman-step-1',
        status: 'PAUSED',
        currentStepExecutionId: 'child-step-1',
        spaceId: 'space-1',
        requestedInputRef: `inline:${Buffer.from(JSON.stringify(handoffPause)).toString('base64')}`,
      })
      .mockResolvedValueOnce({
        sessionId: 'helmsman-1',
        agentId: 'cybernetic-helmsman',
        agentVersion: '1',
        traceId: 'trace-1',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['child-1'],
        delegationWaitMode: 'until_pause', // ← key: Helmsman's start-workflow mode
      });
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'start-workflow',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
      inputRef: 'inline:original-input',
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      'child-1',
      agentDefLoader,
    );

    // The until_pause path emits a SUCCEEDED step result on the parent.
    // Decode the outputRef and assert the structured handoff is preserved.
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const callArgs = mockAddStepResult.mock.calls[0]![1] as {
      status: string;
      outputRef: string;
      sessionId: string;
    };
    expect(callArgs.status).toBe('SUCCEEDED');
    expect(callArgs.sessionId).toBe('helmsman-1');

    const decoded = JSON.parse(
      Buffer.from(callArgs.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;

    // Must include the structured handoff so Helmsman can branch on
    // handoff.skillSlug without parsing prose.
    expect(decoded['childSessionId']).toBe('child-1');
    expect(decoded['status']).toBe('PAUSED');
    expect(decoded['pausePrompt']).toContain('compose-skill cannot proceed');
    const hp = decoded['handoffPayload'] as Record<string, unknown>;
    expect(hp).toBeDefined();
    expect(hp['kind']).toBe('compose-skill-handoff');
    expect(hp['reason']).toBe('needs_binding');
    expect(hp['missing']).toEqual([{ kind: 'api', identifier: 'kaggle-api' }]);
    const handoff = hp['handoff'] as Record<string, unknown>;
    expect(handoff['skillSlug']).toBe('bind-capability');

    // Guidance message should reference the target skill explicitly.
    expect(decoded['message']).toContain('bind-capability');
    expect(decoded['message']).toContain('agent.control.resume');
  });

  it('falls back to generic guidance when the child pause has no handoff (legacy plain pause)', async () => {
    const plainPause = { prompt: 'Need user input for X' };

    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: 'child-1',
        parentSessionId: 'parent-1',
        parentStepExecutionId: 'parent-step-1',
        status: 'PAUSED',
        currentStepExecutionId: 'child-step-1',
        requestedInputRef: `inline:${Buffer.from(JSON.stringify(plainPause)).toString('base64')}`,
      })
      .mockResolvedValueOnce({
        sessionId: 'parent-1',
        agentId: 'agent-1',
        agentVersion: '1',
        traceId: 'trace-1',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: ['child-1'],
        delegationWaitMode: 'until_pause',
      });
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'delegate-step',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
      inputRef: 'inline:input',
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      'child-1',
      agentDefLoader,
    );

    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const callArgs = mockAddStepResult.mock.calls[0]![1] as { outputRef: string };
    const decoded = JSON.parse(
      Buffer.from(callArgs.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;

    expect(decoded['handoffPayload']).toBeUndefined();
    expect(decoded['message']).toContain('You can resume with agent.control.resume');
  });
});

// ============================================================================

describe('bubbleChildPauseToParent — Plan 149 §3.1 mode-aware fill hint', () => {
  const PARENT_RUN = '55555555-5555-4555-9555-555555555555';
  const CHILD_RUN = '66666666-6666-4666-9666-666666666666';
  const PARENT_STEP_EXEC = '77777777-7777-4777-9777-777777777777';
  const CHILD_STEP_EXEC = '88888888-8888-4888-9888-888888888888';

  function setupChildPaused(opts: { contract: Record<string, unknown> }) {
    mockSurfaceWorkflowResumeContract.mockResolvedValue({
      contract: opts.contract,
      pauseVersion: 1,
      pausedReason: opts.contract['pauseCause'] as string,
      resumeAttemptCount: 0,
    });
    mockGetSessionState
      .mockResolvedValueOnce({
        sessionId: CHILD_RUN,
        parentSessionId: PARENT_RUN,
        parentStepExecutionId: PARENT_STEP_EXEC,
        status: 'PAUSED',
        currentStepExecutionId: CHILD_STEP_EXEC,
        spaceId: 'space-1',
        // Critical: workflowExecution must be set or the surface call is
        // skipped (see bubble line ~290).
        workflowExecution: { runId: CHILD_RUN, taskId: 'task-a', attempt: 1 },
        requestedInputRef: `inline:${Buffer.from(
          JSON.stringify({
            payloadKind: 'subagent_handoff',
            handoffSource: 'runner-signal-blocked',
            prompt: 'inputs missing',
            blockingCategory: 'missing_input',
          }),
        ).toString('base64')}`,
      })
      .mockResolvedValueOnce({
        sessionId: PARENT_RUN,
        agentId: 'cybernetic-helmsman',
        agentVersion: '1',
        traceId: 'trace-1',
        status: 'WAITING_ON_CHILD',
        waitingForChildSessionIds: [CHILD_RUN],
        delegationWaitMode: 'until_pause',
      });
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'start-workflow',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
      inputRef: 'inline:input',
    });
  }

  it('provide_input mode → tells the parent to fill args.resolution.inputs, NOT .output', async () => {
    setupChildPaused({
      contract: {
        pauseCause: 'subagent_handoff',
        resumePrompt: 'Need vendor + apiId',
        allowedResumeModes: ['provide_input'],
        pausedTaskInputContract: {
          schema: { type: 'object', properties: { vendor: { type: 'string' } } },
          resolutionMode: 'provide_input',
        },
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: CHILD_RUN,
            resolution: { mode: 'provide_input', taskId: 'task-a', inputs: {} },
          },
        },
      },
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );

    const callArgs = mockAddStepResult.mock.calls[0]![1] as { outputRef: string };
    const decoded = JSON.parse(
      Buffer.from(callArgs.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const message = decoded['message'] as string;
    expect(message).toContain('args.resolution.inputs');
    expect(message).toContain('pausedTaskInputContract.schema');
    expect(message).not.toContain('args.resolution.output');
  });

  it('re_execute mode → tells the parent about instructions and remediationConfirmed', async () => {
    setupChildPaused({
      contract: {
        pauseCause: 'subagent_handoff',
        resumePrompt: 'External dependency timeout',
        allowedResumeModes: ['re_execute', 'fail'],
        pausedTaskInputContract: {
          schema: { type: 'object', required: ['remediationConfirmed'] },
          resolutionMode: 're_execute',
        },
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: CHILD_RUN,
            resolution: { mode: 're_execute' },
          },
        },
      },
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );

    const callArgs = mockAddStepResult.mock.calls[0]![1] as { outputRef: string };
    const decoded = JSON.parse(
      Buffer.from(callArgs.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const message = decoded['message'] as string;
    expect(message).toContain('remediationConfirmed');
    expect(message).toContain('PRIOR FAILURE GUIDANCE');
    expect(message).not.toContain('args.resolution.output');
  });

  it('replace_output mode → tells the parent to fill args.resolution.output', async () => {
    setupChildPaused({
      contract: {
        pauseCause: 'task_contract_violation',
        resumePrompt: 'score out of range',
        allowedResumeModes: ['replace_output'],
        replaceOutputSchema: {
          type: 'object',
          properties: { score: { type: 'number' } },
        },
        suggestedResumeCall: {
          op: 'workflow.run.resume',
          args: {
            runId: CHILD_RUN,
            resolution: { mode: 'replace_output', output: {} },
          },
        },
      },
    });

    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );

    const callArgs = mockAddStepResult.mock.calls[0]![1] as { outputRef: string };
    const decoded = JSON.parse(
      Buffer.from(callArgs.outputRef.slice('inline:'.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const message = decoded['message'] as string;
    expect(message).toContain('args.resolution.output');
    expect(message).not.toContain('args.resolution.inputs');
  });
});

// ============================================================================

describe('bubbleChildPauseToParent — Plan 120 robustness branch table', () => {
  const PARENT_RUN = '11111111-1111-4111-9111-111111111111';
  const CHILD_RUN = '22222222-2222-4222-9222-222222222222';
  const PARENT_STEP_EXEC = '33333333-3333-4333-9333-333333333333';
  const CHILD_STEP_EXEC = '44444444-4444-4444-9444-444444444444';

  function inlineRef(payload: unknown): string {
    return `inline:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  }

  function strictHandoffRef(extra: Record<string, unknown> = {}): string {
    return inlineRef({
      payloadKind: 'subagent_handoff',
      handoffSource: 'compose-skill-handoff',
      prompt: 'compose-skill cannot proceed — missing capabilities: api:kaggle-api',
      blockingCategory: 'capability_unavailable',
      kind: 'compose-skill-handoff',
      status: 'blocked',
      reason: 'needs_binding',
      handoff: { skillSlug: 'bind-capability', prefill: { apiNames: ['kaggle-api'] } },
      ...extra,
    });
  }

  function plainUserInputRef(): string {
    return inlineRef({
      reason: 'input_required',
      stepId: 'ask-user',
      prompt: 'What metric should I optimize for?',
      missingVariables: [{ variableId: 'metric', name: 'Metric', required: true }],
    });
  }

  function childStateBase(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: CHILD_RUN,
      parentSessionId: PARENT_RUN,
      parentStepExecutionId: PARENT_STEP_EXEC,
      status: 'PAUSED' as const,
      currentStepExecutionId: CHILD_STEP_EXEC,
      ...overrides,
    };
  }

  function parentStateBase(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: PARENT_RUN,
      agentId: 'helmsman',
      agentVersion: '1',
      traceId: 'trace-1',
      status: 'WAITING_ON_CHILD' as const,
      waitingForChildSessionIds: [CHILD_RUN],
      delegationPauseSource: 'child_running' as const,
      ...overrides,
    };
  }

  function setupParent(
    childRequestedInputRef: string | undefined,
    parentWaitMode: 'until_pause' | 'true' | 'false' | undefined,
  ) {
    mockGetSessionState
      .mockResolvedValueOnce(childStateBase({ requestedInputRef: childRequestedInputRef }))
      .mockResolvedValueOnce(parentStateBase({ delegationWaitMode: parentWaitMode }));
    mockGetStepState.mockResolvedValueOnce({
      stepId: 'delegate-step',
      stepType: 'agent',
      operationId: 'agent.control.delegate',
      attempt: 1,
      inputRef: 'inline:input',
    });
  }

  // ── handoff × waitMode ──────────────────────────────────────────────────

  it('handoff + waitMode=until_pause → typed tool result (Path A)', async () => {
    setupParent(strictHandoffRef(), 'until_pause');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    expect(mockWaitForInput).not.toHaveBeenCalled();
    const decoded = JSON.parse(
      Buffer.from(
        (mockAddStepResult.mock.calls[0]![1] as { outputRef: string }).outputRef.slice(
          'inline:'.length,
        ),
        'base64',
      ).toString('utf8'),
    ) as { handoffPayload: { handoff: { skillSlug: string }; status: string } };
    expect(decoded.handoffPayload.handoff.skillSlug).toBe('bind-capability');
    expect(decoded.handoffPayload.status).toBe('blocked');
  });

  it('handoff + waitMode=true → typed tool result (Path A wins over wait mode)', async () => {
    // The exact bug observed during compose-skill live testing — LLM passed
    // wait=true on agent.control.resume. Pre-fix this fell to Path B with
    // an empty Helmsman pause. Now a structurally-validated handoff always
    // returns to the parent agent regardless of the wait mode.
    setupParent(strictHandoffRef(), 'true');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('handoff + waitMode=undefined → typed tool result + anomaly logged', async () => {
    // Defensive: even after the robustness pass writes delegationWaitMode
    // verbatim from enterChildWait, future regressions should be visible.
    // The bubble logs a structured anomaly when it sees a handoff with no
    // wait mode — easy to grep during debugging.
    const warnSpy = vi.fn();
    const realLogger = await import('../../../../lib/orchestratorLogger.js');
    const original = realLogger.getOrchestratorLogger;
    (realLogger as { getOrchestratorLogger: typeof original }).getOrchestratorLogger = () =>
      ({
        info: vi.fn(),
        warn: warnSpy,
        error: vi.fn(),
        debug: vi.fn(),
        child: () => ({
          info: vi.fn(),
          warn: warnSpy,
          error: vi.fn(),
          debug: vi.fn(),
        }),
      }) as never;
    try {
      setupParent(strictHandoffRef(), undefined);
      await bubbleChildPauseToParent(
        {} as never,
        { retrieve: vi.fn() } as never,
        TENANT,
        CHILD_RUN,
        agentDefLoader,
      );
      expect(mockAddStepResult).toHaveBeenCalledTimes(1);
      expect(mockWaitForInput).not.toHaveBeenCalled();
      // Anomaly log line names the kind so it's greppable.
      const matched = warnSpy.mock.calls.some(
        (call: unknown[]) =>
          typeof call[0] === 'string' &&
          (call[0] as string).includes('missing-wait-mode-on-handoff'),
      );
      expect(matched).toBe(true);
    } finally {
      (realLogger as { getOrchestratorLogger: typeof original }).getOrchestratorLogger = original;
    }
  });

  // ── plain user-input × waitMode ─────────────────────────────────────────

  it('user-input + waitMode=until_pause → typed tool result (Path A; existing Plan 95 behavior)', async () => {
    setupParent(plainUserInputRef(), 'until_pause');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('user-input + waitMode=true → waitForInput-on-parent (Path B; plain user-input bubble)', async () => {
    setupParent(plainUserInputRef(), 'true');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockWaitForInput).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('user-input + waitMode=undefined → waitForInput-on-parent (Path B; legacy default for non-handoff)', async () => {
    setupParent(plainUserInputRef(), undefined);
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockWaitForInput).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  // ── strict-validation edge cases ────────────────────────────────────────

  it('rejects a payload with payloadKind=subagent_handoff but missing prompt', async () => {
    // Discriminator present but schema demands a non-empty prompt. The
    // legacy duck-type path takes over (since isSubagentHandoffPayload is
    // false) — and because the parent has waitMode=until_pause, Path A
    // still fires with the fallback "Sub-agent needs input" prompt.
    const malformed = inlineRef({
      payloadKind: 'subagent_handoff',
      handoffSource: 'broken',
      // prompt missing → schema rejects → not a handoff
    });
    setupParent(malformed, 'until_pause');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const decoded = JSON.parse(
      Buffer.from(
        (mockAddStepResult.mock.calls[0]![1] as { outputRef: string }).outputRef.slice(
          'inline:'.length,
        ),
        'base64',
      ).toString('utf8'),
    ) as { pausePrompt: string };
    expect(decoded.pausePrompt).toBe('Sub-agent needs input');
  });

  it('rejects a payload with wrong payloadKind value (not the literal)', async () => {
    // Schema's z.literal rejects anything that's not exactly 'subagent_handoff'.
    // Falls through to the legacy duck-typed path.
    const wrongKind = inlineRef({
      payloadKind: 'agent_handoff', // not the literal we expect
      prompt: 'whatever',
      handoffSource: 'something',
    });
    setupParent(wrongKind, 'true');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    // Not a handoff and wait=true → Path B (waitForInput on parent).
    expect(mockWaitForInput).toHaveBeenCalledTimes(1);
    expect(mockAddStepResult).not.toHaveBeenCalled();
  });

  it('preserves source-specific extras via passthrough (e.g. compose-skill missing[])', async () => {
    setupParent(
      strictHandoffRef({
        missing: [{ kind: 'api', identifier: 'kaggle-api', definitionExists: false }],
      }),
      'until_pause',
    );
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    const decoded = JSON.parse(
      Buffer.from(
        (mockAddStepResult.mock.calls[0]![1] as { outputRef: string }).outputRef.slice(
          'inline:'.length,
        ),
        'base64',
      ).toString('utf8'),
    ) as { handoffPayload: { missing: Array<{ identifier: string }> } };
    expect(decoded.handoffPayload.missing[0]?.identifier).toBe('kaggle-api');
  });

  it('handles missing requestedInputRef gracefully (no parsed payload, falls through cleanly)', async () => {
    setupParent(undefined, 'until_pause');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
    const decoded = JSON.parse(
      Buffer.from(
        (mockAddStepResult.mock.calls[0]![1] as { outputRef: string }).outputRef.slice(
          'inline:'.length,
        ),
        'base64',
      ).toString('utf8'),
    ) as { pausePrompt: string };
    expect(decoded.pausePrompt).toBe('Sub-agent needs input');
  });

  it('handles unparseable inline ref gracefully (broken base64/JSON)', async () => {
    const broken = `inline:${Buffer.from('not valid json').toString('base64')}`;
    setupParent(broken, 'until_pause');
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).toHaveBeenCalledTimes(1);
  });

  // ── skip conditions (re-pin existing short-circuits with named log lines) ──

  it('skips when child has child_running (internal delegation wait, not bubble-worthy)', async () => {
    mockGetSessionState
      .mockResolvedValueOnce(
        childStateBase({
          delegationPauseSource: 'child_running',
          requestedInputRef: strictHandoffRef(),
        }),
      )
      .mockResolvedValueOnce(parentStateBase({ delegationWaitMode: 'until_pause' }));
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('skips when parent already has child_input bubbled (idempotent re-fire)', async () => {
    mockGetSessionState
      .mockResolvedValueOnce(childStateBase({ requestedInputRef: strictHandoffRef() }))
      .mockResolvedValueOnce(
        parentStateBase({
          delegationPauseSource: 'child_input',
          delegationWaitMode: 'until_pause',
        }),
      );
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });

  it('skips when parent does not track the child in waitingForChildSessionIds', async () => {
    mockGetSessionState
      .mockResolvedValueOnce(childStateBase({ requestedInputRef: strictHandoffRef() }))
      .mockResolvedValueOnce(
        parentStateBase({
          waitingForChildSessionIds: [],
          delegationWaitMode: 'until_pause',
        }),
      );
    await bubbleChildPauseToParent(
      {} as never,
      { retrieve: vi.fn() } as never,
      TENANT,
      CHILD_RUN,
      agentDefLoader,
    );
    expect(mockAddStepResult).not.toHaveBeenCalled();
    expect(mockWaitForInput).not.toHaveBeenCalled();
  });
});
